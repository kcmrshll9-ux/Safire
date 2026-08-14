import fs from 'node:fs/promises';
import path from 'node:path';
import {
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
  readJournalEntry,
  readJsonWithDigest,
  removeJournalDirectoryIfEmpty,
  removeJournalEntry,
  replaceJsonOptimistic,
  resolveContainedPath,
  withVaultLock,
} from './filesystem.mjs';
import {
  assertNamespaceAccess,
  canReadNamespace,
  lookupActor,
  PROFILE_TYPES,
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
  digestRecord,
  newOpaqueId,
  regenerateVaultManifest,
  requestDigest,
  sourceKeyDigest,
  verifyRecordIntegrity,
} from './records.mjs';
import {
  ACTOR_TYPES,
  EVENT_KINDS,
  MEMORY_SCHEMA_VERSION,
  canonicalizeNamespace,
  parseEventInput,
  parseFeedbackInput,
  parseOpaqueId,
} from './schema.mjs';
import { rankMemoryEvents } from './search.mjs';

const IDEMPOTENCY_SCHEMA = 'safire.memory.idempotency/v1';
const TRANSACTION_SCHEMA = 'safire.memory.transaction/v1';
const JOURNAL_ID = 'ingestion';
const MAX_BATCH_SIZE = 100;

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

function incomingRelationsFor(events, targetEventId) {
  return events
    .flatMap((event) => (event.relations || [])
      .filter((relation) => relation.target_event_id === targetEventId)
      .map((relation) => ({
        type: relation.type,
        source_event_id: event.event_id,
      })))
    .sort((left, right) => (
      left.source_event_id.localeCompare(right.source_event_id)
      || left.type.localeCompare(right.type)
    ));
}

function visibleEventProjection(event, readableEventIds) {
  const relations = (event.relations || [])
    .filter((relation) => readableEventIds.has(relation.target_event_id));
  const derived = event.derived
    ? {
      ...event.derived,
      source_event_ids: event.derived.source_event_ids
        .filter((eventId) => readableEventIds.has(eventId)),
    }
    : null;
  return { ...event, relations, derived };
}

function visibleMemoryProjection(memory, readableEventIds) {
  return {
    ...memory,
    source_event_ids: memory.source_event_ids
      .filter((eventId) => readableEventIds.has(eventId)),
  };
}

function visibleFeedbackProjection(feedback, readableEventIds, readableMemoryIds) {
  if (!feedback.related_target) return feedback;
  const readable = feedback.related_target.type === 'event'
    ? readableEventIds.has(feedback.related_target.id)
    : readableMemoryIds.has(feedback.related_target.id);
  return readable ? feedback : { ...feedback, related_target: null };
}

function transactionIdentity(operation, keyDigest) {
  return `${operation}:${keyDigest}`;
}

export class MemoryStore {
  constructor({
    vaultDir,
    profile,
    enabled = true,
    now = () => new Date(),
    idFactory = newOpaqueId,
    faultInjector = null,
    trustedIngress = false,
  } = {}) {
    if (typeof vaultDir !== 'string' || !vaultDir.trim()) {
      throw new MemoryStoreError('An explicit vault directory is required', { code: 'MEMORY_VAULT_REQUIRED' });
    }
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
    this.vaultDir = resolvedVaultDir;
    this.enabled = Boolean(enabled);
    this.profile = profile ? validateProfile(profile) : null;
    if (this.enabled && !this.profile) {
      throw new MemoryStoreError('An enabled memory store requires a validated agent profile', {
        code: 'MEMORY_PROFILE_REQUIRED',
      });
    }
    if (typeof trustedIngress !== 'boolean') {
      throw new TypeError('MemoryStore trustedIngress must be a boolean');
    }
    if (trustedIngress && this.profile?.profile_type !== PROFILE_TYPES.TRUSTED_BRIDGE) {
      throw new MemoryStoreError('Trusted ingress requires a trusted_bridge profile', {
        code: 'MEMORY_PROFILE_DENIED',
      });
    }
    this.trustedIngress = trustedIngress;
    if (typeof now !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('MemoryStore now and idFactory options must be functions');
    }
    this.now = now;
    this.idFactory = idFactory;
    this.faultInjector = faultInjector;
    this.layout = null;
    this.initialization = null;
  }

  _timestamp() {
    return asIsoTimestamp(this.now());
  }

  _assertEnabled() {
    if (!this.enabled) throw new MemoryDisabledError();
  }

  async _ensureInitialized() {
    this._assertEnabled();
    if (!this.initialization) {
      this.initialization = this._initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async initialize() {
    await this._ensureInitialized();
    return withVaultLock(this.layout, async () => {
      const manifest = (await this._readManifest()).value;
      await this._recoverTransactions(manifest);
      return { layout: this.layout, manifest };
    });
  }

  async _initialize() {
    await fs.mkdir(this.vaultDir, { recursive: true });
    this.layout = await ensureMemoryLayout(this.vaultDir);
    return withVaultLock(this.layout, async (lock) => {
      const manifestState = await this._ensureManifest();
      const manifest = assertManifest(manifestState.value);
      await this._ensureProfileActors(manifest);
      await this._recoverTransactions(manifest, lock);
      return { layout: this.layout, manifest };
    });
  }

  _manifestPath() {
    return resolveContainedPath(this.layout.rootDir, 'manifest.json');
  }

  async _ensureManifest() {
    const existing = await missingAsNull(() => readJsonWithDigest(this.layout.rootDir, this._manifestPath()));
    if (existing) return existing;
    const [recordCollections, stateEntries, journalEntries] = await Promise.all([
      fs.readdir(this.layout.recordsDir, { withFileTypes: true }),
      fs.readdir(this.layout.stateDir, { withFileTypes: true }),
      fs.readdir(this.layout.journalsDir, { withFileTypes: true }),
    ]);
    let hasRecordData = recordCollections.some((entry) => !entry.isDirectory());
    for (const collection of recordCollections.filter((entry) => entry.isDirectory())) {
      if ((await fs.readdir(path.join(this.layout.recordsDir, collection.name))).length > 0) {
        hasRecordData = true;
        break;
      }
    }
    if (hasRecordData || stateEntries.length > 0 || journalEntries.length > 0) {
      throw new MemoryStoreError('The memory manifest is missing from a nonempty sidecar', {
        code: 'MEMORY_MANIFEST_MISSING',
      });
    }
    const manifest = buildVaultManifest({ createdAt: this._timestamp() });
    try {
      return await createJsonExclusive(this.layout.rootDir, this._manifestPath(), manifest);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return readJsonWithDigest(this.layout.rootDir, this._manifestPath());
    }
  }

  async _readManifest() {
    const state = await readJsonWithDigest(this.layout.rootDir, this._manifestPath());
    assertManifest(state.value);
    return state;
  }

  async _withConsistentVault(operation) {
    await this._ensureInitialized();
    return withVaultLock(this.layout, async (lock) => {
      const manifest = (await this._readManifest()).value;
      await this._recoverTransactions(manifest);
      return operation(manifest, lock);
    });
  }

  async _ensureProfileActors(manifest) {
    const actors = [this.profile.principal, this.profile.agent_instance, ...this.profile.allowed_actors];
    for (const actor of actors) {
      const existing = await missingAsNull(() => readImmutableJson(this.layout, 'actors', actor.id));
      if (existing) {
        const stored = assertStoredRecord(existing.value, manifest, MEMORY_ACTOR_SCHEMA);
        if (!actorIdentityMatches(stored.actor, actor)) {
          throw new MemoryStoreError('A stable actor ID is already registered with another type', {
            code: 'MEMORY_ACTOR_CONFLICT',
          });
        }
        continue;
      }
      const record = buildActorRecord({ vaultId: manifest.vault_id, actor, createdAt: this._timestamp() });
      try {
        await createImmutableJson(this.layout, 'actors', actor.id, record);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const raced = await readImmutableJson(this.layout, 'actors', actor.id);
        const stored = assertStoredRecord(raced.value, manifest, MEMORY_ACTOR_SCHEMA);
        if (!actorIdentityMatches(stored.actor, actor)) {
          throw new MemoryStoreError('A stable actor ID is already registered with another type', {
            code: 'MEMORY_ACTOR_CONFLICT',
          });
        }
      }
    }
  }

  async _fault(stage, metadata) {
    if (typeof this.faultInjector === 'function') await this.faultInjector(stage, Object.freeze({ ...metadata }));
  }

  async _listCollection(collection) {
    const directory = immutableCollectionDirectory(this.layout, collection);
    const entries = await listImmutableJson(this.layout, collection);
    return Promise.all(entries.map((entry) => readJsonWithDigest(directory, entry.path)));
  }

  _assertCollectionIdentity(state, collection, identity) {
    const expectedPath = immutableRecordPath(this.layout, collection, identity);
    if (!sameFilesystemPath(state.path, expectedPath)) {
      throw new MemoryStoreError('Memory record identity does not match its storage key', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
  }

  async _ensureImmutable(collection, identity, expected, manifest, schema) {
    try {
      await createImmutableJson(this.layout, collection, identity, expected);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readImmutableJson(this.layout, collection, identity);
      const stored = assertStoredRecord(existing.value, manifest, schema);
      if (stored.integrity.digest !== expected.integrity.digest) {
        throw new MemoryStoreError('An immutable memory ID collision was detected', {
          code: 'MEMORY_ID_CONFLICT',
        });
      }
      return false;
    }
  }

  async _uniqueId(prefix, collection) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.idFactory(prefix);
      parseOpaqueId(id);
      const existing = await missingAsNull(() => readImmutableJson(this.layout, collection, id));
      if (!existing) return id;
    }
    throw new MemoryStoreError('Unable to allocate an exclusive memory ID', { code: 'MEMORY_ID_CONFLICT' });
  }

  async _readEvent(eventId, manifest) {
    parseOpaqueId(eventId);
    const state = await missingAsNull(() => readImmutableJson(this.layout, 'events', eventId));
    if (!state) throw new MemoryNotFoundError();
    const event = assertStoredRecord(state.value, manifest, MEMORY_EVENT_SCHEMA);
    if (event.event_id !== eventId) {
      throw new MemoryStoreError('Event record identity does not match its storage key', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
    return event;
  }

  async _readMemory(memoryId, manifest) {
    parseOpaqueId(memoryId);
    const state = await missingAsNull(() => readImmutableJson(this.layout, 'memories', memoryId));
    if (!state) throw new MemoryNotFoundError();
    const memory = assertStoredRecord(state.value, manifest, MEMORY_ITEM_SCHEMA);
    if (memory.memory_id !== memoryId) {
      throw new MemoryStoreError('Memory record identity does not match its storage key', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
    return memory;
  }

  async _assertReferencesAccessible(input, manifest) {
    const references = new Set([
      ...(input.relations || []).map((relation) => relation.target_event_id),
      ...(input.derived?.source_event_ids || []),
    ]);
    for (const eventId of references) {
      const target = await this._readEvent(eventId, manifest);
      try {
        assertNamespaceAccess(this.profile, target.namespace, 'read');
      } catch {
        throw new MemoryNotFoundError();
      }
    }
  }

  async _readMarker(operation, sourceKey, requestHash, manifest) {
    const identity = idempotencyIdentity(operation, sourceKey);
    const state = await missingAsNull(() => readImmutableJson(this.layout, 'idempotency', identity));
    if (!state) return null;
    const marker = assertSealedMetadata(state.value, manifest, IDEMPOTENCY_SCHEMA);
    if (marker.operation !== operation || marker.source_key_digest !== sourceKey) {
      throw new MemoryStoreError('Idempotency metadata is inconsistent', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    if (marker.request_digest !== requestHash) throw new MemoryIdempotencyConflictError();
    return marker;
  }

  async _readTransaction(operation, sourceKey, requestHash, manifest) {
    const identity = transactionIdentity(operation, sourceKey);
    const state = await missingAsNull(() => readJournalEntry(this.layout, JOURNAL_ID, identity));
    if (!state) return null;
    const transaction = assertSealedMetadata(state.value, manifest, TRANSACTION_SCHEMA);
    if (transaction.operation !== operation
        || transaction.source_key_digest !== sourceKey
        || transaction.request_digest !== requestHash
        || transaction.transaction_id !== transactionIdentity(operation, sourceKey)) {
      throw new MemoryIdempotencyConflictError();
    }
    return state;
  }

  async _createTransaction(operation, sourceKey, requestHash, payload, manifest) {
    const identity = transactionIdentity(operation, sourceKey);
    const transaction = sealRecord({
      schema: TRANSACTION_SCHEMA,
      schema_version: MEMORY_SCHEMA_VERSION,
      vault_id: manifest.vault_id,
      operation,
      transaction_id: identity,
      source_key_digest: sourceKey,
      request_digest: requestHash,
      created_at: this._timestamp(),
      ...payload,
    });
    try {
      const state = await createJournalEntry(this.layout, JOURNAL_ID, identity, transaction);
      return { ...state, resumed: false };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await this._readTransaction(operation, sourceKey, requestHash, manifest);
      return { ...existing, resumed: true };
    }
  }

  async _cleanupTransaction(transactionState) {
    const transaction = transactionState.value;
    await removeJournalEntry(
      this.layout,
      JOURNAL_ID,
      transaction.transaction_id,
      { expectedDigest: transactionState.digest },
    );
    await removeJournalDirectoryIfEmpty(this.layout, JOURNAL_ID);
  }

  _markerForEvent(transaction) {
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

  _markerForFeedback(transaction) {
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

  async _commitEventTransaction(transactionState, manifest, { injectFaults = true } = {}) {
    const transaction = assertSealedMetadata(transactionState.value, manifest, TRANSACTION_SCHEMA);
    const event = assertStoredRecord(transaction.event, manifest, MEMORY_EVENT_SCHEMA);
    const memory = assertStoredRecord(transaction.memory, manifest, MEMORY_ITEM_SCHEMA);
    if (memory.event_id !== event.event_id || event.memory_id !== memory.memory_id) {
      throw new MemoryStoreError('Event and memory transaction records do not link to each other', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    await this._ensureImmutable('events', event.event_id, event, manifest, MEMORY_EVENT_SCHEMA);
    if (injectFaults) await this._fault('after_event_create', { event_id: event.event_id });
    await this._ensureImmutable('memories', memory.memory_id, memory, manifest, MEMORY_ITEM_SCHEMA);
    if (injectFaults) await this._fault('after_memory_create', { event_id: event.event_id, memory_id: memory.memory_id });
    const marker = this._markerForEvent(transaction);
    await this._ensureImmutable(
      'idempotency',
      idempotencyIdentity('event', transaction.source_key_digest),
      marker,
      manifest,
      IDEMPOTENCY_SCHEMA,
    );
    if (injectFaults) await this._fault('after_idempotency_create', { event_id: event.event_id });
    await this._cleanupTransaction(transactionState);
    return { event, memory };
  }

  async _commitFeedbackTransaction(transactionState, manifest, { injectFaults = true } = {}) {
    const transaction = assertSealedMetadata(transactionState.value, manifest, TRANSACTION_SCHEMA);
    const feedback = assertStoredRecord(transaction.feedback, manifest, MEMORY_FEEDBACK_SCHEMA);
    await this._ensureImmutable('feedback', feedback.feedback_id, feedback, manifest, MEMORY_FEEDBACK_SCHEMA);
    if (injectFaults) await this._fault('after_feedback_create', { feedback_id: feedback.feedback_id });
    const marker = this._markerForFeedback(transaction);
    await this._ensureImmutable(
      'idempotency',
      idempotencyIdentity('feedback', transaction.source_key_digest),
      marker,
      manifest,
      IDEMPOTENCY_SCHEMA,
    );
    if (injectFaults) await this._fault('after_idempotency_create', { feedback_id: feedback.feedback_id });
    await this._cleanupTransaction(transactionState);
    return feedback;
  }

  async _recoverTransactions(manifest) {
    const entries = await missingAsNull(() => listJournalEntries(this.layout, JOURNAL_ID));
    if (!entries) return;
    const directory = journalDirectory(this.layout, JOURNAL_ID);
    for (const entry of entries) {
      const state = await readJsonWithDigest(directory, entry.path);
      const transaction = assertSealedMetadata(state.value, manifest, TRANSACTION_SCHEMA);
      const expectedTransactionId = transactionIdentity(transaction.operation, transaction.source_key_digest);
      const expectedPath = journalEntryPath(this.layout, JOURNAL_ID, expectedTransactionId);
      if (transaction.transaction_id !== expectedTransactionId || !sameFilesystemPath(entry.path, expectedPath)) {
        throw new MemoryStoreError('Memory journal entry identity does not match its storage key', {
          code: 'MEMORY_TRANSACTION_INVALID',
        });
      }
      if (transaction.operation === 'event') {
        await this._commitEventTransaction(state, manifest, { injectFaults: false });
      } else if (transaction.operation === 'feedback') {
        await this._commitFeedbackTransaction(state, manifest, { injectFaults: false });
      } else {
        throw new MemoryStoreError('Unsupported memory transaction operation', {
          code: 'MEMORY_TRANSACTION_INVALID',
        });
      }
    }
  }

  _resolveEventAttribution(input) {
    const attribution = resolveAttribution(this.profile, {
      actor: eventActorReference(this.profile, input),
      source: input.source,
    });
    if (attribution.actor.type === 'user' && !this.trustedIngress) {
      throw new MemoryStoreError('Trusted user events require an internal bridge-enabled store', {
        code: 'MEMORY_PROFILE_DENIED',
      });
    }
    assertKindActorCoherence(input, attribution.actor);
    assertAttributionMatchesInput(input, attribution);
    return attribution;
  }

  async _existingEvent(marker, manifest) {
    const event = await this._readEvent(marker.event_id, manifest);
    const memory = await this._readMemory(marker.memory_id, manifest);
    if (event.integrity.digest !== marker.record_digest
        || marker.event_id !== event.event_id
        || marker.memory_id !== memory.memory_id
        || memory.event_id !== event.event_id
        || event.memory_id !== memory.memory_id) {
      throw new MemoryStoreError('Committed event metadata failed verification', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return { event, memory };
  }

  async _recordEvent(input, attribution, manifest) {
    const sourceKey = sourceKeyDigest(attribution.source);
    const inputHash = requestDigest(input, attribution);
    await this._assertReferencesAccessible(input, manifest);
    const marker = await this._readMarker('event', sourceKey, inputHash, manifest);
    if (marker) return { status: 'duplicate', ...(await this._existingEvent(marker, manifest)) };
    let transactionState = await this._readTransaction('event', sourceKey, inputHash, manifest);
    if (transactionState) transactionState = { ...transactionState, resumed: true };
    if (!transactionState) {
      const eventId = await this._uniqueId('evt', 'events');
      const memoryId = await this._uniqueId('mem', 'memories');
      const event = buildEventRecord({
        vaultId: manifest.vault_id,
        input,
        attribution,
        eventId,
        memoryId,
        ingestedAt: this._timestamp(),
      });
      const memory = buildMemoryRecord(event);
      transactionState = await this._createTransaction(
        'event', sourceKey, inputHash, { event, memory }, manifest,
      );
      await this._fault('after_journal_create', { event_id: eventId, memory_id: memoryId });
    }
    const result = await this._commitEventTransaction(transactionState, manifest);
    return { status: transactionState.resumed ? 'recovered' : 'created', ...result };
  }

  async recordEvents(rawEvents) {
    this._assertEnabled();
    assertBatch(rawEvents, 'events');
    const prepared = rawEvents.map((raw) => {
      const input = parseEventInput(raw);
      assertNamespaceAccess(this.profile, input.namespace, 'write');
      return { input, attribution: this._resolveEventAttribution(input) };
    });
    return this._withConsistentVault(async (manifest) => {
      const results = [];
      for (const item of prepared) results.push(await this._recordEvent(item.input, item.attribution, manifest));
      return {
        results,
        created_count: results.filter((result) => result.status === 'created').length,
        recovered_count: results.filter((result) => result.status === 'recovered').length,
        duplicate_count: results.filter((result) => result.status === 'duplicate').length,
      };
    });
  }

  async _resolveTarget(target, manifest, access = 'read') {
    let event;
    let memory = null;
    if (target.type === 'event') {
      event = await this._readEvent(target.id, manifest);
    } else {
      memory = await this._readMemory(target.id, manifest);
      event = await this._readEvent(memory.event_id, manifest);
      if (event.memory_id !== memory.memory_id) {
        throw new MemoryStoreError('Event and memory records do not link to each other', {
          code: 'MEMORY_RECORD_INVALID',
        });
      }
    }
    try {
      assertNamespaceAccess(this.profile, event.namespace, access);
    } catch {
      throw new MemoryNotFoundError();
    }
    return { event, memory, namespace: event.namespace };
  }

  _resolveFeedbackAttribution(input) {
    const actor = lookupActor(this.profile, input.actor_id);
    if (actor?.type === 'user' && !this.trustedIngress) {
      throw new MemoryStoreError('Trusted user feedback requires an internal bridge-enabled store', {
        code: 'MEMORY_PROFILE_DENIED',
      });
    }
    if (['user_confirmed', 'user_rejected'].includes(input.signal) && actor && actor.type !== 'user') {
      throw new MemoryStoreError('User confirmation signals require a trusted user actor', {
        code: 'MEMORY_ACTOR_KIND_MISMATCH',
      });
    }
    return resolveAttribution(this.profile, {
      actor: input.actor_id,
      source: input.source,
      trusted_user_feedback: actor?.type === 'user',
      user_confirmed: input.signal === 'user_confirmed',
      user_rejected: input.signal === 'user_rejected',
    });
  }

  async _existingFeedback(marker, manifest) {
    const state = await readImmutableJson(this.layout, 'feedback', marker.feedback_id);
    const feedback = assertStoredRecord(state.value, manifest, MEMORY_FEEDBACK_SCHEMA);
    if (feedback.feedback_id !== marker.feedback_id || feedback.integrity.digest !== marker.record_digest) {
      throw new MemoryStoreError('Committed feedback metadata failed verification', {
        code: 'MEMORY_TRANSACTION_INVALID',
      });
    }
    return feedback;
  }

  async _recordFeedback(input, attribution, manifest) {
    const sourceKey = sourceKeyDigest(attribution.source);
    const inputHash = requestDigest(input, attribution);
    const target = await this._resolveTarget(input.target, manifest, 'write');
    if (input.related_target) await this._resolveTarget(input.related_target, manifest, 'read');
    const marker = await this._readMarker('feedback', sourceKey, inputHash, manifest);
    if (marker) return { status: 'duplicate', feedback: await this._existingFeedback(marker, manifest) };
    let transactionState = await this._readTransaction('feedback', sourceKey, inputHash, manifest);
    if (transactionState) transactionState = { ...transactionState, resumed: true };
    if (!transactionState) {
      const feedbackId = await this._uniqueId('fbk', 'feedback');
      const feedback = buildFeedbackRecord({
        vaultId: manifest.vault_id,
        input,
        attribution,
        namespace: target.namespace,
        feedbackId,
        recordedAt: this._timestamp(),
      });
      transactionState = await this._createTransaction(
        'feedback', sourceKey, inputHash, { feedback }, manifest,
      );
      await this._fault('after_journal_create', { feedback_id: feedbackId });
    }
    const feedback = await this._commitFeedbackTransaction(transactionState, manifest);
    return { status: transactionState.resumed ? 'recovered' : 'created', feedback };
  }

  async recordFeedback(rawFeedback) {
    this._assertEnabled();
    assertBatch(rawFeedback, 'feedback');
    const prepared = rawFeedback.map((raw) => {
      const input = parseFeedbackInput(raw);
      return { input, attribution: this._resolveFeedbackAttribution(input) };
    });
    return this._withConsistentVault(async (manifest) => {
      const results = [];
      for (const item of prepared) results.push(await this._recordFeedback(item.input, item.attribution, manifest));
      return {
        results,
        created_count: results.filter((result) => result.status === 'created').length,
        recovered_count: results.filter((result) => result.status === 'recovered').length,
        duplicate_count: results.filter((result) => result.status === 'duplicate').length,
      };
    });
  }

  async _readAccessibleEvents(manifest) {
    const states = await this._listCollection('events');
    const events = states
      .map((state) => {
        const event = assertStoredRecord(state.value, manifest, MEMORY_EVENT_SCHEMA);
        this._assertCollectionIdentity(state, 'events', event.event_id);
        return event;
      })
      .filter((event) => canReadNamespace(this.profile, event.namespace));
    for (const event of events) {
      const memory = await this._readMemory(event.memory_id, manifest);
      if (memory.event_id !== event.event_id) {
        throw new MemoryStoreError('Event and memory records do not link to each other', {
          code: 'MEMORY_RECORD_INVALID',
        });
      }
    }
    return events;
  }

  async _readAccessibleFeedback(manifest) {
    const states = await this._listCollection('feedback');
    return states
      .map((state) => {
        const feedback = assertStoredRecord(state.value, manifest, MEMORY_FEEDBACK_SCHEMA);
        this._assertCollectionIdentity(state, 'feedback', feedback.feedback_id);
        return feedback;
      })
      .filter((feedback) => canReadNamespace(this.profile, feedback.namespace));
  }

  async search({ query = '', namespaces, actor_types, kinds, limit = 50 } = {}) {
    this._assertEnabled();
    if (typeof query !== 'string' || query.length > 2_000) {
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
    for (const namespace of requestedNamespaces || []) assertNamespaceAccess(this.profile, namespace, 'read');
    const requestedActors = actor_types === undefined ? null : new Set(actor_types);
    if (requestedActors && [...requestedActors].some((type) => !ACTOR_TYPES.includes(type))) {
      throw new MemoryStoreError('Memory actor filter is invalid', { code: 'MEMORY_QUERY_INVALID' });
    }
    const requestedKinds = kinds === undefined ? null : new Set(kinds);
    if (requestedKinds && [...requestedKinds].some((kind) => !EVENT_KINDS.includes(kind))) {
      throw new MemoryStoreError('Memory kind filter is invalid', { code: 'MEMORY_QUERY_INVALID' });
    }

    return this._withConsistentVault(async (manifest) => {
      const accessibleEvents = await this._readAccessibleEvents(manifest);
      let events = accessibleEvents;
      if (requestedNamespaces) {
        events = events.filter((event) => requestedNamespaces.some(
          (namespace) => event.namespace === namespace || event.namespace.startsWith(`${namespace}/`),
        ));
      }
      if (requestedActors) events = events.filter((event) => requestedActors.has(event.actor.type));
      if (requestedKinds) events = events.filter((event) => requestedKinds.has(event.kind));
      const feedback = await this._readAccessibleFeedback(manifest);
      const ranked = rankMemoryEvents(events, feedback, { query, limit });
      const readableEventIds = new Set(accessibleEvents.map((event) => event.event_id));
      return {
        query,
        namespaces: requestedNamespaces,
        count: ranked.length,
        results: ranked.map(({ event, ...ranking }) => {
          const visibleEvent = visibleEventProjection(event, readableEventIds);
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
            incoming_relations: incomingRelationsFor(accessibleEvents, visibleEvent.event_id),
            derived: visibleEvent.derived,
            occurred_at: visibleEvent.occurred_at,
            ingested_at: visibleEvent.ingested_at,
            integrity: visibleEvent.integrity,
            ...ranking,
          };
        }),
      };
    });
  }

  async _getUnlocked(id, manifest, accessibleEvents = null, accessibleFeedback = null) {
    let event;
    let memory;
    if (id.startsWith('evt_')) {
      event = await this._readEvent(id, manifest);
      memory = await this._readMemory(event.memory_id, manifest);
    } else if (id.startsWith('mem_')) {
      memory = await this._readMemory(id, manifest);
      event = await this._readEvent(memory.event_id, manifest);
    } else {
      throw new MemoryNotFoundError();
    }
    try {
      assertNamespaceAccess(this.profile, event.namespace, 'read');
    } catch {
      throw new MemoryNotFoundError();
    }
    if (event.memory_id !== memory.memory_id || memory.event_id !== event.event_id) {
      throw new MemoryStoreError('Event and memory records do not link to each other', {
        code: 'MEMORY_RECORD_INVALID',
      });
    }
    const allFeedback = accessibleFeedback || await this._readAccessibleFeedback(manifest);
    const feedback = allFeedback.filter((item) => (
      (item.target.type === 'event' && item.target.id === event.event_id)
      || (item.target.type === 'memory' && item.target.id === memory.memory_id)
    ));
    const allEvents = accessibleEvents || await this._readAccessibleEvents(manifest);
    const readableEventIds = new Set(allEvents.map((item) => item.event_id));
    const readableMemoryIds = new Set(allEvents.map((item) => item.memory_id));
    const [ranking] = rankMemoryEvents([event], feedback, { query: '', limit: 1 });
    return {
      event: visibleEventProjection(event, readableEventIds),
      memory: visibleMemoryProjection(memory, readableEventIds),
      feedback: feedback.map((item) => visibleFeedbackProjection(
        item,
        readableEventIds,
        readableMemoryIds,
      )),
      incoming_relations: incomingRelationsFor(allEvents, event.event_id),
      activity: ranking.activity,
      signals_by_actor: ranking.signals_by_actor,
    };
  }

  async get(id) {
    this._assertEnabled();
    parseOpaqueId(id);
    return this._withConsistentVault((manifest) => this._getUnlocked(id, manifest));
  }

  async recall(ids) {
    this._assertEnabled();
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH_SIZE) {
      throw new MemoryStoreError('Recall requires 1 through 100 event or memory IDs', {
        code: 'MEMORY_QUERY_INVALID',
      });
    }
    const unique = [...new Set(ids)];
    for (const id of unique) parseOpaqueId(id);
    return this._withConsistentVault(async (manifest) => {
      const [events, feedback] = await Promise.all([
        this._readAccessibleEvents(manifest),
        this._readAccessibleFeedback(manifest),
      ]);
      const results = [];
      for (const id of unique) {
        results.push(await this._getUnlocked(id, manifest, events, feedback));
      }
      return { results };
    });
  }

  async status() {
    if (!this.enabled) {
      return {
        enabled: false,
        schema_version: MEMORY_SCHEMA_VERSION,
        vault_id: null,
        profile: publicProfile(this.profile),
        counts: { actors: 0, events: 0, memories: 0, feedback: 0 },
        pending_transactions: 0,
      };
    }
    return this._withConsistentVault(async (manifest) => {
      const [events, feedback] = await Promise.all([
        this._readAccessibleEvents(manifest),
        this._readAccessibleFeedback(manifest),
      ]);
      const visibleActors = new Set([
        this.profile.principal.id,
        this.profile.agent_instance.id,
        ...this.profile.allowed_actors.map((actor) => actor.id),
      ]);
      return {
        enabled: true,
        schema_version: MEMORY_SCHEMA_VERSION,
        vault_id: manifest.vault_id,
        vault_lineage: manifest.lineage,
        manifest_revision: manifest.revision,
        profile: publicProfile(this.profile),
        counts: {
          actors: visibleActors.size,
          events: events.length,
          memories: events.length,
          feedback: feedback.length,
        },
        pending_transactions: 0,
      };
    });
  }

  async regenerateVaultIdentity({ confirmIndependentClone = false } = {}) {
    this._assertEnabled();
    if (confirmIndependentClone !== true) {
      throw new MemoryStoreError('Vault identity regeneration requires literal confirmation', {
        code: 'MEMORY_IDENTITY_CONFIRMATION_REQUIRED',
      });
    }
    return this._withConsistentVault(async (manifest, lock) => {
      const current = await this._readManifest();
      const next = regenerateVaultManifest(manifest, {
        regeneratedAt: this._timestamp(),
        confirmIndependentClone,
      });
      const replaced = await replaceJsonOptimistic(this.layout, this._manifestPath(), next, {
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
