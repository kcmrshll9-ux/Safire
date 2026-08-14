import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertSupportedMemoryVaultPath,
  createImmutableJson,
  createJsonExclusive,
  createJournalEntry,
  ensureMemoryLayout,
  immutableCollectionDirectory,
  immutableRecordPath,
  journalDirectory,
  journalEntryPath,
  listImmutableJson,
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
import { rankMemoryEvents } from './search.mjs';

const IDEMPOTENCY_SCHEMA = 'safire.memory.idempotency/v1';
const TRANSACTION_SCHEMA = 'safire.memory.transaction/v1';
const BATCH_TRANSACTION_SCHEMA = 'safire.memory.batch-transaction/v1';
const JOURNAL_ID = 'ingestion';
const MAX_BATCH_SIZE = 100;

export const DEFAULT_MEMORY_RESOURCE_LIMITS = Object.freeze({
  readConcurrency: 8,
  maxRecordsPerRequest: 25_000,
  maxBytesPerRequest: 128 * 1024 * 1024,
  maxRecordsPerProfile: 10_000,
  maxBytesPerProfile: 64 * 1024 * 1024,
  maxRecordsPerNamespace: 5_000,
  maxBytesPerNamespace: 32 * 1024 * 1024,
  maxFeedbackExpansion: 256,
  maxRelationExpansion: 512,
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
  }
  if (limits.readConcurrency > 64) {
    throw new TypeError('MemoryStore readConcurrency cannot exceed 64');
  }
  return Object.freeze(limits);
}

class RequestBudget {
  constructor(limits) {
    this.limits = limits;
    this.records = 0;
    this.bytes = 0;
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

function assertBatch(values, label) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_BATCH_SIZE) {
    throw new MemoryStoreError(`${label} must contain 1 through ${MAX_BATCH_SIZE} records`, {
      code: 'MEMORY_BATCH_INVALID',
    });
  }
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
    const existing = await missingAsNull(() => readJsonWithDigest(this.#layout.rootDir, this.#manifestPath()));
    if (existing) return existing;
    const [recordCollections, stateEntries, journalEntries] = await Promise.all([
      fs.readdir(this.#layout.recordsDir, { withFileTypes: true }),
      fs.readdir(this.#layout.stateDir, { withFileTypes: true }),
      fs.readdir(this.#layout.journalsDir, { withFileTypes: true }),
    ]);
    let hasRecordData = recordCollections.some((entry) => !entry.isDirectory());
    for (const collection of recordCollections.filter((entry) => entry.isDirectory())) {
      if ((await fs.readdir(path.join(this.#layout.recordsDir, collection.name))).length > 0) {
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
      return readJsonWithDigest(this.#layout.rootDir, this.#manifestPath());
    }
  }

  async #readManifest() {
    const state = await readJsonWithDigest(this.#layout.rootDir, this.#manifestPath());
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
      const existing = await missingAsNull(() => readImmutableJson(this.#layout, 'actors', actor.id));
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
        const raced = await readImmutableJson(this.#layout, 'actors', actor.id);
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
    const state = await readImmutableJson(this.#layout, collection, identity);
    if (budget && state.byteLength > reservedBytes) budget.reserve(0, state.byteLength - reservedBytes);
    return state;
  }

  async #listCollection(collection, budget = null) {
    const directory = immutableCollectionDirectory(this.#layout, collection);
    const entries = await listImmutableJson(this.#layout, collection);
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
        const state = await readJsonWithDigest(directory, entry.path);
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

  async #ensureImmutable(collection, identity, expected, manifest, schema) {
    try {
      await createImmutableJson(this.#layout, collection, identity, expected);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readImmutableJson(this.#layout, collection, identity);
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
    return marker;
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

  async #createBatchTransaction(operation, transactions, manifest) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const idFactory = this.#idFactory;
      const batchId = idFactory('bat');
      parseOpaqueId(batchId);
      const identity = batchTransactionIdentity(operation, batchId);
      const transaction = sealRecord({
        schema: BATCH_TRANSACTION_SCHEMA,
        schema_version: MEMORY_SCHEMA_VERSION,
        vault_id: manifest.vault_id,
        operation: `${operation}_batch`,
        transaction_id: identity,
        batch_id: batchId,
        created_at: this.#timestamp(),
        transactions,
      });
      try {
        const state = await createJournalEntry(this.#layout, JOURNAL_ID, identity, transaction);
        return { ...state, resumed: false };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new MemoryStoreError('Unable to allocate an exclusive batch transaction ID', {
      code: 'MEMORY_ID_CONFLICT',
    });
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
    });
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

  async #assertImmutableCompatible(collection, identity, expected, manifest, schema) {
    const existing = await missingAsNull(() => readImmutableJson(this.#layout, collection, identity));
    if (!existing) return;
    const stored = assertStoredRecord(existing.value, manifest, schema);
    if (stored.integrity.digest !== expected.integrity.digest) {
      throw new MemoryStoreError('An immutable memory ID collision was detected', {
        code: 'MEMORY_ID_CONFLICT',
      });
    }
  }

  async #preflightEventTransaction(rawTransaction, manifest) {
    const validated = this.#validateEventTransaction(rawTransaction, manifest);
    await Promise.all([
      this.#assertImmutableCompatible(
        'events', validated.event.event_id, validated.event, manifest, MEMORY_EVENT_SCHEMA,
      ),
      this.#assertImmutableCompatible(
        'memories', validated.memory.memory_id, validated.memory, manifest, MEMORY_ITEM_SCHEMA,
      ),
      this.#assertImmutableCompatible(
        'idempotency',
        idempotencyIdentity('event', validated.transaction.source_key_digest),
        validated.marker,
        manifest,
        IDEMPOTENCY_SCHEMA,
      ),
    ]);
    return validated;
  }

  async #preflightFeedbackTransaction(rawTransaction, manifest) {
    const validated = this.#validateFeedbackTransaction(rawTransaction, manifest);
    await Promise.all([
      this.#assertImmutableCompatible(
        'feedback', validated.feedback.feedback_id, validated.feedback, manifest, MEMORY_FEEDBACK_SCHEMA,
      ),
      this.#assertImmutableCompatible(
        'idempotency',
        idempotencyIdentity('feedback', validated.transaction.source_key_digest),
        validated.marker,
        manifest,
        IDEMPOTENCY_SCHEMA,
      ),
    ]);
    return validated;
  }

  async #commitEventTransaction(transactionState, manifest, {
    injectFaults = true,
    cleanup = true,
    preflight = true,
  } = {}) {
    const validated = preflight
      ? await this.#preflightEventTransaction(transactionState.value, manifest)
      : this.#validateEventTransaction(transactionState.value, manifest);
    const {
      transaction, event, memory, marker,
    } = validated;
    await this.#ensureImmutable('events', event.event_id, event, manifest, MEMORY_EVENT_SCHEMA);
    if (injectFaults) await this.#fault('after_event_create', { event_id: event.event_id });
    await this.#ensureImmutable('memories', memory.memory_id, memory, manifest, MEMORY_ITEM_SCHEMA);
    if (injectFaults) await this.#fault('after_memory_create', { event_id: event.event_id, memory_id: memory.memory_id });
    await this.#ensureImmutable(
      'idempotency',
      idempotencyIdentity('event', transaction.source_key_digest),
      marker,
      manifest,
      IDEMPOTENCY_SCHEMA,
    );
    if (injectFaults) await this.#fault('after_idempotency_create', { event_id: event.event_id });
    if (cleanup) await this.#cleanupTransaction(transactionState);
    return { event, memory };
  }

  async #commitFeedbackTransaction(transactionState, manifest, {
    injectFaults = true,
    cleanup = true,
    preflight = true,
  } = {}) {
    const validated = preflight
      ? await this.#preflightFeedbackTransaction(transactionState.value, manifest)
      : this.#validateFeedbackTransaction(transactionState.value, manifest);
    const { transaction, feedback, marker } = validated;
    await this.#ensureImmutable('feedback', feedback.feedback_id, feedback, manifest, MEMORY_FEEDBACK_SCHEMA);
    if (injectFaults) await this.#fault('after_feedback_create', { feedback_id: feedback.feedback_id });
    await this.#ensureImmutable(
      'idempotency',
      idempotencyIdentity('feedback', transaction.source_key_digest),
      marker,
      manifest,
      IDEMPOTENCY_SCHEMA,
    );
    if (injectFaults) await this.#fault('after_idempotency_create', { feedback_id: feedback.feedback_id });
    if (cleanup) await this.#cleanupTransaction(transactionState);
    return feedback;
  }

  async #validateBatchTransaction(transactionState, manifest) {
    const batch = assertSealedMetadata(transactionState.value, manifest, BATCH_TRANSACTION_SCHEMA);
    parseOpaqueId(batch.batch_id);
    const operation = batch.operation === 'event_batch'
      ? 'event'
      : batch.operation === 'feedback_batch' ? 'feedback' : null;
    const expectedTransactionId = operation
      ? batchTransactionIdentity(operation, batch.batch_id)
      : null;
    if (!operation
        || batch.transaction_id !== expectedTransactionId
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
      const item = operation === 'event'
        ? this.#validateEventTransaction(child, manifest)
        : this.#validateFeedbackTransaction(child, manifest);
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
        ? this.#preflightEventTransaction(child, manifest)
        : this.#preflightFeedbackTransaction(child, manifest)),
    );
    return { batch, operation, validated };
  }

  async #commitBatchTransaction(transactionState, manifest, { injectFaults = true } = {}) {
    const { batch, operation } = await this.#validateBatchTransaction(transactionState, manifest);
    const results = [];
    for (const child of batch.transactions) {
      const childState = { value: child };
      results.push(operation === 'event'
        ? await this.#commitEventTransaction(childState, manifest, {
          injectFaults, cleanup: false, preflight: false,
        })
        : await this.#commitFeedbackTransaction(childState, manifest, {
          injectFaults, cleanup: false, preflight: false,
        }));
    }
    await this.#cleanupTransaction(transactionState);
    return results;
  }

  async #recoverTransactions(manifest) {
    const entries = await missingAsNull(() => listJournalEntries(this.#layout, JOURNAL_ID));
    if (!entries) return;
    const directory = journalDirectory(this.#layout, JOURNAL_ID);
    for (const entry of entries) {
      const state = await readJsonWithDigest(directory, entry.path);
      let transaction;
      let expectedTransactionId;
      if (state.value?.schema === BATCH_TRANSACTION_SCHEMA) {
        transaction = assertSealedMetadata(state.value, manifest, BATCH_TRANSACTION_SCHEMA);
        const operation = transaction.operation === 'event_batch'
          ? 'event'
          : transaction.operation === 'feedback_batch' ? 'feedback' : null;
        if (!operation) {
          throw new MemoryStoreError('Unsupported memory transaction operation', {
            code: 'MEMORY_TRANSACTION_INVALID',
          });
        }
        parseOpaqueId(transaction.batch_id);
        expectedTransactionId = batchTransactionIdentity(operation, transaction.batch_id);
      } else if (state.value?.schema === TRANSACTION_SCHEMA) {
        transaction = assertSealedMetadata(state.value, manifest, TRANSACTION_SCHEMA);
        if (!['event', 'feedback'].includes(transaction.operation)) {
          throw new MemoryStoreError('Unsupported memory transaction operation', {
            code: 'MEMORY_TRANSACTION_INVALID',
          });
        }
        expectedTransactionId = transactionIdentity(
          transaction.operation,
          transaction.source_key_digest,
        );
      } else {
        throw new MemoryStoreError('Memory transaction metadata is invalid', {
          code: 'MEMORY_TRANSACTION_INVALID',
        });
      }
      const expectedPath = journalEntryPath(this.#layout, JOURNAL_ID, expectedTransactionId);
      if (transaction.transaction_id !== expectedTransactionId || !sameFilesystemPath(entry.path, expectedPath)) {
        throw new MemoryStoreError('Memory journal entry identity does not match its storage key', {
          code: 'MEMORY_TRANSACTION_INVALID',
        });
      }
      if (transaction.schema === BATCH_TRANSACTION_SCHEMA) {
        await this.#commitBatchTransaction(state, manifest, { injectFaults: false });
      } else if (transaction.operation === 'event') {
        await this.#commitEventTransaction(state, manifest, { injectFaults: false });
      } else if (transaction.operation === 'feedback') {
        await this.#commitFeedbackTransaction(state, manifest, { injectFaults: false });
      } else {
        throw new MemoryStoreError('Unsupported memory transaction operation', {
          code: 'MEMORY_TRANSACTION_INVALID',
        });
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
    if (event.integrity.digest !== marker.record_digest
        || marker.event_id !== event.event_id
        || marker.memory_id !== memory.memory_id
        || event.idempotency?.source_key_digest !== marker.source_key_digest
        || event.idempotency?.request_digest !== marker.request_digest
        || memory.event_id !== event.event_id
        || event.memory_id !== memory.memory_id) {
      throw new MemoryStoreError('Committed event metadata failed verification', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
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

      const marker = await this.#readMarker('event', sourceKey, manifest, budget);
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
    assertBatch(rawEvents, 'events');
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
        const transactionState = await this.#createBatchTransaction('event', plan.transactions, manifest);
        await this.#fault('after_journal_create', {
          batch_id: transactionState.value.batch_id,
          event_count: plan.transactions.length,
        });
        await this.#commitBatchTransaction(transactionState, manifest);
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
    } else {
      memory = await this.#readMemory(target.id, manifest, budget);
      event = await this.#readEvent(memory.event_id, manifest, budget);
      if (event.memory_id !== memory.memory_id) {
        throw new MemoryStoreError('Event and memory records do not link to each other', {
          code: 'MEMORY_RECORD_INVALID',
        });
      }
    }
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
    if (feedback.feedback_id !== marker.feedback_id
        || feedback.integrity.digest !== marker.record_digest
        || feedback.idempotency?.source_key_digest !== marker.source_key_digest
        || feedback.idempotency?.request_digest !== marker.request_digest) {
      throw new MemoryStoreError('Committed feedback metadata failed verification', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return feedback;
  }

  async #planFeedbackBatch(prepared, manifest, budget) {
    const entries = [];
    const transactions = [];
    const sources = new Map();
    const reservedFeedbackIds = new Set();

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

      const marker = await this.#readMarker('feedback', sourceKey, manifest, budget);
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
    assertBatch(rawFeedback, 'feedback');
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
        const transactionState = await this.#createBatchTransaction('feedback', plan.transactions, manifest);
        await this.#fault('after_journal_create', {
          batch_id: transactionState.value.batch_id,
          feedback_count: plan.transactions.length,
        });
        await this.#commitBatchTransaction(transactionState, manifest);
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
      });
    }
    return events;
  }

  async #readAccessibleFeedback(manifest, budget) {
    const states = await this.#listCollection('feedback', budget);
    return states
      .map((state) => {
        const feedback = assertStoredRecord(state.value, manifest, MEMORY_FEEDBACK_SCHEMA);
        this.#assertCollectionIdentity(state, 'feedback', feedback.feedback_id);
        return feedback;
      })
      .filter((feedback) => canReadNamespace(this.#profile, feedback.namespace));
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
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new MemoryStoreError('Memory search limit must be an integer from 1 through 100', {
        code: 'MEMORY_QUERY_INVALID',
      });
    }
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

    return this.#withConsistentVault(async (manifest) => {
      const accessibleEvents = await this.#readAccessibleEvents(manifest, budget);
      let events = accessibleEvents;
      if (requestedNamespaces) {
        events = events.filter((event) => requestedNamespaces.some(
          (namespace) => event.namespace === namespace || event.namespace.startsWith(`${namespace}/`),
        ));
      }
      if (requestedActors) events = events.filter((event) => requestedActors.has(event.actor.type));
      if (requestedKinds) events = events.filter((event) => requestedKinds.has(event.kind));
      const feedback = await this.#readAccessibleFeedback(manifest, budget);
      const readableEventIds = new Set(accessibleEvents.map((event) => event.event_id));
      const readableMemoryIds = new Set(accessibleEvents.map((event) => event.memory_id));
      const visibleFeedback = feedback
        .map((item) => visibleFeedbackProjection(item, readableEventIds, readableMemoryIds))
        .filter(Boolean);
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
    });
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
