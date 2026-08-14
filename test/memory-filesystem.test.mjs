import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import { createMemoryStore } from '../lib/memory/store.mjs';

import {
  HARD_MAX_LOCK_METADATA_BYTES,
  HARD_MAX_MEMORY_JSON_FILE_BYTES,
  IMMUTABLE_COLLECTIONS,
  MemoryConflictError,
  VaultLockTimeoutError,
  VaultLockOwnershipError,
  acquireVaultLock,
  assertPathContained,
  assertSupportedMemoryVaultPath,
  createImmutableJson,
  createJournalEntry,
  createMutableJson,
  digestJson,
  ensureJournalDirectory,
  ensureMemoryLayout,
  immutableCollectionDirectory,
  immutableRecordPath,
  journalDirectory,
  journalEntryPath,
  listImmutableJson,
  listJournalEntries,
  opaqueJsonFilename,
  readImmutableJson,
  readJsonWithDigest,
  readJournalEntry,
  readMutableJson,
  removeJournalDirectoryIfEmpty,
  removeJournalEntry,
  replaceMutableJson,
  resolveContainedPath,
  serializeJson,
  sha256Hex,
  withVaultLock,
} from '../lib/memory/filesystem.mjs';

const MODULE_URL = new URL('../lib/memory/filesystem.mjs', import.meta.url).href;
const LOCK_HOLDER_FIXTURE = fileURLToPath(new URL('../test-support/memory-lock-holder.mjs', import.meta.url));
const HARD_KILL_WRITER_FIXTURE = fileURLToPath(new URL('../test-support/memory-hard-kill-writer.mjs', import.meta.url));

async function temporaryVault(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-memory-filesystem-'));
  const vault = path.join(scratch, 'vault');
  await fs.mkdir(vault);
  t.after(async () => {
    const resolvedScratch = path.resolve(scratch);
    const resolvedTemp = path.resolve(os.tmpdir());
    assertPathContained(resolvedTemp, resolvedScratch);
    await fs.rm(resolvedScratch, { recursive: true, force: true });
  });
  return { scratch, vault };
}

async function waitForOutput(child, expected, timeoutMs = 2_000) {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child output timeout (${stderr.trim() || 'no stderr'})`)), timeoutMs);
    const onData = chunk => {
      stdout += chunk;
      if (!stdout.includes(expected)) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(stdout);
    };
    child.stdout.on('data', onData);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (stdout.includes(expected)) return;
      clearTimeout(timer);
      reject(new Error(`Child exited ${code} before ${expected} (${stderr.trim() || 'no stderr'})`));
    });
  });
}

function spawnLockHolder(vault) {
  return spawn(process.execPath, [LOCK_HOLDER_FIXTURE, vault], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function spawnHardKillWriter(vault) {
  return spawn(process.execPath, [HARD_KILL_WRITER_FIXTURE, vault], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function killChildIfRunning(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function hardKillProfile() {
  return createPortableMcpProfile({
    profileId: 'profile:hard-kill-writer',
    principal: { id: 'agent:hard-kill', type: 'agent', displayName: 'Hard-kill test agent' },
    agentInstance: { id: 'agent_instance:hard-kill:test', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:safire-memory-mcp:hard-kill-test' },
    sourceIdentity: 'mcp:hard-kill-test',
    allowedActors: [],
    namespaceGrants: [
      { namespace: 'agents/hard-kill', read: true, write: true, descendants: true },
    ],
  });
}

test('creates a contained v1 memory layout only under an explicit vault', async t => {
  const { scratch, vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);

  assert.equal(layout.rootDir, path.join(await fs.realpath(vault), '.safire', 'memory', 'v1'));
  assert.ok(Object.isFrozen(layout));
  assert.ok(Object.isFrozen(layout.collections));
  assert.deepEqual(Object.keys(layout.collections).sort(), [...IMMUTABLE_COLLECTIONS].sort());

  for (const directory of [
    layout.rootDir,
    layout.recordsDir,
    layout.stateDir,
    layout.journalsDir,
    layout.locksDir,
    ...Object.values(layout.collections),
  ]) {
    assert.equal((await fs.stat(directory)).isDirectory(), true);
    assertPathContained(layout.vaultDir, directory);
  }

  await assert.rejects(ensureMemoryLayout('relative/vault'), error => error.code === 'MEMORY_VAULT_REQUIRED');
  await assert.rejects(ensureMemoryLayout(path.parse(vault).root), error => error.code === 'MEMORY_VAULT_UNSAFE');
  assert.throws(
    () => assertPathContained(vault, path.join(scratch, 'vault-neighbor', 'record.json')),
    error => error.code === 'MEMORY_PATH_ESCAPE',
  );
  assert.throws(
    () => immutableCollectionDirectory(layout, 'arbitrary-user-segment'),
    error => error.code === 'MEMORY_COLLECTION_INVALID',
  );
  assert.equal(resolveContainedPath(layout.rootDir, 'state'), layout.stateDir);

  if (process.platform === 'win32') {
    assert.doesNotThrow(() => assertPathContained(layout.rootDir.toUpperCase(), layout.stateDir.toLowerCase()));
  }
});

test('rejects UNC and Windows device namespace vault paths before filesystem access', {
  skip: process.platform !== 'win32',
}, async () => {
  const unsupported = [
    String.raw`\\server\share\vault`,
    '//server/share/vault',
    String.raw`\\?\UNC\server\share\vault`,
    String.raw`\\?\C:\vault`,
    String.raw`\\.\C:\vault`,
  ];
  for (const vaultPath of unsupported) {
    assert.throws(
      () => assertSupportedMemoryVaultPath(vaultPath),
      error => error.code === 'MEMORY_VAULT_NETWORK_UNSUPPORTED',
    );
    assert.throws(
      () => createMemoryStore({ vaultDir: vaultPath, enabled: false }),
      error => error.code === 'MEMORY_VAULT_NETWORK_UNSUPPORTED',
    );
    await assert.rejects(
      ensureMemoryLayout(vaultPath),
      error => error.code === 'MEMORY_VAULT_NETWORK_UNSUPPORTED',
    );
  }
});

test('refuses a symlinked or non-directory Safire layout segment', async t => {
  const { vault } = await temporaryVault(t);
  await fs.writeFile(path.join(vault, '.safire'), 'not a directory', 'utf8');
  await assert.rejects(
    ensureMemoryLayout(vault),
    error => ['MEMORY_LAYOUT_UNSAFE', 'EEXIST'].includes(error.code),
  );
});

test('rejects a collection directory that is replaced after layout validation', async t => {
  const { scratch, vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const collection = layout.collections.actors;
  const original = path.join(scratch, 'actors-original');
  await fs.rename(collection, original);
  await fs.mkdir(collection);
  try {
    await assert.rejects(
      createImmutableJson(layout, 'actors', 'replacement-attempt', { id: 'must-not-write' }),
      error => error.code === 'MEMORY_PATH_IDENTITY',
    );
    assert.deepEqual(await fs.readdir(collection), []);
  } finally {
    await fs.rmdir(collection);
    await fs.rename(original, collection);
  }
});

test('rejects reads and writes through a real NTFS junction', {
  skip: process.platform !== 'win32',
}, async t => {
  const { scratch, vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const collection = layout.collections.actors;
  const original = path.join(scratch, 'actors-original');
  const outside = path.join(scratch, 'outside');
  const identity = 'junction-attempt';
  const outsideTarget = path.join(outside, opaqueJsonFilename(identity));
  await fs.mkdir(outside);
  await fs.writeFile(outsideTarget, serializeJson({ id: 'outside' }), 'utf8');
  await fs.rename(collection, original);
  await fs.symlink(outside, collection, 'junction');
  try {
    for (const operation of [
      () => readImmutableJson(layout, 'actors', identity),
      () => createImmutableJson(layout, 'actors', identity, { id: 'must-not-write' }),
    ]) {
      await assert.rejects(
        operation,
        error => ['MEMORY_PATH_UNSAFE', 'MEMORY_PATH_IDENTITY'].includes(error.code),
      );
    }
    assert.deepEqual(JSON.parse(await fs.readFile(outsideTarget, 'utf8')), { id: 'outside' });
  } finally {
    await fs.unlink(collection);
    await fs.rename(original, collection);
  }
});

test('revalidates directory identity immediately after the immutable publish step', {
  skip: process.platform !== 'win32',
}, async t => {
  const { scratch, vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const collection = layout.collections.actors;
  const original = path.join(scratch, 'actors-original');
  const outside = path.join(scratch, 'outside');
  await fs.mkdir(outside);

  const originalLink = fs.link;
  fs.link = async () => {
    await fs.rename(collection, original);
    await fs.symlink(outside, collection, 'junction');
  };
  try {
    await assert.rejects(
      createImmutableJson(layout, 'actors', 'post-publish-swap', { id: 'must-not-escape' }),
      error => ['MEMORY_PATH_UNSAFE', 'MEMORY_PATH_IDENTITY'].includes(error.code),
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    fs.link = originalLink;
    const stat = await fs.lstat(collection).catch(() => null);
    if (stat?.isSymbolicLink()) await fs.unlink(collection);
    if (await fs.stat(original).then(() => true, () => false)) await fs.rename(original, collection);
  }
});

test('uses deterministic canonical JSON, SHA-256 digests, and opaque filenames', () => {
  const sensitiveIdentity = 'user@example.test/private/conversation/42';
  const filename = opaqueJsonFilename(sensitiveIdentity);
  assert.match(filename, /^[a-f0-9]{64}\.json$/);
  assert.equal(filename.includes('user'), false);
  assert.equal(filename, `${sha256Hex(sensitiveIdentity)}.json`);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  const left = { z: [3, 2, 1], a: { y: true, x: null } };
  const right = { a: { x: null, y: true }, z: [3, 2, 1] };
  assert.equal(serializeJson(left), serializeJson(right));
  assert.equal(digestJson(left), digestJson(right));
  assert.throws(() => serializeJson({ invalid: undefined }), /Undefined JSON fields/);
});

test('publishes immutable JSON exclusively and lists only opaque records', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const identity = 'actor:user:primary';
  const record = { type: 'user', id: 'actor_01' };

  const created = await createImmutableJson(layout, 'actors', identity, record);
  assert.equal(created.path, immutableRecordPath(layout, 'actors', identity));
  assert.match(path.basename(created.path), /^[a-f0-9]{64}\.json$/);
  assert.deepEqual((await readImmutableJson(layout, 'actors', identity)).value, record);

  await assert.rejects(
    createImmutableJson(layout, 'actors', identity, { type: 'agent', id: 'replacement' }),
    error => error.code === 'EEXIST',
  );
  assert.deepEqual((await readImmutableJson(layout, 'actors', identity)).value, record);

  await fs.writeFile(path.join(layout.collections.actors, 'human-readable.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(layout.collections.actors, '.interrupted.tmp'), '{}\n', 'utf8');
  const listed = await listImmutableJson(layout, 'actors');
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
  assert.deepEqual(listed.map(entry => entry.name), [path.basename(created.path)]);

  const leftovers = (await fs.readdir(layout.collections.actors)).filter(name => name.endsWith('.tmp') && name !== '.interrupted.tmp');
  assert.deepEqual(leftovers, []);

  const memory = await createImmutableJson(layout, 'memories', 'memory_01', {
    memory_id: 'memory_01',
    source_event_ids: ['event_01'],
  });
  assert.deepEqual((await readImmutableJson(layout, 'memories', 'memory_01')).value, {
    memory_id: 'memory_01',
    source_event_ids: ['event_01'],
  });
  assertPathContained(layout.collections.memories, memory.path);
});

test('opened-file JSON reads and writes enforce immutable byte ceilings before allocation', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const identity = 'bounded-json';
  const created = await createImmutableJson(layout, 'actors', identity, { value: 'synthetic' });
  const exactBytes = (await fs.stat(created.path)).size;
  assert.deepEqual(
    (await readImmutableJson(layout, 'actors', identity, { maxBytes: exactBytes })).value,
    { value: 'synthetic' },
  );
  await assert.rejects(
    () => readImmutableJson(layout, 'actors', identity, { maxBytes: exactBytes - 1 }),
    error => error.code === 'MEMORY_RESOURCE_LIMIT'
      && error.message === 'Safire memory resource limit exceeded'
      && !Object.hasOwn(error, 'details'),
  );

  const rejectedIdentity = 'bounded-json-write';
  await assert.rejects(
    () => createImmutableJson(
      layout,
      'actors',
      rejectedIdentity,
      { value: 'x'.repeat(128) },
      { maxBytes: 64 },
    ),
    error => error.code === 'MEMORY_RESOURCE_LIMIT' && !Object.hasOwn(error, 'details'),
  );
  await assert.rejects(
    () => fs.stat(immutableRecordPath(layout, 'actors', rejectedIdentity)),
    { code: 'ENOENT' },
  );

  const sparsePath = immutableRecordPath(layout, 'actors', 'oversized-sparse-json');
  await fs.writeFile(sparsePath, '{}\n', 'utf8');
  await fs.truncate(sparsePath, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);
  await assert.rejects(
    () => readJsonWithDigest(layout.collections.actors, sparsePath),
    error => error.code === 'MEMORY_RESOURCE_LIMIT'
      && error.message === 'Safire memory resource limit exceeded'
      && !Object.hasOwn(error, 'details'),
  );
  assert.equal((await fs.stat(sparsePath)).size, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);
});

test('serializes cross-process vault lock contention with bounded retry', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const script = `
    import { ensureMemoryLayout, acquireVaultLock } from ${JSON.stringify(MODULE_URL)};
    const layout = await ensureMemoryLayout(${JSON.stringify(vault)});
    const lock = await acquireVaultLock(layout, { timeoutMs: 1000, retryDelayMs: 5 });
    process.stdout.write('LOCKED\\n');
    await new Promise(resolve => setTimeout(resolve, 300));
    await lock.release();
    process.stdout.write('RELEASED\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  await waitForOutput(child, 'LOCKED');
  await assert.rejects(
    acquireVaultLock(layout, { timeoutMs: 70, retryDelayMs: 8 }),
    error => error instanceof VaultLockTimeoutError && error.code === 'MEMORY_LOCK_TIMEOUT',
  );
  await waitForOutput(child, 'RELEASED');

  const lock = await acquireVaultLock(layout, { timeoutMs: 500, retryDelayMs: 5 });
  assert.equal(await lock.isOwned(), true);
  assert.equal(await lock.release(), true);
  assert.equal(await lock.isOwned(), false);
});

test('oversized lock metadata fails closed without removing the lock', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const lock = await acquireVaultLock(layout);
  await fs.truncate(layout.lockPath, HARD_MAX_LOCK_METADATA_BYTES + 1);
  await assert.rejects(
    () => lock.release(),
    error => error.code === 'MEMORY_RESOURCE_LIMIT'
      && error.message === 'Safire memory resource limit exceeded'
      && !Object.hasOwn(error, 'details'),
  );
  assert.equal((await fs.stat(layout.lockPath)).size, HARD_MAX_LOCK_METADATA_BYTES + 1);
});

test('keeps a killed owner lock until explicit operator recovery', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const child = spawnLockHolder(vault);
  t.after(() => killChildIfRunning(child));

  await waitForOutput(child, 'LOCKED');
  const serialized = await fs.readFile(layout.lockPath, 'utf8');
  const abandoned = JSON.parse(serialized);
  assert.equal(serialized.endsWith('\n'), true);
  assert.deepEqual(Object.keys(abandoned).sort(), ['createdAtMs', 'pid', 'recovery', 'token', 'version']);
  assert.equal(abandoned.version, 2);
  assert.equal(abandoned.recovery, 'operator_only');
  assert.equal(abandoned.pid, child.pid);
  assert.match(abandoned.token, /^[a-f0-9]{64}$/);
  assert.equal(Number.isFinite(abandoned.createdAtMs), true);

  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  await exited;

  await assert.rejects(
    acquireVaultLock(layout, { timeoutMs: 80, retryDelayMs: 5, staleMs: 0 }),
    error => error instanceof VaultLockTimeoutError && error.code === 'MEMORY_LOCK_TIMEOUT',
  );
  assert.equal(await fs.readFile(layout.lockPath, 'utf8'), serialized);

  // This models the documented operator-only procedure in an isolated temp
  // vault: the owner has exited before the exact lock file is removed.
  assert.notEqual(child.signalCode, null);
  await fs.unlink(layout.lockPath);
  const recovered = await acquireVaultLock(layout, { timeoutMs: 500, retryDelayMs: 5 });
  assert.notEqual(recovered.token, abandoned.token);
  await recovered.release();
});

test('recovers a fully flushed multi-item journal after its first child writer is hard-killed', async t => {
  const { vault } = await temporaryVault(t);
  const child = spawnHardKillWriter(vault);
  t.after(() => killChildIfRunning(child));
  await waitForOutput(child, 'FIRST_CHILD_COMMITTED', 5_000);

  const layout = await ensureMemoryLayout(vault);
  const lockBytes = await fs.readFile(layout.lockPath, 'utf8');
  assert.ok((await listJournalEntries(layout, 'ingestion')).length > 0);

  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
  await assert.rejects(
    acquireVaultLock(layout, { timeoutMs: 80, retryDelayMs: 5 }),
    error => error instanceof VaultLockTimeoutError,
  );
  assert.equal(await fs.readFile(layout.lockPath, 'utf8'), lockBytes);

  // Operator recovery is modeled only after the child is confirmed stopped.
  assert.notEqual(child.signalCode, null);
  await fs.unlink(layout.lockPath);
  const recovered = createMemoryStore({ vaultDir: vault, profile: hardKillProfile() });
  const status = await recovered.status();
  assert.equal(status.counts.events, 2);
  assert.equal(status.counts.memories, 2);
  assert.equal(status.pending_transactions, 0);
});

test('three contenders time out without changing a live owner lock', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const owner = await acquireVaultLock(layout, { timeoutMs: 500, retryDelayMs: 5 });
  const serialized = await fs.readFile(layout.lockPath, 'utf8');
  const contenders = await Promise.allSettled(Array.from({ length: 3 }, () => (
    acquireVaultLock(layout, { timeoutMs: 100, retryDelayMs: 7, staleMs: 1 })
  )));
  assert.equal(contenders.length, 3);
  assert.equal(contenders.every(result => (
    result.status === 'rejected'
      && result.reason instanceof VaultLockTimeoutError
      && result.reason.code === 'MEMORY_LOCK_TIMEOUT'
  )), true);
  assert.equal(await fs.readFile(layout.lockPath, 'utf8'), serialized);
  assert.equal(await owner.isOwned(), true);
  await owner.release();
});

test('lock age, a reused live PID, and invalid metadata never authorize automatic recovery', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const old = Date.now() - 60_000;
  const serialized = serializeJson({
    version: 2,
    token: 'e'.repeat(64),
    pid: process.pid,
    createdAtMs: old,
    recovery: 'operator_only',
  });
  await fs.writeFile(layout.lockPath, serialized, 'utf8');
  await fs.utimes(layout.lockPath, new Date(old), new Date(old));

  await assert.rejects(
    acquireVaultLock(layout, { timeoutMs: 80, retryDelayMs: 5, staleMs: 1 }),
    error => error instanceof VaultLockTimeoutError,
  );
  assert.equal(await fs.readFile(layout.lockPath, 'utf8'), serialized);
  await fs.unlink(layout.lockPath);

  const invalid = '{ invalid lock metadata\n';
  await fs.writeFile(layout.lockPath, invalid, 'utf8');
  await fs.utimes(layout.lockPath, new Date(old), new Date(old));
  await assert.rejects(
    acquireVaultLock(layout, { timeoutMs: 80, retryDelayMs: 5 }),
    error => error instanceof VaultLockTimeoutError,
  );
  assert.equal(await fs.readFile(layout.lockPath, 'utf8'), invalid);
  await fs.unlink(layout.lockPath);
});

test('a delayed contender cannot remove or release a newly acquired owner lock', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const first = await acquireVaultLock(layout, { timeoutMs: 500, retryDelayMs: 5 });
  let reportFirstContention;
  const firstContention = new Promise(resolve => { reportFirstContention = resolve; });
  const contentionSignal = {
    aborted: false,
    addEventListener(type) {
      assert.equal(type, 'abort');
      reportFirstContention();
    },
    removeEventListener(type) {
      assert.equal(type, 'abort');
    },
  };
  const contender = acquireVaultLock(layout, {
    timeoutMs: 250,
    retryDelayMs: 100,
    signal: contentionSignal,
  });
  await firstContention;

  await first.release();
  const second = await acquireVaultLock(layout, { timeoutMs: 50, retryDelayMs: 2 });
  const secondBytes = await fs.readFile(layout.lockPath, 'utf8');
  await assert.rejects(
    contender,
    error => error instanceof VaultLockTimeoutError && error.code === 'MEMORY_LOCK_TIMEOUT',
  );
  assert.equal(await fs.readFile(layout.lockPath, 'utf8'), secondBytes);
  assert.equal(await second.isOwned(), true);
  await second.release();
});

test('withVaultLock releases the lock after an operation failure', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  await assert.rejects(
    withVaultLock(layout, async lock => {
      assert.equal(await lock.isOwned(), true);
      throw new Error('expected operation failure');
    }),
    /expected operation failure/,
  );
  const next = await acquireVaultLock(layout, { timeoutMs: 100 });
  await next.release();
});

test('withVaultLock fails closed if callback lock ownership is replaced', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  await assert.rejects(
    withVaultLock(layout, async () => {
      await fs.unlink(layout.lockPath);
      await fs.writeFile(layout.lockPath, serializeJson({
        version: 1,
        token: 'f'.repeat(64),
        pid: process.pid,
        createdAtMs: Date.now(),
      }), 'utf8');
      return 'must not be returned';
    }),
    error => error instanceof VaultLockOwnershipError && error.code === 'MEMORY_LOCK_OWNERSHIP',
  );
  const replacement = JSON.parse(await fs.readFile(layout.lockPath, 'utf8'));
  assert.equal(replacement.token, 'f'.repeat(64));
  await fs.unlink(layout.lockPath);
});

test('mutable publication rechecks lock ownership after preparing its temporary file', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const created = await createMutableJson(layout, 'fenced-state', { items: [] });
  const replacementToken = 'd'.repeat(64);
  const originalOpen = fs.open;
  let replaced = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const candidate = args[0];
    if (!replaced
        && typeof candidate === 'string'
        && path.dirname(candidate) === layout.stateDir
        && path.basename(candidate).endsWith('.tmp')) {
      replaced = true;
      await fs.unlink(layout.lockPath);
      await fs.writeFile(layout.lockPath, serializeJson({
        version: 2,
        token: replacementToken,
        pid: process.pid,
        createdAtMs: Date.now(),
        recovery: 'operator_only',
      }), 'utf8');
    }
    return handle;
  };
  try {
    await assert.rejects(
      withVaultLock(layout, lock => replaceMutableJson(
        layout,
        'fenced-state',
        { items: ['must-not-publish'] },
        { expectedRevision: 0, expectedDigest: created.digest, lock },
      )),
      error => error instanceof VaultLockOwnershipError,
    );
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(replaced, true);
  assert.deepEqual((await readMutableJson(layout, 'fenced-state')).value, { items: [], revision: 0 });
  assert.equal(JSON.parse(await fs.readFile(layout.lockPath, 'utf8')).token, replacementToken);
  await fs.unlink(layout.lockPath);
});

test('optimistic mutable JSON requires matching revision and digest', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const created = await createMutableJson(layout, 'search-index', { items: [] });
  assert.equal(created.revision, 0);

  const first = await replaceMutableJson(
    layout,
    'search-index',
    { items: ['event_01'] },
    { expectedRevision: 0, expectedDigest: created.digest },
  );
  assert.equal(first.revision, 1);

  await assert.rejects(
    replaceMutableJson(
      layout,
      'search-index',
      { items: ['stale-writer'] },
      { expectedRevision: 0, expectedDigest: created.digest },
    ),
    error => error instanceof MemoryConflictError && error.kind === 'revision' && error.details.actualRevision === 1,
  );

  await assert.rejects(
    replaceMutableJson(
      layout,
      'search-index',
      { items: ['wrong-digest'] },
      { expectedRevision: 1, expectedDigest: created.digest },
    ),
    error => error instanceof MemoryConflictError && error.kind === 'digest' && error.details.actualDigest === first.digest,
  );

  const beforeRace = await readMutableJson(layout, 'search-index');
  const raced = await Promise.allSettled([
    replaceMutableJson(
      layout,
      'search-index',
      { items: ['writer-a'] },
      { expectedRevision: beforeRace.revision, expectedDigest: beforeRace.digest },
    ),
    replaceMutableJson(
      layout,
      'search-index',
      { items: ['writer-b'] },
      { expectedRevision: beforeRace.revision, expectedDigest: beforeRace.digest },
    ),
  ]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter(result => result.status === 'rejected').length, 1);
  assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'MEMORY_CONFLICT');

  const final = await readMutableJson(layout, 'search-index');
  assert.equal(final.revision, 2);
  assert.ok([['writer-a'], ['writer-b']].some(items => JSON.stringify(items) === JSON.stringify(final.value.items)));
});

test('optimistic replacement accepts an already-owned vault lock', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const created = await createMutableJson(layout, 'manifest', { entries: [] });

  await withVaultLock(layout, async lock => {
    const replaced = await replaceMutableJson(
      layout,
      'manifest',
      { entries: ['one'] },
      { expectedRevision: 0, expectedDigest: created.digest, lock },
    );
    assert.equal(replaced.revision, 1);
    assert.deepEqual((await readMutableJson(layout, 'manifest')).value, {
      entries: ['one'],
      revision: 1,
    });
    assert.deepEqual(
      (await fs.readdir(layout.stateDir)).filter(name => name.endsWith('.tmp')),
      [],
    );
  });
});

test('journal helpers hash all path segments and remove only scoped entries', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const journalId = 'transaction/user-visible-secret';
  const entryId = 'prepare/private-record-name';
  const directory = await ensureJournalDirectory(layout, journalId);
  assert.equal(directory, journalDirectory(layout, journalId));
  assert.match(path.basename(directory), /^[a-f0-9]{64}$/);
  assert.equal(directory.includes('user-visible-secret'), false);
  assert.match(path.basename(journalEntryPath(layout, journalId, entryId)), /^[a-f0-9]{64}\.json$/);

  const created = await createJournalEntry(layout, journalId, entryId, { phase: 'prepare' });
  assert.deepEqual((await readJournalEntry(layout, journalId, entryId)).value, { phase: 'prepare' });
  const listed = await listJournalEntries(layout, journalId);
  assert.equal(Object.isFrozen(listed), true);
  assert.deepEqual(listed.map(entry => entry.path), [created.path]);

  await assert.rejects(
    removeJournalEntry(layout, journalId, entryId, { expectedDigest: sha256Hex('wrong') }),
    error => error instanceof MemoryConflictError && error.kind === 'digest',
  );
  assert.equal(await removeJournalEntry(layout, journalId, entryId, { expectedDigest: created.digest }), true);
  assert.equal(await removeJournalEntry(layout, journalId, entryId), false);
  assert.equal(await removeJournalDirectoryIfEmpty(layout, journalId), true);
  assert.equal(await removeJournalDirectoryIfEmpty(layout, journalId), false);
  assert.deepEqual(await listJournalEntries(layout, journalId), []);
});
