import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BACKUP_DIRECTORY = '.safire-backups';
const MAX_NAME_ATTEMPTS = 128;
const MAX_ACTIVE_NOTE_KEYS = 1024;
const MAX_PENDING_PER_NOTE = 64;

function slash(value) {
  return String(value).replace(/\\/g, '/');
}

function pathKey(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function sameIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs,
  );
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function containmentError() {
  return new Error('Vault paths cannot use symlinks or junctions');
}

function changedError() {
  return new Error('The note changed during the requested operation');
}

function assertInside(vaultDir, absolutePath) {
  const vault = path.resolve(vaultDir);
  const target = path.resolve(absolutePath);
  const relative = path.relative(vault, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes vault');
  return { vault, target, relative };
}

export async function assertContainedPath(vaultDir, absolutePath, { allowMissing = false, fsApi = fs } = {}) {
  const { vault, target, relative } = assertInside(vaultDir, absolutePath);
  let current = vault;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fsApi.lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) throw containmentError();
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function createCoordinator() {
  const queues = new Map();
  function busyError() {
    const error = new Error('Safire is busy with note changes; try again');
    error.code = 'EBUSY';
    return error;
  }
  return {
    async runMany(keys, operation) {
      const normalizedKeys = [...new Set(keys.map(pathKey))].sort((left, right) => left.localeCompare(right));
      if (!normalizedKeys.length) throw new Error('At least one note key is required');
      const missingKeys = normalizedKeys.filter((key) => !queues.has(key));
      if (queues.size + missingKeys.length > MAX_ACTIVE_NOTE_KEYS) throw busyError();
      const entries = normalizedKeys.map((key) => queues.get(key) || { key, tail: Promise.resolve(), pending: 0 });
      if (entries.some((entry) => entry.pending >= MAX_PENDING_PER_NOTE)) throw busyError();
      for (const entry of entries) {
        if (!queues.has(entry.key)) queues.set(entry.key, entry);
        entry.pending += 1;
      }
      const predecessors = [...new Set(entries.map((entry) => entry.tail))];
      const current = Promise.all(predecessors.map((predecessor) => predecessor.catch(() => {}))).then(operation);
      for (const entry of entries) entry.tail = current;
      try {
        return await current;
      } finally {
        for (const entry of entries) {
          entry.pending -= 1;
          if (entry.tail === current && entry.pending === 0) queues.delete(entry.key);
        }
      }
    },
    async run(key, operation) {
      return this.runMany([key], operation);
    },
    size() {
      return queues.size;
    },
  };
}

async function closeQuietly(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The original filesystem failure is more useful than a second close error.
  }
}

async function unlinkIfOwned(fsApi, absolutePath, expectedIdentity) {
  if (!expectedIdentity) return false;
  try {
    const current = await fsApi.lstat(absolutePath, { bigint: true });
    if (!sameIdentity(current, expectedIdentity)) return false;
    await fsApi.unlink(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function rmdirIfOwned(fsApi, absolutePath, expectedIdentity) {
  if (!expectedIdentity) return false;
  try {
    const current = await fsApi.lstat(absolutePath, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expectedIdentity)) return false;
    await fsApi.rmdir(absolutePath);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) return false;
    throw error;
  }
}

async function writeExclusive(fsApi, absolutePath, content) {
  let handle;
  let ownedIdentity;
  try {
    handle = await fsApi.open(absolutePath, 'wx', 0o600);
    try {
      ownedIdentity = identity(await handle.stat({ bigint: true }));
    } catch (error) {
      // A transient first stat must not turn a provably owned exclusive file into
      // debris. If identity remains unavailable, cleanup deliberately fails closed.
      try {
        ownedIdentity = identity(await handle.stat({ bigint: true }));
      } catch {
        // Preserve an ownership-uncertain pathname rather than unlinking by name.
      }
      throw error;
    }
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    return ownedIdentity;
  } catch (error) {
    await closeQuietly(handle);
    await unlinkIfOwned(fsApi, absolutePath, ownedIdentity);
    throw error;
  }
}

async function readStable(fsApi, vaultDir, absolutePath) {
  await assertContainedPath(vaultDir, absolutePath, { fsApi });
  const handle = await fsApi.open(absolutePath, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('The requested item is not a file');
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await fsApi.lstat(absolutePath, { bigint: true });
    if (current.isSymbolicLink() || !sameSnapshot(before, after) || !sameIdentity(after, current)) throw changedError();
    return { content, stat: after };
  } finally {
    await closeQuietly(handle);
  }
}

function safeToken(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'token';
}

async function ensureDirectory(fsApi, vaultDir, directory) {
  await assertContainedPath(vaultDir, directory, { allowMissing: true, fsApi });
  await fsApi.mkdir(directory, { recursive: true });
  await assertContainedPath(vaultDir, directory, { fsApi });
}

async function writeUnique(fsApi, makePath, content) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = makePath(attempt);
    try {
      const ownedIdentity = await writeExclusive(fsApi, candidate, content);
      return { absolutePath: candidate, ownedIdentity };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const error = new Error('Safire could not allocate a unique mutation file');
  error.code = 'EEXIST';
  throw error;
}

async function createUniqueDirectory(fsApi, makePath) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = makePath(attempt);
    try {
      await fsApi.mkdir(candidate, { mode: 0o700 });
      const stat = await fsApi.lstat(candidate, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw containmentError();
      return { absolutePath: candidate, ownedIdentity: identity(stat) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const error = new Error('Safire could not allocate a unique backup namespace');
  error.code = 'EEXIST';
  throw error;
}

export function createNoteMutator({
  vaultDir: configuredVaultDir,
  fsApi = fs,
  now = () => Date.now(),
  randomId = () => randomUUID(),
} = {}) {
  const vaultDir = path.resolve(configuredVaultDir);
  const coordinator = createCoordinator();

  function noteRelativePath(absolutePath) {
    const { relative } = assertInside(vaultDir, absolutePath);
    if (!relative) throw new Error('A note path is required');
    return slash(relative);
  }

  function coordinationKeys(...absolutePaths) {
    const keys = [];
    for (const absolutePath of absolutePaths) {
      const { relative } = assertInside(vaultDir, absolutePath);
      let current = vaultDir;
      for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        keys.push(current);
      }
    }
    return keys;
  }

  async function publishBackup(absolutePath, snapshot) {
    const relativePath = noteRelativePath(absolutePath);
    const timestamp = Number(now());
    const date = new Date(timestamp);
    if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) throw new Error('Safire could not create a backup');
    const backupDirectory = path.join(vaultDir, BACKUP_DIRECTORY, date.toISOString().slice(0, 10));
    await ensureDirectory(fsApi, vaultDir, backupDirectory);
    const token = safeToken(randomId());
    const namespace = await createUniqueDirectory(
      fsApi,
      (attempt) => path.join(backupDirectory, `.safire-backup-${Math.trunc(timestamp)}-${token}${attempt ? `-${attempt}` : ''}`),
    );
    const finalPath = path.join(
      namespace.absolutePath,
      `${relativePath.replace(/[\\/:]/g, '__')}.${Math.trunc(timestamp)}.${token}.bak`,
    );
    const temporaryPath = path.join(namespace.absolutePath, '.safire-backup-write.tmp');
    let temporaryIdentity;
    try {
      temporaryIdentity = await writeExclusive(fsApi, temporaryPath, snapshot.content);
      const currentNamespace = await fsApi.lstat(namespace.absolutePath, { bigint: true });
      if (!currentNamespace.isDirectory() || currentNamespace.isSymbolicLink() || !sameIdentity(currentNamespace, namespace.ownedIdentity)) {
        throw containmentError();
      }
      try {
        await fsApi.lstat(finalPath, { bigint: true });
        throw changedError();
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const currentTemporary = await fsApi.lstat(temporaryPath, { bigint: true });
      if (!sameIdentity(currentTemporary, temporaryIdentity)) throw changedError();
      await fsApi.rename(temporaryPath, finalPath);
      const published = await fsApi.lstat(finalPath, { bigint: true });
      if (!published.isFile() || published.isSymbolicLink() || !sameIdentity(published, temporaryIdentity)) throw changedError();
      return slash(path.relative(vaultDir, finalPath));
    } catch (error) {
      await unlinkIfOwned(fsApi, temporaryPath, temporaryIdentity);
      await rmdirIfOwned(fsApi, namespace.absolutePath, namespace.ownedIdentity);
      throw error;
    }
  }

  async function publishReplacement(absolutePath, content, expectedStat) {
    const parent = path.dirname(absolutePath);
    await ensureDirectory(fsApi, vaultDir, parent);
    const token = safeToken(randomId());
    const name = path.basename(absolutePath);
    const temporary = await writeUnique(
      fsApi,
      (attempt) => path.join(parent, `.${name}.safire-write-${token}${attempt ? `-${attempt}` : ''}.tmp`),
      content,
    );
    try {
      await assertContainedPath(vaultDir, absolutePath, { allowMissing: !expectedStat, fsApi });
      try {
        const current = await fsApi.lstat(absolutePath, { bigint: true });
        if (current.isSymbolicLink() || !expectedStat || !sameSnapshot(current, expectedStat)) throw changedError();
      } catch (error) {
        if (error?.code !== 'ENOENT' || expectedStat) throw error;
      }
      const temporaryStat = await fsApi.lstat(temporary.absolutePath, { bigint: true });
      if (!sameIdentity(temporaryStat, temporary.ownedIdentity)) throw changedError();
      await fsApi.rename(temporary.absolutePath, absolutePath);
    } catch (error) {
      await unlinkIfOwned(fsApi, temporary.absolutePath, temporary.ownedIdentity);
      throw error;
    }
  }

  async function snapshotOrNull(absolutePath) {
    try {
      return await readStable(fsApi, vaultDir, absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function mutateLocked(absolutePath, transform, { requireExisting = true } = {}) {
    const snapshot = await snapshotOrNull(absolutePath);
    if (!snapshot && requireExisting) {
      const error = new Error('The requested item was not found');
      error.code = 'ENOENT';
      throw error;
    }
    const transformed = await transform(snapshot?.content ?? null);
    const next = transformed && typeof transformed === 'object' && Object.hasOwn(transformed, 'content')
      ? transformed
      : { content: transformed, value: undefined };
    const backup = snapshot ? await publishBackup(absolutePath, snapshot) : null;
    if (snapshot) await publishReplacement(absolutePath, next.content, snapshot.stat);
    else {
      const parent = path.dirname(absolutePath);
      await ensureDirectory(fsApi, vaultDir, parent);
      await writeExclusive(fsApi, absolutePath, next.content);
    }
    return { backup, value: next.value };
  }

  return Object.freeze({
    async create(absolutePath, content) {
      noteRelativePath(absolutePath);
      return coordinator.runMany(coordinationKeys(absolutePath), async () => {
        const parent = path.dirname(absolutePath);
        await ensureDirectory(fsApi, vaultDir, parent);
        await assertContainedPath(vaultDir, absolutePath, { allowMissing: true, fsApi });
        await writeExclusive(fsApi, absolutePath, content);
        return { path: slash(path.relative(vaultDir, absolutePath)) };
      });
    },

    async replace(absolutePath, content) {
      noteRelativePath(absolutePath);
      return coordinator.runMany(coordinationKeys(absolutePath), () => mutateLocked(absolutePath, () => content, { requireExisting: true }));
    },

    async put(absolutePath, content) {
      noteRelativePath(absolutePath);
      return coordinator.runMany(coordinationKeys(absolutePath), () => mutateLocked(absolutePath, () => content, { requireExisting: false }));
    },

    async mutate(absolutePath, transform, options = {}) {
      noteRelativePath(absolutePath);
      return coordinator.runMany(coordinationKeys(absolutePath), () => mutateLocked(absolutePath, transform, options));
    },

    async remove(absolutePath) {
      noteRelativePath(absolutePath);
      return coordinator.runMany(coordinationKeys(absolutePath), async () => {
        const snapshot = await snapshotOrNull(absolutePath);
        if (!snapshot) return { backup: null };
        const backup = await publishBackup(absolutePath, snapshot);
        await assertContainedPath(vaultDir, absolutePath, { fsApi });
        const current = await fsApi.lstat(absolutePath, { bigint: true });
        if (current.isSymbolicLink() || !sameSnapshot(current, snapshot.stat)) throw changedError();
        await fsApi.unlink(absolutePath);
        return { backup };
      });
    },

    async rename(sourcePath, destinationPath) {
      noteRelativePath(sourcePath);
      noteRelativePath(destinationPath);
      if (pathKey(sourcePath) === pathKey(destinationPath)) {
        const error = new Error('The requested item already exists');
        error.code = 'EEXIST';
        throw error;
      }
      return coordinator.runMany(coordinationKeys(sourcePath, destinationPath), async () => {
        const source = await readStable(fsApi, vaultDir, sourcePath);
        const destinationParent = path.dirname(destinationPath);
        await ensureDirectory(fsApi, vaultDir, destinationParent);
        await assertContainedPath(vaultDir, destinationPath, { allowMissing: true, fsApi });
        const destinationIdentity = await writeExclusive(fsApi, destinationPath, source.content);
        try {
          const currentDestination = await fsApi.lstat(destinationPath, { bigint: true });
          if (currentDestination.isSymbolicLink() || !sameIdentity(currentDestination, destinationIdentity)) throw changedError();
          await assertContainedPath(vaultDir, sourcePath, { fsApi });
          const currentSource = await fsApi.lstat(sourcePath, { bigint: true });
          if (currentSource.isSymbolicLink() || !sameSnapshot(currentSource, source.stat)) throw changedError();
          await fsApi.unlink(sourcePath);
        } catch (error) {
          await unlinkIfOwned(fsApi, destinationPath, destinationIdentity);
          throw error;
        }
        return {
          from: slash(path.relative(vaultDir, sourcePath)),
          to: slash(path.relative(vaultDir, destinationPath)),
        };
      });
    },

    async ensureFolder(absolutePath) {
      const { relative } = assertInside(vaultDir, absolutePath);
      if (!relative) throw new Error('A folder path is required');
      return coordinator.runMany(coordinationKeys(absolutePath), async () => {
        await ensureDirectory(fsApi, vaultDir, absolutePath);
        return { path: slash(relative) };
      });
    },

    async renameFolder(sourcePath, destinationPath) {
      const source = assertInside(vaultDir, sourcePath);
      const destination = assertInside(vaultDir, destinationPath);
      if (!source.relative || !destination.relative) throw new Error('A folder path is required');
      if (pathKey(sourcePath) === pathKey(destinationPath)) {
        const error = new Error('The requested item already exists');
        error.code = 'EEXIST';
        throw error;
      }
      return coordinator.runMany(coordinationKeys(sourcePath, destinationPath), async () => {
        await assertContainedPath(vaultDir, sourcePath, { fsApi });
        const sourceStat = await fsApi.lstat(sourcePath, { bigint: true });
        if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('The requested item is not a folder');
        await ensureDirectory(fsApi, vaultDir, path.dirname(destinationPath));
        if (await assertContainedPath(vaultDir, destinationPath, { allowMissing: true, fsApi })) {
          const error = new Error('The requested item already exists');
          error.code = 'EEXIST';
          throw error;
        }
        const currentSource = await fsApi.lstat(sourcePath, { bigint: true });
        if (currentSource.isSymbolicLink() || !currentSource.isDirectory() || !sameSnapshot(currentSource, sourceStat)) throw changedError();
        await fsApi.rename(sourcePath, destinationPath);
        return { from: slash(source.relative), to: slash(destination.relative) };
      });
    },

    pendingCount() {
      return coordinator.size();
    },
  });
}

export async function listContainedFiles(vaultDir, directory, { fsApi = fs } = {}) {
  const root = path.resolve(directory);
  try {
    const exists = await assertContainedPath(vaultDir, root, { allowMissing: true, fsApi });
    if (!exists) return [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  async function visit(current) {
    const before = await fsApi.lstat(current, { bigint: true });
    if (before.isSymbolicLink()) throw containmentError();
    if (!before.isDirectory()) throw new Error('Backup storage is not a directory');
    const entries = await fsApi.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const stat = await fsApi.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) throw containmentError();
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) {
        files.push({
          relativePath: slash(path.relative(root, child)),
          size: Number(stat.size),
          mtimeMs: Number(stat.mtimeNs) / 1_000_000,
        });
      } else {
        throw new Error('Backup storage contains an unsupported item');
      }
    }
    const after = await fsApi.lstat(current, { bigint: true });
    if (!sameIdentity(before, after)) throw containmentError();
  }
  await visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function readContainedFile(vaultDir, absolutePath, encoding, { fsApi = fs } = {}) {
  const snapshot = await readStable(fsApi, vaultDir, absolutePath);
  return encoding ? snapshot.content.toString(encoding) : snapshot.content;
}
