import { createHash, randomUUID } from 'node:crypto';
import { MEMORY_SCHEMA_VERSION, parseOpaqueId } from './schema.mjs';

export const MEMORY_MANIFEST_SCHEMA = 'safire.memory.manifest/v1';
export const MEMORY_EVENT_SCHEMA = 'safire.memory.event/v1';
export const MEMORY_ITEM_SCHEMA = 'safire.memory.item/v1';
export const MEMORY_FEEDBACK_SCHEMA = 'safire.memory.feedback/v1';
export const MEMORY_ACTOR_SCHEMA = 'safire.memory.actor/v1';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestRecord(record) {
  const { integrity: _integrity, ...unsigned } = record;
  return sha256(canonicalJson(unsigned));
}

function withIntegrity(record) {
  return {
    ...record,
    integrity: {
      algorithm: 'sha256',
      digest: digestRecord(record),
    },
  };
}

export function verifyRecordIntegrity(record) {
  return record?.integrity?.algorithm === 'sha256'
    && record.integrity.digest === digestRecord(record);
}

export function newOpaqueId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function sourceKeyDigest(source) {
  if (!source?.identity || !source?.stream || !source?.event_id) {
    throw new Error('A complete trusted source identity is required');
  }
  return sha256(canonicalJson({
    identity: source.identity,
    stream: source.stream,
    event_id: source.event_id,
  }));
}

function stableActorIdentity(actor) {
  if (!actor) return null;
  return {
    id: actor.id,
    type: actor.type,
    delegated_by: actor.delegated_by || null,
  };
}

function stableRequestInput(input) {
  if (input?.kind !== undefined) {
    return {
      schema_version: input.schema_version,
      namespace: input.namespace,
      kind: input.kind,
      speech_act: input.speech_act,
      content: input.content,
      occurred_at: input.occurred_at,
      context: input.context || {},
      relations: input.relations || [],
      derived: input.derived || null,
      attributes: input.attributes || {},
      source: input.source,
    };
  }
  return {
    schema_version: input?.schema_version,
    target: input?.target,
    signal: input?.signal,
    correction: input?.correction || null,
    related_target: input?.related_target || null,
    source: input?.source,
  };
}

export function requestDigest(input, attribution) {
  return sha256(canonicalJson({
    input: stableRequestInput(input),
    actor: stableActorIdentity(attribution.actor),
    ingested_by: attribution.ingested_by,
    agent_instance: stableActorIdentity(attribution.agent_instance),
    delegated_by: stableActorIdentity(attribution.delegated_by),
    source: attribution.source,
  }));
}

export function persistedRequestDigest(record) {
  let input;
  if (record?.schema === MEMORY_EVENT_SCHEMA) {
    input = {
      schema_version: record.schema_version,
      namespace: record.namespace,
      kind: record.kind,
      speech_act: record.speech_act,
      content: record.content,
      occurred_at: record.occurred_at,
      context: record.context,
      relations: record.relations,
      derived: record.derived,
      attributes: record.attributes,
      source: {
        stream: record.source?.stream,
        event_id: record.source?.event_id,
      },
    };
  } else if (record?.schema === MEMORY_FEEDBACK_SCHEMA) {
    input = {
      schema_version: record.schema_version,
      target: record.target,
      signal: record.signal,
      correction: record.correction,
      related_target: record.related_target,
      source: {
        stream: record.source?.stream,
        event_id: record.source?.event_id,
      },
    };
  } else {
    throw new TypeError('A persisted event or feedback record is required');
  }
  return requestDigest(input, {
    actor: record.actor,
    ingested_by: record.ingested_by,
    agent_instance: record.agent_instance,
    delegated_by: record.delegated_by,
    source: record.source,
  });
}

export function buildVaultManifest({ vaultId = newOpaqueId('vlt'), createdAt }) {
  parseOpaqueId(vaultId);
  const record = {
    schema: MEMORY_MANIFEST_SCHEMA,
    schema_version: MEMORY_SCHEMA_VERSION,
    vault_id: vaultId,
    created_at: createdAt,
    revision: 1,
    lineage: [],
  };
  return withIntegrity(record);
}

export function regenerateVaultManifest(manifest, {
  vaultId = newOpaqueId('vlt'),
  regeneratedAt,
  confirmIndependentClone = false,
} = {}) {
  if (confirmIndependentClone !== true) {
    throw new Error('Independent-clone confirmation is required to regenerate vault identity');
  }
  if (!verifyRecordIntegrity(manifest)) throw new Error('Vault manifest integrity check failed');
  parseOpaqueId(vaultId);
  const lineage = [...new Set([...(manifest.lineage || []), manifest.vault_id])];
  const record = {
    schema: MEMORY_MANIFEST_SCHEMA,
    schema_version: MEMORY_SCHEMA_VERSION,
    vault_id: vaultId,
    created_at: manifest.created_at,
    revision: manifest.revision + 1,
    lineage,
    regenerated_at: regeneratedAt,
    regeneration_reason: 'independent_clone',
    previous_manifest_digest: manifest.integrity.digest,
  };
  return withIntegrity(record);
}

export function buildActorRecord({ vaultId, actor, createdAt }) {
  const record = {
    schema: MEMORY_ACTOR_SCHEMA,
    schema_version: MEMORY_SCHEMA_VERSION,
    vault_id: parseOpaqueId(vaultId),
    actor,
    created_at: createdAt,
  };
  return withIntegrity(record);
}

export function buildEventRecord({
  vaultId,
  input,
  attribution,
  eventId = newOpaqueId('evt'),
  memoryId = newOpaqueId('mem'),
  ingestedAt,
}) {
  parseOpaqueId(vaultId);
  parseOpaqueId(eventId);
  parseOpaqueId(memoryId);
  const sourceKey = sourceKeyDigest(attribution.source);
  const inputDigest = requestDigest(input, attribution);
  const record = {
    schema: MEMORY_EVENT_SCHEMA,
    schema_version: MEMORY_SCHEMA_VERSION,
    vault_id: vaultId,
    event_id: eventId,
    memory_id: memoryId,
    namespace: input.namespace,
    actor: attribution.actor,
    ingested_by: attribution.ingested_by,
    agent_instance: attribution.agent_instance || null,
    delegated_by: attribution.delegated_by || null,
    kind: input.kind,
    speech_act: input.speech_act,
    content: input.content,
    occurred_at: input.occurred_at,
    ingested_at: ingestedAt,
    context: input.context || {},
    relations: input.relations || [],
    derived: input.derived || null,
    attributes: input.attributes || {},
    source: attribution.source,
    idempotency: {
      source_key_digest: sourceKey,
      request_digest: inputDigest,
    },
  };
  return withIntegrity(record);
}

export function buildFeedbackRecord({
  vaultId,
  input,
  attribution,
  namespace,
  feedbackId = newOpaqueId('fbk'),
  recordedAt,
}) {
  parseOpaqueId(vaultId);
  parseOpaqueId(feedbackId);
  const record = {
    schema: MEMORY_FEEDBACK_SCHEMA,
    schema_version: MEMORY_SCHEMA_VERSION,
    vault_id: vaultId,
    feedback_id: feedbackId,
    namespace,
    target: input.target,
    signal: input.signal,
    correction: input.correction || null,
    related_target: input.related_target || null,
    actor: attribution.actor,
    ingested_by: attribution.ingested_by,
    agent_instance: attribution.agent_instance || null,
    delegated_by: attribution.delegated_by || null,
    recorded_at: recordedAt,
    source: attribution.source,
    idempotency: {
      source_key_digest: sourceKeyDigest(attribution.source),
      request_digest: requestDigest(input, attribution),
    },
  };
  return withIntegrity(record);
}

export function buildMemoryRecord(event) {
  if (!verifyRecordIntegrity(event) || event.schema !== MEMORY_EVENT_SCHEMA) {
    throw new Error('A valid memory event is required');
  }
  const record = {
    schema: MEMORY_ITEM_SCHEMA,
    schema_version: MEMORY_SCHEMA_VERSION,
    vault_id: event.vault_id,
    memory_id: event.memory_id,
    namespace: event.namespace,
    event_id: event.event_id,
    source_event_ids: event.derived?.source_event_ids?.length
      ? [...event.derived.source_event_ids]
      : [event.event_id],
    created_at: event.ingested_at,
  };
  return withIntegrity(record);
}

export function assertRecordBelongsToManifest(record, manifest) {
  const acceptedVaultIds = new Set([manifest.vault_id, ...(manifest.lineage || [])]);
  if (!acceptedVaultIds.has(record.vault_id)) {
    throw new Error('Memory record belongs to a different vault identity');
  }
  if (!verifyRecordIntegrity(record)) throw new Error('Memory record integrity check failed');
  return record;
}
