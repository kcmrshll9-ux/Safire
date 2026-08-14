import { constants as fsConstants, promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export const MEMORY_LAYOUT_VERSION = 'v1';
export const IMMUTABLE_COLLECTIONS = Object.freeze(['actors', 'events', 'feedback', 'idempotency', 'memories']);

const OPAQUE_JSON_NAME = /^[a-f0-9]{64}\.json$/;
const OPAQUE_DIRECTORY_NAME = /^[a-f0-9]{64}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']);
const DEFAULT_LOCK_OPTIONS = Object.freeze({ timeoutMs: 5_000, retryDelayMs: 25 });
const LOCK_METADATA_VERSION = 3;
const LOCK_PROTOCOL = 'owner-directory/v1';
const LOCK_TOKEN = /^[a-f0-9]{64}$/;
const knownDirectoryIdentities = new Map();

// Directory walks are always incremental and capped, including calls made
// directly through this module instead of through MemoryStore.
export const HARD_MAX_DIRECTORY_ENTRIES_PER_OPERATION = 25_000;
// A request may contain up to 128 MiB of canonical input. Batch journals add
// bounded transaction, provenance, derivation, integrity, and pretty-print
// overhead, so retain a conservative 32 MiB envelope without permitting a
// caller to raise the opened-file allocation ceiling.
export const HARD_MAX_MEMORY_JSON_FILE_BYTES = 160 * 1024 * 1024;
export const HARD_MAX_LOCK_METADATA_BYTES = 4 * 1024;

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

function pathIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function directoryChangedError() {
  return new MemoryFilesystemError('A Safire memory directory changed during filesystem access', {
    code: 'MEMORY_PATH_IDENTITY',
  });
}

function isWindowsNamespacePath(value) {
  if (process.platform !== 'win32' || typeof value !== 'string') return false;
  return /^[\\/]{2}/.test(value.trim());
}

export function assertSupportedMemoryVaultPath(vaultPath) {
  if (isWindowsNamespacePath(vaultPath)) {
    throw new MemoryFilesystemError('Network and Windows namespace vault paths are unsupported', {
      code: 'MEMORY_VAULT_NETWORK_UNSUPPORTED',
    });
  }
  return vaultPath;
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
  assertSupportedMemoryVaultPath(vaultPath);
  if (typeof vaultPath !== 'string' || !vaultPath.trim() || !path.isAbsolute(vaultPath)) {
    throw new MemoryFilesystemError('An explicit absolute vault path is required', { code: 'MEMORY_VAULT_REQUIRED' });
  }
  const resolved = path.resolve(vaultPath);
  if (samePath(resolved, path.parse(resolved).root)) {
    throw new MemoryFilesystemError('A filesystem root cannot be used as a memory vault', { code: 'MEMORY_VAULT_UNSAFE' });
  }
  return resolved;
}

async function snapshotPlainDirectory(directory, errorCode = 'MEMORY_PATH_UNSAFE') {
  const lexical = path.resolve(directory);
  let stat;
  try {
    stat = await fs.lstat(lexical, { bigint: true });
  } catch (cause) {
    throw new MemoryFilesystemError('A Safire memory directory is unavailable', {
      code: errorCode,
      cause,
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MemoryFilesystemError('A Safire memory path is not a plain directory', {
      code: errorCode,
    });
  }
  const realPath = await fs.realpath(lexical);
  return Object.freeze({
    path: lexical,
    realPath,
    identity: pathIdentity(stat),
  });
}

function assertSameDirectory(expected, actual) {
  if (!samePath(expected.path, actual.path)
      || !samePath(expected.realPath, actual.realPath)
      || !sameIdentity(expected.identity, actual.identity)) {
    throw directoryChangedError();
  }
  return actual;
}

async function revalidateDirectory(expected) {
  return assertSameDirectory(expected, await snapshotPlainDirectory(expected.path));
}

function rememberDirectory(snapshot) {
  const key = foldPathForComparison(snapshot.path);
  const existing = knownDirectoryIdentities.get(key);
  if (existing) assertSameDirectory(existing, snapshot);
  else knownDirectoryIdentities.set(key, snapshot);
  return snapshot;
}

async function knownOrCurrentDirectory(directory) {
  const snapshot = await snapshotPlainDirectory(directory);
  const known = knownDirectoryIdentities.get(foldPathForComparison(snapshot.path));
  return known ? assertSameDirectory(known, snapshot) : snapshot;
}

async function ensurePlainDirectory(parentDir, segment, { persistent = true } = {}) {
  const parentBefore = await knownOrCurrentDirectory(parentDir);
  const candidate = resolveContainedPath(parentDir, segment);
  try {
    await fs.mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  await revalidateDirectory(parentBefore);
  const child = await snapshotPlainDirectory(candidate, 'MEMORY_LAYOUT_UNSAFE');
  assertPathContained(parentBefore.realPath, child.realPath);
  await revalidateDirectory(parentBefore);
  if (persistent) rememberDirectory(child);
  return child.realPath;
}

function freezeLayout(layout) {
  return Object.freeze({
    ...layout,
    collections: Object.freeze({ ...layout.collections }),
  });
}

export async function ensureMemoryLayout(vaultPath) {
  const requestedVault = requireExplicitVault(vaultPath);
  const vaultStat = await fs.lstat(requestedVault, { bigint: true }).catch((cause) => {
    throw new MemoryFilesystemError('The explicit Safire vault is unavailable', {
      code: 'MEMORY_VAULT_UNAVAILABLE', cause,
    });
  });
  if (!vaultStat.isDirectory() || vaultStat.isSymbolicLink()) {
    throw new MemoryFilesystemError('The explicit Safire vault is not a directory', { code: 'MEMORY_VAULT_INVALID' });
  }

  const vaultDir = await fs.realpath(requestedVault);
  assertSupportedMemoryVaultPath(vaultDir);
  if (samePath(vaultDir, path.parse(vaultDir).root)) {
    throw new MemoryFilesystemError('A filesystem root cannot be used as a memory vault', { code: 'MEMORY_VAULT_UNSAFE' });
  }
  const requestedVaultIdentity = Object.freeze({
    path: requestedVault,
    realPath: vaultDir,
    identity: pathIdentity(vaultStat),
  });
  await revalidateDirectory(requestedVaultIdentity);
  const stableVault = await snapshotPlainDirectory(vaultDir, 'MEMORY_VAULT_INVALID');
  if (!sameIdentity(requestedVaultIdentity.identity, stableVault.identity)) throw directoryChangedError();
  rememberDirectory(stableVault);

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

async function syncDirectory(directory, expectedIdentity = null) {
  let handle;
  try {
    if (expectedIdentity) await revalidateDirectory(expectedIdentity);
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  if (expectedIdentity) await revalidateDirectory(expectedIdentity);
}

async function safeExistingDirectory(rootDir, directory) {
  const lexical = assertPathContained(rootDir, directory, { allowRoot: true });
  const rootIdentity = await knownOrCurrentDirectory(rootDir);
  const directoryIdentity = samePath(rootDir, lexical)
    ? rootIdentity
    : await knownOrCurrentDirectory(lexical);
  assertPathContained(rootIdentity.realPath, directoryIdentity.realPath, { allowRoot: true });
  return {
    realRoot: rootIdentity.realPath,
    realDirectory: directoryIdentity.realPath,
    rootIdentity,
    directoryIdentity,
  };
}

async function safeFileTarget(rootDir, targetPath, { mustExist = false } = {}) {
  const lexical = assertPathContained(rootDir, targetPath);
  const parent = path.dirname(lexical);
  const {
    realRoot, realDirectory, rootIdentity, directoryIdentity,
  } = await safeExistingDirectory(rootDir, parent);
  const target = path.join(realDirectory, path.basename(lexical));
  assertPathContained(realRoot, target);

  let fileIdentity = null;
  try {
    const stat = await fs.lstat(target, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MemoryFilesystemError('A memory JSON target is not a plain file', { code: 'MEMORY_PATH_UNSAFE' });
    }
    fileIdentity = pathIdentity(stat);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (mustExist) throw error;
  }
  return {
    target,
    parent: realDirectory,
    root: realRoot,
    rootIdentity,
    parentIdentity: directoryIdentity,
    fileIdentity,
  };
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

function memoryResourceLimitError() {
  return new MemoryFilesystemError('Safire memory resource limit exceeded', {
    code: 'MEMORY_RESOURCE_LIMIT',
  });
}

function normalizeFileByteLimit(maxBytes, hardMaximum = HARD_MAX_MEMORY_JSON_FILE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > hardMaximum) {
    throw new TypeError('Memory JSON file byte limit is invalid');
  }
  return maxBytes;
}

async function readOpenedFileBounded(handle, openedStat, maxBytes) {
  const limit = normalizeFileByteLimit(maxBytes);
  if (openedStat.size < 0n || openedStat.size > BigInt(limit)) throw memoryResourceLimitError();
  const expectedBytes = Number(openedStat.size);
  const bytes = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
    if (result.bytesRead === 0) throw memoryResourceLimitError();
    offset += result.bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const probe = await handle.read(overflow, 0, 1, offset);
  if (probe.bytesRead > 0) throw memoryResourceLimitError();
  const completedStat = await handle.stat({ bigint: true });
  if (completedStat.size !== openedStat.size) throw memoryResourceLimitError();
  return bytes;
}

function assertSerializedFileSize(serialized, maxBytes = HARD_MAX_MEMORY_JSON_FILE_BYTES) {
  const limit = normalizeFileByteLimit(maxBytes);
  if (Buffer.byteLength(serialized) > limit) throw memoryResourceLimitError();
}

export async function readJsonWithDigest(rootDir, targetPath, {
  maxBytes = HARD_MAX_MEMORY_JSON_FILE_BYTES,
} = {}) {
  const byteLimit = normalizeFileByteLimit(maxBytes);
  const {
    target, rootIdentity, parentIdentity, fileIdentity,
  } = await safeFileTarget(rootDir, targetPath, { mustExist: true });
  await Promise.all([revalidateDirectory(rootIdentity), revalidateDirectory(parentIdentity)]);
  const handle = await fs.open(target, fsConstants.O_RDONLY);
  let bytes;
  try {
    const openedStat = await handle.stat({ bigint: true });
    const openedIdentity = pathIdentity(openedStat);
    if (!sameIdentity(fileIdentity, openedIdentity)) throw directoryChangedError();
    bytes = await readOpenedFileBounded(handle, openedStat, byteLimit);
  } finally {
    await handle.close().catch(() => {});
  }
  await Promise.all([revalidateDirectory(rootIdentity), revalidateDirectory(parentIdentity)]);
  const value = parseJsonBuffer(bytes, target);
  return Object.freeze({
    path: target,
    value,
    digest: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    revision: Number.isSafeInteger(value?.revision) ? value.revision : null,
  });
}

export async function readJsonFile(rootDir, targetPath, options = {}) {
  return (await readJsonWithDigest(rootDir, targetPath, options)).value;
}

function temporaryPath(parent, target) {
  return path.join(parent, `.${path.basename(target)}.${process.pid}.${randomOpaqueToken(16)}.tmp`);
}

async function writeSyncedTemporary(parentIdentity, target, serialized) {
  const parent = parentIdentity.realPath;
  const temp = temporaryPath(parent, target);
  assertPathContained(parent, temp);
  await revalidateDirectory(parentIdentity);
  const handle = await fs.open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlinkWithStableParent(temp, parentIdentity, { missingAsFalse: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await revalidateDirectory(parentIdentity);
  return temp;
}

async function unlinkWithStableParent(target, parentIdentity, { missingAsFalse = false } = {}) {
  await revalidateDirectory(parentIdentity);
  try {
    await fs.unlink(target);
  } catch (error) {
    if (missingAsFalse && error?.code === 'ENOENT') return false;
    throw error;
  }
  await revalidateDirectory(parentIdentity);
  return true;
}

export async function createJsonExclusive(rootDir, targetPath, value, {
  maxBytes = HARD_MAX_MEMORY_JSON_FILE_BYTES,
} = {}) {
  const serialized = serializeJson(value);
  assertSerializedFileSize(serialized, maxBytes);
  const {
    target, parent, rootIdentity, parentIdentity,
  } = await safeFileTarget(rootDir, targetPath);
  const temp = await writeSyncedTemporary(parentIdentity, target, serialized);
  let operationError = null;
  try {
    await Promise.all([revalidateDirectory(rootIdentity), revalidateDirectory(parentIdentity)]);
    // A same-directory hard link publishes the already-synced inode atomically and
    // fails with EEXIST instead of replacing an immutable record.
    await fs.link(temp, target);
    await Promise.all([revalidateDirectory(rootIdentity), revalidateDirectory(parentIdentity)]);
    await syncDirectory(parent, parentIdentity);
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  try {
    await unlinkWithStableParent(temp, parentIdentity, { missingAsFalse: true });
    await syncDirectory(parent, parentIdentity);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return Object.freeze({
    path: target,
    value,
    digest: sha256Hex(serialized),
    byteLength: Buffer.byteLength(serialized),
    revision: Number.isSafeInteger(value?.revision) ? value.revision : null,
  });
}

async function replaceJsonAtomic(rootDir, targetPath, value, {
  beforePublish = null,
  maxBytes = HARD_MAX_MEMORY_JSON_FILE_BYTES,
} = {}) {
  if (beforePublish !== null && typeof beforePublish !== 'function') {
    throw new TypeError('beforePublish must be a function');
  }
  const serialized = serializeJson(value);
  assertSerializedFileSize(serialized, maxBytes);
  const {
    target, parent, rootIdentity, parentIdentity, fileIdentity,
  } = await safeFileTarget(rootDir, targetPath, { mustExist: true });
  const temp = await writeSyncedTemporary(parentIdentity, target, serialized);
  try {
    await Promise.all([revalidateDirectory(rootIdentity), revalidateDirectory(parentIdentity)]);
    const latest = await safeFileTarget(rootDir, targetPath, { mustExist: true });
    if (!sameIdentity(fileIdentity, latest.fileIdentity)) throw directoryChangedError();
    if (beforePublish) await beforePublish();
    await fs.rename(temp, target);
    await Promise.all([revalidateDirectory(rootIdentity), revalidateDirectory(parentIdentity)]);
    await syncDirectory(parent, parentIdentity);
  } catch (error) {
    try {
      await unlinkWithStableParent(temp, parentIdentity, { missingAsFalse: true });
    } catch {
      // A changed parent must not be followed to remove a path outside the validated directory.
    }
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

export async function createImmutableJson(layout, collection, identity, value, options = {}) {
  const directory = immutableCollectionDirectory(layout, collection);
  return createJsonExclusive(directory, immutableRecordPath(layout, collection, identity), value, options);
}

export async function readImmutableJson(layout, collection, identity, options = {}) {
  const directory = immutableCollectionDirectory(layout, collection);
  return readJsonWithDigest(directory, immutableRecordPath(layout, collection, identity), options);
}

function normalizeDirectoryEntryLimit(maxEntries) {
  if (!Number.isSafeInteger(maxEntries)
      || maxEntries < 1
      || maxEntries > HARD_MAX_DIRECTORY_ENTRIES_PER_OPERATION) {
    throw new TypeError('Memory directory entry limit is invalid');
  }
  return maxEntries;
}

function directoryEntryKind(entry) {
  if (entry.isSymbolicLink()) return 'symbolic_link';
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  return 'other';
}

export async function listDirectoryEntries(rootDirectory, directory, {
  maxEntries = HARD_MAX_DIRECTORY_ENTRIES_PER_OPERATION,
  onEntryExamined,
} = {}) {
  const entryLimit = normalizeDirectoryEntryLimit(maxEntries);
  if (onEntryExamined !== undefined && typeof onEntryExamined !== 'function') {
    throw new TypeError('Memory directory entry observer is invalid');
  }
  const { realDirectory, directoryIdentity } = await safeExistingDirectory(rootDirectory, directory);
  await revalidateDirectory(directoryIdentity);
  const entries = [];
  let examined = 0;
  const handle = await fs.opendir(realDirectory);
  for await (const entry of handle) {
    examined += 1;
    if (examined > entryLimit) {
      throw new MemoryFilesystemError('Safire memory resource limit exceeded', {
        code: 'MEMORY_RESOURCE_LIMIT',
      });
    }
    onEntryExamined?.(1);
    entries.push(Object.freeze({ name: entry.name, kind: directoryEntryKind(entry) }));
  }
  await revalidateDirectory(directoryIdentity);
  return Object.freeze(entries);
}

async function listOpaqueJson(directory, {
  maxEntries = HARD_MAX_DIRECTORY_ENTRIES_PER_OPERATION,
  rejectUnexpected = false,
  onEntryExamined,
} = {}) {
  const entryLimit = normalizeDirectoryEntryLimit(maxEntries);
  if (onEntryExamined !== undefined && typeof onEntryExamined !== 'function') {
    throw new TypeError('Memory directory entry observer is invalid');
  }
  const { realDirectory, directoryIdentity } = await safeExistingDirectory(directory, directory);
  await revalidateDirectory(directoryIdentity);
  const entries = [];
  let examined = 0;
  const handle = await fs.opendir(realDirectory);
  for await (const entry of handle) {
    examined += 1;
    if (examined > entryLimit) {
      throw new MemoryFilesystemError('Safire memory resource limit exceeded', {
        code: 'MEMORY_RESOURCE_LIMIT',
      });
    }
    onEntryExamined?.(1);
    const valid = entry.isFile() && !entry.isSymbolicLink() && OPAQUE_JSON_NAME.test(entry.name);
    if (!valid && rejectUnexpected) {
      throw new MemoryFilesystemError('Safire memory directory state is invalid', {
        code: 'MEMORY_DIRECTORY_INVALID',
      });
    }
    if (valid) {
      entries.push(Object.freeze({ name: entry.name, path: path.join(realDirectory, entry.name) }));
    }
  }
  await revalidateDirectory(directoryIdentity);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(entries);
}

export async function listImmutableJson(layout, collection, options = {}) {
  return listOpaqueJson(immutableCollectionDirectory(layout, collection), options);
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

export async function createMutableJson(layout, identity, value, options = {}) {
  assertLayout(layout);
  return createJsonExclusive(
    layout.stateDir,
    mutableStatePath(layout, identity),
    initialMutableValue(value),
    options,
  );
}

export async function readMutableJson(layout, identity, options = {}) {
  assertLayout(layout);
  return readJsonWithDigest(layout.stateDir, mutableStatePath(layout, identity), options);
}

function lockOptions(options = {}) {
  // Keep accepting legacy callers that pass staleMs, but deliberately ignore
  // it. A lock's age never authorizes automatic recovery.
  const normalized = {
    timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_OPTIONS.timeoutMs,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_LOCK_OPTIONS.retryDelayMs,
    signal: options.signal,
  };
  for (const key of ['timeoutMs', 'retryDelayMs']) {
    if (!Number.isFinite(normalized[key]) || normalized[key] < 0) {
      throw new TypeError(`${key} must be a non-negative finite number`);
    }
  }
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

function lockOwnerMetadataPath(layout, token) {
  if (!LOCK_TOKEN.test(token)) throw new VaultLockOwnershipError();
  return resolveContainedPath(layout.lockPath, `owner-${token}.json`);
}

async function createVaultLock(layout) {
  const token = randomOpaqueToken(32);
  const metadata = {
    version: LOCK_METADATA_VERSION,
    protocol: LOCK_PROTOCOL,
    token,
    pid: process.pid,
    createdAtMs: Date.now(),
    recovery: 'operator_only',
  };

  const locksIdentity = await knownOrCurrentDirectory(layout.locksDir);
  await revalidateDirectory(locksIdentity);
  // mkdir is the cross-platform exclusive ownership primitive. The directory
  // may briefly be empty, but acquisition is not complete until its unique
  // owner file is durably published and the directory identity is rechecked.
  await fs.mkdir(layout.lockPath, { mode: 0o700 });
  await revalidateDirectory(locksIdentity);

  let lockIdentity;
  try {
    lockIdentity = await snapshotPlainDirectory(layout.lockPath, 'MEMORY_LOCK_OWNERSHIP');
    assertPathContained(locksIdentity.realPath, lockIdentity.realPath);
    await revalidateDirectory(locksIdentity);
  } catch {
    throw new VaultLockOwnershipError();
  }

  const ownerPath = lockOwnerMetadataPath(layout, token);
  const ownerState = await createJsonExclusive(
    lockIdentity.realPath,
    ownerPath,
    metadata,
    { maxBytes: HARD_MAX_LOCK_METADATA_BYTES },
  );
  try {
    await Promise.all([
      revalidateDirectory(locksIdentity),
      revalidateDirectory(lockIdentity),
    ]);
    await syncDirectory(layout.locksDir, locksIdentity);
  } catch {
    throw new VaultLockOwnershipError();
  }
  return {
    token,
    metadata,
    ownerPath,
    ownerDigest: ownerState.digest,
    locksIdentity,
    lockIdentity,
  };
}

async function readOwnedLockSnapshot(ownership) {
  await Promise.all([
    revalidateDirectory(ownership.locksIdentity),
    revalidateDirectory(ownership.lockIdentity),
  ]);
  const state = await readJsonWithDigest(
    ownership.lockIdentity.realPath,
    ownership.ownerPath,
    { maxBytes: HARD_MAX_LOCK_METADATA_BYTES },
  );
  await Promise.all([
    revalidateDirectory(ownership.locksIdentity),
    revalidateDirectory(ownership.lockIdentity),
  ]);
  return state;
}

function ownedLockSnapshotMatches(ownership, state) {
  const metadata = state?.value;
  return Boolean(metadata
    && state.digest === ownership.ownerDigest
    && metadata.version === LOCK_METADATA_VERSION
    && metadata.protocol === LOCK_PROTOCOL
    && metadata.token === ownership.token
    && metadata.pid === ownership.metadata.pid
    && metadata.createdAtMs === ownership.metadata.createdAtMs
    && metadata.recovery === 'operator_only');
}

async function lockStillOwned(ownership) {
  try {
    return ownedLockSnapshotMatches(ownership, await readOwnedLockSnapshot(ownership));
  } catch (error) {
    if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw error;
    return false;
  }
}

function asLockOwnershipError(error) {
  if (error instanceof VaultLockOwnershipError) return error;
  return new VaultLockOwnershipError();
}

export async function acquireVaultLock(layout, options = {}) {
  assertLayout(layout);
  const normalized = lockOptions(options);
  const started = Date.now();
  const deadline = started + normalized.timeoutMs;

  while (true) {
    try {
      const ownership = await createVaultLock(layout);
      const { token, metadata } = ownership;
      let releaseState = 'held';
      let releaseInFlight = null;
      const lock = {
        path: layout.lockPath,
        token,
        pid: metadata.pid,
        createdAtMs: metadata.createdAtMs,
        async isOwned() {
          return releaseState === 'held' && lockStillOwned(ownership);
        },
        async release() {
          if (releaseState === 'released') return false;
          if (releaseState === 'releasing') return releaseInFlight;
          releaseState = 'releasing';
          releaseInFlight = (async () => {
            let snapshot;
            try {
              snapshot = await readOwnedLockSnapshot(ownership);
            } catch (error) {
              if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw error;
              releaseState = 'released';
              throw asLockOwnershipError(error);
            }
            if (!ownedLockSnapshotMatches(ownership, snapshot)) {
              releaseState = 'released';
              throw new VaultLockOwnershipError();
            }
            try {
              // The owner-specific filename is the conditional-delete fence. If
              // the canonical gate is replaced, a successor has a different
              // nonempty child, so this unlink cannot remove its ownership and
              // the following non-recursive rmdir fails rather than deleting it.
              await unlinkWithStableParent(ownership.ownerPath, ownership.lockIdentity);
              await Promise.all([
                revalidateDirectory(ownership.locksIdentity),
                revalidateDirectory(ownership.lockIdentity),
              ]);
              // This non-recursive removal commits ownership release. Every
              // earlier cleanup crash leaves a complete or empty held gate;
              // the best-effort parent sync that follows deletes no pathname.
              await fs.rmdir(layout.lockPath);
              releaseState = 'released';
              await syncDirectory(layout.locksDir, ownership.locksIdentity);
              return true;
            } catch (error) {
              releaseState = 'released';
              throw asLockOwnershipError(error);
            }
          })();
          try {
            return await releaseInFlight;
          } catch (error) {
            if (releaseState === 'releasing') releaseState = 'held';
            throw error;
          } finally {
            releaseInFlight = null;
          }
        },
      };
      return Object.freeze(lock);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

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
  return replaceJsonAtomic(
    layout.rootDir,
    targetPath,
    { ...nextValue, revision: nextRevision },
    { beforePublish: () => requireOwnedLock(layout, lock) },
  );
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
  // Transaction journal directories are intentionally removed after recovery,
  // so their identity is scoped to each operation rather than the process.
  return ensurePlainDirectory(layout.journalsDir, name, { persistent: false });
}

export function journalEntryPath(layout, journalId, entryId) {
  return opaqueJsonPath(journalDirectory(layout, journalId), requireOpaqueSource(entryId, 'journal entry identity'));
}

export async function createJournalEntry(layout, journalId, entryId, value, options = {}) {
  const directory = await ensureJournalDirectory(layout, journalId);
  return createJsonExclusive(directory, journalEntryPath(layout, journalId, entryId), value, options);
}

export async function readJournalEntry(layout, journalId, entryId, options = {}) {
  const directory = journalDirectory(layout, journalId);
  return readJsonWithDigest(directory, journalEntryPath(layout, journalId, entryId), options);
}

export async function listJournalEntries(layout, journalId, options = {}) {
  return listOpaqueJson(journalDirectory(layout, journalId), options).catch((error) => {
    if (error?.code === 'ENOENT'
        || (error?.code === 'MEMORY_PATH_UNSAFE' && error?.cause?.code === 'ENOENT')) {
      return Object.freeze([]);
    }
    throw error;
  });
}

export async function listJournalDirectories(layout, {
  maxEntries = HARD_MAX_DIRECTORY_ENTRIES_PER_OPERATION,
  rejectUnexpected = false,
  onEntryExamined,
} = {}) {
  assertLayout(layout);
  const entryLimit = normalizeDirectoryEntryLimit(maxEntries);
  if (onEntryExamined !== undefined && typeof onEntryExamined !== 'function') {
    throw new TypeError('Memory directory entry observer is invalid');
  }
  const { realDirectory, directoryIdentity } = await safeExistingDirectory(
    layout.journalsDir,
    layout.journalsDir,
  );
  await revalidateDirectory(directoryIdentity);
  const entries = [];
  let examined = 0;
  const handle = await fs.opendir(realDirectory);
  for await (const entry of handle) {
    examined += 1;
    if (examined > entryLimit) {
      throw new MemoryFilesystemError('Safire memory resource limit exceeded', {
        code: 'MEMORY_RESOURCE_LIMIT',
      });
    }
    onEntryExamined?.(1);
    const valid = entry.isDirectory()
      && !entry.isSymbolicLink()
      && OPAQUE_DIRECTORY_NAME.test(entry.name);
    if (!valid && rejectUnexpected) {
      throw new MemoryFilesystemError('Safire memory journal state is invalid', {
        code: 'MEMORY_DIRECTORY_INVALID',
      });
    }
    if (valid) {
      entries.push(Object.freeze({ name: entry.name, path: path.join(realDirectory, entry.name) }));
    }
  }
  await revalidateDirectory(directoryIdentity);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(entries);
}

export async function removeJournalEntry(layout, journalId, entryId, { expectedDigest } = {}) {
  const directory = journalDirectory(layout, journalId);
  const target = journalEntryPath(layout, journalId, entryId);
  if (expectedDigest !== undefined) {
    if (typeof expectedDigest !== 'string' || !SHA256_DIGEST.test(expectedDigest)) {
      throw new TypeError('expectedDigest must be a lowercase SHA-256 digest');
    }
    const current = await readJsonWithDigest(directory, target).catch((error) => {
      if (error?.code === 'ENOENT'
          || (error?.code === 'MEMORY_PATH_UNSAFE' && error?.cause?.code === 'ENOENT')) return null;
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
    const {
      target: safeTarget, parentIdentity, fileIdentity,
    } = await safeFileTarget(directory, target, { mustExist: true });
    const current = await readJsonWithDigest(directory, target);
    const latest = await safeFileTarget(directory, target, { mustExist: true });
    if (!sameIdentity(fileIdentity, latest.fileIdentity)) throw directoryChangedError();
    if (expectedDigest !== undefined && current.digest !== expectedDigest) {
      throw new MemoryConflictError('digest', {
        expectedDigest,
        actualDigest: current.digest,
      });
    }
    await unlinkWithStableParent(safeTarget, parentIdentity);
    await syncDirectory(directory, parentIdentity);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT'
        || (error?.code === 'MEMORY_PATH_UNSAFE' && error?.cause?.code === 'ENOENT')) return false;
    throw error;
  }
}

export async function removeJournalDirectoryIfEmpty(layout, journalId) {
  assertLayout(layout);
  const directory = journalDirectory(layout, journalId);
  try {
    const {
      realDirectory, rootIdentity, directoryIdentity,
    } = await safeExistingDirectory(layout.journalsDir, directory);
    await Promise.all([revalidateDirectory(rootIdentity), revalidateDirectory(directoryIdentity)]);
    await fs.rmdir(realDirectory);
    await syncDirectory(layout.journalsDir, rootIdentity);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT'
        || (error?.code === 'MEMORY_PATH_UNSAFE' && error?.cause?.code === 'ENOENT')) return false;
    if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) return false;
    throw error;
  }
}
