import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createNoteMutator,
  listContainedFiles,
  readContainedFile,
} from '../lib/note-mutations.mjs';
import { createNotesMcpService, publicNotesMcpError } from '../lib/notes-mcp-service.mjs';

async function withVault(t, run) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-note-mutation-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return run(vault);
}

async function backupFiles(vault) {
  const root = path.join(vault, '.safire-backups');
  return (await listContainedFiles(vault, root)).filter((item) => item.relativePath.endsWith('.bak'));
}

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
        if (String(destination).endsWith('.bak')) return fs.rename(source, destination);
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
