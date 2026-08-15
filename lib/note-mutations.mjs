import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const BACKUP_DIRECTORY = '.safire-backups';
const BACKUP_FORMAT = 'safire-note-backup/v2';
const BACKUP_CONTENT_NAME = 'content.bak';
const BACKUP_METADATA_NAME = 'metadata.json';
const MAX_BACKUP_METADATA_BYTES = 256 * 1024;
const MUTATION_LOCK_DIRECTORY = '.safire-note-mutations.lock';
const MUTATION_LOCK_VERSION = 1;
const MUTATION_LOCK_PROTOCOL = 'owner-directory/v1';
const DEFAULT_LOCK_OPTIONS = Object.freeze({ timeoutMs: 5_000, retryDelayMs: 25 });
const MAX_NAME_ATTEMPTS = 128;
const MAX_ACTIVE_NOTE_KEYS = 1024;
const MAX_PENDING_PER_NOTE = 64;
const WINDOWS_DOS_SHORT_NAME_COMPONENT = /^[^\\/:.]{1,6}~[1-9][0-9]*(?:\.[^\\/:.]{1,3})?$/i;
const SAFIRE_CONTROL_DIRECTORIES = Object.freeze([
  '.safire',
  BACKUP_DIRECTORY,
  MUTATION_LOCK_DIRECTORY,
]);

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

function mutationBusyError() {
  const error = new Error('Safire is busy with note changes; try again');
  error.code = 'EBUSY';
  return error;
}

function reservedMutationPathError() {
  const error = new Error('Safire internal paths are reserved');
  error.code = 'SAFIRE_RESERVED_PATH';
  return error;
}

function assertInside(vaultDir, absolutePath) {
  const vault = path.resolve(vaultDir);
  const target = path.resolve(absolutePath);
  const relative = path.relative(vault, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes vault');
  return { vault, target, relative };
}

function mutationPathComponentKey(value) {
  const component = String(value);
  return process.platform === 'win32'
    ? component.replace(/[ .]+$/g, '').toLowerCase()
    : component;
}

export function assertUserMutationPath(vaultDir, absolutePath) {
  const contained = assertInside(vaultDir, absolutePath);
  const reserved = SAFIRE_CONTROL_DIRECTORIES.map(mutationPathComponentKey);
  const components = contained.relative.split(path.sep).filter(Boolean);
  const aliasesControlPath = process.platform === 'win32' && components.some((part) => {
    const normalized = part.replace(/[ .]+$/g, '');
    return normalized.includes(':') || WINDOWS_DOS_SHORT_NAME_COMPONENT.test(normalized);
  });
  if (aliasesControlPath || components.some((part) => reserved.includes(mutationPathComponentKey(part)))) {
    throw reservedMutationPathError();
  }
  return contained;
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

async function readStable(fsApi, vaultDir, absolutePath, { maxBytes = Number.POSITIVE_INFINITY } = {}) {
  await assertContainedPath(vaultDir, absolutePath, { fsApi });
  const handle = await fsApi.open(absolutePath, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('The requested item is not a file');
    let content;
    if (Number.isFinite(maxBytes)) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer');
      if (before.size > BigInt(maxBytes)) throw new Error('The requested item is too large');
      const expectedBytes = Number(before.size);
      const bounded = Buffer.alloc(expectedBytes + 1);
      const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
      if (bytesRead !== expectedBytes) throw changedError();
      content = bounded.subarray(0, expectedBytes);
    } else {
      content = await handle.readFile();
    }
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

function normalizedLockOptions(options = {}) {
  const normalized = {
    timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_OPTIONS.timeoutMs,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_LOCK_OPTIONS.retryDelayMs,
    signal: options.signal,
  };
  for (const key of ['timeoutMs', 'retryDelayMs']) {
    if (!Number.isFinite(normalized[key]) || normalized[key] < 0) throw new TypeError(`${key} must be a non-negative finite number`);
  }
  return normalized;
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || mutationBusyError());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason || mutationBusyError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function snapshotPlainDirectory(fsApi, absolutePath) {
  const stat = await fsApi.lstat(absolutePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw containmentError();
  return identity(stat);
}

async function revalidatePlainDirectory(fsApi, absolutePath, expectedIdentity) {
  const current = await fsApi.lstat(absolutePath, { bigint: true });
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, expectedIdentity)) throw mutationBusyError();
}

async function createMutationLock(fsApi, vaultDir, randomId) {
  const lockPath = path.join(vaultDir, MUTATION_LOCK_DIRECTORY);
  const vaultIdentity = await snapshotPlainDirectory(fsApi, vaultDir);
  await fsApi.mkdir(lockPath, { mode: 0o700 });
  let lockIdentity;
  let ownerIdentity;
  let ownerPath;
  try {
    lockIdentity = await snapshotPlainDirectory(fsApi, lockPath);
    await revalidatePlainDirectory(fsApi, vaultDir, vaultIdentity);
    const token = safeToken(randomId());
    ownerPath = path.join(lockPath, `owner-${token}.json`);
    const serialized = Buffer.from(JSON.stringify({
      version: MUTATION_LOCK_VERSION,
      protocol: MUTATION_LOCK_PROTOCOL,
      token,
      pid: process.pid,
      createdAtMs: Date.now(),
      recovery: 'operator_only',
    }));
    ownerIdentity = await writeExclusive(fsApi, ownerPath, serialized);
    await revalidatePlainDirectory(fsApi, vaultDir, vaultIdentity);
    await revalidatePlainDirectory(fsApi, lockPath, lockIdentity);
    return { lockPath, lockIdentity, ownerPath, ownerIdentity, serialized, vaultIdentity };
  } catch (error) {
    try {
      await unlinkIfOwned(fsApi, ownerPath, ownerIdentity);
      await rmdirIfOwned(fsApi, lockPath, lockIdentity);
    } catch {
      // Any ownership-uncertain gate remains held for explicit operator recovery.
    }
    throw error;
  }
}

async function acquireMutationLock(fsApi, vaultDir, randomId, options) {
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  while (true) {
    try {
      const ownership = await createMutationLock(fsApi, vaultDir, randomId);
      let released = false;
      return {
        async release() {
          if (released) return false;
          try {
            await revalidatePlainDirectory(fsApi, vaultDir, ownership.vaultIdentity);
            await revalidatePlainDirectory(fsApi, ownership.lockPath, ownership.lockIdentity);
            const owner = await readStable(fsApi, ownership.lockPath, ownership.ownerPath, { maxBytes: 4 * 1024 });
            if (!sameIdentity(owner.stat, ownership.ownerIdentity) || !owner.content.equals(ownership.serialized)) throw mutationBusyError();
            const removed = await unlinkIfOwned(fsApi, ownership.ownerPath, ownership.ownerIdentity);
            if (!removed) throw mutationBusyError();
            await revalidatePlainDirectory(fsApi, ownership.lockPath, ownership.lockIdentity);
            await revalidatePlainDirectory(fsApi, vaultDir, ownership.vaultIdentity);
            // This non-recursive rmdir is the final ownership-bound release.
            // Normal contenders cannot create a successor gate before it completes.
            await fsApi.rmdir(ownership.lockPath);
            released = true;
            return true;
          } catch {
            throw mutationBusyError();
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const current = Date.now();
    if (current >= deadline) throw mutationBusyError();
    await waitForRetry(Math.min(options.retryDelayMs, Math.max(1, deadline - current)), options.signal);
  }
}

async function withMutationLock(fsApi, vaultDir, randomId, options, operation) {
  const lock = await acquireMutationLock(fsApi, vaultDir, randomId, options);
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  const released = await lock.release();
  if (!released) throw mutationBusyError();
  if (operationError) throw operationError;
  return result;
}

function safeBackupNotePath(value) {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || !/\.md$/i.test(value)) return null;
  return value;
}

function invalidBackupMetadata(version = null) {
  return Object.freeze({
    version,
    valid: false,
    legacy: version === 1,
    notePath: null,
    createdAt: null,
    requiresExplicitPath: true,
  });
}

function legacyBackupMetadata(fileRelativePath) {
  const base = path.posix.basename(slash(fileRelativePath));
  const match = base.match(/^(.*\.md)\.(\d+)(?:\.[A-Za-z0-9_-]+)?\.bak$/i);
  if (!match) return invalidBackupMetadata(1);
  const ambiguous = match[1].includes('__');
  const notePath = ambiguous ? null : safeBackupNotePath(match[1]);
  const timestamp = Number(match[2]);
  return Object.freeze({
    version: 1,
    valid: Boolean(notePath),
    legacy: true,
    notePath,
    createdAt: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null,
    requiresExplicitPath: !notePath,
  });
}

function indexByteLimitError() {
  const error = new Error('The generic index byte limit was reached');
  error.code = 'SAFIRE_INDEX_BYTE_LIMIT';
  return error;
}

async function readBackupMetadataResult(vaultDir, backupPath, { fsApi = fs, maxMetadataBytes = MAX_BACKUP_METADATA_BYTES } = {}) {
  const { target } = assertInside(vaultDir, backupPath);
  if (path.basename(target) !== BACKUP_CONTENT_NAME) {
    return {
      metadata: legacyBackupMetadata(slash(path.relative(vaultDir, target))),
      bytesConsumed: 0,
      contentOmitted: false,
      attemptFailed: false,
    };
  }
  const byteLimit = Number.isSafeInteger(maxMetadataBytes) && maxMetadataBytes >= 0
    ? Math.min(maxMetadataBytes, MAX_BACKUP_METADATA_BYTES)
    : MAX_BACKUP_METADATA_BYTES;
  if (byteLimit === 0) {
    return { metadata: invalidBackupMetadata(2), bytesConsumed: 0, contentOmitted: true, attemptFailed: true };
  }
  const namespacePath = path.dirname(target);
  const metadataPath = path.join(namespacePath, BACKUP_METADATA_NAME);
  let metadata;
  let contentSize;
  let bytesConsumed = 0;
  try {
    const namespaceIdentity = await snapshotPlainDirectory(fsApi, namespacePath);
    const snapshot = await readStable(fsApi, vaultDir, metadataPath, { maxBytes: byteLimit });
    bytesConsumed = snapshot.content.byteLength;
    metadata = JSON.parse(snapshot.content.toString('utf8'));
    const contentStat = await fsApi.lstat(target, { bigint: true });
    await revalidatePlainDirectory(fsApi, namespacePath, namespaceIdentity);
    if (contentStat.isSymbolicLink() || !contentStat.isFile()) {
      return { metadata: invalidBackupMetadata(2), bytesConsumed, contentOmitted: false, attemptFailed: true };
    }
    contentSize = Number(contentStat.size);
  } catch {
    return {
      metadata: invalidBackupMetadata(2),
      bytesConsumed,
      contentOmitted: bytesConsumed === 0 && byteLimit < MAX_BACKUP_METADATA_BYTES,
      attemptFailed: true,
    };
  }
  const notePath = safeBackupNotePath(metadata?.notePath);
  const valid = Boolean(
    metadata
    && Object.keys(metadata).sort().join(',') === 'byteLength,contentSha256,createdAt,format,namespace,notePath'
    && metadata.format === BACKUP_FORMAT
    && metadata.namespace === path.basename(namespacePath)
    && notePath
    && Number.isSafeInteger(metadata.createdAt)
    && metadata.createdAt >= 0
    && Number.isSafeInteger(metadata.byteLength)
    && metadata.byteLength >= 0
    && metadata.byteLength === contentSize
    && /^[a-f0-9]{64}$/.test(metadata.contentSha256),
  );
  if (!valid) return {
    metadata: invalidBackupMetadata(2), bytesConsumed, contentOmitted: false, attemptFailed: false,
  };
  return {
    metadata: Object.freeze({
      version: 2,
      valid: true,
      legacy: false,
      notePath,
      createdAt: metadata.createdAt,
      byteLength: metadata.byteLength,
      contentSha256: metadata.contentSha256,
      requiresExplicitPath: false,
    }),
    bytesConsumed,
    contentOmitted: false,
    attemptFailed: false,
  };
}

export async function readBackupMetadata(vaultDir, backupPath, { fsApi = fs } = {}) {
  return (await readBackupMetadataResult(vaultDir, backupPath, { fsApi })).metadata;
}

export async function readBackupMetadataForIndex(vaultDir, backupPath, options = {}) {
  return readBackupMetadataResult(vaultDir, backupPath, options);
}

export async function readBackupFileForIndex(vaultDir, backupPath, encoding, options = {}) {
  const fsApi = options.fsApi || fs;
  const maximum = Number.isSafeInteger(options.maxOperationBytes) && options.maxOperationBytes >= 0
    ? options.maxOperationBytes
    : Number.POSITIVE_INFINITY;
  const metadataResult = await readBackupMetadataResult(vaultDir, backupPath, {
    fsApi,
    maxMetadataBytes: Number.isFinite(maximum) ? maximum : MAX_BACKUP_METADATA_BYTES,
  });
  if (metadataResult.contentOmitted) throw indexByteLimitError();
  const metadata = metadataResult.metadata;
  if (metadata.version === 2 && !metadata.valid) throw new Error('Backup metadata is invalid');
  const remainingBytes = Number.isFinite(maximum) ? Math.max(0, maximum - metadataResult.bytesConsumed) : maximum;
  if (remainingBytes === 0) throw indexByteLimitError();
  let snapshot;
  try {
    snapshot = await readStable(fsApi, vaultDir, backupPath, { maxBytes: remainingBytes });
  } catch (error) {
    if (Number.isFinite(remainingBytes)) {
      try {
        const stat = await fsApi.lstat(backupPath, { bigint: true });
        if (stat.isFile() && stat.size > BigInt(remainingBytes)) throw indexByteLimitError();
      } catch (statError) {
        if (statError?.code === 'SAFIRE_INDEX_BYTE_LIMIT') throw statError;
      }
    }
    throw error;
  }
  if (metadata.version === 2) {
    const digest = createHash('sha256').update(snapshot.content).digest('hex');
    if (snapshot.content.byteLength !== metadata.byteLength || digest !== metadata.contentSha256) {
      throw new Error('Backup metadata is invalid');
    }
  }
  return {
    metadata,
    content: encoding ? snapshot.content.toString(encoding) : snapshot.content,
    bytesConsumed: metadataResult.bytesConsumed + snapshot.content.byteLength,
  };
}

export async function readBackupFile(vaultDir, backupPath, encoding, { fsApi = fs } = {}) {
  const result = await readBackupFileForIndex(vaultDir, backupPath, encoding, { fsApi });
  return { metadata: result.metadata, content: result.content };
}

export function createNoteMutator({
  vaultDir: configuredVaultDir,
  fsApi = fs,
  now = () => Date.now(),
  randomId = () => randomUUID(),
  lockOptions = {},
} = {}) {
  const vaultDir = path.resolve(configuredVaultDir);
  const coordinator = createCoordinator();
  const processLockOptions = normalizedLockOptions(lockOptions);

  function noteRelativePath(absolutePath) {
    const { relative } = assertUserMutationPath(vaultDir, absolutePath);
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

  function runMutation(absolutePaths, operation) {
    return coordinator.runMany(
      coordinationKeys(...absolutePaths),
      () => withMutationLock(fsApi, vaultDir, randomId, processLockOptions, operation),
    );
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
    const finalPath = path.join(namespace.absolutePath, BACKUP_CONTENT_NAME);
    const metadataPath = path.join(namespace.absolutePath, BACKUP_METADATA_NAME);
    const temporaryPath = path.join(namespace.absolutePath, '.safire-backup-write.tmp');
    const temporaryMetadataPath = path.join(namespace.absolutePath, '.safire-backup-metadata.tmp');
    let temporaryIdentity;
    let metadataIdentity;
    let contentPublished = false;
    let metadataPublished = false;
    try {
      temporaryIdentity = await writeExclusive(fsApi, temporaryPath, snapshot.content);
      const metadataBytes = Buffer.from(JSON.stringify({
        format: BACKUP_FORMAT,
        namespace: path.basename(namespace.absolutePath),
        notePath: relativePath,
        createdAt: Math.trunc(timestamp),
        byteLength: snapshot.content.byteLength,
        contentSha256: createHash('sha256').update(snapshot.content).digest('hex'),
      }));
      if (metadataBytes.byteLength > MAX_BACKUP_METADATA_BYTES) throw new Error('Safire could not create a backup');
      metadataIdentity = await writeExclusive(fsApi, temporaryMetadataPath, metadataBytes);
      const currentNamespace = await fsApi.lstat(namespace.absolutePath, { bigint: true });
      if (!currentNamespace.isDirectory() || currentNamespace.isSymbolicLink() || !sameIdentity(currentNamespace, namespace.ownedIdentity)) {
        throw containmentError();
      }
      for (const candidate of [metadataPath, finalPath]) {
        try {
          await fsApi.lstat(candidate, { bigint: true });
          throw changedError();
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      const currentTemporary = await fsApi.lstat(temporaryPath, { bigint: true });
      if (!sameIdentity(currentTemporary, temporaryIdentity)) throw changedError();
      const currentMetadata = await fsApi.lstat(temporaryMetadataPath, { bigint: true });
      if (!sameIdentity(currentMetadata, metadataIdentity)) throw changedError();
      await fsApi.rename(temporaryMetadataPath, metadataPath);
      metadataPublished = true;
      const publishedMetadata = await fsApi.lstat(metadataPath, { bigint: true });
      if (!publishedMetadata.isFile() || publishedMetadata.isSymbolicLink() || !sameIdentity(publishedMetadata, metadataIdentity)) throw changedError();
      await fsApi.rename(temporaryPath, finalPath);
      contentPublished = true;
      const published = await fsApi.lstat(finalPath, { bigint: true });
      if (!published.isFile() || published.isSymbolicLink() || !sameIdentity(published, temporaryIdentity)) throw changedError();
      return slash(path.relative(vaultDir, finalPath));
    } catch (error) {
      await unlinkIfOwned(fsApi, contentPublished ? finalPath : temporaryPath, temporaryIdentity);
      await unlinkIfOwned(fsApi, metadataPublished ? metadataPath : temporaryMetadataPath, metadataIdentity);
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
      return runMutation([absolutePath], async () => {
        const parent = path.dirname(absolutePath);
        await ensureDirectory(fsApi, vaultDir, parent);
        await assertContainedPath(vaultDir, absolutePath, { allowMissing: true, fsApi });
        await writeExclusive(fsApi, absolutePath, content);
        return { path: slash(path.relative(vaultDir, absolutePath)) };
      });
    },

    async replace(absolutePath, content) {
      noteRelativePath(absolutePath);
      return runMutation([absolutePath], () => mutateLocked(absolutePath, () => content, { requireExisting: true }));
    },

    async put(absolutePath, content) {
      noteRelativePath(absolutePath);
      return runMutation([absolutePath], () => mutateLocked(absolutePath, () => content, { requireExisting: false }));
    },

    async mutate(absolutePath, transform, options = {}) {
      noteRelativePath(absolutePath);
      return runMutation([absolutePath], () => mutateLocked(absolutePath, transform, options));
    },

    async remove(absolutePath) {
      noteRelativePath(absolutePath);
      return runMutation([absolutePath], async () => {
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
      return runMutation([sourcePath, destinationPath], async () => {
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
      const { relative } = assertUserMutationPath(vaultDir, absolutePath);
      if (!relative) throw new Error('A folder path is required');
      return runMutation([absolutePath], async () => {
        await ensureDirectory(fsApi, vaultDir, absolutePath);
        return { path: slash(relative) };
      });
    },

    async renameFolder(sourcePath, destinationPath) {
      const source = assertUserMutationPath(vaultDir, sourcePath);
      const destination = assertUserMutationPath(vaultDir, destinationPath);
      if (!source.relative || !destination.relative) throw new Error('A folder path is required');
      if (pathKey(sourcePath) === pathKey(destinationPath)) {
        const error = new Error('The requested item already exists');
        error.code = 'EEXIST';
        throw error;
      }
      return runMutation([sourcePath, destinationPath], async () => {
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

export async function listContainedFilesBounded(vaultDir, directory, options = {}) {
  const fsApi = options.fsApi || fs;
  const fileLimit = Number.isInteger(options.fileLimit) && options.fileLimit >= 0 ? options.fileLimit : 1_000;
  const directoryLimit = Number.isInteger(options.directoryLimit) && options.directoryLimit >= 0 ? options.directoryLimit : 2_000;
  const entryLimit = Number.isInteger(options.entryLimit) && options.entryLimit >= 0 ? options.entryLimit : 10_000;
  const depthLimit = Number.isInteger(options.depthLimit) && options.depthLimit >= 0 ? options.depthLimit : 64;
  const fieldCharacters = Number.isInteger(options.fieldCharacters) && options.fieldCharacters >= 0 ? options.fieldCharacters : 1_024;
  const fieldBytes = Number.isInteger(options.fieldBytes) && options.fieldBytes >= 0 ? options.fieldBytes : 2_048;
  const includeFile = typeof options.includeFile === 'function' ? options.includeFile : () => true;
  const root = path.resolve(directory);
  try {
    const exists = await assertContainedPath(vaultDir, root, { allowMissing: true, fsApi });
    if (!exists) return {
      files: [], observedFiles: 0, observedDirectories: 0, observedEntries: 0, complete: true,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      files: [], observedFiles: 0, observedDirectories: 0, observedEntries: 0, complete: true,
    };
    throw error;
  }

  const files = [];
  const pending = [{ absolutePath: root, depth: 0, expectedIdentity: null }];
  let observedFiles = 0;
  let observedDirectories = directoryLimit > 0 ? 1 : 0;
  let observedEntries = 0;
  let complete = fileLimit > 0 && directoryLimit > 0 && entryLimit > 0;
  let stopped = fileLimit === 0 || directoryLimit === 0 || entryLimit === 0;

  while (pending.length > 0 && !stopped) {
    const current = pending.pop();
    await assertContainedPath(vaultDir, current.absolutePath, { fsApi });
    const before = await fsApi.lstat(current.absolutePath, { bigint: true });
    if (before.isSymbolicLink()) throw containmentError();
    if (!before.isDirectory()) throw new Error('Backup storage is not a directory');
    if (current.expectedIdentity && !sameIdentity(before, current.expectedIdentity)) throw containmentError();

    const handle = await fsApi.opendir(current.absolutePath);
    for await (const entry of handle) {
      observedEntries += 1;
      if (observedEntries > entryLimit) {
        complete = false;
        stopped = true;
        break;
      }
      const child = path.join(current.absolutePath, entry.name);
      const stat = await fsApi.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) throw containmentError();
      if (stat.isDirectory()) {
        observedDirectories += 1;
        if (observedDirectories > directoryLimit) {
          complete = false;
          stopped = true;
          break;
        }
        if (current.depth >= depthLimit) {
          complete = false;
          continue;
        }
        pending.push({ absolutePath: child, depth: current.depth + 1, expectedIdentity: identity(stat) });
        continue;
      }
      if (!stat.isFile()) throw new Error('Backup storage contains an unsupported item');
      const relativePath = slash(path.relative(root, child));
      if (!includeFile(relativePath)) continue;
      observedFiles += 1;
      if (observedFiles > fileLimit) {
        complete = false;
        stopped = true;
        break;
      }
      if (relativePath.length > fieldCharacters || Buffer.byteLength(relativePath, 'utf8') > fieldBytes) {
        complete = false;
        continue;
      }
      const size = Number(stat.size);
      const mtimeMs = Number(stat.mtimeNs) / 1_000_000;
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtimeMs)) {
        complete = false;
        continue;
      }
      files.push({ relativePath, size, mtimeMs });
    }
    const after = await fsApi.lstat(current.absolutePath, { bigint: true });
    if (!sameIdentity(before, after)) throw containmentError();
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    files,
    observedFiles: Math.min(observedFiles, fileLimit + 1),
    observedDirectories: Math.min(observedDirectories, directoryLimit + 1),
    observedEntries: Math.min(observedEntries, entryLimit + 1),
    complete,
  };
}

export async function readContainedFile(vaultDir, absolutePath, encoding, { fsApi = fs } = {}) {
  const snapshot = await readStable(fsApi, vaultDir, absolutePath);
  return encoding ? snapshot.content.toString(encoding) : snapshot.content;
}
