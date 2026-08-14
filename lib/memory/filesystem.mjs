import { constants as fsConstants, promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export const MEMORY_LAYOUT_VERSION = 'v1';
export const IMMUTABLE_COLLECTIONS = Object.freeze(['actors', 'events', 'feedback', 'idempotency', 'memories']);

const OPAQUE_JSON_NAME = /^[a-f0-9]{64}\.json$/;
const OPAQUE_DIRECTORY_NAME = /^[a-f0-9]{64}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']);
const DEFAULT_LOCK_OPTIONS = Object.freeze({ timeoutMs: 5_000, retryDelayMs: 25, staleMs: 60_000 });

export class MemoryFilesystemError extends Error {
  constructor(message, { code = 'MEMORY_FILESYSTEM_ERROR', cause, details } = {}) {
    super(message, { cause });
    this.name = 'MemoryFilesystemError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class MemoryConflictError extends MemoryFilesystemError {
  constructor(kind, details = {}) {
    super(`Memory JSON ${kind} conflict`, {
      code: 'MEMORY_CONFLICT',
      details: Object.freeze({ kind, ...details }),
    });
    this.name = 'MemoryConflictError';
    this.kind = kind;
  }
}

export class VaultLockTimeoutError extends MemoryFilesystemError {
  constructor(timeoutMs) {
    super('Timed out waiting for the Safire memory vault lock', {
      code: 'MEMORY_LOCK_TIMEOUT',
      details: Object.freeze({ timeoutMs }),
    });
    this.name = 'VaultLockTimeoutError';
  }
}

export class VaultLockOwnershipError extends MemoryFilesystemError {
  constructor() {
    super('Safire memory vault lock ownership changed', { code: 'MEMORY_LOCK_OWNERSHIP' });
    this.name = 'VaultLockOwnershipError';
  }
}

function foldPathForComparison(value) {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const withoutTrailing = resolved === parsed.root ? resolved : resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? withoutTrailing.toLocaleLowerCase('en-US') : withoutTrailing;
}

function samePath(left, right) {
  return foldPathForComparison(left) === foldPathForComparison(right);
}

export function assertPathContained(rootDir, candidatePath, { allowRoot = false } = {}) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) {
    throw new MemoryFilesystemError('A containment root is required', { code: 'MEMORY_PATH_INVALID' });
  }
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    throw new MemoryFilesystemError('A candidate path is required', { code: 'MEMORY_PATH_INVALID' });
  }

  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  const foldedRoot = foldPathForComparison(root);
  const foldedCandidate = foldPathForComparison(candidate);
  if (foldedCandidate === foldedRoot) {
    if (allowRoot) return candidate;
    throw new MemoryFilesystemError('The target must be below the containment root', { code: 'MEMORY_PATH_ESCAPE' });
  }

  const prefix = foldedRoot.endsWith(path.sep) ? foldedRoot : `${foldedRoot}${path.sep}`;
  if (!foldedCandidate.startsWith(prefix)) {
    throw new MemoryFilesystemError('The target escapes the containment root', { code: 'MEMORY_PATH_ESCAPE' });
  }
  return candidate;
}

export function resolveContainedPath(rootDir, ...segments) {
  if (!segments.length) return assertPathContained(rootDir, rootDir, { allowRoot: true });
  return assertPathContained(rootDir, path.resolve(rootDir, ...segments));
}

function requireExplicitVault(vaultPath) {
  if (typeof vaultPath !== 'string' || !vaultPath.trim() || !path.isAbsolute(vaultPath)) {
    throw new MemoryFilesystemError('An explicit absolute vault path is required', { code: 'MEMORY_VAULT_REQUIRED' });
  }
  const resolved = path.resolve(vaultPath);
  if (samePath(resolved, path.parse(resolved).root)) {
    throw new MemoryFilesystemError('A filesystem root cannot be used as a memory vault', { code: 'MEMORY_VAULT_UNSAFE' });
  }
  return resolved;
}

async function ensurePlainDirectory(parentDir, segment) {
  const candidate = resolveContainedPath(parentDir, segment);
  try {
    await fs.mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MemoryFilesystemError('A Safire memory layout path is not a plain directory', {
      code: 'MEMORY_LAYOUT_UNSAFE',
    });
  }
  const real = await fs.realpath(candidate);
  assertPathContained(parentDir, real);
  return real;
}

function freezeLayout(layout) {
  return Object.freeze({
    ...layout,
    collections: Object.freeze({ ...layout.collections }),
  });
}

export async function ensureMemoryLayout(vaultPath) {
  const requestedVault = requireExplicitVault(vaultPath);
  const vaultStat = await fs.stat(requestedVault).catch((cause) => {
    throw new MemoryFilesystemError('The explicit Safire vault is unavailable', {
      code: 'MEMORY_VAULT_UNAVAILABLE', cause,
    });
  });
  if (!vaultStat.isDirectory()) {
    throw new MemoryFilesystemError('The explicit Safire vault is not a directory', { code: 'MEMORY_VAULT_INVALID' });
  }

  const vaultDir = await fs.realpath(requestedVault);
  if (samePath(vaultDir, path.parse(vaultDir).root)) {
    throw new MemoryFilesystemError('A filesystem root cannot be used as a memory vault', { code: 'MEMORY_VAULT_UNSAFE' });
  }

  const safireDir = await ensurePlainDirectory(vaultDir, '.safire');
  const memoryDir = await ensurePlainDirectory(safireDir, 'memory');
  const rootDir = await ensurePlainDirectory(memoryDir, MEMORY_LAYOUT_VERSION);
  const recordsDir = await ensurePlainDirectory(rootDir, 'records');
  const stateDir = await ensurePlainDirectory(rootDir, 'state');
  const journalsDir = await ensurePlainDirectory(rootDir, 'journals');
  const locksDir = await ensurePlainDirectory(rootDir, 'locks');

  const collections = {};
  for (const collection of IMMUTABLE_COLLECTIONS) {
    collections[collection] = await ensurePlainDirectory(recordsDir, collection);
  }

  return freezeLayout({
    vaultDir,
    safireDir,
    memoryDir,
    rootDir,
    recordsDir,
    stateDir,
    journalsDir,
    locksDir,
    lockPath: path.join(locksDir, 'vault.lock'),
    collections,
  });
}

function assertLayout(layout) {
  if (!layout || typeof layout !== 'object') {
    throw new MemoryFilesystemError('A Safire memory layout is required', { code: 'MEMORY_LAYOUT_REQUIRED' });
  }
  const required = ['vaultDir', 'rootDir', 'recordsDir', 'stateDir', 'journalsDir', 'locksDir', 'lockPath'];
  for (const key of required) {
    if (typeof layout[key] !== 'string' || !layout[key]) {
      throw new MemoryFilesystemError('The Safire memory layout is incomplete', { code: 'MEMORY_LAYOUT_INVALID' });
    }
  }
  const expectedRoot = path.join(layout.vaultDir, '.safire', 'memory', MEMORY_LAYOUT_VERSION);
  if (!samePath(layout.rootDir, expectedRoot)) {
    throw new MemoryFilesystemError('The Safire memory layout root is invalid', { code: 'MEMORY_LAYOUT_INVALID' });
  }
  assertPathContained(layout.vaultDir, layout.rootDir);
  assertPathContained(layout.rootDir, layout.recordsDir);
  assertPathContained(layout.rootDir, layout.stateDir);
  assertPathContained(layout.rootDir, layout.journalsDir);
  assertPathContained(layout.rootDir, layout.locksDir);
  assertPathContained(layout.locksDir, layout.lockPath);
  return layout;
}

function assertCollection(collection) {
  if (!IMMUTABLE_COLLECTIONS.includes(collection)) {
    throw new MemoryFilesystemError('Unsupported immutable memory collection', {
      code: 'MEMORY_COLLECTION_INVALID',
      details: Object.freeze({ allowed: IMMUTABLE_COLLECTIONS }),
    });
  }
  return collection;
}

export function immutableCollectionDirectory(layout, collection) {
  assertLayout(layout);
  assertCollection(collection);
  const directory = layout.collections?.[collection] || path.join(layout.recordsDir, collection);
  return assertPathContained(layout.recordsDir, directory);
}

export function sha256Hex(input) {
  if (!(typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array)) {
    throw new TypeError('sha256Hex accepts a string, Buffer, or Uint8Array');
  }
  return createHash('sha256').update(input).digest('hex');
}

export const digestBytes = sha256Hex;

export function randomOpaqueToken(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new TypeError('Opaque token size must be an integer from 16 through 128 bytes');
  }
  return randomBytes(bytes).toString('hex');
}

function requireOpaqueSource(value, label = 'identity') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MemoryFilesystemError(`A non-empty ${label} is required`, { code: 'MEMORY_ID_INVALID' });
  }
  return value;
}

export function opaqueJsonFilename(identity) {
  return `${sha256Hex(requireOpaqueSource(identity))}.json`;
}

export function opaqueJsonPath(directory, identity) {
  return resolveContainedPath(directory, opaqueJsonFilename(identity));
}

function canonicalizeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Value is not JSON serializable');
  if (seen.has(value)) throw new TypeError('Circular JSON values are not supported');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonicalizeJson(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain objects can be serialized as memory JSON');
    }
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError('Undefined JSON fields are not supported');
      output[key] = canonicalizeJson(value[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function serializeJson(value) {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

export function digestJson(value) {
  return sha256Hex(serializeJson(value));
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function safeExistingDirectory(rootDir, directory) {
  const lexical = assertPathContained(rootDir, directory, { allowRoot: true });
  const [realRoot, stat] = await Promise.all([fs.realpath(rootDir), fs.lstat(lexical)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MemoryFilesystemError('A memory filesystem parent is not a plain directory', {
      code: 'MEMORY_PATH_UNSAFE',
    });
  }
  const realDirectory = await fs.realpath(lexical);
  assertPathContained(realRoot, realDirectory, { allowRoot: true });
  return { realRoot, realDirectory };
}

async function safeFileTarget(rootDir, targetPath, { mustExist = false } = {}) {
  const lexical = assertPathContained(rootDir, targetPath);
  const parent = path.dirname(lexical);
  const { realRoot, realDirectory } = await safeExistingDirectory(rootDir, parent);
  const target = path.join(realDirectory, path.basename(lexical));
  assertPathContained(realRoot, target);

  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MemoryFilesystemError('A memory JSON target is not a plain file', { code: 'MEMORY_PATH_UNSAFE' });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (mustExist) throw error;
  }
  return { target, parent: realDirectory, root: realRoot };
}

function parseJsonBuffer(buffer, targetPath) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (cause) {
    throw new MemoryFilesystemError('A Safire memory JSON file is invalid', {
      code: 'MEMORY_JSON_INVALID', cause,
      details: Object.freeze({ path: targetPath }),
    });
  }
}

export async function readJsonWithDigest(rootDir, targetPath) {
  const { target } = await safeFileTarget(rootDir, targetPath, { mustExist: true });
  const bytes = await fs.readFile(target);
  const value = parseJsonBuffer(bytes, target);
  return Object.freeze({
    path: target,
    value,
    digest: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    revision: Number.isSafeInteger(value?.revision) ? value.revision : null,
  });
}

export async function readJsonFile(rootDir, targetPath) {
  return (await readJsonWithDigest(rootDir, targetPath)).value;
}

function temporaryPath(parent, target) {
  return path.join(parent, `.${path.basename(target)}.${process.pid}.${randomOpaqueToken(16)}.tmp`);
}

async function writeSyncedTemporary(parent, target, serialized) {
  const temp = temporaryPath(parent, target);
  assertPathContained(parent, temp);
  const handle = await fs.open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  return temp;
}

export async function createJsonExclusive(rootDir, targetPath, value) {
  const serialized = serializeJson(value);
  const { target, parent } = await safeFileTarget(rootDir, targetPath);
  const temp = await writeSyncedTemporary(parent, target, serialized);
  try {
    // A same-directory hard link publishes the already-synced inode atomically and
    // fails with EEXIST instead of replacing an immutable record.
    await fs.link(temp, target);
    await syncDirectory(parent);
  } finally {
    await fs.unlink(temp).catch(() => {});
    await syncDirectory(parent);
  }
  return Object.freeze({
    path: target,
    value,
    digest: sha256Hex(serialized),
    byteLength: Buffer.byteLength(serialized),
    revision: Number.isSafeInteger(value?.revision) ? value.revision : null,
  });
}

async function replaceJsonAtomic(rootDir, targetPath, value) {
  const serialized = serializeJson(value);
  const { target, parent } = await safeFileTarget(rootDir, targetPath, { mustExist: true });
  const temp = await writeSyncedTemporary(parent, target, serialized);
  try {
    await fs.rename(temp, target);
    await syncDirectory(parent);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  return Object.freeze({
    path: target,
    value,
    digest: sha256Hex(serialized),
    byteLength: Buffer.byteLength(serialized),
    revision: Number.isSafeInteger(value?.revision) ? value.revision : null,
  });
}

export function immutableRecordPath(layout, collection, identity) {
  return opaqueJsonPath(immutableCollectionDirectory(layout, collection), identity);
}

export async function createImmutableJson(layout, collection, identity, value) {
  const directory = immutableCollectionDirectory(layout, collection);
  return createJsonExclusive(directory, immutableRecordPath(layout, collection, identity), value);
}

export async function readImmutableJson(layout, collection, identity) {
  const directory = immutableCollectionDirectory(layout, collection);
  return readJsonWithDigest(directory, immutableRecordPath(layout, collection, identity));
}

async function listOpaqueJson(directory) {
  const { realDirectory } = await safeExistingDirectory(directory, directory);
  const entries = await fs.readdir(realDirectory, { withFileTypes: true });
  return Object.freeze(entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && OPAQUE_JSON_NAME.test(entry.name))
    .map(entry => Object.freeze({ name: entry.name, path: path.join(realDirectory, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name)));
}

export async function listImmutableJson(layout, collection) {
  return listOpaqueJson(immutableCollectionDirectory(layout, collection));
}

export function mutableStatePath(layout, identity) {
  assertLayout(layout);
  return opaqueJsonPath(layout.stateDir, identity);
}

function initialMutableValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Mutable memory JSON must be a plain object');
  }
  if (value.revision === undefined) return { ...value, revision: 0 };
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new TypeError('Mutable memory JSON revision must be a non-negative safe integer');
  }
  return value;
}

export async function createMutableJson(layout, identity, value) {
  assertLayout(layout);
  return createJsonExclusive(layout.stateDir, mutableStatePath(layout, identity), initialMutableValue(value));
}

export async function readMutableJson(layout, identity) {
  assertLayout(layout);
  return readJsonWithDigest(layout.stateDir, mutableStatePath(layout, identity));
}

function lockOptions(options = {}) {
  const normalized = { ...DEFAULT_LOCK_OPTIONS, ...options };
  for (const key of ['timeoutMs', 'retryDelayMs', 'staleMs']) {
    if (!Number.isFinite(normalized[key]) || normalized[key] < 0) {
      throw new TypeError(`${key} must be a non-negative finite number`);
    }
  }
  if (normalized.staleMs === 0) throw new TypeError('staleMs must be greater than zero');
  return normalized;
}

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('Operation aborted'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason || new Error('Operation aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

async function readLockSnapshot(lockPath, { tolerateTransientAccessDenial = false } = {}) {
  let handle;
  try {
    handle = await fs.open(lockPath, fsConstants.O_RDONLY);
    const stat = await handle.stat();
    const bytes = await handle.readFile();
    let metadata = null;
    try { metadata = JSON.parse(bytes.toString('utf8')); } catch { /* Invalid legacy locks use stale fallback. */ }
    return { bytes, digest: sha256Hex(bytes), stat, metadata };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (tolerateTransientAccessDenial && ['EPERM', 'EACCES'].includes(error?.code)) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function lockMetadata(snapshot) {
  const metadata = snapshot?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata;
}

function lockSnapshotIsStale(snapshot, staleMs, now = Date.now()) {
  if (!snapshot) return false;
  const metadata = lockMetadata(snapshot);
  const created = Number.isFinite(metadata?.createdAtMs) && metadata.createdAtMs >= 0
    ? metadata.createdAtMs
    : snapshot.stat.mtimeMs;
  const freshest = Math.max(created, snapshot.stat.mtimeMs);
  return now - freshest >= staleMs;
}

function lockOwnerLiveness(snapshot) {
  const pid = lockMetadata(snapshot)?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'indeterminate';
  if (pid === process.pid) return 'alive';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    // Permission errors imply that the process exists even though this process
    // cannot signal it. Treat that as live; age alone must never steal its lock.
    if (['EPERM', 'EACCES'].includes(error?.code)) return 'alive';
    return 'indeterminate';
  }
}

function lockMayBeRecovered(snapshot, staleMs) {
  const liveness = lockOwnerLiveness(snapshot);
  if (liveness === 'alive') return false;
  if (liveness === 'dead') return true;
  return lockSnapshotIsStale(snapshot, staleMs);
}

async function recoverAbandonedLock(layout, staleMs) {
  // On Windows an unlink/replace race can briefly deny a second handle. Treat
  // that as a contended live lock and retry; never infer absence or staleness.
  const snapshot = await readLockSnapshot(
    layout.lockPath,
    { tolerateTransientAccessDenial: true },
  );
  if (snapshot === undefined) return false;
  if (!lockMayBeRecovered(snapshot, staleMs)) return false;

  const quarantine = path.join(layout.locksDir, `.vault.lock.recovery.${randomOpaqueToken(16)}`);
  assertPathContained(layout.locksDir, quarantine);
  try {
    await fs.rename(layout.lockPath, quarantine);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) return false;
    throw error;
  }

  const moved = await readLockSnapshot(quarantine);
  if (!moved || moved.digest !== snapshot.digest || !lockMayBeRecovered(moved, staleMs)) {
    // A lock changed during recovery. Restore it only when the public lock path
    // is still vacant; never overwrite another process's lock.
    try { await fs.link(quarantine, layout.lockPath); } catch { /* Another owner won the path. */ }
    await fs.unlink(quarantine).catch(() => {});
    await syncDirectory(layout.locksDir);
    return false;
  }

  await fs.unlink(quarantine);
  await syncDirectory(layout.locksDir);
  return true;
}

async function createVaultLock(layout) {
  const token = randomOpaqueToken(32);
  const metadata = {
    version: 1,
    token,
    pid: process.pid,
    createdAtMs: Date.now(),
  };
  // Publish only after the complete metadata is durable. The same-directory
  // hard link is exclusive, so contenders can observe either no lock or one
  // complete lock, never the partially written public file.
  await createJsonExclusive(layout.locksDir, layout.lockPath, metadata);
  return { token, metadata };
}

async function lockStillOwned(layout, token) {
  const snapshot = await readLockSnapshot(layout.lockPath);
  return Boolean(snapshot?.metadata?.token && snapshot.metadata.token === token);
}

export async function acquireVaultLock(layout, options = {}) {
  assertLayout(layout);
  const normalized = lockOptions(options);
  const started = Date.now();
  const deadline = started + normalized.timeoutMs;

  while (true) {
    try {
      const { token, metadata } = await createVaultLock(layout);
      let released = false;
      const lock = {
        path: layout.lockPath,
        token,
        pid: metadata.pid,
        createdAtMs: metadata.createdAtMs,
        async isOwned() {
          return !released && lockStillOwned(layout, token);
        },
        async release() {
          if (released) return false;
          if (!(await lockStillOwned(layout, token))) {
            released = true;
            throw new VaultLockOwnershipError();
          }
          await fs.unlink(layout.lockPath);
          await syncDirectory(layout.locksDir);
          released = true;
          return true;
        },
      };
      return Object.freeze(lock);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    if (await recoverAbandonedLock(layout, normalized.staleMs)) continue;
    const now = Date.now();
    if (now >= deadline) throw new VaultLockTimeoutError(normalized.timeoutMs);
    await wait(Math.min(normalized.retryDelayMs, Math.max(1, deadline - now)), normalized.signal);
  }
}

export async function withVaultLock(layout, options, operation) {
  if (typeof options === 'function') {
    operation = options;
    options = {};
  }
  if (typeof operation !== 'function') throw new TypeError('withVaultLock requires an operation');
  const lock = await acquireVaultLock(layout, options);
  try {
    return await operation(lock);
  } finally {
    // release() performs a final token check. Never return a successful
    // operation if ownership was replaced or the callback released early.
    const released = await lock.release();
    if (!released) throw new VaultLockOwnershipError();
  }
}

async function requireOwnedLock(layout, lock) {
  if (!lock || lock.path !== layout.lockPath || typeof lock.isOwned !== 'function' || !(await lock.isOwned())) {
    throw new VaultLockOwnershipError();
  }
}

function validateExpectedState(expectedRevision, expectedDigest) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('expectedRevision must be a non-negative safe integer');
  }
  if (typeof expectedDigest !== 'string' || !SHA256_DIGEST.test(expectedDigest)) {
    throw new TypeError('expectedDigest must be a lowercase SHA-256 digest');
  }
}

async function replaceJsonWhileLocked(layout, targetPath, nextValue, { expectedRevision, expectedDigest, lock }) {
  await requireOwnedLock(layout, lock);
  const current = await readJsonWithDigest(layout.rootDir, targetPath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new MemoryConflictError('missing', { expectedRevision, expectedDigest });
    }
    throw error;
  });
  if (current.revision !== expectedRevision) {
    throw new MemoryConflictError('revision', {
      expectedRevision,
      actualRevision: current.revision,
      expectedDigest,
      actualDigest: current.digest,
    });
  }
  if (current.digest !== expectedDigest) {
    throw new MemoryConflictError('digest', {
      expectedRevision,
      actualRevision: current.revision,
      expectedDigest,
      actualDigest: current.digest,
    });
  }
  if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)) {
    throw new TypeError('Optimistic replacement requires a plain JSON object');
  }
  const nextRevision = expectedRevision + 1;
  if (nextValue.revision !== undefined && nextValue.revision !== nextRevision) {
    throw new TypeError(`Replacement revision must be ${nextRevision}`);
  }
  return replaceJsonAtomic(layout.rootDir, targetPath, { ...nextValue, revision: nextRevision });
}

export async function replaceJsonOptimistic(layout, targetPath, nextValue, options = {}) {
  assertLayout(layout);
  const { expectedRevision, expectedDigest, lock, lockOptions: requestedLockOptions } = options;
  validateExpectedState(expectedRevision, expectedDigest);
  assertPathContained(layout.rootDir, targetPath);
  if (lock) {
    return replaceJsonWhileLocked(layout, targetPath, nextValue, {
      expectedRevision, expectedDigest, lock,
    });
  }
  return withVaultLock(layout, requestedLockOptions || {}, acquired => replaceJsonWhileLocked(
    layout,
    targetPath,
    nextValue,
    { expectedRevision, expectedDigest, lock: acquired },
  ));
}

export async function replaceMutableJson(layout, identity, nextValue, options = {}) {
  assertLayout(layout);
  return replaceJsonOptimistic(layout, mutableStatePath(layout, identity), nextValue, options);
}

export function journalDirectory(layout, journalId) {
  assertLayout(layout);
  const name = sha256Hex(requireOpaqueSource(journalId, 'journal identity'));
  if (!OPAQUE_DIRECTORY_NAME.test(name)) throw new MemoryFilesystemError('Invalid journal identity', { code: 'MEMORY_ID_INVALID' });
  return resolveContainedPath(layout.journalsDir, name);
}

export async function ensureJournalDirectory(layout, journalId) {
  assertLayout(layout);
  const name = path.basename(journalDirectory(layout, journalId));
  return ensurePlainDirectory(layout.journalsDir, name);
}

export function journalEntryPath(layout, journalId, entryId) {
  return opaqueJsonPath(journalDirectory(layout, journalId), requireOpaqueSource(entryId, 'journal entry identity'));
}

export async function createJournalEntry(layout, journalId, entryId, value) {
  const directory = await ensureJournalDirectory(layout, journalId);
  return createJsonExclusive(directory, journalEntryPath(layout, journalId, entryId), value);
}

export async function readJournalEntry(layout, journalId, entryId) {
  const directory = journalDirectory(layout, journalId);
  return readJsonWithDigest(directory, journalEntryPath(layout, journalId, entryId));
}

export async function listJournalEntries(layout, journalId) {
  return listOpaqueJson(journalDirectory(layout, journalId)).catch((error) => {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  });
}

export async function removeJournalEntry(layout, journalId, entryId, { expectedDigest } = {}) {
  const directory = journalDirectory(layout, journalId);
  const target = journalEntryPath(layout, journalId, entryId);
  if (expectedDigest !== undefined) {
    if (typeof expectedDigest !== 'string' || !SHA256_DIGEST.test(expectedDigest)) {
      throw new TypeError('expectedDigest must be a lowercase SHA-256 digest');
    }
    const current = await readJsonWithDigest(directory, target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!current) return false;
    if (current.digest !== expectedDigest) {
      throw new MemoryConflictError('digest', {
        expectedDigest,
        actualDigest: current.digest,
      });
    }
  }
  try {
    const { target: safeTarget } = await safeFileTarget(directory, target, { mustExist: true });
    await fs.unlink(safeTarget);
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function removeJournalDirectoryIfEmpty(layout, journalId) {
  assertLayout(layout);
  const directory = journalDirectory(layout, journalId);
  try {
    const { realDirectory } = await safeExistingDirectory(layout.journalsDir, directory);
    await fs.rmdir(realDirectory);
    await syncDirectory(layout.journalsDir);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) return false;
    throw error;
  }
}
