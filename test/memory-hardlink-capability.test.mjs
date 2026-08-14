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

function assertGenericProbeError(error) {
  assert.equal(error instanceof MemoryHardLinkUnavailableError, false);
  assert.equal(error.code, 'MEMORY_FILESYSTEM_ERROR');
  assert.equal(error.message, 'Safire memory hard-link capability probe failed');
  assert.equal(error.cause, undefined);
  return true;
}

function assertProbeIdentityError(error) {
  assert.equal(error instanceof MemoryHardLinkUnavailableError, false);
  assert.equal(error.code, 'MEMORY_PATH_IDENTITY');
  assert.equal(error.message, 'Safire memory hard-link capability probe identity changed');
  assert.equal(error.cause, undefined);
  return true;
}

function assertProbeDirectoryError(error) {
  assert.equal(error instanceof MemoryHardLinkUnavailableError, false);
  assert.equal(error.code, 'MEMORY_PATH_UNSAFE');
  assert.equal(error.message, 'A Safire memory directory is unavailable');
  assert.equal(Object.hasOwn(error, 'details'), false);
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
  assert.equal((await fs.readdir(path.join(root, 'locks'))).includes('vault.lock'), false);
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

test('a transient initial handle-stat failure recovers identity once and cleans the source', async t => {
  const { vault } = await temporaryVault(t);
  const originalOpen = fs.open;
  const originalLink = fs.link;
  let statCalls = 0;
  let linkCalls = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const target = String(args[0]);
    if (path.basename(path.dirname(target)) !== 'locks'
        || !path.basename(target).endsWith('.source')) {
      return handle;
    }
    return new Proxy(handle, {
      get(value, property) {
        if (property === 'stat') return async (...statArgs) => {
          statCalls += 1;
          if (statCalls === 1) throw hardLinkError('EIO');
          return value.stat(...statArgs);
        };
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
    await assert.rejects(() => ensureMemoryLayout(vault), assertGenericProbeError);
  } finally {
    fs.open = originalOpen;
    fs.link = originalLink;
  }
  assert.equal(statCalls, 2);
  assert.equal(linkCalls, 0);
  await assertOnlyEmptyLayout(vault);
});

test('a source replaced after recovery stat is preserved before cleanup', async t => {
  const { vault } = await temporaryVault(t);
  const originalOpen = fs.open;
  const originalLink = fs.link;
  const replacement = Buffer.from('replacement after recovered handle identity\n');
  let replacementPath;
  let statCalls = 0;
  let linkCalls = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const target = String(args[0]);
    if (path.basename(path.dirname(target)) !== 'locks'
        || !path.basename(target).endsWith('.source')) {
      return handle;
    }
    return new Proxy(handle, {
      get(value, property) {
        if (property === 'stat') return async (...statArgs) => {
          statCalls += 1;
          if (statCalls === 1) throw hardLinkError('EIO');
          return value.stat(...statArgs);
        };
        if (property === 'close') return async () => {
          await value.close();
          await fs.unlink(target);
          await fs.writeFile(target, replacement, { flag: 'wx', mode: 0o600 });
          replacementPath = target;
        };
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
    await assert.rejects(() => ensureMemoryLayout(vault), assertProbeIdentityError);
  } finally {
    fs.open = originalOpen;
    fs.link = originalLink;
  }
  assert.equal(statCalls, 2);
  assert.equal(linkCalls, 0);
  await assertNoPublishedMemoryState(vault);
  assert.deepEqual(await fs.readdir(path.dirname(replacementPath)), [path.basename(replacementPath)]);
  assert.deepEqual(await fs.readFile(replacementPath), replacement);
});

test('a permanent handle-stat failure makes one recovery attempt and preserves the unproven source', async t => {
  const { vault } = await temporaryVault(t);
  const originalOpen = fs.open;
  const originalLink = fs.link;
  let statCalls = 0;
  let linkCalls = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const target = String(args[0]);
    if (path.basename(path.dirname(target)) !== 'locks'
        || !path.basename(target).endsWith('.source')) {
      return handle;
    }
    return new Proxy(handle, {
      get(value, property) {
        if (property === 'stat') return async () => {
          statCalls += 1;
          throw hardLinkError('EIO');
        };
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
    await assert.rejects(() => ensureMemoryLayout(vault), assertGenericProbeError);
  } finally {
    fs.open = originalOpen;
    fs.link = originalLink;
  }
  assert.equal(statCalls, 2);
  assert.equal(linkCalls, 0);
  await assertNoPublishedMemoryState(vault);
  const locks = path.join(vault, '.safire', 'memory', 'v1', 'locks');
  const entries = await fs.readdir(locks);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\.hard-link-capability-[a-f0-9]+\.source$/);
  assert.equal((await fs.stat(path.join(locks, entries[0]))).size, 0);
});

test('post-link validation failures clean both identity-proven probe names', async t => {
  for (const stage of ['directory revalidation', 'source lstat', 'destination lstat']) {
    await t.test(stage, async subtest => {
      const { vault } = await temporaryVault(subtest);
      const locks = path.join(vault, '.safire', 'memory', 'v1', 'locks');
      const originalLink = fs.link;
      const originalLstat = fs.lstat;
      let linked = false;
      let injected = false;
      fs.link = async (...args) => {
        await originalLink(...args);
        linked = true;
      };
      fs.lstat = async (target, options) => {
        const targetPath = String(target);
        const shouldFail = linked && !injected && (
          (stage === 'directory revalidation' && path.resolve(targetPath) === path.resolve(locks))
          || (stage === 'source lstat' && path.basename(targetPath).endsWith('.source'))
          || (stage === 'destination lstat' && path.basename(targetPath).endsWith('.link'))
        );
        if (shouldFail) {
          injected = true;
          throw hardLinkError('EIO');
        }
        return originalLstat(target, options);
      };
      try {
        await assert.rejects(
          () => ensureMemoryLayout(vault),
          stage === 'directory revalidation' ? assertProbeDirectoryError : assertGenericProbeError,
        );
      } finally {
        fs.link = originalLink;
        fs.lstat = originalLstat;
      }
      assert.equal(linked, true);
      assert.equal(injected, true);
      await assertOnlyEmptyLayout(vault);
    });
  }
});

test('persistent post-link parent failure preserves both exact probe names and unrelated bytes', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const unrelatedPath = path.join(layout.locksDir, 'operator-owned.keep');
  const unrelated = Buffer.from('unrelated bytes survive persistent parent failure\n');
  await fs.writeFile(unrelatedPath, unrelated, { flag: 'wx', mode: 0o600 });
  const originalLink = fs.link;
  const originalLstat = fs.lstat;
  let linked = false;
  fs.link = async (...args) => {
    await originalLink(...args);
    linked = true;
  };
  fs.lstat = async (target, options) => {
    if (linked && path.resolve(String(target)) === path.resolve(layout.locksDir)) {
      throw hardLinkError('EIO');
    }
    return originalLstat(target, options);
  };
  try {
    await assert.rejects(
      () => assertHardLinkPublicationSupported(layout.locksDir),
      assertProbeDirectoryError,
    );
  } finally {
    fs.link = originalLink;
    fs.lstat = originalLstat;
  }
  assert.equal(linked, true);
  assert.deepEqual(await fs.readFile(unrelatedPath), unrelated);
  const entries = await fs.readdir(layout.locksDir);
  const probeEntries = entries.filter(name => name.startsWith('.hard-link-capability-'));
  assert.equal(probeEntries.length, 2);
  assert.equal(probeEntries.some(name => name.endsWith('.source')), true);
  assert.equal(probeEntries.some(name => name.endsWith('.link')), true);
  const probeStats = await Promise.all(
    probeEntries.map(name => fs.lstat(path.join(layout.locksDir, name), { bigint: true })),
  );
  assert.equal(probeStats.every(stat => stat.isFile() && !stat.isSymbolicLink()), true);
  assert.equal(probeStats[0].dev, probeStats[1].dev);
  assert.equal(probeStats[0].ino, probeStats[1].ino);
  assert.equal(probeStats[0].nlink, 2n);
  assert.equal(probeStats[1].nlink, 2n);
  for (const name of probeEntries) {
    assert.equal(
      await fs.readFile(path.join(layout.locksDir, name), 'utf8'),
      'safire-memory-hard-link-capability-v1\n',
    );
  }
  await assertNoPublishedMemoryState(vault);
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
    await assert.rejects(() => ensureMemoryLayout(vault), assertProbeIdentityError);
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

test('an unproven source replacement after a resolved link is preserved fail closed', async t => {
  const { vault } = await temporaryVault(t);
  const originalLink = fs.link;
  const replacement = Buffer.from('operator-owned source replacement\n');
  let replacementPath;
  let injected = false;
  fs.link = async (source, destination) => {
    if (injected || path.basename(path.dirname(source)) !== 'locks') {
      return originalLink(source, destination);
    }
    injected = true;
    await originalLink(source, destination);
    await fs.unlink(source);
    await fs.writeFile(source, replacement, { flag: 'wx', mode: 0o600 });
    replacementPath = source;
  };
  try {
    await assert.rejects(() => ensureMemoryLayout(vault), assertProbeIdentityError);
  } finally {
    fs.link = originalLink;
  }
  await assertNoPublishedMemoryState(vault);
  assert.deepEqual(await fs.readdir(path.dirname(replacementPath)), [path.basename(replacementPath)]);
  assert.deepEqual(await fs.readFile(replacementPath), replacement);
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
    await assert.rejects(() => ensureMemoryLayout(vault), assertProbeIdentityError);
  } finally {
    fs.link = originalLink;
  }
  await assertNoPublishedMemoryState(vault);
  assert.deepEqual(await fs.readdir(path.dirname(replacementPath)), [path.basename(replacementPath)]);
  assert.deepEqual(await fs.readFile(replacementPath), replacement);
});

test('repeated unproven failures preserve prior replacement and unrelated bytes', async t => {
  const { vault } = await temporaryVault(t);
  const layout = await ensureMemoryLayout(vault);
  const unrelatedPath = path.join(layout.locksDir, 'operator-owned.keep');
  const unrelated = Buffer.from('unrelated operator bytes\n');
  const replacement = Buffer.from('prior replacement bytes\n');
  await fs.writeFile(unrelatedPath, unrelated, { flag: 'wx', mode: 0o600 });

  const originalLink = fs.link;
  let replacementPath;
  fs.link = async (source, destination) => {
    await originalLink(source, destination);
    await fs.unlink(destination);
    await fs.writeFile(destination, replacement, { flag: 'wx', mode: 0o600 });
    replacementPath = destination;
  };
  try {
    await assert.rejects(
      () => assertHardLinkPublicationSupported(layout.locksDir),
      assertProbeIdentityError,
    );
  } finally {
    fs.link = originalLink;
  }

  const originalOpen = fs.open;
  let statCalls = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const target = String(args[0]);
    if (!path.basename(target).endsWith('.source')) return handle;
    return new Proxy(handle, {
      get(value, property) {
        if (property === 'stat') return async () => {
          statCalls += 1;
          throw hardLinkError('EIO');
        };
        const member = value[property];
        return typeof member === 'function' ? member.bind(value) : member;
      },
    });
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => assertHardLinkPublicationSupported(layout.locksDir),
        assertGenericProbeError,
      );
    }
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(statCalls, 4);
  assert.deepEqual(await fs.readFile(unrelatedPath), unrelated);
  assert.deepEqual(await fs.readFile(replacementPath), replacement);
  const entries = await fs.readdir(layout.locksDir);
  const sources = entries.filter(name => name.endsWith('.source'));
  assert.equal(sources.length, 2);
  for (const source of sources) {
    assert.equal((await fs.stat(path.join(layout.locksDir, source))).size, 0);
  }
  assert.equal(entries.includes(path.basename(unrelatedPath)), true);
  assert.equal(entries.includes(path.basename(replacementPath)), true);
  await assertNoPublishedMemoryState(vault);
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

test('MCP redacts a generic initial handle-stat failure after proven cleanup', async t => {
  const { vault } = await temporaryVault(t);
  const handlers = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  };
  const store = createMemoryStore({ vaultDir: vault, profile: portableProfile() });
  registerMemoryMcpTools(server, store);
  const originalOpen = fs.open;
  let statCalls = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const target = String(args[0]);
    if (!path.basename(target).endsWith('.source')) return handle;
    return new Proxy(handle, {
      get(value, property) {
        if (property === 'stat') return async (...statArgs) => {
          statCalls += 1;
          if (statCalls === 1) throw hardLinkError('EIO');
          return value.stat(...statArgs);
        };
        const member = value[property];
        return typeof member === 'function' ? member.bind(value) : member;
      },
    });
  };
  let result;
  try {
    result = await handlers.get('memory_status')({});
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(statCalls, 2);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: {
      code: 'MEMORY_REQUEST_FAILED',
      message: 'Safire memory request failed',
    },
  });
  assert.doesNotMatch(result.content[0].text, /[A-Z]:\\|cause|EIO|synthetic|hard-link-capability/i);
  await assertOnlyEmptyLayout(vault);
});
