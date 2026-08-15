import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertUserMutationPath,
  createNoteMutator,
  listContainedFiles,
  readBackupMetadata,
  readBackupMetadataForIndex,
  readContainedFile,
} from '../lib/note-mutations.mjs';
import { createNotesMcpService, publicNotesMcpError } from '../lib/notes-mcp-service.mjs';

const MUTATION_WORKER = fileURLToPath(new URL('../test-support/note-mutation-worker.mjs', import.meta.url));
const IPC_BARRIER_TIMEOUT_MS = 10_000;

async function boundedBarrier(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), IPC_BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sameResolvedPath(left, right) {
  const resolvedLeft = path.normalize(path.resolve(left));
  const resolvedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight;
}

async function withVault(t, run) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-note-mutation-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return run(vault);
}

async function backupFiles(vault) {
  const root = path.join(vault, '.safire-backups');
  return (await listContainedFiles(vault, root)).filter((item) => item.relativePath.endsWith('.bak'));
}

function mutationWorker(t, vault, note, label, { hold = false } = {}) {
  const child = fork(MUTATION_WORKER, [vault, note, label, hold ? '1' : '0'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages = [];
  const waiters = [];
  let stderr = '';
  child.on('message', (message) => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.types.has(message?.type));
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    else messages.push(message);
  });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`mutation worker exited before ${[...waiter.types].join('/')} (code=${code}, signal=${signal}): ${stderr}`));
    }
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return {
    child,
    send(message) { child.send(message); },
    next(...types) {
      const queuedIndex = messages.findIndex((message) => types.includes(message?.type));
      if (queuedIndex >= 0) return Promise.resolve(messages.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { types: new Set(types), resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for mutation worker ${types.join('/')} barrier: ${stderr}`));
        }, IPC_BARRIER_TIMEOUT_MS);
        waiters.push(waiter);
      });
    },
    exited() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for mutation worker exit: ${stderr}`)), IPC_BARRIER_TIMEOUT_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

test('cross-process note updates serialize before snapshot and preserve both successful writes', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Cross Process.md');
    await fs.writeFile(note, 'initial\n', 'utf8');
    const first = mutationWorker(t, vault, note, 'first', { hold: true });
    assert.equal((await first.next('ready')).type, 'ready');
    first.send('start');
    assert.deepEqual(await first.next('transform'), { type: 'transform', content: 'initial\n' });

    const second = mutationWorker(t, vault, note, 'second');
    assert.equal((await second.next('ready')).type, 'ready');
    second.send('start');
    const secondBeforeRelease = await second.next('contended', 'transform', 'done', 'error');
    assert.equal(secondBeforeRelease.type, 'contended');

    first.send('release');
    assert.equal((await first.next('done', 'error')).type, 'done');
    assert.deepEqual(await second.next('transform'), { type: 'transform', content: 'initial\nfirst\n' });
    assert.equal((await second.next('done', 'error')).type, 'done');
    await Promise.all([first.exited(), second.exited()]);
    assert.equal(await fs.readFile(note, 'utf8'), 'initial\nfirst\nsecond\n');

    const backups = await backupFiles(vault);
    assert.equal(backups.length, 2);
    assert.deepEqual(
      new Set(await Promise.all(backups.map((item) => fs.readFile(path.join(vault, '.safire-backups', item.relativePath), 'utf8')))),
      new Set(['initial\n', 'initial\nfirst\n']),
    );
  });
});

test('a crashed cross-process owner leaves a fail-closed gate that is never stolen automatically', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Crash Protected.md');
    await fs.writeFile(note, 'protected\n', 'utf8');
    const owner = mutationWorker(t, vault, note, 'must-not-commit', { hold: true });
    await owner.next('ready');
    owner.send('start');
    await owner.next('transform');
    owner.child.kill('SIGKILL');
    await owner.exited();

    const lockDirectory = path.join(vault, '.safire-note-mutations.lock');
    assert.equal((await fs.lstat(lockDirectory)).isDirectory(), true);
    assert.equal((await fs.readdir(lockDirectory)).length, 1);
    const contender = createNoteMutator({ vaultDir: vault, lockOptions: { timeoutMs: 0 } });
    await assert.rejects(() => contender.replace(note, 'replacement\n'), { code: 'EBUSY' });
    assert.equal(await fs.readFile(note, 'utf8'), 'protected\n');
    assert.deepEqual(await backupFiles(vault), []);
  });
});

test('shared mutation policy reserves exact Safire control-directory components only', () => {
  const vault = path.resolve(os.tmpdir(), 'safire-reserved-policy-fixture');
  for (const relativePath of [
    '.safire/Settings.md',
    'Nested/.safire/Settings.md',
    '.safire-backups/Backup.md',
    'Nested/.safire-backups/Backup.md',
    '.safire-note-mutations.lock/Owner.md',
    'Nested/.safire-note-mutations.lock/Owner.md',
  ]) {
    assert.throws(
      () => assertUserMutationPath(vault, path.join(vault, relativePath)),
      (error) => error?.code === 'SAFIRE_RESERVED_PATH'
        && error.message === 'Safire internal paths are reserved'
        && !error.message.includes(relativePath),
    );
  }

  for (const relativePath of [
    '.safire-notes/Allowed.md',
    '.safire-backups-old/Allowed.md',
    '.safire-note-mutations.locked/Allowed.md',
  ]) {
    assert.doesNotThrow(() => assertUserMutationPath(vault, path.join(vault, relativePath)));
  }

  if (process.platform === 'win32') {
    for (const relativePath of [
      '.SAFIRE/Settings.md',
      '.safire-backups./Backup.md',
      '.SAFIRE-NOTE-MUTATIONS.LOCK /Owner.md',
      'SAFIRE~1.LOC/Owner.md',
      '.safire-note-mutations.lock::$INDEX_ALLOCATION/Owner.md',
    ]) {
      assert.throws(
        () => assertUserMutationPath(vault, path.join(vault, relativePath)),
        { code: 'SAFIRE_RESERVED_PATH' },
      );
    }
  }
});

test('reserved Safire control paths reject every core mutation before lock acquisition', async (t) => {
  await withVault(t, async (vault) => {
    const lockDirectory = path.join(vault, '.safire-note-mutations.lock');
    let lockAcquisitionAttempts = 0;
    const observingFs = {
      ...fs,
      async mkdir(target, options) {
        if (sameResolvedPath(target, lockDirectory)) lockAcquisitionAttempts += 1;
        return fs.mkdir(target, options);
      },
    };
    const mutator = createNoteMutator({
      vaultDir: vault,
      fsApi: observingFs,
      lockOptions: { timeoutMs: 0 },
    });

    async function assertCleanRejection(operation, requestedPath, ordinaryName) {
      const attemptsBefore = lockAcquisitionAttempts;
      await assert.rejects(operation, { code: 'SAFIRE_RESERVED_PATH' });
      assert.equal(lockAcquisitionAttempts, attemptsBefore);
      await assert.rejects(() => fs.access(requestedPath), { code: 'ENOENT' });
      await assert.rejects(() => fs.access(lockDirectory), { code: 'ENOENT' });
      const ordinaryPath = path.join(vault, ordinaryName);
      await mutator.create(ordinaryPath, 'ordinary');
      assert.equal(lockAcquisitionAttempts, attemptsBefore + 1);
      assert.equal(await fs.readFile(ordinaryPath, 'utf8'), 'ordinary');
      await assert.rejects(() => fs.access(lockDirectory), { code: 'ENOENT' });
    }

    await assertCleanRejection(
      () => mutator.create(path.join(lockDirectory, 'Poison.md'), 'synthetic'),
      path.join(lockDirectory, 'Poison.md'),
      'After rejected create.md',
    );

    const noteSource = path.join(vault, 'Rename source.md');
    await fs.writeFile(noteSource, 'source', 'utf8');
    const noteDestination = path.join(vault, 'Nested', '.safire-note-mutations.lock', 'Poison.md');
    await assertCleanRejection(
      () => mutator.rename(noteSource, noteDestination),
      noteDestination,
      'After rejected note rename.md',
    );
    assert.equal(await fs.readFile(noteSource, 'utf8'), 'source');

    const reservedFolder = path.join(vault, 'Nested', '.safire-note-mutations.lock');
    await assertCleanRejection(
      () => mutator.ensureFolder(reservedFolder),
      reservedFolder,
      'After rejected folder create.md',
    );

    const folderSource = path.join(vault, 'Folder source');
    await fs.mkdir(folderSource);
    const folderDestination = path.join(vault, '.safire-note-mutations.lock', 'Poison folder');
    await assertCleanRejection(
      () => mutator.renameFolder(folderSource, folderDestination),
      folderDestination,
      'After rejected folder rename.md',
    );
    assert.equal((await fs.lstat(folderSource)).isDirectory(), true);

    if (process.platform === 'win32') {
      for (const unsafeAlias of [
        path.join(vault, 'SAFIRE~1.LOC', 'Poison.md'),
        path.join(vault, '.safire-note-mutations.lock::$INDEX_ALLOCATION', 'Poison.md'),
      ]) {
        await assertCleanRejection(
          () => mutator.create(unsafeAlias, 'synthetic alias poison'),
          unsafeAlias,
          `After rejected Windows alias ${path.basename(path.dirname(unsafeAlias)).replaceAll(':', '-')}.md`,
        );
      }
      assert.doesNotThrow(() => assertUserMutationPath(vault, path.join(vault, 'Project~2026', 'Allowed.md')));
    }
  });
});

test('malformed and replaced lock owners remain held and are never cleaned by pathname', async (t) => {
  await withVault(t, async (vault) => {
    const malformedGate = path.join(vault, '.safire-note-mutations.lock');
    const unexpected = path.join(malformedGate, 'unexpected.keep');
    await fs.mkdir(malformedGate);
    await fs.writeFile(unexpected, 'operator bytes', 'utf8');
    const blocked = createNoteMutator({ vaultDir: vault, lockOptions: { timeoutMs: 0 } });
    await assert.rejects(() => blocked.create(path.join(vault, 'Blocked.md'), 'blocked'), { code: 'EBUSY' });
    assert.equal(await fs.readFile(unexpected, 'utf8'), 'operator bytes');
    await fs.unlink(unexpected);
    await fs.rmdir(malformedGate);

    const note = path.join(vault, 'Replacement Protected.md');
    let replacementPath;
    let injected = false;
    const replacementFs = {
      ...fs,
      async open(target, flags, mode) {
        if (!injected && flags === 'r' && /^owner-[A-Za-z0-9_-]+\.json$/.test(path.basename(String(target)))) {
          injected = true;
          replacementPath = String(target);
          await fs.unlink(target);
          await fs.writeFile(target, 'successor owner bytes', { encoding: 'utf8', flag: 'wx' });
        }
        return fs.open(target, flags, mode);
      },
    };
    const replaced = createNoteMutator({ vaultDir: vault, fsApi: replacementFs });
    await assert.rejects(() => replaced.create(note, 'committed before ownership replacement'), { code: 'EBUSY' });
    assert.equal(injected, true);
    assert.equal(await fs.readFile(note, 'utf8'), 'committed before ownership replacement');
    assert.equal(await fs.readFile(replacementPath, 'utf8'), 'successor owner bytes');
    assert.equal((await fs.lstat(malformedGate)).isDirectory(), true);
  });
});

test('successful lock rmdir is the release commit point with no failing pathname check afterward', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Release Commit.md');
    let releaseCommitted = false;
    const faultAfterReleaseFs = {
      ...fs,
      async rmdir(target) {
        const result = await fs.rmdir(target);
        if (sameResolvedPath(target, path.join(vault, '.safire-note-mutations.lock'))) releaseCommitted = true;
        return result;
      },
      async lstat(target, options) {
        if (releaseCommitted) throw Object.assign(new Error('synthetic post-release diagnostic failure'), { code: 'EIO' });
        return fs.lstat(target, options);
      },
    };
    const mutator = createNoteMutator({ vaultDir: vault, fsApi: faultAfterReleaseFs });
    await assert.doesNotReject(() => mutator.create(note, 'committed'));
    assert.equal(releaseCommitted, true);
    assert.equal(await fs.readFile(note, 'utf8'), 'committed');
  });
});

test('a contender cannot acquire an empty gate before the prior owner finalizes nonrecursive release', async (t) => {
  await withVault(t, async (vault) => {
    const lockPath = path.join(path.resolve(vault), '.safire-note-mutations.lock');
    let markReleaseStarted;
    const releaseStarted = new Promise((resolve) => { markReleaseStarted = resolve; });
    let finishRelease;
    const releaseGate = new Promise((resolve) => { finishRelease = resolve; });
    let markContended;
    const contenderObserved = new Promise((resolve) => { markContended = resolve; });
    let holdFirstRelease = true;
    const gatedFs = {
      ...fs,
      async mkdir(target, options) {
        try {
          return await fs.mkdir(target, options);
        } catch (error) {
          if (error?.code === 'EEXIST' && sameResolvedPath(target, lockPath)) markContended();
          throw error;
        }
      },
      async rmdir(target) {
        if (holdFirstRelease && sameResolvedPath(target, lockPath)) {
          holdFirstRelease = false;
          markReleaseStarted();
          await releaseGate;
        }
        return fs.rmdir(target);
      },
    };
    const firstMutator = createNoteMutator({ vaultDir: vault, fsApi: gatedFs });
    const secondMutator = createNoteMutator({ vaultDir: vault, fsApi: gatedFs });
    const first = firstMutator.create(path.join(vault, 'First.md'), 'first');
    await boundedBarrier(releaseStarted, 'the prior owner release barrier');
    const second = secondMutator.create(path.join(vault, 'Second.md'), 'second');
    try {
      await boundedBarrier(contenderObserved, 'the empty-gate contention barrier');
    } finally {
      finishRelease();
    }
    await Promise.all([first, second]);
    assert.equal(await fs.readFile(path.join(vault, 'First.md'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(vault, 'Second.md'), 'utf8'), 'second');
    await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
  });
});

test('ordinary uncapped replace, remove, and contained reads remain supported', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Ordinary.md');
    const mutator = createNoteMutator({ vaultDir: vault });
    await mutator.create(note, 'first');
    await mutator.replace(note, 'second');
    assert.equal(await readContainedFile(vault, note, 'utf8'), 'second');
    await mutator.remove(note);
    await assert.rejects(() => fs.access(note), { code: 'ENOENT' });
  });
});

test('versioned backup identities distinguish folders from literal double underscores', async (t) => {
  await withVault(t, async (vault) => {
    const paths = ['Folder/A__B.md', 'Folder__A__B.md'];
    const mutator = createNoteMutator({ vaultDir: vault, now: () => 1234, randomId: () => 'fixed' });
    for (const relativePath of paths) {
      const note = path.join(vault, relativePath);
      await fs.mkdir(path.dirname(note), { recursive: true });
      await mutator.create(note, `original ${relativePath}`);
      await mutator.replace(note, `replacement ${relativePath}`);
    }
    const backups = await backupFiles(vault);
    assert.equal(backups.length, 2);
    assert.equal(backups.every((item) => path.basename(item.relativePath) === 'content.bak'), true);
    assert.equal(backups.every((item) => item.relativePath.split('/').every((component) => component.length < 128)), true);
    const metadata = await Promise.all(backups.map((item) => (
      readBackupMetadata(vault, path.join(vault, '.safire-backups', item.relativePath))
    )));
    assert.deepEqual(new Set(metadata.map((item) => item.notePath)), new Set(paths));
  });
});

test('legacy ambiguous and malformed versioned backup ids never infer a restore destination', async (t) => {
  await withVault(t, async (vault) => {
  const ambiguous = await readBackupMetadata(vault, path.join(vault, '.safire-backups', '2026-08-15', 'Folder__A__B.md.1234.fixed.bak'));
  assert.deepEqual(
    { notePath: ambiguous.notePath, legacy: ambiguous.legacy, requiresExplicitPath: ambiguous.requiresExplicitPath },
    { notePath: null, legacy: true, requiresExplicitPath: true },
  );
  assert.equal((await readBackupMetadata(vault, path.join(vault, '.safire-backups', '2026-08-15', 'Simple.md.1234.fixed.bak'))).notePath, 'Simple.md');

  const namespace = path.join(vault, '.safire-backups', '2026-08-15', '.safire-backup-invalid');
  await fs.mkdir(namespace, { recursive: true });
  await fs.writeFile(path.join(namespace, 'content.bak'), 'content', 'utf8');
  for (const notePath of ['../Escape.md', '/Absolute.md', 'Folder\\Alias.md']) {
    await fs.writeFile(path.join(namespace, 'metadata.json'), JSON.stringify({
      format: 'safire-note-backup/v2',
      namespace: path.basename(namespace),
      notePath,
      createdAt: 1234,
      byteLength: 7,
      contentSha256: createHash('sha256').update('content').digest('hex'),
    }));
    const metadata = await readBackupMetadata(vault, path.join(namespace, 'content.bak'));
    assert.equal(metadata.notePath, null);
    assert.equal(metadata.requiresExplicitPath, true);
  }
  });
});

test('concurrent same-path creates accept exactly one complete note', async (t) => {
  await withVault(t, async (vault) => {
    const service = await createNotesMcpService({ vaultDir: vault });
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, (_value, index) => service.createNote('Race.md', `writer-${index}\n`)),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason?.code === 'EEXIST').length, 31);
    assert.match(await fs.readFile(path.join(vault, 'Race.md'), 'utf8'), /^writer-\d+\n$/);
  });
});

test('concurrent updates are serialized and preserve every accepted predecessor', async (t) => {
  await withVault(t, async (vault) => {
    const service = await createNotesMcpService({ vaultDir: vault });
    await service.createNote('Race.md', 'initial\n');
    const writes = Array.from({ length: 32 }, (_value, index) => `update-${index}\n`);
    const results = await Promise.allSettled(writes.map((content) => service.updateNote('Race.md', content)));
    assert.equal(results.every((result) => result.status === 'fulfilled'), true);
    assert.equal(await fs.readFile(path.join(vault, 'Race.md'), 'utf8'), writes.at(-1));

    const backups = await backupFiles(vault);
    assert.equal(backups.length, writes.length);
    assert.equal(backups.every((item) => item.size > 0), true);
    const contents = await Promise.all(backups.map((item) => fs.readFile(path.join(vault, '.safire-backups', item.relativePath), 'utf8')));
    assert.deepEqual(new Set(contents), new Set(['initial\n', ...writes.slice(0, -1)]));
  });
});

test('update and task toggle share the same per-note mutation queue', async (t) => {
  await withVault(t, async (vault) => {
    const service = await createNotesMcpService({ vaultDir: vault });
    await service.createNote('Tasks.md', '- [ ] first\n');
    const [update, toggle] = await Promise.all([
      service.updateNote('Tasks.md', '- [ ] replacement\n'),
      service.toggleTask('Tasks.md', 1),
    ]);
    assert.equal(update.ok, true);
    assert.equal(toggle.ok, true);
    assert.equal(await fs.readFile(path.join(vault, 'Tasks.md'), 'utf8'), '- [x] replacement\n');
    const backups = await backupFiles(vault);
    assert.equal(backups.length, 2);
    const contents = await Promise.all(backups.map((item) => fs.readFile(path.join(vault, '.safire-backups', item.relativePath), 'utf8')));
    assert.deepEqual(new Set(contents), new Set(['- [ ] first\n', '- [ ] replacement\n']));
  });
});

test('fixed timestamps and random tokens cannot collide backup publication', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Fixed.md');
    const mutator = createNoteMutator({ vaultDir: vault, now: () => 1234, randomId: () => 'fixed' });
    await mutator.create(note, 'version-0');
    for (let index = 1; index <= 8; index += 1) await mutator.replace(note, `version-${index}`);
    const backups = await backupFiles(vault);
    assert.equal(backups.length, 8);
    assert.equal(new Set(backups.map((item) => item.relativePath)).size, 8);
    assert.deepEqual(
      new Set(await Promise.all(backups.map((item) => fs.readFile(path.join(vault, '.safire-backups', item.relativePath), 'utf8')))),
      new Set(Array.from({ length: 8 }, (_value, index) => `version-${index}`)),
    );
  });
});

test('per-note mutation queues are bounded and drain after rejected work', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Busy.md');
    await fs.writeFile(note, 'unchanged', 'utf8');
    const mutator = createNoteMutator({ vaultDir: vault });
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let isFirst = true;
    const operation = () => mutator.mutate(note, async () => {
      if (isFirst) {
        isFirst = false;
        markStarted();
        await firstGate;
      }
      throw new Error('synthetic queued stop');
    });
    const accepted = Array.from({ length: 64 }, operation);
    await started;
    await assert.rejects(operation, { code: 'EBUSY' });
    releaseFirst();
    const settled = await Promise.allSettled(accepted);
    assert.equal(settled.every((result) => result.status === 'rejected'), true);
    assert.equal(mutator.pendingCount(), 0);
    assert.equal(await fs.readFile(note, 'utf8'), 'unchanged');
  });
});

test('replace requires an existing note and cannot turn a missing update into creation', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Missing.md');
    const mutator = createNoteMutator({ vaultDir: vault });
    await assert.rejects(() => mutator.replace(note, 'must not appear'), { code: 'ENOENT' });
    await assert.rejects(() => fs.access(note), { code: 'ENOENT' });
    assert.deepEqual(await backupFiles(vault), []);
  });
});

test('multi-key coordination makes create and rename mutually exclusive in either order', async (t) => {
  await withVault(t, async (vault) => {
    async function scenario(createFirst) {
      const suffix = createFirst ? 'create-first' : 'rename-first';
      const source = path.join(vault, `Source-${suffix}.md`);
      const destination = path.join(vault, `Destination-${suffix}.md`);
      await fs.writeFile(source, `source-${suffix}`, 'utf8');
      let releaseDestination;
      const destinationGate = new Promise((resolve) => { releaseDestination = resolve; });
      let markDestinationOpen;
      const destinationOpenStarted = new Promise((resolve) => { markDestinationOpen = resolve; });
      let gateFirstDestinationOpen = true;
      const gatedFs = {
        ...fs,
        async open(target, flags, mode) {
          if (gateFirstDestinationOpen && path.resolve(target) === path.resolve(destination) && flags === 'wx') {
            gateFirstDestinationOpen = false;
            markDestinationOpen();
            await destinationGate;
          }
          return fs.open(target, flags, mode);
        },
      };
      const mutator = createNoteMutator({ vaultDir: vault, fsApi: gatedFs });
      const first = createFirst
        ? mutator.create(destination, `created-${suffix}`)
        : mutator.rename(source, destination);
      await destinationOpenStarted;
      const second = createFirst
        ? mutator.rename(source, destination)
        : mutator.create(destination, `created-${suffix}`);
      releaseDestination();
      const [firstResult, secondResult] = await Promise.allSettled([first, second]);
      assert.equal(firstResult.status, 'fulfilled');
      assert.equal(secondResult.status, 'rejected');
      assert.equal(secondResult.reason?.code, 'EEXIST');
      if (createFirst) {
        assert.equal(await fs.readFile(destination, 'utf8'), `created-${suffix}`);
        assert.equal(await fs.readFile(source, 'utf8'), `source-${suffix}`);
      } else {
        assert.equal(await fs.readFile(destination, 'utf8'), `source-${suffix}`);
        await assert.rejects(() => fs.access(source), { code: 'ENOENT' });
      }
      assert.equal(mutator.pendingCount(), 0);
    }

    await scenario(true);
    await scenario(false);
  });
});

test('failed source removal rolls back only the destination owned by rename', async (t) => {
  await withVault(t, async (vault) => {
    const source = path.join(vault, 'Rollback Source.md');
    const destination = path.join(vault, 'Rollback Destination.md');
    await fs.writeFile(source, 'source bytes', 'utf8');
    const failingFs = {
      ...fs,
      async unlink(target) {
        if (path.resolve(target) === path.resolve(source)) {
          const error = new Error('synthetic source unlink failure');
          error.code = 'EACCES';
          throw error;
        }
        return fs.unlink(target);
      },
    };
    const mutator = createNoteMutator({ vaultDir: vault, fsApi: failingFs });
    await assert.rejects(() => mutator.rename(source, destination), { code: 'EACCES' });
    assert.equal(await fs.readFile(source, 'utf8'), 'source bytes');
    await assert.rejects(() => fs.access(destination), { code: 'ENOENT' });

    const successorSource = path.join(vault, 'Successor Source.md');
    const successorDestination = path.join(vault, 'Successor Destination.md');
    await fs.writeFile(successorSource, 'second source bytes', 'utf8');
    const replacementFs = {
      ...fs,
      async unlink(target) {
        if (path.resolve(target) === path.resolve(successorSource)) {
          await fs.unlink(successorDestination);
          await fs.writeFile(successorDestination, 'successor owner bytes', { encoding: 'utf8', flag: 'wx' });
          const error = new Error('synthetic source unlink failure after replacement');
          error.code = 'EACCES';
          throw error;
        }
        return fs.unlink(target);
      },
    };
    const replacementMutator = createNoteMutator({ vaultDir: vault, fsApi: replacementFs });
    await assert.rejects(() => replacementMutator.rename(successorSource, successorDestination), { code: 'EACCES' });
    assert.equal(await fs.readFile(successorSource, 'utf8'), 'second source bytes');
    assert.equal(await fs.readFile(successorDestination, 'utf8'), 'successor owner bytes');
  });
});

test('folder rename waits for descendant note publication and cannot strand a failed copy', async (t) => {
  await withVault(t, async (vault) => {
    const sourceNote = path.join(vault, 'Outside Source.md');
    const destinationFolder = path.join(vault, 'Destination Folder');
    const movedFolder = path.join(vault, 'Moved Folder');
    const destinationNote = path.join(destinationFolder, 'Moved Note.md');
    await fs.writeFile(sourceNote, 'source note bytes', 'utf8');
    await fs.mkdir(destinationFolder);
    let releaseDestination;
    const gate = new Promise((resolve) => { releaseDestination = resolve; });
    let markStarted;
    const destinationOpenStarted = new Promise((resolve) => { markStarted = resolve; });
    let held = false;
    const gatedFs = {
      ...fs,
      async open(target, flags, mode) {
        if (!held && flags === 'wx' && path.resolve(target) === path.resolve(destinationNote)) {
          held = true;
          markStarted();
          await gate;
        }
        return fs.open(target, flags, mode);
      },
    };
    const mutator = createNoteMutator({ vaultDir: vault, fsApi: gatedFs });
    const noteRename = mutator.rename(sourceNote, destinationNote);
    await destinationOpenStarted;
    const folderRename = mutator.renameFolder(destinationFolder, movedFolder);
    releaseDestination();
    const [noteResult, folderResult] = await Promise.all([noteRename, folderRename]);
    assert.equal(noteResult.to, 'Destination Folder/Moved Note.md');
    assert.equal(folderResult.to, 'Moved Folder');
    assert.equal(await fs.readFile(path.join(movedFolder, 'Moved Note.md'), 'utf8'), 'source note bytes');
    await assert.rejects(() => fs.access(sourceNote), { code: 'ENOENT' });
    await assert.rejects(() => fs.access(destinationFolder), { code: 'ENOENT' });
    assert.equal(mutator.pendingCount(), 0);
  });
});

test('backup write failure preserves the note and removes provably owned partial output', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Protected.md');
    await fs.writeFile(note, 'protected bytes', 'utf8');
    let injected = false;
    const failingFs = {
      ...fs,
      async open(target, flags, mode) {
        const handle = await fs.open(target, flags, mode);
        if (!injected && String(target).endsWith('.safire-backup-write.tmp')) {
          injected = true;
          return new Proxy(handle, {
            get(object, property) {
              if (property === 'writeFile') return async (data) => {
                await object.writeFile(Buffer.from(data).subarray(0, 3));
                const error = new Error('synthetic backup failure');
                error.code = 'EIO';
                throw error;
              };
              const value = object[property];
              return typeof value === 'function' ? value.bind(object) : value;
            },
          });
        }
        return handle;
      },
    };
    const mutator = createNoteMutator({ vaultDir: vault, fsApi: failingFs, randomId: () => 'failure' });
    await assert.rejects(() => mutator.replace(note, 'replacement bytes'), { code: 'EIO' });
    assert.equal(await fs.readFile(note, 'utf8'), 'protected bytes');
    assert.deepEqual(await backupFiles(vault), []);
    const syntheticError = Object.assign(new Error(`synthetic backup failure at ${note}`), { code: 'EIO' });
    const publicMessage = publicNotesMcpError(syntheticError, vault);
    assert.equal(publicMessage, 'Safire could not complete the requested file operation');
    assert.equal(publicMessage.includes(path.resolve(vault)), false);
  });
});

test('replacement failure preserves the note and leaves only a complete safety backup', async (t) => {
  await withVault(t, async (vault) => {
    const note = path.join(vault, 'Protected.md');
    await fs.writeFile(note, 'protected bytes', 'utf8');
    const failingFs = {
      ...fs,
      async rename(source, destination) {
        if (String(destination).includes(`${path.sep}.safire-backups${path.sep}`)) return fs.rename(source, destination);
        const error = new Error('synthetic replacement failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const mutator = createNoteMutator({ vaultDir: vault, fsApi: failingFs, randomId: () => 'failure' });
    await assert.rejects(() => mutator.replace(note, 'replacement bytes'), { code: 'EIO' });
    assert.equal(await fs.readFile(note, 'utf8'), 'protected bytes');
    const backups = await backupFiles(vault);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].size, Buffer.byteLength('protected bytes'));
    assert.equal(await fs.readFile(path.join(vault, '.safire-backups', backups[0].relativePath), 'utf8'), 'protected bytes');
    assert.deepEqual((await fs.readdir(vault)).filter((name) => name.includes('.safire-write-')), []);
  });
});

test('contained backup helpers reject a junction root without reading outside data', async (t) => {
  await withVault(t, async (vault) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-note-mutation-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const sentinel = path.join(outside, 'outside-sentinel.bak');
    await fs.writeFile(sentinel, 'outside sentinel', 'utf8');
    try {
      await fs.symlink(outside, path.join(vault, '.safire-backups'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`directory links are unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(() => listContainedFiles(vault, path.join(vault, '.safire-backups')), /symlinks or junctions/);
    await assert.rejects(() => readContainedFile(vault, path.join(vault, '.safire-backups', 'outside-sentinel.bak')), /symlinks or junctions/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside sentinel');
  });
});

test('bounded backup metadata reads probe one byte beyond the opened-handle snapshot', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-backup-growth-probe-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  const namespace = path.join(vault, '.safire-backups', 'probe');
  await fs.mkdir(namespace, { recursive: true });
  const metadataPath = path.join(namespace, 'metadata.json');
  const contentPath = path.join(namespace, 'content.bak');
  await fs.writeFile(metadataPath, 'x');
  await fs.writeFile(contentPath, '');
  const metadataStat = await fs.stat(metadataPath, { bigint: true });
  let readFileCalled = false;
  const fsApi = {
    ...fs,
    async open(candidate, flags) {
      if (path.resolve(candidate) !== path.resolve(metadataPath)) return fs.open(candidate, flags);
      return {
        async stat() { return metadataStat; },
        async read(buffer) {
          buffer.fill(0x78);
          return { bytesRead: Number(metadataStat.size) + 1 };
        },
        async readFile() {
          readFileCalled = true;
          throw new Error('bounded reads must not call readFile');
        },
        async close() {},
      };
    },
  };

  const result = await readBackupMetadataForIndex(vault, contentPath, { fsApi, maxMetadataBytes: 100 });
  assert.equal(result.contentOmitted, true);
  assert.equal(result.attemptFailed, true);
  assert.equal(result.bytesConsumed, 0);
  assert.equal(readFileCalled, false);
});

test('bounded backup metadata accounting fails closed after a post-read identity change', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-backup-identity-probe-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  const namespace = path.join(vault, '.safire-backups', 'probe');
  await fs.mkdir(namespace, { recursive: true });
  const metadataPath = path.join(namespace, 'metadata.json');
  const contentPath = path.join(namespace, 'content.bak');
  await fs.writeFile(metadataPath, 'x');
  await fs.writeFile(contentPath, '');
  const metadataStat = await fs.stat(metadataPath, { bigint: true });
  let statCalls = 0;
  const changedStat = { ...metadataStat, ino: metadataStat.ino + 1n, isFile: () => true };
  const fsApi = {
    ...fs,
    async open(candidate, flags) {
      if (path.resolve(candidate) !== path.resolve(metadataPath)) return fs.open(candidate, flags);
      return {
        async stat() {
          statCalls += 1;
          return statCalls === 1 ? metadataStat : changedStat;
        },
        async read(buffer) {
          buffer[0] = 0x78;
          return { bytesRead: 1 };
        },
        async close() {},
      };
    },
  };

  const result = await readBackupMetadataForIndex(vault, contentPath, { fsApi, maxMetadataBytes: 100 });
  assert.equal(result.attemptFailed, true);
  assert.equal(result.bytesConsumed, 0);
  assert.equal(result.contentOmitted, true);
});
