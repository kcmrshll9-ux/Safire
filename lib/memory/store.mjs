import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HARD_MAX_DIRECTORY_ENTRIES_PER_OPERATION,
  assertSupportedMemoryVaultPath,
  createImmutableJson,
  createJsonExclusive,
  createJournalEntry,
  digestJson,
  ensureMemoryLayout,
  immutableCollectionDirectory,
  immutableRecordPath,
  journalDirectory,
  journalEntryPath,
  listDirectoryEntries,
  listImmutableJson,
  listJournalDirectories,
  listJournalEntries,
  readImmutableJson,
  readJsonWithDigest,
  removeJournalDirectoryIfEmpty,
  removeJournalEntry,
  replaceJsonOptimistic,
  resolveContainedPath,
  serializeJson,
  withVaultLock,
} from './filesystem.mjs';
import {
  assertNamespaceAccess,
  canReadNamespace,
  lookupActor,
  resolveAttribution,
  validateProfile,
} from './profile.mjs';
import {
  MEMORY_ACTOR_SCHEMA,
  MEMORY_EVENT_SCHEMA,
  MEMORY_FEEDBACK_SCHEMA,
  MEMORY_ITEM_SCHEMA,
  MEMORY_MANIFEST_SCHEMA,
  assertRecordBelongsToManifest,
  buildActorRecord,
  buildEventRecord,
  buildFeedbackRecord,
  buildMemoryRecord,
  buildVaultManifest,
  canonicalJson,
  digestRecord,
  newOpaqueId,
  persistedRequestDigest,
  regenerateVaultManifest,
  requestDigest,
  sourceKeyDigest,
  verifyRecordIntegrity,
} from './records.mjs';
import { createTrustedBridge } from './trusted-bridge.mjs';
import {
  ACTOR_TYPES,
  EVENT_KINDS,
  MEMORY_SCHEMA_VERSION,
  canonicalizeNamespace,
  containsDisallowedSensitiveMaterial,
  parseEventInput,
  parseFeedbackInput,
  parseOpaqueId,
} from './schema.mjs';
import {
  HARD_MAX_SEARCH_CANDIDATES,
  HARD_MAX_SEARCH_RESULTS,
  rankMemoryEvents,
} from './search.mjs';

const IDEMPOTENCY_SCHEMA = 'safire.memory.idempotency/v1';
const TRANSACTION_SCHEMA = 'safire.memory.transaction/v1';
const BATCH_TRANSACTION_SCHEMA = 'safire.memory.batch-transaction/v1';
const BATCH_GUARD_SCHEMA = 'safire.memory.batch-guard/v1';
const BATCH_RECEIPT_SCHEMA = 'safire.memory.batch-receipt/v1';
const BATCH_PROTOCOL = 'guard-receipt/v1';
const JOURNAL_ID = 'ingestion';
const BATCH_GUARD_JOURNAL_ID = 'ingestion-batch-guard';
const BATCH_GUARD_ENTRY_ID = 'active-batch';
const MAX_BATCH_SIZE = 100;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

export const HARD_MEMORY_RESOURCE_LIMITS = Object.freeze({
  readConcurrency: 64,
  maxDirectoryEntriesPerOperation: HARD_MAX_DIRECTORY_ENTRIES_PER_OPERATION,
  maxRecordsPerRequest: 50_000,
  maxBytesPerRequest: 128 * 1024 * 1024,
  maxSearchCandidates: HARD_MAX_SEARCH_CANDIDATES,
  maxSearchResults: HARD_MAX_SEARCH_RESULTS,
  maxRecordsPerProfile: 10_000,
  maxBytesPerProfile: 64 * 1024 * 1024,
  maxRecordsPerNamespace: 5_000,
  maxBytesPerNamespace: 32 * 1024 * 1024,
  maxFeedbackExpansion: 256,
  maxRelationExpansion: 512,
  maxBatchSize: MAX_BATCH_SIZE,
});

export const DEFAULT_MEMORY_RESOURCE_LIMITS = Object.freeze({
  readConcurrency: 8,
  maxDirectoryEntriesPerOperation: HARD_MEMORY_RESOURCE_LIMITS.maxDirectoryEntriesPerOperation,
  maxRecordsPerRequest: HARD_MEMORY_RESOURCE_LIMITS.maxRecordsPerRequest,
  maxBytesPerRequest: HARD_MEMORY_RESOURCE_LIMITS.maxBytesPerRequest,
  maxSearchCandidates: HARD_MEMORY_RESOURCE_LIMITS.maxSearchCandidates,
  maxSearchResults: HARD_MEMORY_RESOURCE_LIMITS.maxSearchResults,
  maxRecordsPerProfile: HARD_MEMORY_RESOURCE_LIMITS.maxRecordsPerProfile,
  maxBytesPerProfile: HARD_MEMORY_RESOURCE_LIMITS.maxBytesPerProfile,
  maxRecordsPerNamespace: HARD_MEMORY_RESOURCE_LIMITS.maxRecordsPerNamespace,
  maxBytesPerNamespace: HARD_MEMORY_RESOURCE_LIMITS.maxBytesPerNamespace,
  maxFeedbackExpansion: HARD_MEMORY_RESOURCE_LIMITS.maxFeedbackExpansion,
  maxRelationExpansion: HARD_MEMORY_RESOURCE_LIMITS.maxRelationExpansion,
  maxBatchSize: HARD_MEMORY_RESOURCE_LIMITS.maxBatchSize,
});

const RESOURCE_LIMIT_KEYS = new Set(Object.keys(DEFAULT_MEMORY_RESOURCE_LIMITS));

let createTrustedStoreAccess;

const ACTOR_KIND_GRANTS = Object.freeze({
  user: Object.freeze([
    'visible_user_message',
    'supplied_file',
    'supplied_link',
    'user_result_interaction',
  ]),
  agent: Object.freeze([
    'visible_agent_response',
    'delegated_instruction',
    'tool_prompt',
    'tool_call',
    'observable_action',
    'explicit_conclusion',
  ]),
  agent_instance: Object.freeze([
    'visible_agent_response',
    'delegated_instruction',
    'tool_prompt',
    'tool_call',
    'observable_action',
    'explicit_conclusion',
  ]),
  automation: Object.freeze([
    'automation_decision',
    'delegated_instruction',
    'tool_prompt',
    'tool_call',
    'observable_action',
    'explicit_conclusion',
  ]),
  external_service: Object.freeze([
    'tool_result',
    'external_observation',
  ]),
  system: Object.freeze([
    'tool_result',
    'observable_action',
    'external_observation',
  ]),
  unknown: Object.freeze([
    'external_observation',
  ]),
});

export class MemoryStoreError extends Error {
  constructor(message, { code = 'MEMORY_STORE_ERROR', details, cause } = {}) {
    super(message, { cause });
    this.name = 'MemoryStoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class MemoryDisabledError extends MemoryStoreError {
  constructor() {
    super('Safire memory is disabled for this integration', { code: 'MEMORY_DISABLED' });
    this.name = 'MemoryDisabledError';
  }
}

export class MemoryNotFoundError extends MemoryStoreError {
  constructor() {
    super('Memory record was not found or is not accessible', { code: 'MEMORY_NOT_FOUND' });
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryIdempotencyConflictError extends MemoryStoreError {
  constructor() {
    super('The trusted source event ID was already used with a different payload', {
      code: 'MEMORY_IDEMPOTENCY_CONFLICT',
    });
    this.name = 'MemoryIdempotencyConflictError';
  }
}

export class MemoryResourceLimitError extends MemoryStoreError {
  constructor() {
    super('Safire memory resource limit exceeded', { code: 'MEMORY_RESOURCE_LIMIT' });
    this.name = 'MemoryResourceLimitError';
  }
}

function normalizeResourceLimits(value) {
  if (value === undefined) return DEFAULT_MEMORY_RESOURCE_LIMITS;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('MemoryStore resourceLimits must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!RESOURCE_LIMIT_KEYS.has(key)) throw new TypeError('MemoryStore resourceLimits contains an unsupported field');
  }
  const limits = { ...DEFAULT_MEMORY_RESOURCE_LIMITS, ...value };
  for (const [key, limit] of Object.entries(limits)) {
    const permitsZero = key === 'maxFeedbackExpansion' || key === 'maxRelationExpansion';
    if (!Number.isSafeInteger(limit) || limit < (permitsZero ? 0 : 1)) {
      throw new TypeError('MemoryStore resource limits must be non-negative safe integers');
    }
    if (limit > HARD_MEMORY_RESOURCE_LIMITS[key]) {
      throw new TypeError('MemoryStore resource limits cannot exceed hard maximums');
    }
  }
  return Object.freeze(limits);
}

class RequestBudget {
  constructor(limits) {
    this.limits = limits;
    this.directoryEntries = 0;
    this.records = 0;
    this.bytes = 0;
  }

  reserveDirectoryEntries(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0
        || this.directoryEntries + count > this.limits.maxDirectoryEntriesPerOperation) {
      throw new MemoryResourceLimitError();
    }
    this.directoryEntries += count;
  }

  reserve(records, bytes) {
    if (!Number.isSafeInteger(records) || records < 0
        || !Number.isSafeInteger(bytes) || bytes < 0
        || this.records + records > this.limits.maxRecordsPerRequest
        || this.bytes + bytes > this.limits.maxBytesPerRequest) {
      throw new MemoryResourceLimitError();
    }
    this.records += records;
    this.bytes += bytes;
  }
}

class ExpansionBudget {
  constructor(limits) {
    this.limits = limits;
    this.feedback = 0;
    this.relations = 0;
  }

  reserveFeedback(count) {
    if (this.feedback + count > this.limits.maxFeedbackExpansion) {
      throw new MemoryResourceLimitError();
    }
    this.feedback += count;
  }

  reserveRelations(count) {
    if (this.relations + count > this.limits.maxRelationExpansion) {
      throw new MemoryResourceLimitError();
    }
    this.relations += count;
  }
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!failed && nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await operation(values[index], index);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

function normalizeExpansionOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new MemoryStoreError('Memory expansion options are invalid', { code: 'MEMORY_QUERY_INVALID' });
  }
  for (const key of Object.keys(options)) {
    if (!['includeFeedback', 'includeRelations'].includes(key)) {
      throw new MemoryStoreError('Memory expansion options are invalid', { code: 'MEMORY_QUERY_INVALID' });
    }
  }
  if ((options.includeFeedback !== undefined && typeof options.includeFeedback !== 'boolean')
      || (options.includeRelations !== undefined && typeof options.includeRelations !== 'boolean')) {
    throw new MemoryStoreError('Memory expansion options are invalid', { code: 'MEMORY_QUERY_INVALID' });
  }
  return {
    includeFeedback: options.includeFeedback === true,
    includeRelations: options.includeRelations === true,
  };
}

function serializedByteLength(value) {
  return Buffer.byteLength(serializeJson(value));
}

function requestByteLength(value) {
  return Buffer.byteLength(canonicalJson(value));
}

function sealRecord(record) {
  return {
    ...record,
    integrity: { algorithm: 'sha256', digest: digestRecord(record) },
  };
}

function asIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MemoryStoreError('The memory clock returned an invalid time');
  return date.toISOString();
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function missingAsNull(operation) {
  try {
    return await operation();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assertBatch(values, label, configuredMaximum = MAX_BATCH_SIZE) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_BATCH_SIZE) {
    throw new MemoryStoreError(`${label} must contain 1 through ${MAX_BATCH_SIZE} records`, {
      code: 'MEMORY_BATCH_INVALID',
    });
  }
  if (values.length > configuredMaximum) throw new MemoryResourceLimitError();
}

function assertManifest(manifest) {
  if (manifest?.schema !== MEMORY_MANIFEST_SCHEMA
      || manifest.schema_version !== MEMORY_SCHEMA_VERSION
      || !Number.isSafeInteger(manifest.revision)
      || manifest.revision < 1
      || !Array.isArray(manifest.lineage)
      || !verifyRecordIntegrity(manifest)) {
    throw new MemoryStoreError('The Safire memory manifest is invalid or corrupt', {
      code: 'MEMORY_MANIFEST_INVALID',
    });
  }
  parseOpaqueId(manifest.vault_id);
  for (const vaultId of manifest.lineage) parseOpaqueId(vaultId);
  return manifest;
}

function assertStoredRecord(record, manifest, schema) {
  if (record?.schema !== schema || record.schema_version !== MEMORY_SCHEMA_VERSION) {
    throw new MemoryStoreError('A versioned memory record is invalid', { code: 'MEMORY_RECORD_INVALID' });
  }
  return assertRecordBelongsToManifest(record, manifest);
}

function assertSealedMetadata(record, manifest, schema) {
  if (record?.schema !== schema
      || record.schema_version !== MEMORY_SCHEMA_VERSION
      || !verifyRecordIntegrity(record)) {
    throw new MemoryStoreError('Memory transaction metadata is invalid', { code: 'MEMORY_TRANSACTION_INVALID' });
  }
  const accepted = new Set([manifest.vault_id, ...(manifest.lineage || [])]);
  if (!accepted.has(record.vault_id)) {
    throw new MemoryStoreError('Memory transaction belongs to another vault', {
      code: 'MEMORY_VAULT_MISMATCH',
    });
  }
  return record;
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    profile_id: profile.profile_id,
    profile_type: profile.profile_type,
    principal: profile.principal,
    agent_instance: profile.agent_instance,
    ingested_by: profile.ingested_by,
    source_identity: profile.source_identity,
    namespace_grants: profile.namespace_grants,
    allowed_actors: profile.allowed_actors,
    trust: profile.trust,
  };
}

function eventActorReference(profile, input) {
  const id = input.actor_id
    || (input.actor_type === 'agent_instance' ? profile.agent_instance.id : profile.principal.id);
  return { id, type: input.actor_type };
}

function assertKindActorCoherence(input, actor) {
  if (!ACTOR_KIND_GRANTS[actor.type]?.includes(input.kind)) {
    throw new MemoryStoreError('The event kind is not valid for the attributed actor type', {
      code: 'MEMORY_ACTOR_KIND_MISMATCH',
    });
  }
}

function assertAttributionMatchesInput(input, attribution) {
  if (input.agent_instance_id && input.agent_instance_id !== attribution.agent_instance?.id) {
    throw new MemoryStoreError('agent_instance_id does not match the configured integration instance', {
      code: 'MEMORY_ATTRIBUTION_MISMATCH',
    });
  }
  if (input.delegated_by && input.delegated_by !== attribution.delegated_by?.id) {
    throw new MemoryStoreError('delegated_by does not match the configured delegation', {
      code: 'MEMORY_ATTRIBUTION_MISMATCH',
    });
  }
  if (input.actor_id && input.actor_id !== attribution.actor.id) {
    throw new MemoryStoreError('actor_id does not match the authorized actor', {
      code: 'MEMORY_ATTRIBUTION_MISMATCH',
    });
  }
}

function idempotencyIdentity(operation, keyDigest) {
  return `${operation}:${keyDigest}`;
}

function batchReceiptIdentity(batchId) {
  return `batch-receipt:${batchId}`;
}

function sameFilesystemPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function actorIdentityMatches(stored, configured) {
  return stored?.id === configured.id
    && stored.type === configured.type
    && (stored.delegated_by || null) === (configured.delegated_by || null);
}

function incomingRelationsFor(events, targetEventId, expansionBudget = null) {
  const incoming = [];
  for (const event of events) {
    for (const relation of event.relations || []) {
      if (relation.target_event_id !== targetEventId) continue;
      expansionBudget?.reserveRelations(1);
      incoming.push({ type: relation.type, source_event_id: event.event_id });
    }
  }
  return incoming.sort((left, right) => (
      left.source_event_id.localeCompare(right.source_event_id)
      || left.type.localeCompare(right.type)
  ));
}

function incomingRelationsForTargets(events, targetEventIds, expansionBudget) {
  const incoming = new Map([...targetEventIds].map(eventId => [eventId, []]));
  for (const event of events) {
    for (const relation of event.relations || []) {
      const relations = incoming.get(relation.target_event_id);
      if (!relations) continue;
      expansionBudget.reserveRelations(1);
      relations.push({ type: relation.type, source_event_id: event.event_id });
    }
  }
  for (const relations of incoming.values()) {
    relations.sort((left, right) => (
      left.source_event_id.localeCompare(right.source_event_id)
      || left.type.localeCompare(right.type)
    ));
  }
  return incoming;
}

function visibleEventProjection(event, readableEventIds) {
  const relations = (event.relations || [])
    .filter((relation) => readableEventIds.has(relation.target_event_id));
  const derivedIsReadable = !event.derived || event.derived.source_event_ids
    .every((eventId) => readableEventIds.has(eventId));
  const projection = {
    ...event,
    relations,
    derived: derivedIsReadable ? event.derived : null,
  };
  delete projection.integrity;
  return projection;
}

function visibleMemoryProjection(memory) {
  const projection = { ...memory };
  delete projection.source_event_ids;
  delete projection.integrity;
  return projection;
}

function visibleFeedbackProjection(feedback, readableEventIds, readableMemoryIds) {
  if (!feedback.related_target) return feedback;
  const readable = feedback.related_target.type === 'event'
    ? readableEventIds.has(feedback.related_target.id)
    : readableMemoryIds.has(feedback.related_target.id);
  return readable ? feedback : null;
}

function feedbackTargetKey(target) {
  return `${target.type}\u0000${target.id}`;
}

function feedbackByTarget(records) {
  const index = new Map();
  for (const record of records) {
    const key = feedbackTargetKey(record.target);
    const targetRecords = index.get(key) || [];
    targetRecords.push(record);
    index.set(key, targetRecords);
  }
  return index;
}

function transactionIdentity(operation, keyDigest) {
  return `${operation}:${keyDigest}`;
}

function batchTransactionIdentity(operation, batchId) {
  return `${operation}_batch:${batchId}`;
}

export class MemoryStore {
  #vaultDir;

  #enabled;

  #profile;

  #now;

  #idFactory;

  #faultInjector;

  #resourceLimits;

  #layout = null;

  #initialization = null;

  #trustedIngressCapability = null;

  static {
    createTrustedStoreAccess = (options) => {
      const store = new MemoryStore(options);
      const capability = Object.freeze(Object.create(null));
      store.#trustedIngressCapability = capability;
      const facade = Object.assign(Object.create(null), {
        initialize: (...args) => store.#initializeApi(...args),
        recordEvents: rawEvents => store.#recordEvents(rawEvents, undefined),
        recordFeedback: rawFeedback => store.#recordFeedback(rawFeedback, undefined),
        search: (...args) => store.#search(...args),
        get: (...args) => store.#get(...args),
        recall: (...args) => store.#recall(...args),
        status: (...args) => store.#status(...args),
        regenerateVaultIdentity: (...args) => store.#regenerateVaultIdentity(...args),
      });
      Object.defineProperties(facade, {
        enabled: { enumerable: true, get: () => store.#enabled },
        profile: { enumerable: true, get: () => store.#profile },
      });
      return Object.freeze({
        facade,
        profile: store.#profile,
        recordEvents: rawEvents => store.#recordEvents(rawEvents, capability),
        recordFeedback: rawFeedback => store.#recordFeedback(rawFeedback, capability),
      });
    };
  }

  constructor(options = {}) {
    const {
      vaultDir,
      profile,
      enabled = true,
      now = () => new Date(),
      idFactory = newOpaqueId,
      faultInjector = null,
      resourceLimits,
    } = options;
    if (typeof vaultDir !== 'string' || !vaultDir.trim()) {
      throw new MemoryStoreError('An explicit vault directory is required', { code: 'MEMORY_VAULT_REQUIRED' });
    }
    assertSupportedMemoryVaultPath(vaultDir);
    if (!path.isAbsolute(vaultDir)) {
      throw new MemoryStoreError('The vault directory must be an absolute non-root path', {
        code: 'MEMORY_VAULT_REQUIRED',
      });
    }
    const resolvedVaultDir = path.resolve(vaultDir);
    if (sameFilesystemPath(resolvedVaultDir, path.parse(resolvedVaultDir).root)) {
      throw new MemoryStoreError('The vault directory must be an absolute non-root path', {
        code: 'MEMORY_VAULT_REQUIRED',
      });
    }
    this.#vaultDir = resolvedVaultDir;
    this.#enabled = Boolean(enabled);
    this.#profile = profile ? validateProfile(profile) : null;
    if (this.#enabled && !this.#profile) {
      throw new MemoryStoreError('An enabled memory store requires a validated agent profile', {
        code: 'MEMORY_PROFILE_REQUIRED',
      });
    }
    if (Object.prototype.hasOwnProperty.call(options, 'trustedIngress')) {
      throw new MemoryStoreError(
        'The trustedIngress constructor option is not supported; use createTrustedMemoryBridge',
        { code: 'MEMORY_PROFILE_DENIED' },
      );
    }
    if (typeof now !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('MemoryStore now and idFactory options must be functions');
    }
    this.#now = now;
    this.#idFactory = idFactory;
    this.#faultInjector = faultInjector;
    this.#resourceLimits = normalizeResourceLimits(resourceLimits);
  }

  get vaultDir() {
    return this.#vaultDir;
  }

  get enabled() {
    return this.#enabled;
  }

  get profile() {
    return this.#profile;
  }

  get resourceLimits() {
    return this.#resourceLimits;
  }

  get layout() {
    return this.#layout;
  }

  #timestamp() {
    const now = this.#now;
    return asIsoTimestamp(now());
  }

  #assertEnabled() {
    if (!this.#enabled) throw new MemoryDisabledError();
  }

  async #ensureInitialized() {
    this.#assertEnabled();
    if (!this.#initialization) {
      this.#initialization = this.#initialize().catch((error) => {
        this.#initialization = null;
        throw error;
      });
    }
    return this.#initialization;
  }

  async initialize() {
    return this.#initializeApi();
  }

  async #initializeApi() {
    await this.#ensureInitialized();
    return withVaultLock(this.#layout, async () => {
      const manifest = (await this.#readManifest()).value;
      await this.#recoverTransactions(manifest);
      return { layout: this.#layout, manifest };
    });
  }

  async #initialize() {
    await fs.mkdir(this.#vaultDir, { recursive: true });
    this.#layout = await ensureMemoryLayout(this.#vaultDir);
    return withVaultLock(this.#layout, async (lock) => {
      const manifestState = await this.#ensureManifest();
      const manifest = assertManifest(manifestState.value);
      await this.#ensureProfileActors(manifest);
      await this.#recoverTransactions(manifest, lock);
      return { layout: this.#layout, manifest };
    });
  }

  #manifestPath() {
    return resolveContainedPath(this.#layout.rootDir, 'manifest.json');
  }

  async #ensureManifest() {
    let existing;
    try {
      existing = await missingAsNull(() => readJsonWithDigest(this.#layout.rootDir, this.#manifestPath()));
    } catch (error) {
      if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
      throw error;
    }
    if (existing) return existing;
    const directoryBudget = this.#requestBudget();
    const listBounded = async (rootDirectory, directory) => {
      try {
        return await listDirectoryEntries(rootDirectory, directory, {
          maxEntries: this.#resourceLimits.maxDirectoryEntriesPerOperation,
          onEntryExamined: count => directoryBudget.reserveDirectoryEntries(count),
        });
      } catch (error) {
        if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
        throw error;
      }
    };
    const [recordCollections, stateEntries, journalEntries] = await Promise.all([
      listBounded(this.#layout.recordsDir, this.#layout.recordsDir),
      listBounded(this.#layout.stateDir, this.#layout.stateDir),
      listBounded(this.#layout.journalsDir, this.#layout.journalsDir),
    ]);
    let hasRecordData = recordCollections.some((entry) => entry.kind !== 'directory');
    for (const collection of recordCollections.filter((entry) => entry.kind === 'directory')) {
      const nested = await listBounded(
        this.#layout.recordsDir,
        path.join(this.#layout.recordsDir, collection.name),
      );
      if (nested.length > 0) {
        hasRecordData = true;
        break;
      }
    }
    if (hasRecordData || stateEntries.length > 0 || journalEntries.length > 0) {
      throw new MemoryStoreError('The memory manifest is missing from a nonempty sidecar', {
        code: 'MEMORY_MANIFEST_MISSING',
      });
    }
    const manifest = buildVaultManifest({ createdAt: this.#timestamp() });
    try {
      return await createJsonExclusive(this.#layout.rootDir, this.#manifestPath(), manifest);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        return await readJsonWithDigest(this.#layout.rootDir, this.#manifestPath());
      } catch (readError) {
        if (readError?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
        throw readError;
      }
    }
  }

  async #readManifest() {
    let state;
    try {
      state = await readJsonWithDigest(this.#layout.rootDir, this.#manifestPath());
    } catch (error) {
      if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
      throw error;
    }
    assertManifest(state.value);
    return state;
  }

  async #withConsistentVault(operation) {
    await this.#ensureInitialized();
    return withVaultLock(this.#layout, async (lock) => {
      const manifest = (await this.#readManifest()).value;
      await this.#recoverTransactions(manifest);
      return operation(manifest, lock);
    });
  }

  async #ensureProfileActors(manifest) {
    const actors = [this.#profile.principal, this.#profile.agent_instance, ...this.#profile.allowed_actors];
    for (const actor of actors) {
      const existing = await missingAsNull(() => this.#readImmutableState('actors', actor.id));
      if (existing) {
        const stored = assertStoredRecord(existing.value, manifest, MEMORY_ACTOR_SCHEMA);
        if (!actorIdentityMatches(stored.actor, actor)) {
          throw new MemoryStoreError('A stable actor ID is already registered with another type', {
            code: 'MEMORY_ACTOR_CONFLICT',
          });
        }
        continue;
      }
      const record = buildActorRecord({ vaultId: manifest.vault_id, actor, createdAt: this.#timestamp() });
      try {
        await createImmutableJson(this.#layout, 'actors', actor.id, record);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const raced = await this.#readImmutableState('actors', actor.id);
        const stored = assertStoredRecord(raced.value, manifest, MEMORY_ACTOR_SCHEMA);
        if (!actorIdentityMatches(stored.actor, actor)) {
          throw new MemoryStoreError('A stable actor ID is already registered with another type', {
            code: 'MEMORY_ACTOR_CONFLICT',
          });
        }
      }
    }
  }

  async #fault(stage, metadata) {
    const faultInjector = this.#faultInjector;
    if (typeof faultInjector === 'function') {
      await faultInjector(stage, Object.freeze({ ...metadata }));
    }
  }

  #requestBudget(value = null, records = 0) {
    const budget = new RequestBudget(this.#resourceLimits);
    if (value !== null) budget.reserve(records, requestByteLength(value));
    return budget;
  }

  async #readImmutableState(collection, identity, budget = null) {
    let reservedBytes = 0;
    if (budget) {
      const target = immutableRecordPath(this.#layout, collection, identity);
      const stat = await fs.lstat(target);
      reservedBytes = Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0;
      budget.reserve(1, reservedBytes);
    }
    await this.#fault('before_direct_record_read', { collection });
    let state;
    try {
      state = await readImmutableJson(
        this.#layout,
        collection,
        identity,
        budget ? { maxBytes: reservedBytes } : {},
      );
    } catch (error) {
      if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
      throw error;
    }
    if (budget && state.byteLength > reservedBytes) budget.reserve(0, state.byteLength - reservedBytes);
    return state;
  }

  async #listCollection(collection, budget = null) {
    const directory = immutableCollectionDirectory(this.#layout, collection);
    let entries;
    try {
      entries = await listImmutableJson(this.#layout, collection, {
        maxEntries: this.#resourceLimits.maxDirectoryEntriesPerOperation,
        ...(budget
          ? { onEntryExamined: count => budget.reserveDirectoryEntries(count) }
          : {}),
      });
    } catch (error) {
      if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
      throw error;
    }
    let reservedSizes = null;
    if (budget) {
      budget.reserve(entries.length, 0);
      const stats = await mapWithConcurrency(
        entries,
        this.#resourceLimits.readConcurrency,
        entry => fs.lstat(entry.path),
      );
      budget.reserve(0, stats.reduce((total, stat) => {
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || total > Number.MAX_SAFE_INTEGER - stat.size) {
          throw new MemoryResourceLimitError();
        }
        return total + stat.size;
      }, 0));
      reservedSizes = stats.map(stat => stat.size);
    }
    return mapWithConcurrency(entries, this.#resourceLimits.readConcurrency, async (entry, index) => {
      await this.#fault('before_collection_record_read', { collection });
      try {
        let state;
        try {
          state = await readJsonWithDigest(
            directory,
            entry.path,
            budget ? { maxBytes: reservedSizes[index] } : {},
          );
        } catch (error) {
          if (error?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
          throw error;
        }
        if (budget && state.byteLength > reservedSizes[index]) {
          budget.reserve(0, state.byteLength - reservedSizes[index]);
        }
        return state;
      } finally {
        await this.#fault('after_collection_record_read', { collection });
      }
    });
  }

  #assertCollectionIdentity(state, collection, identity) {
    const expectedPath = immutableRecordPath(this.#layout, collection, identity);
    if (!sameFilesystemPath(state.path, expectedPath)) {
      throw new MemoryStoreError('Memory record identity does not match its storage key', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
  }

  async #ensureImmutable(collection, identity, expected, manifest, schema, budget = null) {
    try {
      await createImmutableJson(this.#layout, collection, identity, expected);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = budget
        ? await this.#readImmutableState(collection, identity, budget)
        : await readImmutableJson(this.#layout, collection, identity);
      const stored = assertStoredRecord(existing.value, manifest, schema);
      if (stored.integrity.digest !== expected.integrity.digest) {
        throw new MemoryStoreError('An immutable memory ID collision was detected', {
          code: 'MEMORY_ID_CONFLICT',
        });
      }
      return false;
    }
  }

  async #uniqueId(prefix, collection, reserved = null) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const idFactory = this.#idFactory;
      const id = idFactory(prefix);
      parseOpaqueId(id);
      if (reserved?.has(id)) continue;
      const existing = await missingAsNull(() => readImmutableJson(this.#layout, collection, id));
      if (!existing) {
        reserved?.add(id);
        return id;
      }
    }
    throw new MemoryStoreError('Unable to allocate an exclusive memory ID', { code: 'MEMORY_ID_CONFLICT' });
  }

  async #readEvent(eventId, manifest, budget = null) {
    parseOpaqueId(eventId);
    const state = await missingAsNull(() => this.#readImmutableState('events', eventId, budget));
    if (!state) throw new MemoryNotFoundError();
    const event = assertStoredRecord(state.value, manifest, MEMORY_EVENT_SCHEMA);
    if (event.event_id !== eventId) {
      throw new MemoryStoreError('Event record identity does not match its storage key', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
    return event;
  }

  async #readMemory(memoryId, manifest, budget = null) {
    parseOpaqueId(memoryId);
    const state = await missingAsNull(() => this.#readImmutableState('memories', memoryId, budget));
    if (!state) throw new MemoryNotFoundError();
    const memory = assertStoredRecord(state.value, manifest, MEMORY_ITEM_SCHEMA);
    if (memory.memory_id !== memoryId) {
      throw new MemoryStoreError('Memory record identity does not match its storage key', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
    return memory;
  }

  async #assertReferencesAccessible(input, manifest, budget = null) {
    const references = new Set([
      ...(input.relations || []).map((relation) => relation.target_event_id),
      ...(input.derived?.source_event_ids || []),
    ]);
    for (const eventId of references) {
      const target = await this.#readEvent(eventId, manifest, budget);
      const memory = await this.#readMemory(target.memory_id, manifest, budget);
      if (memory.event_id !== target.event_id) {
        throw new MemoryStoreError('Event and memory records do not link to each other', {
          code: 'MEMORY_RECORD_INVALID',
        });
      }
      await this.#assertEventCommitted(target, memory, manifest, budget);
      try {
        assertNamespaceAccess(this.#profile, target.namespace, 'read');
      } catch {
        throw new MemoryNotFoundError();
      }
    }
  }

  async #readMarker(operation, sourceKey, manifest, budget = null) {
    const identity = idempotencyIdentity(operation, sourceKey);
    const state = await missingAsNull(() => this.#readImmutableState(
      'idempotency', identity, budget,
    ));
    if (!state) return null;
    const marker = assertSealedMetadata(state.value, manifest, IDEMPOTENCY_SCHEMA);
    if (marker.operation !== operation || marker.source_key_digest !== sourceKey) {
      throw new MemoryStoreError('Idempotency metadata is inconsistent', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    await this.#assertMarkerBatchReceipt(marker, manifest, budget);
    return marker;
  }

  #assertEventMarker(marker, event, memory) {
    const idempotency = this.#recordIdempotency(event);
    if (!marker
        || marker.operation !== 'event'
        || marker.source_key_digest !== idempotency.source_key_digest
        || marker.request_digest !== idempotency.request_digest
        || marker.event_id !== event.event_id
        || marker.memory_id !== memory.memory_id
        || marker.record_digest !== event.integrity.digest
        || memory.event_id !== event.event_id
        || event.memory_id !== memory.memory_id) {
      throw new MemoryStoreError('Committed event metadata failed verification', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return marker;
  }

  #assertFeedbackMarker(marker, feedback) {
    const idempotency = this.#recordIdempotency(feedback);
    if (!marker
        || marker.operation !== 'feedback'
        || marker.source_key_digest !== idempotency.source_key_digest
        || marker.request_digest !== idempotency.request_digest
        || marker.feedback_id !== feedback.feedback_id
        || marker.record_digest !== feedback.integrity.digest) {
      throw new MemoryStoreError('Committed feedback metadata failed verification', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return marker;
  }

  #recordIdempotency(record) {
    const idempotency = record?.idempotency;
    if (!idempotency
        || typeof idempotency !== 'object'
        || Array.isArray(idempotency)
        || !SHA256_DIGEST.test(idempotency.source_key_digest)
        || !SHA256_DIGEST.test(idempotency.request_digest)) {
      throw new MemoryStoreError('Memory idempotency metadata is invalid', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return idempotency;
  }

  async #assertEventCommitted(event, memory, manifest, budget = null) {
    const idempotency = this.#recordIdempotency(event);
    const marker = await this.#readMarker(
      'event', idempotency.source_key_digest, manifest, budget,
    );
    return this.#assertEventMarker(marker, event, memory);
  }

  async #assertFeedbackCommitted(feedback, manifest, budget = null) {
    const idempotency = this.#recordIdempotency(feedback);
    const marker = await this.#readMarker(
      'feedback', idempotency.source_key_digest, manifest, budget,
    );
    return this.#assertFeedbackMarker(marker, feedback);
  }

  async #recordsBySource(operation, manifest, budget) {
    const eventOperation = operation === 'event';
    const collection = eventOperation ? 'events' : 'feedback';
    const schema = eventOperation ? MEMORY_EVENT_SCHEMA : MEMORY_FEEDBACK_SCHEMA;
    const identityKey = eventOperation ? 'event_id' : 'feedback_id';
    const states = await this.#listCollection(collection, budget);
    const records = new Map();
    for (const state of states) {
      const record = assertStoredRecord(state.value, manifest, schema);
      this.#assertCollectionIdentity(state, collection, record[identityKey]);
      const sourceKey = this.#recordIdempotency(record).source_key_digest;
      const matching = records.get(sourceKey) || [];
      matching.push(record);
      records.set(sourceKey, matching);
    }
    return records;
  }

  #assertSourceMarkerUnique(operation, recordsBySource, sourceKey, marker) {
    const matches = recordsBySource.get(sourceKey) || [];
    const identityKey = operation === 'event' ? 'event_id' : 'feedback_id';
    if ((!marker && matches.length > 0)
        || (marker && (matches.length !== 1 || matches[0][identityKey] !== marker[identityKey]))) {
      throw new MemoryStoreError('Idempotency metadata is missing or inconsistent', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
  }

  #buildTransaction(operation, sourceKey, requestHash, payload, manifest) {
    return sealRecord({
      schema: TRANSACTION_SCHEMA,
      schema_version: MEMORY_SCHEMA_VERSION,
      vault_id: manifest.vault_id,
      operation,
      transaction_id: transactionIdentity(operation, sourceKey),
      source_key_digest: sourceKey,
      request_digest: requestHash,
      created_at: this.#timestamp(),
      ...payload,
    });
  }

  async #createBatchTransaction(operation, transactions, manifest, budget = null) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const idFactory = this.#idFactory;
      const batchId = idFactory('bat');
      parseOpaqueId(batchId);
      const identity = batchTransactionIdentity(operation, batchId);
      const batchLink = {
        protocol: BATCH_PROTOCOL,
        operation: `${operation}_batch`,
        batch_id: batchId,
        batch_transaction_id: identity,
        transaction_count: transactions.length,
      };
      const protectedTransactions = transactions.map((child) => {
        const { integrity: _integrity, ...unsigned } = child;
        return sealRecord({ ...unsigned, batch: batchLink });
      });
      const transaction = sealRecord({
        schema: BATCH_TRANSACTION_SCHEMA,
        schema_version: MEMORY_SCHEMA_VERSION,
        vault_id: manifest.vault_id,
        operation: `${operation}_batch`,
        transaction_id: identity,
        batch_id: batchId,
        protocol: BATCH_PROTOCOL,
        created_at: this.#timestamp(),
        transactions: protectedTransactions,
      });
      const existingReceipt = await missingAsNull(() => this.#readImmutableState(
        'idempotency',
        batchReceiptIdentity(batchId),
        budget,
      ));
      if (existingReceipt) continue;
      try {
        const state = await createJournalEntry(this.#layout, JOURNAL_ID, identity, transaction);
        const guardState = await this.#createBatchGuard(state, manifest);
        return { ...state, guardState, resumed: false };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new MemoryStoreError('Unable to allocate an exclusive batch transaction ID', {
      code: 'MEMORY_ID_CONFLICT',
    });
  }

  async #createBatchGuard(transactionState, manifest) {
    const batch = assertSealedMetadata(
      transactionState.value,
      manifest,
      BATCH_TRANSACTION_SCHEMA,
    );
    const guard = sealRecord({
      schema: BATCH_GUARD_SCHEMA,
      schema_version: MEMORY_SCHEMA_VERSION,
      vault_id: batch.vault_id,
      operation: batch.operation,
      transaction_id: batch.transaction_id,
      batch_id: batch.batch_id,
      protocol: batch.protocol || null,
      journal_digest: transactionState.digest,
      transaction_count: batch.transactions.length,
      created_at: batch.created_at,
    });
    try {
      return await createJournalEntry(
        this.#layout,
        BATCH_GUARD_JOURNAL_ID,
        BATCH_GUARD_ENTRY_ID,
        guard,
      );
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      throw new MemoryStoreError('An active memory batch guard already exists', {
        code: 'MEMORY_TRANSACTION_INVALID', cause,
      });
    }
  }

  #validateBatchGuard(guardState, transactionState, manifest) {
    const guard = assertSealedMetadata(guardState.value, manifest, BATCH_GUARD_SCHEMA);
    const batch = assertSealedMetadata(
      transactionState.value,
      manifest,
      BATCH_TRANSACTION_SCHEMA,
    );
    if (guard.operation !== batch.operation
        || guard.transaction_id !== batch.transaction_id
        || guard.batch_id !== batch.batch_id
        || guard.protocol !== (batch.protocol || null)
        || guard.journal_digest !== transactionState.digest
        || guard.transaction_count !== batch.transactions.length) {
      throw new MemoryStoreError('Memory batch guard does not match its journal', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return guard;
  }

  async #cleanupBatchTransaction(transactionState) {
    const guardState = transactionState.guardState;
    if (!guardState) {
      throw new MemoryStoreError('Memory batch guard is missing', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    await removeJournalEntry(
      this.#layout,
      BATCH_GUARD_JOURNAL_ID,
      BATCH_GUARD_ENTRY_ID,
      { expectedDigest: guardState.digest },
    );
    await removeJournalDirectoryIfEmpty(this.#layout, BATCH_GUARD_JOURNAL_ID);
    await this.#cleanupTransaction(transactionState);
  }

  async #cleanupTransaction(transactionState) {
    const transaction = transactionState.value;
    await removeJournalEntry(
      this.#layout,
      JOURNAL_ID,
      transaction.transaction_id,
      { expectedDigest: transactionState.digest },
    );
    await removeJournalDirectoryIfEmpty(this.#layout, JOURNAL_ID);
  }

  #markerForEvent(transaction) {
    return sealRecord({
      schema: IDEMPOTENCY_SCHEMA,
      schema_version: MEMORY_SCHEMA_VERSION,
      vault_id: transaction.vault_id,
      operation: 'event',
      source_key_digest: transaction.source_key_digest,
      request_digest: transaction.request_digest,
      event_id: transaction.event.event_id,
      memory_id: transaction.memory.memory_id,
      record_digest: transaction.event.integrity.digest,
      committed_at: transaction.created_at,
      ...(transaction.batch ? { batch: transaction.batch } : {}),
    });
  }

  #markerForFeedback(transaction) {
    return sealRecord({
      schema: IDEMPOTENCY_SCHEMA,
      schema_version: MEMORY_SCHEMA_VERSION,
      vault_id: transaction.vault_id,
      operation: 'feedback',
      source_key_digest: transaction.source_key_digest,
      request_digest: transaction.request_digest,
      feedback_id: transaction.feedback.feedback_id,
      record_digest: transaction.feedback.integrity.digest,
      committed_at: transaction.created_at,
      ...(transaction.batch ? { batch: transaction.batch } : {}),
    });
  }

  #assertBatchLink(link, operation) {
    const expectedOperation = `${operation}_batch`;
    let expectedTransactionId;
    try {
      if (!link
          || typeof link !== 'object'
          || Array.isArray(link)
          || link.protocol !== BATCH_PROTOCOL
          || link.operation !== expectedOperation
          || !Number.isSafeInteger(link.transaction_count)
          || link.transaction_count < 1
          || link.transaction_count > MAX_BATCH_SIZE) {
        throw new TypeError('invalid batch link');
      }
      parseOpaqueId(link.batch_id);
      expectedTransactionId = batchTransactionIdentity(operation, link.batch_id);
    } catch (cause) {
      throw new MemoryStoreError('Memory batch membership metadata is invalid', {
        code: 'MEMORY_TRANSACTION_INVALID', cause,
      });
    }
    if (link.batch_transaction_id !== expectedTransactionId) {
      throw new MemoryStoreError('Memory batch membership metadata is inconsistent', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return link;
  }

  #batchMemberForMarker(marker) {
    const common = {
      source_key_digest: marker.source_key_digest,
      request_digest: marker.request_digest,
      record_digest: marker.record_digest,
    };
    return marker.operation === 'event'
      ? { ...common, event_id: marker.event_id, memory_id: marker.memory_id }
      : { ...common, feedback_id: marker.feedback_id };
  }

  #batchReceipt(batch) {
    const operation = batch.operation === 'event_batch' ? 'event' : 'feedback';
    const members = batch.transactions.map((child) => (
      this.#batchMemberForMarker(
        operation === 'event' ? this.#markerForEvent(child) : this.#markerForFeedback(child),
      )
    ));
    return sealRecord({
      schema: BATCH_RECEIPT_SCHEMA,
      schema_version: MEMORY_SCHEMA_VERSION,
      vault_id: batch.vault_id,
      protocol: BATCH_PROTOCOL,
      operation: batch.operation,
      transaction_id: batch.transaction_id,
      batch_id: batch.batch_id,
      transaction_count: batch.transactions.length,
      transaction_digest: batch.integrity.digest,
      committed_at: batch.created_at,
      members,
    });
  }

  async #ensureBatchReceipt(batch, manifest, injectFaults, budget = null) {
    if (batch.protocol !== BATCH_PROTOCOL) return null;
    const receipt = this.#batchReceipt(batch);
    await this.#ensureImmutable(
      'idempotency',
      batchReceiptIdentity(batch.batch_id),
      receipt,
      manifest,
      BATCH_RECEIPT_SCHEMA,
      budget,
    );
    if (injectFaults) {
      await this.#fault('after_batch_receipt_create', { batch_id: batch.batch_id });
    }
    return receipt;
  }

  #validateBatchReceipt(receipt, manifest) {
    const stored = assertSealedMetadata(receipt, manifest, BATCH_RECEIPT_SCHEMA);
    const operation = stored.operation === 'event_batch'
      ? 'event'
      : stored.operation === 'feedback_batch' ? 'feedback' : null;
    let expectedTransactionId;
    try {
      if (!operation
          || stored.protocol !== BATCH_PROTOCOL
          || !Number.isSafeInteger(stored.transaction_count)
          || stored.transaction_count < 1
          || stored.transaction_count > MAX_BATCH_SIZE
          || !Array.isArray(stored.members)
          || stored.members.length !== stored.transaction_count
          || !SHA256_DIGEST.test(stored.transaction_digest)) {
        throw new TypeError('invalid batch receipt');
      }
      parseOpaqueId(stored.batch_id);
      expectedTransactionId = batchTransactionIdentity(operation, stored.batch_id);
      const expectedKeys = operation === 'event'
        ? ['event_id', 'memory_id', 'record_digest', 'request_digest', 'source_key_digest']
        : ['feedback_id', 'record_digest', 'request_digest', 'source_key_digest'];
      const sourceKeys = new Set();
      const recordIds = new Set();
      for (const member of stored.members) {
        if (!member
            || typeof member !== 'object'
            || Array.isArray(member)
            || canonicalJson(Object.keys(member).sort()) !== canonicalJson(expectedKeys)
            || !SHA256_DIGEST.test(member.source_key_digest)
            || !SHA256_DIGEST.test(member.request_digest)
            || !SHA256_DIGEST.test(member.record_digest)) {
          throw new TypeError('invalid batch receipt member');
        }
        const ids = operation === 'event'
          ? [member.event_id, member.memory_id]
          : [member.feedback_id];
        for (const id of ids) parseOpaqueId(id);
        if (sourceKeys.has(member.source_key_digest)
            || ids.some(id => recordIds.has(id))) {
          throw new TypeError('duplicate batch receipt member');
        }
        sourceKeys.add(member.source_key_digest);
        for (const id of ids) recordIds.add(id);
      }
    } catch (cause) {
      throw new MemoryStoreError('Memory batch receipt is invalid', {
        code: 'MEMORY_TRANSACTION_INVALID', cause,
      });
    }
    if (stored.transaction_id !== expectedTransactionId) {
      throw new MemoryStoreError('Memory batch receipt identity is inconsistent', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return stored;
  }

  async #assertMarkerBatchReceipt(marker, manifest, budget) {
    if (marker.batch === undefined) return;
    const link = this.#assertBatchLink(marker.batch, marker.operation);
    const state = await missingAsNull(() => this.#readImmutableState(
      'idempotency',
      batchReceiptIdentity(link.batch_id),
      budget,
    ));
    if (!state) {
      throw this.#journalInvalid('Memory batch completion receipt is missing');
    }
    const receipt = this.#validateBatchReceipt(state.value, manifest);
    this.#assertCollectionIdentity(
      state,
      'idempotency',
      batchReceiptIdentity(receipt.batch_id),
    );
    const member = canonicalJson(this.#batchMemberForMarker(marker));
    const matchingMembers = receipt.members.filter(item => canonicalJson(item) === member);
    if (receipt.batch_id !== link.batch_id
        || receipt.operation !== link.operation
        || receipt.transaction_id !== link.batch_transaction_id
        || receipt.transaction_count !== link.transaction_count
        || matchingMembers.length !== 1) {
      throw this.#journalInvalid('Memory batch completion receipt is inconsistent');
    }
  }

  #validateEventTransaction(rawTransaction, manifest) {
    const transaction = assertSealedMetadata(rawTransaction, manifest, TRANSACTION_SCHEMA);
    const event = assertStoredRecord(transaction.event, manifest, MEMORY_EVENT_SCHEMA);
    const memory = assertStoredRecord(transaction.memory, manifest, MEMORY_ITEM_SCHEMA);
    const expectedTransactionId = transactionIdentity('event', transaction.source_key_digest);
    if (transaction.operation !== 'event'
        || transaction.transaction_id !== expectedTransactionId
        || event.idempotency?.source_key_digest !== transaction.source_key_digest
        || event.idempotency?.request_digest !== transaction.request_digest
        || memory.event_id !== event.event_id
        || event.memory_id !== memory.memory_id) {
      throw new MemoryStoreError('Event and memory transaction records do not link to each other', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return { transaction, event, memory, marker: this.#markerForEvent(transaction) };
  }

  #validateFeedbackTransaction(rawTransaction, manifest) {
    const transaction = assertSealedMetadata(rawTransaction, manifest, TRANSACTION_SCHEMA);
    const feedback = assertStoredRecord(transaction.feedback, manifest, MEMORY_FEEDBACK_SCHEMA);
    const expectedTransactionId = transactionIdentity('feedback', transaction.source_key_digest);
    if (transaction.operation !== 'feedback'
        || transaction.transaction_id !== expectedTransactionId
        || feedback.idempotency?.source_key_digest !== transaction.source_key_digest
        || feedback.idempotency?.request_digest !== transaction.request_digest) {
      throw new MemoryStoreError('Feedback transaction metadata is inconsistent', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return { transaction, feedback, marker: this.#markerForFeedback(transaction) };
  }

  async #assertImmutableCompatible(collection, identity, expected, manifest, schema, budget = null) {
    const existing = await missingAsNull(() => (budget
      ? this.#readImmutableState(collection, identity, budget)
      : readImmutableJson(this.#layout, collection, identity)));
    if (!existing) return;
    const stored = assertStoredRecord(existing.value, manifest, schema);
    if (stored.integrity.digest !== expected.integrity.digest) {
      throw new MemoryStoreError('An immutable memory ID collision was detected', {
        code: 'MEMORY_ID_CONFLICT',
      });
    }
  }

  async #preflightEventTransaction(rawTransaction, manifest, budget = null) {
    const validated = this.#validateEventTransaction(rawTransaction, manifest);
    await Promise.all([
      this.#assertImmutableCompatible(
        'events', validated.event.event_id, validated.event, manifest, MEMORY_EVENT_SCHEMA, budget,
      ),
      this.#assertImmutableCompatible(
        'memories', validated.memory.memory_id, validated.memory, manifest, MEMORY_ITEM_SCHEMA, budget,
      ),
      this.#assertImmutableCompatible(
        'idempotency',
        idempotencyIdentity('event', validated.transaction.source_key_digest),
        validated.marker,
        manifest,
        IDEMPOTENCY_SCHEMA,
        budget,
      ),
    ]);
    return validated;
  }

  async #preflightFeedbackTransaction(rawTransaction, manifest, budget = null) {
    const validated = this.#validateFeedbackTransaction(rawTransaction, manifest);
    await Promise.all([
      this.#assertImmutableCompatible(
        'feedback', validated.feedback.feedback_id, validated.feedback, manifest, MEMORY_FEEDBACK_SCHEMA, budget,
      ),
      this.#assertImmutableCompatible(
        'idempotency',
        idempotencyIdentity('feedback', validated.transaction.source_key_digest),
        validated.marker,
        manifest,
        IDEMPOTENCY_SCHEMA,
        budget,
      ),
    ]);
    return validated;
  }

  async #commitEventTransaction(transactionState, manifest, {
    injectFaults = true,
    cleanup = true,
    preflight = true,
    budget = null,
  } = {}) {
    const validated = preflight
      ? await this.#preflightEventTransaction(transactionState.value, manifest, budget)
      : this.#validateEventTransaction(transactionState.value, manifest);
    const {
      transaction, event, memory, marker,
    } = validated;
    await this.#ensureImmutable('events', event.event_id, event, manifest, MEMORY_EVENT_SCHEMA, budget);
    if (injectFaults) await this.#fault('after_event_create', { event_id: event.event_id });
    await this.#ensureImmutable('memories', memory.memory_id, memory, manifest, MEMORY_ITEM_SCHEMA, budget);
    if (injectFaults) await this.#fault('after_memory_create', { event_id: event.event_id, memory_id: memory.memory_id });
    await this.#ensureImmutable(
      'idempotency',
      idempotencyIdentity('event', transaction.source_key_digest),
      marker,
      manifest,
      IDEMPOTENCY_SCHEMA,
      budget,
    );
    if (injectFaults) await this.#fault('after_idempotency_create', { event_id: event.event_id });
    if (cleanup) await this.#cleanupTransaction(transactionState);
    return { event, memory };
  }

  async #commitFeedbackTransaction(transactionState, manifest, {
    injectFaults = true,
    cleanup = true,
    preflight = true,
    budget = null,
  } = {}) {
    const validated = preflight
      ? await this.#preflightFeedbackTransaction(transactionState.value, manifest, budget)
      : this.#validateFeedbackTransaction(transactionState.value, manifest);
    const { transaction, feedback, marker } = validated;
    await this.#ensureImmutable(
      'feedback', feedback.feedback_id, feedback, manifest, MEMORY_FEEDBACK_SCHEMA, budget,
    );
    if (injectFaults) await this.#fault('after_feedback_create', { feedback_id: feedback.feedback_id });
    await this.#ensureImmutable(
      'idempotency',
      idempotencyIdentity('feedback', transaction.source_key_digest),
      marker,
      manifest,
      IDEMPOTENCY_SCHEMA,
      budget,
    );
    if (injectFaults) await this.#fault('after_idempotency_create', { feedback_id: feedback.feedback_id });
    if (cleanup) await this.#cleanupTransaction(transactionState);
    return feedback;
  }

  async #validateBatchTransaction(transactionState, manifest, budget = null) {
    const batch = assertSealedMetadata(transactionState.value, manifest, BATCH_TRANSACTION_SCHEMA);
    if (transactionState.guardState) {
      this.#validateBatchGuard(transactionState.guardState, transactionState, manifest);
    }
    parseOpaqueId(batch.batch_id);
    const operation = batch.operation === 'event_batch'
      ? 'event'
      : batch.operation === 'feedback_batch' ? 'feedback' : null;
    const expectedTransactionId = operation
      ? batchTransactionIdentity(operation, batch.batch_id)
      : null;
    if (!operation
        || batch.transaction_id !== expectedTransactionId
        || (batch.protocol !== undefined && batch.protocol !== BATCH_PROTOCOL)
        || !Array.isArray(batch.transactions)
        || batch.transactions.length < 1
        || batch.transactions.length > MAX_BATCH_SIZE) {
      throw new MemoryStoreError('Memory batch transaction metadata is invalid', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }

    const sourceKeys = new Set();
    const recordIds = new Set();
    const validated = [];
    for (const child of batch.transactions) {
      let item;
      try {
        item = operation === 'event'
          ? this.#validateEventTransaction(child, manifest)
          : this.#validateFeedbackTransaction(child, manifest);
      } catch (cause) {
        if (cause?.code === 'MEMORY_TRANSACTION_INVALID') throw cause;
        throw new MemoryStoreError('Memory batch child transaction is invalid', {
          code: 'MEMORY_TRANSACTION_INVALID', cause,
        });
      }
      if (batch.protocol === BATCH_PROTOCOL) {
        const link = this.#assertBatchLink(item.transaction.batch, operation);
        if (link.batch_id !== batch.batch_id
            || link.batch_transaction_id !== batch.transaction_id
            || link.transaction_count !== batch.transactions.length) {
          throw new MemoryStoreError('Memory batch child membership is inconsistent', {
            code: 'MEMORY_TRANSACTION_INVALID',
          });
        }
      } else if (item.transaction.batch !== undefined) {
        throw new MemoryStoreError('Legacy memory batch contains unsupported membership metadata', {
          code: 'MEMORY_TRANSACTION_INVALID',
        });
      }
      const ids = operation === 'event'
        ? [item.event.event_id, item.memory.memory_id]
        : [item.feedback.feedback_id];
      if (sourceKeys.has(item.transaction.source_key_digest)
          || ids.some(id => recordIds.has(id))) {
        throw new MemoryStoreError('Memory batch transaction contains duplicate identities', {
          code: 'MEMORY_TRANSACTION_INVALID',
        });
      }
      sourceKeys.add(item.transaction.source_key_digest);
      for (const id of ids) recordIds.add(id);
      validated.push(item);
    }

    await mapWithConcurrency(
      batch.transactions,
      this.#resourceLimits.readConcurrency,
      child => (operation === 'event'
        ? this.#preflightEventTransaction(child, manifest, budget)
        : this.#preflightFeedbackTransaction(child, manifest, budget)),
    );
    if (batch.protocol === BATCH_PROTOCOL) {
      await this.#assertImmutableCompatible(
        'idempotency',
        batchReceiptIdentity(batch.batch_id),
        this.#batchReceipt(batch),
        manifest,
        BATCH_RECEIPT_SCHEMA,
        budget,
      );
    }
    return { batch, operation, validated };
  }

  async #commitBatchTransaction(transactionState, manifest, {
    injectFaults = true,
    budget = null,
  } = {}) {
    const { batch, operation } = await this.#validateBatchTransaction(
      transactionState,
      manifest,
      budget,
    );
    const results = [];
    for (const child of batch.transactions) {
      const childState = { value: child };
      results.push(operation === 'event'
        ? await this.#commitEventTransaction(childState, manifest, {
          injectFaults, cleanup: false, preflight: false, budget,
        })
        : await this.#commitFeedbackTransaction(childState, manifest, {
          injectFaults, cleanup: false, preflight: false, budget,
        }));
    }
    await this.#ensureBatchReceipt(batch, manifest, injectFaults, budget);
    await this.#cleanupBatchTransaction(transactionState);
    return results;
  }

  #journalInvalid(message, cause = undefined) {
    return new MemoryStoreError(message, {
      code: 'MEMORY_TRANSACTION_INVALID',
      ...(cause === undefined ? {} : { cause }),
    });
  }

  async #strictJournalDirectories(budget) {
    try {
      return await listJournalDirectories(this.#layout, {
        maxEntries: HARD_MEMORY_RESOURCE_LIMITS.maxDirectoryEntriesPerOperation,
        rejectUnexpected: true,
        onEntryExamined: count => budget.reserveDirectoryEntries(count),
      });
    } catch (cause) {
      if (cause?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
      if (cause?.code === 'MEMORY_DIRECTORY_INVALID') {
        throw this.#journalInvalid('Memory journal directory state is invalid', cause);
      }
      throw cause;
    }
  }

  async #strictJournalEntries(journalId, budget) {
    try {
      return await listJournalEntries(this.#layout, journalId, {
        maxEntries: HARD_MEMORY_RESOURCE_LIMITS.maxDirectoryEntriesPerOperation,
        rejectUnexpected: true,
        onEntryExamined: count => budget.reserveDirectoryEntries(count),
      });
    } catch (cause) {
      if (cause?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
      if (cause?.code === 'MEMORY_DIRECTORY_INVALID') {
        throw this.#journalInvalid('Memory journal entry state is invalid', cause);
      }
      throw cause;
    }
  }

  async #readCanonicalJournalState(directory, entryPath, budget) {
    let reservedBytes = 0;
    if (budget) {
      const stat = await fs.lstat(entryPath);
      reservedBytes = Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0;
      budget.reserve(1, reservedBytes);
    }
    let state;
    try {
      state = await readJsonWithDigest(
        directory,
        entryPath,
        budget ? { maxBytes: reservedBytes } : {},
      );
    } catch (cause) {
      if (cause?.code === 'MEMORY_RESOURCE_LIMIT') throw new MemoryResourceLimitError();
      if (cause?.code === 'MEMORY_JSON_INVALID') {
        throw this.#journalInvalid('Memory journal JSON is invalid', cause);
      }
      throw cause;
    }
    if (budget && state.byteLength > reservedBytes) {
      budget.reserve(0, state.byteLength - reservedBytes);
    }
    let canonicalDigest;
    try {
      canonicalDigest = digestJson(state.value);
    } catch (cause) {
      throw this.#journalInvalid('Memory journal JSON is invalid', cause);
    }
    if (state.digest !== canonicalDigest) {
      throw this.#journalInvalid('Memory journal JSON is not canonically serialized');
    }
    return state;
  }

  #validateJournalTransaction(state, entryPath, manifest) {
    let transaction;
    let expectedTransactionId;
    if (state.value?.schema === BATCH_TRANSACTION_SCHEMA) {
      transaction = assertSealedMetadata(state.value, manifest, BATCH_TRANSACTION_SCHEMA);
      const operation = transaction.operation === 'event_batch'
        ? 'event'
        : transaction.operation === 'feedback_batch' ? 'feedback' : null;
      if (!operation) {
        throw this.#journalInvalid('Unsupported memory transaction operation');
      }
      try {
        parseOpaqueId(transaction.batch_id);
      } catch (cause) {
        throw this.#journalInvalid('Memory batch transaction identity is invalid', cause);
      }
      expectedTransactionId = batchTransactionIdentity(operation, transaction.batch_id);
    } else if (state.value?.schema === TRANSACTION_SCHEMA) {
      transaction = assertSealedMetadata(state.value, manifest, TRANSACTION_SCHEMA);
      if (!['event', 'feedback'].includes(transaction.operation)) {
        throw this.#journalInvalid('Unsupported memory transaction operation');
      }
      expectedTransactionId = transactionIdentity(
        transaction.operation,
        transaction.source_key_digest,
      );
    } else {
      throw this.#journalInvalid('Memory transaction metadata is invalid');
    }
    const expectedPath = journalEntryPath(this.#layout, JOURNAL_ID, expectedTransactionId);
    if (transaction.transaction_id !== expectedTransactionId
        || !sameFilesystemPath(entryPath, expectedPath)) {
      throw this.#journalInvalid('Memory journal entry identity does not match its storage key');
    }
    return transaction;
  }

  async #recoverTransactions(manifest) {
    // Recovery remains bounded by immutable hard ceilings, but is not made
    // impossible merely because a host later lowers its request defaults.
    const recoveryBudget = new RequestBudget(HARD_MEMORY_RESOURCE_LIMITS);
    const allowedDirectories = new Set([
      path.basename(journalDirectory(this.#layout, JOURNAL_ID)),
      path.basename(journalDirectory(this.#layout, BATCH_GUARD_JOURNAL_ID)),
    ]);
    const journalDirectories = await this.#strictJournalDirectories(recoveryBudget);
    if (journalDirectories.some(entry => !allowedDirectories.has(entry.name))) {
      throw this.#journalInvalid('Memory journal directory identity is invalid');
    }

    const entries = await this.#strictJournalEntries(JOURNAL_ID, recoveryBudget);
    const guardEntries = await this.#strictJournalEntries(
      BATCH_GUARD_JOURNAL_ID,
      recoveryBudget,
    );
    if (guardEntries.length > 1) {
      throw this.#journalInvalid('Multiple active memory batch guards were found');
    }

    const directory = journalDirectory(this.#layout, JOURNAL_ID);
    const pending = [];
    for (const entry of entries) {
      const state = await this.#readCanonicalJournalState(
        directory,
        entry.path,
        recoveryBudget,
      );
      const transaction = this.#validateJournalTransaction(state, entry.path, manifest);
      pending.push({ state, transaction });
    }

    if (pending.some(({ transaction }) => (
      transaction.schema === BATCH_TRANSACTION_SCHEMA
        && transaction.protocol === BATCH_PROTOCOL
    )) && pending.length !== 1) {
      throw this.#journalInvalid('Protected memory batch journal state is ambiguous');
    }

    let guardState = null;
    if (guardEntries.length === 1) {
      const expectedGuardPath = journalEntryPath(
        this.#layout,
        BATCH_GUARD_JOURNAL_ID,
        BATCH_GUARD_ENTRY_ID,
      );
      if (!sameFilesystemPath(guardEntries[0].path, expectedGuardPath)) {
        throw this.#journalInvalid('Memory batch guard identity does not match its storage key');
      }
      guardState = await this.#readCanonicalJournalState(
        journalDirectory(this.#layout, BATCH_GUARD_JOURNAL_ID),
        guardEntries[0].path,
        recoveryBudget,
      );
      if (pending.length !== 1 || pending[0].transaction.schema !== BATCH_TRANSACTION_SCHEMA) {
        throw this.#journalInvalid('An active memory batch guard has no matching journal');
      }
      this.#validateBatchGuard(guardState, pending[0].state, manifest);
    }

    for (const { state, transaction } of pending) {
      if (transaction.schema === BATCH_TRANSACTION_SCHEMA) {
        if (guardState && pending.length !== 1) {
          throw this.#journalInvalid('Memory batch guard state is ambiguous');
        }
        const activeGuard = guardState || await this.#createBatchGuard(state, manifest);
        await this.#commitBatchTransaction(
          { ...state, guardState: activeGuard },
          manifest,
          { injectFaults: false, budget: recoveryBudget },
        );
        guardState = null;
      } else if (transaction.operation === 'event') {
        await this.#commitEventTransaction(
          state,
          manifest,
          { injectFaults: false, budget: recoveryBudget },
        );
      } else if (transaction.operation === 'feedback') {
        await this.#commitFeedbackTransaction(
          state,
          manifest,
          { injectFaults: false, budget: recoveryBudget },
        );
      } else {
        throw this.#journalInvalid('Unsupported memory transaction operation');
      }
    }
  }

  #resolveEventAttribution(input, trustedIngress) {
    const attribution = resolveAttribution(this.#profile, {
      actor: eventActorReference(this.#profile, input),
      source: input.source,
    });
    if (attribution.actor.type === 'user' && !trustedIngress) {
      throw new MemoryStoreError('Trusted user events require authenticated bridge ingestion', {
        code: 'MEMORY_PROFILE_DENIED',
      });
    }
    assertKindActorCoherence(input, attribution.actor);
    assertAttributionMatchesInput(input, attribution);
    return attribution;
  }

  async #existingEvent(marker, manifest, budget = null) {
    const event = await this.#readEvent(marker.event_id, manifest, budget);
    const memory = await this.#readMemory(marker.memory_id, manifest, budget);
    this.#assertEventMarker(marker, event, memory);
    return { event, memory };
  }

  async #assertWriteQuotas(operation, transactions, manifest, budget) {
    if (transactions.length === 0) return;
    const projectedRecords = transactions.map((transaction) => (
      operation === 'event' ? transaction.event : transaction.feedback
    ));
    if (operation === 'event') {
      const requestedRelations = projectedRecords.reduce((total, event) => (
        total + (event.relations || []).length + (event.derived?.source_event_ids || []).length
      ), 0);
      if (requestedRelations > this.#resourceLimits.maxRelationExpansion) {
        throw new MemoryResourceLimitError();
      }
    }

    const requestedNamespaces = new Set(projectedRecords.map(record => record.namespace));
    const namespaceUsage = new Map(
      [...requestedNamespaces].map(namespace => [namespace, { records: 0, bytes: 0 }]),
    );
    const profileUsage = { records: 0, bytes: 0 };
    for (const [collection, schema, identityKey] of [
      ['events', MEMORY_EVENT_SCHEMA, 'event_id'],
      ['feedback', MEMORY_FEEDBACK_SCHEMA, 'feedback_id'],
    ]) {
      const states = await this.#listCollection(collection, budget);
      for (const state of states) {
        const record = assertStoredRecord(state.value, manifest, schema);
        this.#assertCollectionIdentity(state, collection, record[identityKey]);
        if (record.ingested_by?.profile_id === this.#profile.profile_id) {
          profileUsage.records += 1;
          profileUsage.bytes += state.byteLength;
        }
        const namespace = namespaceUsage.get(record.namespace);
        if (namespace) {
          namespace.records += 1;
          namespace.bytes += state.byteLength;
        }
      }
    }

    for (const record of projectedRecords) {
      const bytes = serializedByteLength(record);
      profileUsage.records += 1;
      profileUsage.bytes += bytes;
      const namespace = namespaceUsage.get(record.namespace);
      namespace.records += 1;
      namespace.bytes += bytes;
    }
    if (profileUsage.records > this.#resourceLimits.maxRecordsPerProfile
        || profileUsage.bytes > this.#resourceLimits.maxBytesPerProfile
        || [...namespaceUsage.values()].some(usage => (
          usage.records > this.#resourceLimits.maxRecordsPerNamespace
          || usage.bytes > this.#resourceLimits.maxBytesPerNamespace
        ))) {
      throw new MemoryResourceLimitError();
    }
  }

  async #planEventBatch(prepared, manifest, budget) {
    const entries = [];
    const transactions = [];
    const sources = new Map();
    const reservedEventIds = new Set();
    const reservedMemoryIds = new Set();
    let recordsBySource = null;

    for (const { input, attribution } of prepared) {
      await this.#assertReferencesAccessible(input, manifest, budget);
      const sourceKey = sourceKeyDigest(attribution.source);
      const inputHash = requestDigest(input, attribution);
      const prior = sources.get(sourceKey);
      if (prior) {
        if (prior.inputHash !== inputHash) throw new MemoryIdempotencyConflictError();
        entries.push({ status: 'duplicate', records: prior.records });
        continue;
      }

      recordsBySource ||= await this.#recordsBySource('event', manifest, budget);
      const marker = await this.#readMarker('event', sourceKey, manifest, budget);
      this.#assertSourceMarkerUnique('event', recordsBySource, sourceKey, marker);
      if (marker) {
        const records = await this.#existingEvent(marker, manifest, budget);
        if (persistedRequestDigest(records.event) !== inputHash) {
          throw new MemoryIdempotencyConflictError();
        }
        sources.set(sourceKey, { inputHash, records });
        entries.push({ status: 'duplicate', records });
        continue;
      }

      const eventId = await this.#uniqueId('evt', 'events', reservedEventIds);
      const memoryId = await this.#uniqueId('mem', 'memories', reservedMemoryIds);
      const event = buildEventRecord({
        vaultId: manifest.vault_id,
        input,
        attribution,
        eventId,
        memoryId,
        ingestedAt: this.#timestamp(),
      });
      const memory = buildMemoryRecord(event);
      const transaction = this.#buildTransaction(
        'event', sourceKey, inputHash, { event, memory }, manifest,
      );
      const records = { event, memory };
      transactions.push(transaction);
      sources.set(sourceKey, { inputHash, records });
      entries.push({ status: 'created', records });
    }
    return { entries, transactions };
  }

  async #recordEvents(rawEvents, capability) {
    this.#assertEnabled();
    assertBatch(rawEvents, 'events', this.#resourceLimits.maxBatchSize);
    const trustedIngress = this.#trustedIngressCapability !== null
      && capability === this.#trustedIngressCapability;
    const prepared = rawEvents.map((raw) => {
      const input = parseEventInput(raw);
      assertNamespaceAccess(this.#profile, input.namespace, 'write');
      return { input, attribution: this.#resolveEventAttribution(input, trustedIngress) };
    });
    const budget = this.#requestBudget(prepared.map(({ input }) => input), prepared.length);
    return this.#withConsistentVault(async (manifest) => {
      const plan = await this.#planEventBatch(prepared, manifest, budget);
      if (plan.transactions.length > 0) {
        await this.#assertWriteQuotas('event', plan.transactions, manifest, budget);
        const transactionState = await this.#createBatchTransaction(
          'event', plan.transactions, manifest, budget,
        );
        await this.#fault('after_journal_create', {
          batch_id: transactionState.value.batch_id,
          event_count: plan.transactions.length,
        });
        await this.#commitBatchTransaction(transactionState, manifest, { budget });
        if (transactionState.resumed) {
          for (const entry of plan.entries) {
            if (entry.status === 'created') entry.status = 'recovered';
          }
        }
      }
      const results = plan.entries.map(entry => ({ status: entry.status, ...entry.records }));
      return {
        results,
        created_count: results.filter((result) => result.status === 'created').length,
        recovered_count: results.filter((result) => result.status === 'recovered').length,
        duplicate_count: results.filter((result) => result.status === 'duplicate').length,
      };
    });
  }

  async recordEvents(rawEvents) {
    return this.#recordEvents(rawEvents, undefined);
  }

  async #resolveTarget(target, manifest, access = 'read', budget = null) {
    let event;
    let memory = null;
    if (target.type === 'event') {
      event = await this.#readEvent(target.id, manifest, budget);
      memory = await this.#readMemory(event.memory_id, manifest, budget);
    } else {
      memory = await this.#readMemory(target.id, manifest, budget);
      event = await this.#readEvent(memory.event_id, manifest, budget);
    }
    if (!memory || event.memory_id !== memory.memory_id || memory.event_id !== event.event_id) {
      throw new MemoryStoreError('Event and memory records do not link to each other', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
    await this.#assertEventCommitted(event, memory, manifest, budget);
    try {
      assertNamespaceAccess(this.#profile, event.namespace, access);
    } catch {
      throw new MemoryNotFoundError();
    }
    return { event, memory, namespace: event.namespace };
  }

  #resolveFeedbackAttribution(input, trustedIngress) {
    const actor = lookupActor(this.#profile, input.actor_id);
    if (actor?.type === 'user' && !trustedIngress) {
      throw new MemoryStoreError('Trusted user feedback requires authenticated bridge ingestion', {
        code: 'MEMORY_PROFILE_DENIED',
      });
    }
    if (['user_confirmed', 'user_rejected'].includes(input.signal) && actor && actor.type !== 'user') {
      throw new MemoryStoreError('User confirmation signals require a trusted user actor', {
        code: 'MEMORY_ACTOR_KIND_MISMATCH',
      });
    }
    return resolveAttribution(this.#profile, {
      actor: input.actor_id,
      source: input.source,
      trusted_user_feedback: actor?.type === 'user',
      user_confirmed: input.signal === 'user_confirmed',
      user_rejected: input.signal === 'user_rejected',
    });
  }

  async #existingFeedback(marker, manifest, budget = null) {
    const state = await this.#readImmutableState('feedback', marker.feedback_id, budget);
    const feedback = assertStoredRecord(state.value, manifest, MEMORY_FEEDBACK_SCHEMA);
    this.#assertFeedbackMarker(marker, feedback);
    return feedback;
  }

  async #planFeedbackBatch(prepared, manifest, budget) {
    const entries = [];
    const transactions = [];
    const sources = new Map();
    const reservedFeedbackIds = new Set();
    let recordsBySource = null;

    for (const { input, attribution } of prepared) {
      const target = await this.#resolveTarget(input.target, manifest, 'write', budget);
      if (input.related_target) {
        await this.#resolveTarget(input.related_target, manifest, 'read', budget);
      }
      const sourceKey = sourceKeyDigest(attribution.source);
      const inputHash = requestDigest(input, attribution);
      const prior = sources.get(sourceKey);
      if (prior) {
        if (prior.inputHash !== inputHash) throw new MemoryIdempotencyConflictError();
        entries.push({ status: 'duplicate', feedback: prior.feedback });
        continue;
      }

      recordsBySource ||= await this.#recordsBySource('feedback', manifest, budget);
      const marker = await this.#readMarker('feedback', sourceKey, manifest, budget);
      this.#assertSourceMarkerUnique('feedback', recordsBySource, sourceKey, marker);
      if (marker) {
        const feedback = await this.#existingFeedback(marker, manifest, budget);
        if (persistedRequestDigest(feedback) !== inputHash) {
          throw new MemoryIdempotencyConflictError();
        }
        sources.set(sourceKey, { inputHash, feedback });
        entries.push({ status: 'duplicate', feedback });
        continue;
      }

      const feedbackId = await this.#uniqueId('fbk', 'feedback', reservedFeedbackIds);
      const feedback = buildFeedbackRecord({
        vaultId: manifest.vault_id,
        input,
        attribution,
        namespace: target.namespace,
        feedbackId,
        recordedAt: this.#timestamp(),
      });
      const transaction = this.#buildTransaction(
        'feedback', sourceKey, inputHash, { feedback }, manifest,
      );
      transactions.push(transaction);
      sources.set(sourceKey, { inputHash, feedback });
      entries.push({ status: 'created', feedback });
    }
    return { entries, transactions };
  }

  async #recordFeedback(rawFeedback, capability) {
    this.#assertEnabled();
    assertBatch(rawFeedback, 'feedback', this.#resourceLimits.maxBatchSize);
    const trustedIngress = this.#trustedIngressCapability !== null
      && capability === this.#trustedIngressCapability;
    const prepared = rawFeedback.map((raw) => {
      const input = parseFeedbackInput(raw);
      return { input, attribution: this.#resolveFeedbackAttribution(input, trustedIngress) };
    });
    const budget = this.#requestBudget(prepared.map(({ input }) => input), prepared.length);
    return this.#withConsistentVault(async (manifest) => {
      const plan = await this.#planFeedbackBatch(prepared, manifest, budget);
      if (plan.transactions.length > 0) {
        await this.#assertWriteQuotas('feedback', plan.transactions, manifest, budget);
        const transactionState = await this.#createBatchTransaction(
          'feedback', plan.transactions, manifest, budget,
        );
        await this.#fault('after_journal_create', {
          batch_id: transactionState.value.batch_id,
          feedback_count: plan.transactions.length,
        });
        await this.#commitBatchTransaction(transactionState, manifest, { budget });
        if (transactionState.resumed) {
          for (const entry of plan.entries) {
            if (entry.status === 'created') entry.status = 'recovered';
          }
        }
      }
      const results = plan.entries.map(entry => ({
        status: entry.status,
        feedback: entry.feedback,
      }));
      return {
        results,
        created_count: results.filter((result) => result.status === 'created').length,
        recovered_count: results.filter((result) => result.status === 'recovered').length,
        duplicate_count: results.filter((result) => result.status === 'duplicate').length,
      };
    });
  }

  async recordFeedback(rawFeedback) {
    return this.#recordFeedback(rawFeedback, undefined);
  }

  async #readAccessibleEvents(manifest, budget, { validateMemories = true } = {}) {
    const states = await this.#listCollection('events', budget);
    const events = states
      .map((state) => {
        const event = assertStoredRecord(state.value, manifest, MEMORY_EVENT_SCHEMA);
        this.#assertCollectionIdentity(state, 'events', event.event_id);
        return event;
      })
      .filter((event) => canReadNamespace(this.#profile, event.namespace));
    if (validateMemories) {
      await mapWithConcurrency(events, this.#resourceLimits.readConcurrency, async (event) => {
        const memory = await this.#readMemory(event.memory_id, manifest, budget);
        if (memory.event_id !== event.event_id) {
          throw new MemoryStoreError('Event and memory records do not link to each other', {
            code: 'MEMORY_RECORD_INVALID',
          });
        }
        await this.#assertEventCommitted(event, memory, manifest, budget);
      });
    }
    return events;
  }

  async #readAccessibleFeedback(manifest, budget) {
    const states = await this.#listCollection('feedback', budget);
    const feedbackRecords = states
      .map((state) => {
        const feedback = assertStoredRecord(state.value, manifest, MEMORY_FEEDBACK_SCHEMA);
        this.#assertCollectionIdentity(state, 'feedback', feedback.feedback_id);
        return feedback;
      })
      .filter((feedback) => canReadNamespace(this.#profile, feedback.namespace));
    await mapWithConcurrency(
      feedbackRecords,
      this.#resourceLimits.readConcurrency,
      feedback => this.#assertFeedbackCommitted(feedback, manifest, budget),
    );
    return feedbackRecords;
  }

  async search({ query = '', namespaces, actor_types, kinds, limit = 50 } = {}) {
    return this.#search({ query, namespaces, actor_types, kinds, limit });
  }

  async #search({ query = '', namespaces, actor_types, kinds, limit = 50 } = {}) {
    this.#assertEnabled();
    if (typeof query !== 'string'
        || query.length > 2_000
        || containsDisallowedSensitiveMaterial(query)) {
      throw new MemoryStoreError('Memory search query is invalid', { code: 'MEMORY_QUERY_INVALID' });
    }
    for (const [label, value] of [['namespaces', namespaces], ['actor_types', actor_types], ['kinds', kinds]]) {
      if (value !== undefined && (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string'))) {
        throw new MemoryStoreError(`Memory ${label} filter is invalid`, { code: 'MEMORY_QUERY_INVALID' });
      }
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAX_SEARCH_RESULTS) {
      throw new MemoryStoreError('Memory search limit must be an integer from 1 through 100', {
        code: 'MEMORY_QUERY_INVALID',
      });
    }
    if (limit > this.#resourceLimits.maxSearchResults) throw new MemoryResourceLimitError();
    const requestedNamespaces = namespaces === undefined
      ? null
      : [...new Set(namespaces.map((namespace) => canonicalizeNamespace(namespace)))];
    for (const namespace of requestedNamespaces || []) assertNamespaceAccess(this.#profile, namespace, 'read');
    const requestedActors = actor_types === undefined ? null : new Set(actor_types);
    if (requestedActors && [...requestedActors].some((type) => !ACTOR_TYPES.includes(type))) {
      throw new MemoryStoreError('Memory actor filter is invalid', { code: 'MEMORY_QUERY_INVALID' });
    }
    const requestedKinds = kinds === undefined ? null : new Set(kinds);
    if (requestedKinds && [...requestedKinds].some((kind) => !EVENT_KINDS.includes(kind))) {
      throw new MemoryStoreError('Memory kind filter is invalid', { code: 'MEMORY_QUERY_INVALID' });
    }
    const budget = this.#requestBudget({
      query,
      namespaces: requestedNamespaces,
      actor_types: requestedActors ? [...requestedActors] : null,
      kinds: requestedKinds ? [...requestedKinds] : null,
      limit,
    });

    const snapshot = await this.#withConsistentVault(async (manifest) => {
      const accessibleEvents = await this.#readAccessibleEvents(manifest, budget);
      let events = accessibleEvents;
      if (requestedNamespaces) {
        events = events.filter((event) => requestedNamespaces.some(
          (namespace) => event.namespace === namespace || event.namespace.startsWith(`${namespace}/`),
        ));
      }
      if (requestedActors) events = events.filter((event) => requestedActors.has(event.actor.type));
      if (requestedKinds) events = events.filter((event) => requestedKinds.has(event.kind));
      if (events.length > this.#resourceLimits.maxSearchCandidates) {
        throw new MemoryResourceLimitError();
      }
      const feedback = await this.#readAccessibleFeedback(manifest, budget);
      const readableEventIds = new Set(accessibleEvents.map((event) => event.event_id));
      const readableMemoryIds = new Set(accessibleEvents.map((event) => event.memory_id));
      const candidateEventIds = new Set(events.map((event) => event.event_id));
      const candidateMemoryIds = new Set(events.map((event) => event.memory_id));
      const visibleFeedback = feedback
        .map((item) => visibleFeedbackProjection(item, readableEventIds, readableMemoryIds))
        .filter((item) => item && (
          (item.target.type === 'event' && candidateEventIds.has(item.target.id))
          || (item.target.type === 'memory' && candidateMemoryIds.has(item.target.id))
        ));
      return {
        accessibleEvents, events, visibleFeedback, readableEventIds,
      };
    });
    const {
      accessibleEvents, events, visibleFeedback, readableEventIds,
    } = snapshot;
    const ranked = rankMemoryEvents(events, visibleFeedback, { query, limit });
    const expansionBudget = new ExpansionBudget(this.#resourceLimits);
    const incomingByTarget = incomingRelationsForTargets(
      accessibleEvents,
      new Set(ranked.map(({ event }) => event.event_id)),
      expansionBudget,
    );
    return {
      query,
      namespaces: requestedNamespaces,
      count: ranked.length,
      results: ranked.map(({ event, ...ranking }) => {
        const visibleEvent = visibleEventProjection(event, readableEventIds);
        const incomingRelations = incomingByTarget.get(visibleEvent.event_id) || [];
        expansionBudget.reserveRelations(
          visibleEvent.relations.length
          + (visibleEvent.derived?.source_event_ids || []).length,
        );
        return {
          event_id: visibleEvent.event_id,
          memory_id: visibleEvent.memory_id,
          namespace: visibleEvent.namespace,
          kind: visibleEvent.kind,
          speech_act: visibleEvent.speech_act,
          content: visibleEvent.content,
          actor: visibleEvent.actor,
          ingested_by: visibleEvent.ingested_by,
          agent_instance: visibleEvent.agent_instance,
          delegated_by: visibleEvent.delegated_by,
          source: visibleEvent.source,
          context: visibleEvent.context,
          relations: visibleEvent.relations,
          incoming_relations: incomingRelations,
          derived: visibleEvent.derived,
          occurred_at: visibleEvent.occurred_at,
          ingested_at: visibleEvent.ingested_at,
          ...(visibleEvent.integrity === undefined ? {} : { integrity: visibleEvent.integrity }),
          ...ranking,
        };
      }),
    };
  }

  async #getUnlocked(id, manifest, {
    accessibleEvents = null,
    accessibleFeedback = null,
    feedbackIndex = null,
    includeFeedback = false,
    includeRelations = false,
    budget,
    expansionBudget,
  } = {}) {
    let event;
    let memory;
    if (id.startsWith('evt_')) {
      event = await this.#readEvent(id, manifest, budget);
      memory = await this.#readMemory(event.memory_id, manifest, budget);
    } else if (id.startsWith('mem_')) {
      memory = await this.#readMemory(id, manifest, budget);
      event = await this.#readEvent(memory.event_id, manifest, budget);
    } else {
      throw new MemoryNotFoundError();
    }
    try {
      assertNamespaceAccess(this.#profile, event.namespace, 'read');
    } catch {
      throw new MemoryNotFoundError();
    }
    if (event.memory_id !== memory.memory_id || memory.event_id !== event.event_id) {
      throw new MemoryStoreError('Event and memory records do not link to each other', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
    await this.#assertEventCommitted(event, memory, manifest, budget);
    let allEvents = accessibleEvents;
    if ((includeFeedback || includeRelations) && !allEvents) {
      allEvents = await this.#readAccessibleEvents(manifest, budget);
    }
    const readableEventIds = new Set((allEvents || [event]).map(item => item.event_id));
    const readableMemoryIds = new Set((allEvents || [event]).map(item => item.memory_id));
    let visibleFeedback = [];
    if (includeFeedback) {
      const allFeedback = feedbackIndex
        ? [
          ...(feedbackIndex.get(feedbackTargetKey({ type: 'event', id: event.event_id })) || []),
          ...(feedbackIndex.get(feedbackTargetKey({ type: 'memory', id: memory.memory_id })) || []),
        ]
        : accessibleFeedback || await this.#readAccessibleFeedback(manifest, budget);
      for (const item of allFeedback) {
        if (!((item.target.type === 'event' && item.target.id === event.event_id)
            || (item.target.type === 'memory' && item.target.id === memory.memory_id))) continue;
        const visible = visibleFeedbackProjection(item, readableEventIds, readableMemoryIds);
        if (!visible) continue;
        expansionBudget.reserveFeedback(1);
        visibleFeedback.push(visible);
      }
    }
    const projectionIds = includeRelations ? readableEventIds : new Set();
    const visibleEvent = visibleEventProjection(event, projectionIds);
    const incomingRelations = includeRelations
      ? incomingRelationsFor(allEvents, event.event_id, expansionBudget)
      : [];
    if (includeRelations) {
      expansionBudget.reserveRelations(
        visibleEvent.relations.length
        + (visibleEvent.derived?.source_event_ids || []).length,
      );
    }
    const [ranking] = rankMemoryEvents([event], visibleFeedback, { query: '', limit: 1 });
    return {
      event: visibleEvent,
      memory: visibleMemoryProjection(memory),
      feedback: visibleFeedback,
      incoming_relations: incomingRelations,
      activity: ranking.activity,
      signals_by_actor: ranking.signals_by_actor,
      activity_by_stable_actor: ranking.activity_by_stable_actor,
      expansions: { feedback: includeFeedback, relations: includeRelations },
    };
  }

  async get(id, options = {}) {
    return this.#get(id, options);
  }

  async #get(id, options = {}) {
    this.#assertEnabled();
    parseOpaqueId(id);
    const expansion = normalizeExpansionOptions(options);
    const budget = this.#requestBudget({ id, ...expansion });
    const expansionBudget = new ExpansionBudget(this.#resourceLimits);
    return this.#withConsistentVault((manifest) => this.#getUnlocked(id, manifest, {
      ...expansion,
      budget,
      expansionBudget,
    }));
  }

  async recall(ids, options = {}) {
    return this.#recall(ids, options);
  }

  async #recall(ids, options = {}) {
    this.#assertEnabled();
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH_SIZE) {
      throw new MemoryStoreError('Recall requires 1 through 100 event or memory IDs', {
        code: 'MEMORY_QUERY_INVALID',
      });
    }
    if (ids.length > this.#resourceLimits.maxBatchSize) throw new MemoryResourceLimitError();
    const unique = [...new Set(ids)];
    for (const id of unique) parseOpaqueId(id);
    const expansion = normalizeExpansionOptions(options);
    const budget = this.#requestBudget({ ids: unique, ...expansion });
    const expansionBudget = new ExpansionBudget(this.#resourceLimits);
    return this.#withConsistentVault(async (manifest) => {
      const events = expansion.includeFeedback || expansion.includeRelations
        ? await this.#readAccessibleEvents(manifest, budget)
        : null;
      const feedback = expansion.includeFeedback
        ? await this.#readAccessibleFeedback(manifest, budget)
        : null;
      let feedbackIndex = null;
      if (feedback) {
        const readableEventIds = new Set(events.map(event => event.event_id));
        const readableMemoryIds = new Set(events.map(event => event.memory_id));
        feedbackIndex = feedbackByTarget(feedback
          .map(item => visibleFeedbackProjection(item, readableEventIds, readableMemoryIds))
          .filter(Boolean));
      }
      const results = [];
      for (const id of unique) {
        results.push(await this.#getUnlocked(id, manifest, {
          accessibleEvents: events,
          accessibleFeedback: feedback,
          feedbackIndex,
          ...expansion,
          budget,
          expansionBudget,
        }));
      }
      return { results };
    });
  }

  async status() {
    return this.#status();
  }

  async #status() {
    if (!this.#enabled) {
      return {
        enabled: false,
        schema_version: MEMORY_SCHEMA_VERSION,
        vault_id: null,
        profile: publicProfile(this.#profile),
        counts: { actors: 0, events: 0, memories: 0, feedback: 0 },
        pending_transactions: 0,
      };
    }
    const budget = this.#requestBudget();
    return this.#withConsistentVault(async (manifest) => {
      const events = await this.#readAccessibleEvents(manifest, budget);
      const feedback = await this.#readAccessibleFeedback(manifest, budget);
      const readableEventIds = new Set(events.map(event => event.event_id));
      const readableMemoryIds = new Set(events.map(event => event.memory_id));
      const visibleFeedback = feedback
        .map(item => visibleFeedbackProjection(item, readableEventIds, readableMemoryIds))
        .filter(Boolean);
      const visibleActors = new Set([
        this.#profile.principal.id,
        this.#profile.agent_instance.id,
        ...this.#profile.allowed_actors.map((actor) => actor.id),
      ]);
      return {
        enabled: true,
        schema_version: MEMORY_SCHEMA_VERSION,
        vault_id: manifest.vault_id,
        vault_lineage: manifest.lineage,
        manifest_revision: manifest.revision,
        profile: publicProfile(this.#profile),
        counts: {
          actors: visibleActors.size,
          events: events.length,
          memories: events.length,
          feedback: visibleFeedback.length,
        },
        pending_transactions: 0,
      };
    });
  }

  async regenerateVaultIdentity({ confirmIndependentClone = false } = {}) {
    return this.#regenerateVaultIdentity({ confirmIndependentClone });
  }

  async #regenerateVaultIdentity({ confirmIndependentClone = false } = {}) {
    this.#assertEnabled();
    if (confirmIndependentClone !== true) {
      throw new MemoryStoreError('Vault identity regeneration requires literal confirmation', {
        code: 'MEMORY_IDENTITY_CONFIRMATION_REQUIRED',
      });
    }
    return this.#withConsistentVault(async (manifest, lock) => {
      const current = await this.#readManifest();
      const next = regenerateVaultManifest(manifest, {
        regeneratedAt: this.#timestamp(),
        confirmIndependentClone,
      });
      const replaced = await replaceJsonOptimistic(this.#layout, this.#manifestPath(), next, {
        expectedRevision: current.value.revision,
        expectedDigest: current.digest,
        lock,
      });
      return assertManifest(replaced.value);
    });
  }
}

export function createMemoryStore(options) {
  return new MemoryStore(options);
}

export function createTrustedMemoryBridge({ authenticate, ...storeOptions } = {}) {
  const access = createTrustedStoreAccess(storeOptions);
  const bridge = createTrustedBridge({
    profile: access.profile,
    authenticate,
    recordEvents: access.recordEvents,
    recordFeedback: access.recordFeedback,
  });
  return Object.freeze({ store: access.facade, bridge });
}
