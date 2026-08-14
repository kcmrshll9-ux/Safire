import assert from 'node:assert/strict';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MemoryHardLinkUnavailableError,
  assertHardLinkPublicationSupported,
  assertPathContained,
  createImmutableJson,
  ensureMemoryLayout,
  immutableCollectionDirectory,
} from '../lib/memory/filesystem.mjs';
import { registerMemoryMcpTools } from '../lib/memory/mcp.mjs';
import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import { createMemoryStore } from '../lib/memory/store.mjs';

async function temporaryVault(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-memory-hardlink-'));
  t.after(async () => {
    const resolvedScratch = path.resolve(scratch);
    assertPathContained(path.resolve(os.tmpdir()), resolvedScratch);
    await fs.rm(resolvedScratch, { recursive: true, force: true });
  });
  const vault = path.join(scratch, 'vault');
  await fs.mkdir(vault);
  return { scratch, vault };
}

function hardLinkError(code) {
  const error = new Error('synthetic hard-link capability failure');
  error.code = code;
  return error;
}

function assertControlledCapabilityError(error) {
  assert.equal(error instanceof MemoryHardLinkUnavailableError, true);
  assert.equal(error.code, 'MEMORY_HARD_LINK_UNAVAILABLE');
  assert.equal(error.message, 'Safire memory requires same-directory hard-link support');
  assert.equal(Object.hasOwn(error, 'details'), false);
  assert.equal(error.cause, undefined);
  return true;
}

async function assertNoPublishedMemoryState(vault) {
  const root = path.join(vault, '.safire', 'memory', 'v1');
  assert.deepEqual(
    (await fs.readdir(root)).sort(),
    ['journals', 'locks', 'records', 'state'],
  );
  assert.deepEqual(await fs.readdir(path.join(root, 'journals')), []);
  assert.deepEqual(await fs.readdir(path.join(root, 'state')), []);
  const records = path.join(root, 'records');
  assert.deepEqual(
    (await fs.readdir(records)).sort(),
    ['actors', 'events', 'feedback', 'idempotency', 'memories'],
  );
  for (const collection of await fs.readdir(records)) {
    assert.deepEqual(await fs.readdir(path.join(records, collection)), []);
  }
  await assert.rejects(() => fs.stat(path.join(root, 'manifest.json')), { code: 'ENOENT' });
}

async function assertOnlyEmptyLayout(vault) {
  await assertNoPublishedMemoryState(vault);
  const locks = path.join(vault, '.safire', 'memory', 'v1', 'locks');
  assert.deepEqual(await fs.readdir(locks), []);
}

async function snapshotTree(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      snapshot.push({ type: 'directory', path: childRelative });
      snapshot.push(...await snapshotTree(root, childRelative));
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      snapshot.push({
        type: 'file',
        path: childRelative,
        bytes: (await fs.readFile(path.join(root, childRelative))).toString('base64'),
      });
    } else {
      snapshot.push({ type: 'other', path: childRelative });
    }
  }
  return snapshot;
}

function portableProfile() {
  return createPortableMcpProfile({
    profileId: 'profile:hardlink-capability',
    principal: { id: 'agent:hardlink-capability', type: 'agent', displayName: 'Capability Agent' },
    agentInstance: { id: 'agent_instance:hardlink-capability:test', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:hardlink-capability:test' },
    sourceIdentity: 'mcp:hardlink-capability',
    allowedActors: [],
    namespaceGrants: [
      { namespace: 'agents/hardlink-capability', read: true, write: true, descendants: true },
    ],
  });
}

function event() {
  return {
    schema_version: 1,
    namespace: 'agents/hardlink-capability',
    actor_type: 'agent',
    actor_id: 'agent:hardlink-capability',
    agent_instance_id: 'agent_instance:hardlink-capability:test',
    kind: 'observable_action',
    speech_act: 'observation',
    content: 'The hard-link capability test created one retained event.',
    occurred_at: '2026-08-14T12:00:00.000Z',
    source: { stream: 'capability.test', event_id: 'event.1' },
  };
}

function publicationDirectories(layout) {
  return [
    layout.rootDir,
    layout.stateDir,
    layout.journalsDir,
    layout.locksDir,
    ...Object.values(layout.collections),
  ];
}

test('supported same-directory hard links validate by identity and leave no probe artifacts', async t => {
  const { vault } = await temporaryVault(t);
  const originalLink = fs.link;
  const probedDirectories = [];
  fs.link = (source, destination) => {
    probedDirectories.push(path.dirname(source));
    return originalLink(source, destination);
  };
  let layout;
  try {
    layout = await ensureMemoryLayout(vault);
  } finally {
    fs.link = originalLink;
  }
  assert.deepEqual(
    [...new Set(probedDirectories)].sort(),
    [layout.locksDir],
  );
  for (const directory of publicationDirectories(layout)) {
    assert.deepEqual(
      (await fs.readdir(directory)).filter(name => name.startsWith('.hard-link-capability-')),
      [],
    );
  }
  assert.equal(await assertHardLinkPublicationSupported(layout.locksDir), true);
  assert.deepEqual(await fs.readdir(layout.locksDir), []);
  const created = await createImmutableJson(layout, 'actors', 'actor:supported', { supported: true });
  assert.equal((await fs.readFile(created.path, 'utf8')).endsWith('\n'), true);
  assert.deepEqual(await fs.readdir(layout.locksDir), []);
});

test('unsupported hard-link errors fail before lock or manifest and clean exact probes', async t => {
  for (const code of [
    'ENOTSUP',
    'ENOSYS',
    'EPERM',
    'EOPNOTSUPP',
    'EACCES',
    'EINVAL',
    'EXDEV',
  ]) {
    await t.test(code, async subtest => {
      const { vault } = await temporaryVault(subtest);
      const originalLink = fs.link;
      fs.link = async () => { throw hardLinkError(code); };
      try {
        await assert.rejects(() => ensureMemoryLayout(vault), assertControlledCapabilityError);
      } finally {
        fs.link = originalLink;
      }
      await assertOnlyEmptyLayout(vault);
    });
  }
});

test('a publication directory on another reported device fails before the link probe', async t => {
  const { vault } = await temporaryVault(t);
  const originalLstat = fs.lstat;
  const originalLink = fs.link;
  let linkCalls = 0;
  fs.lstat = async (target, options) => {
    const stat = await originalLstat(target, options);
    if (path.basename(String(target)) !== 'events'
        || path.basename(path.dirname(String(target))) !== 'records') {
      return stat;
    }
    return new Proxy(stat, {
      get(value, property, receiver) {
        if (property === 'dev') return value.dev + 1n;
        const member = Reflect.get(value, property, receiver);
        return typeof member === 'function' ? member.bind(value) : member;
      },
    });
  };
  fs.link = (...args) => {
    linkCalls += 1;
    return originalLink(...args);
  };
  try {
    await assert.rejects(() => ensureMemoryLayout(vault), assertControlledCapabilityError);
  } finally {
    fs.lstat = originalLstat;
    fs.link = originalLink;
  }
  assert.equal(linkCalls, 0);
  await assertOnlyEmptyLayout(vault);
});

test('an unrelated hard-link I/O failure is not misreported as unsupported capability', async t => {
  const { vault } = await temporaryVault(t);
  const originalLink = fs.link;
  fs.link = async () => { throw hardLinkError('EIO'); };
  try {
    await assert.rejects(
      () => ensureMemoryLayout(vault),
      error => {
        assert.equal(error instanceof MemoryHardLinkUnavailableError, false);
        assert.equal(error.code, 'MEMORY_FILESYSTEM_ERROR');
        assert.equal(error.message, 'Safire memory hard-link capability probe failed');
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  } finally {
    fs.link = originalLink;
  }
  await assertOnlyEmptyLayout(vault);
});

test('a post-open probe sync failure cleans the identity-pinned source', async t => {
  const { vault } = await temporaryVault(t);
  const originalOpen = fs.open;
  const originalLink = fs.link;
  let linkCalls = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const target = String(args[0]);
    if (path.basename(path.dirname(target)) !== 'locks'
        || !path.basename(target).startsWith('.hard-link-capability-')) {
      return handle;
    }
    return new Proxy(handle, {
      get(value, property) {
        if (property === 'sync') return async () => { throw hardLinkError('EIO'); };
        const member = value[property];
        return typeof member === 'function' ? member.bind(value) : member;
      },
    });
  };
  fs.link = (...args) => {
    linkCalls += 1;
    return originalLink(...args);
  };
  try {
    await assert.rejects(
      () => ensureMemoryLayout(vault),
      error => {
        assert.equal(error instanceof MemoryHardLinkUnavailableError, false);
        assert.equal(error.code, 'MEMORY_FILESYSTEM_ERROR');
        return true;
      },
    );
  } finally {
    fs.open = originalOpen;
    fs.link = originalLink;
  }
  assert.equal(linkCalls, 0);
  await assertOnlyEmptyLayout(vault);
});

test('copy-like link emulation fails identity validation without deleting the unproven destination', async t => {
  const { vault } = await temporaryVault(t);
  const originalLink = fs.link;
  let copiedPath;
  let injected = false;
  fs.link = (source, destination) => {
    if (injected || path.basename(path.dirname(source)) !== 'locks') {
      return originalLink(source, destination);
    }
    injected = true;
    copiedPath = destination;
    return fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  };
  try {
    await assert.rejects(() => ensureMemoryLayout(vault), assertControlledCapabilityError);
  } finally {
    fs.link = originalLink;
  }
  await assertNoPublishedMemoryState(vault);
  assert.deepEqual(await fs.readdir(path.dirname(copiedPath)), [path.basename(copiedPath)]);
  assert.equal(
    await fs.readFile(copiedPath, 'utf8'),
    'safire-memory-hard-link-capability-v1\n',
  );
});

test('a link published before an injected error is proven and cleaned exactly', async t => {
  const { vault } = await temporaryVault(t);
  const originalLink = fs.link;
  let injected = false;
  fs.link = async (source, destination) => {
    if (injected || path.basename(path.dirname(source)) !== 'locks') {
      return originalLink(source, destination);
    }
    injected = true;
    await originalLink(source, destination);
    throw hardLinkError('EPERM');
  };
  try {
    await assert.rejects(() => ensureMemoryLayout(vault), assertControlledCapabilityError);
  } finally {
    fs.link = originalLink;
  }
  await assertOnlyEmptyLayout(vault);
});

test('an unproven replacement at the probe destination is preserved fail closed', async t => {
  const { vault } = await temporaryVault(t);
  const originalLink = fs.link;
  const replacement = Buffer.from('operator-owned replacement\n');
  let replacementPath;
  let injected = false;
  fs.link = async (source, destination) => {
    if (injected || path.basename(path.dirname(source)) !== 'locks') {
      return originalLink(source, destination);
    }
    injected = true;
    await originalLink(source, destination);
    await fs.unlink(destination);
    await fs.writeFile(destination, replacement, { flag: 'wx', mode: 0o600 });
    replacementPath = destination;
  };
  try {
    await assert.rejects(() => ensureMemoryLayout(vault), assertControlledCapabilityError);
  } finally {
    fs.link = originalLink;
  }
  await assertNoPublishedMemoryState(vault);
  assert.deepEqual(await fs.readdir(path.dirname(replacementPath)), [path.basename(replacementPath)]);
  assert.deepEqual(await fs.readFile(replacementPath), replacement);
});

test('a later hard-link failure is controlled and publishes no target or temporary file', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const originalLink = fs.link;
  fs.link = async () => { throw hardLinkError('EPERM'); };
  try {
    await assert.rejects(
      () => createImmutableJson(layout, 'actors', 'actor:unsupported', { must_not_publish: true }),
      assertControlledCapabilityError,
    );
  } finally {
    fs.link = originalLink;
  }
  assert.deepEqual(await fs.readdir(immutableCollectionDirectory(layout, 'actors')), []);
  assert.deepEqual(await fs.readdir(layout.locksDir), []);
});

test('capability failure preserves every existing sidecar path and byte', async t => {
  const { vault } = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: portableProfile() });
  await store.recordEvents([event()]);
  const memoryRoot = path.join(vault, '.safire', 'memory', 'v1');
  const before = await snapshotTree(memoryRoot);
  const originalLink = fs.link;
  fs.link = async () => { throw hardLinkError('ENOTSUP'); };
  try {
    await assert.rejects(() => ensureMemoryLayout(vault), assertControlledCapabilityError);
  } finally {
    fs.link = originalLink;
  }
  assert.deepEqual(await snapshotTree(memoryRoot), before);
});

test('MCP maps an injected store initialization failure without path or cause details', async t => {
  const { vault } = await temporaryVault(t);
  const handlers = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  };
  const store = createMemoryStore({ vaultDir: vault, profile: portableProfile() });
  registerMemoryMcpTools(server, store);
  const originalLink = fs.link;
  fs.link = async () => { throw hardLinkError('EPERM'); };
  let result;
  try {
    result = await handlers.get('memory_status')({});
  } finally {
    fs.link = originalLink;
  }
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: {
      code: 'MEMORY_HARD_LINK_UNAVAILABLE',
      message: 'Safire memory requires same-directory hard-link support',
    },
  });
  assert.doesNotMatch(result.content[0].text, /[A-Z]:\\|cause|EPERM|ENOTSUP|synthetic/i);
  await assertOnlyEmptyLayout(vault);
});
