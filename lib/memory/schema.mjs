import { z } from 'zod';

export const MEMORY_SCHEMA_VERSION = 1;
export const EVENT_INPUT_SCHEMA_ID = 'safire.memory.event-input/v1';
export const FEEDBACK_INPUT_SCHEMA_ID = 'safire.memory.feedback-input/v1';

export const ACTOR_TYPES = Object.freeze([
  'user',
  'agent',
  'agent_instance',
  'automation',
  'external_service',
  'system',
  'unknown',
]);

export const EVENT_KINDS = Object.freeze([
  'visible_user_message',
  'visible_agent_response',
  'delegated_instruction',
  'tool_prompt',
  'tool_call',
  'tool_result',
  'observable_action',
  'automation_decision',
  'explicit_conclusion',
  'supplied_file',
  'supplied_link',
  'user_result_interaction',
  'external_observation',
]);

export const SPEECH_ACTS = Object.freeze([
  'request',
  'assertion',
  'preference',
  'proposal',
  'correction',
  'approval',
  'rejection',
  'observation',
  'conclusion',
  'unknown',
]);

export const RELATION_TYPES = Object.freeze([
  'replies_to',
  'causes',
  'results_in',
  'corrects',
  'approves',
  'rejects',
  'contradicts',
  'supports',
  'belongs_to',
]);

export const FEEDBACK_SIGNALS = Object.freeze([
  'useful',
  'not_useful',
  'correction',
  'superseded',
  'user_confirmed',
  'user_rejected',
]);

export const SCHEMA_LIMITS = Object.freeze({
  namespaceLength: 256,
  namespaceSegments: 16,
  opaqueIdLength: 160,
  visibleContentLength: 250_000,
  derivedTextLength: 20_000,
  correctionLength: 20_000,
  relations: 128,
  sourceEventIds: 512,
  attributes: 64,
  attributeStringLength: 2_048,
  attributeArrayItems: 32,
  attributeArrayStringLength: 512,
});

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const NAMESPACE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const SENSITIVE_ATTRIBUTE_KEY_PATTERN = /(?:^|_)(?:api_key|access_key|private_key|secret|password|passwd|credential|authorization|access_token|refresh_token|auth_token|session_token|cookie|chain_of_thought|private_reasoning|hidden_reasoning|internal_reasoning|reasoning_trace|scratchpad)(?:_|$)/i;

const SENSITIVE_TEXT_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/i,
  /\b(?:password|passwd|api[-_ ]?key|access[-_ ]?key|secret[-_ ]?key|client[-_ ]?secret|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token)\b\s*[:=]\s*\S+/i,
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i,
  /\b(?:bearer)\s+[A-Za-z0-9._~+\/-]{16,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/i,
  /\b(?:chain[-_\s]?of[-_\s]?thought|private[-_\s]?reasoning|hidden[-_\s]?reasoning|internal[-_\s]?reasoning|reasoning[-_\s]?trace|scratchpad)\b/i,
]);

const KNOWN_ERROR_PATHS = new Set([
  'schema_version', 'namespace', 'actor_type', 'actor_id', 'delegated_by', 'agent_instance_id',
  'kind', 'speech_act', 'content', 'occurred_at', 'context', 'conversation_id', 'thread_id',
  'session_id', 'turn_id', 'message_id', 'tool_call_id', 'automation_run_id', 'relations', 'type',
  'target_event_id', 'derived', 'summary', 'claim', 'source_event_ids', 'attributes', 'source',
  'stream', 'event_id', 'target', 'id', 'signal', 'correction', 'related_target',
]);

function normalizedScanText(value) {
  return String(value).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
}

export function containsDisallowedSensitiveMaterial(value) {
  if (typeof value !== 'string') return false;
  const candidate = normalizedScanText(value);
  return SENSITIVE_TEXT_PATTERNS.some(pattern => pattern.test(candidate));
}

function addSensitiveTextIssue(value, context) {
  if (!containsDisallowedSensitiveMaterial(value)) return;
  context.addIssue({
    code: 'custom',
    message: 'Sensitive credentials, tokens, or private reasoning are not accepted',
  });
}

function boundedVisibleText(maximum, { allowEmpty = false } = {}) {
  return z.string().max(maximum).superRefine((value, context) => {
    if (!allowEmpty && !value.trim()) {
      context.addIssue({ code: 'custom', message: 'Visible text is required' });
    }
    addSensitiveTextIssue(value, context);
  });
}

function sanitizeIssues(issues) {
  return issues.map(issue => ({
    code: String(issue.code || 'invalid'),
    path: issue.path
      .map(segment => String(segment))
      .filter(segment => KNOWN_ERROR_PATHS.has(segment)),
    message: issue.code === 'custom' ? String(issue.message) : 'Invalid value',
  }));
}

export class MemorySchemaValidationError extends Error {
  constructor(subject, issues = []) {
    super(`Invalid ${subject}`);
    this.name = 'MemorySchemaValidationError';
    this.code = 'MEMORY_SCHEMA_VALIDATION_FAILED';
    this.issues = sanitizeIssues(issues);
  }
}

export function canonicalizeNamespace(input) {
  if (typeof input !== 'string') throw new MemorySchemaValidationError('memory namespace');
  const normalized = input.normalize('NFKC').trim().toLowerCase();
  if (!normalized || normalized.length > SCHEMA_LIMITS.namespaceLength) {
    throw new MemorySchemaValidationError('memory namespace');
  }
  if (normalized.includes('\\') || normalized.includes('%') || normalized.startsWith('/') || normalized.endsWith('/')) {
    throw new MemorySchemaValidationError('memory namespace');
  }
  if (/^[a-z]:/i.test(normalized) || normalized.startsWith('//')) {
    throw new MemorySchemaValidationError('memory namespace');
  }
  if (containsDisallowedSensitiveMaterial(normalized)) {
    throw new MemorySchemaValidationError('memory namespace');
  }
  const segments = normalized.split('/');
  if (segments.length > SCHEMA_LIMITS.namespaceSegments || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || segment.length > 64 || !NAMESPACE_SEGMENT_PATTERN.test(segment)
  )) {
    throw new MemorySchemaValidationError('memory namespace');
  }
  return segments.join('/');
}

export const opaqueIdSchema = z.string()
  .min(1)
  .max(SCHEMA_LIMITS.opaqueIdLength)
  .regex(OPAQUE_ID_PATTERN, 'Opaque ID contains unsupported characters')
  .superRefine(addSensitiveTextIssue);

export function isOpaqueId(value) {
  return opaqueIdSchema.safeParse(value).success;
}

export function parseOpaqueId(value) {
  const result = opaqueIdSchema.safeParse(value);
  if (!result.success) throw new MemorySchemaValidationError('opaque ID', result.error.issues);
  return result.data;
}

export const namespaceSchema = z.string().transform((value, context) => {
  try {
    return canonicalizeNamespace(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Namespace must be a safe relative logical path' });
    return z.NEVER;
  }
});

export const actorTypeSchema = z.enum(ACTOR_TYPES);
export const eventKindSchema = z.enum(EVENT_KINDS);
export const speechActSchema = z.enum(SPEECH_ACTS);
export const relationTypeSchema = z.enum(RELATION_TYPES);
export const feedbackSignalSchema = z.enum(FEEDBACK_SIGNALS);

export const timestampSchema = z.string().refine(value =>
  ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value)),
  'Timestamp must be an ISO-8601 date-time with an explicit offset'
);

export const contextSchema = z.object({
  conversation_id: opaqueIdSchema.optional(),
  session_id: opaqueIdSchema.optional(),
  thread_id: opaqueIdSchema.optional(),
  turn_id: opaqueIdSchema.optional(),
  message_id: opaqueIdSchema.optional(),
  tool_call_id: opaqueIdSchema.optional(),
  automation_run_id: opaqueIdSchema.optional(),
}).strict();

export const relationSchema = z.object({
  type: relationTypeSchema,
  target_event_id: opaqueIdSchema,
}).strict();

const relationListSchema = z.array(relationSchema)
  .max(SCHEMA_LIMITS.relations)
  .refine(relations => {
    const keys = relations.map(relation => `${relation.type}\u0000${relation.target_event_id}`);
    return new Set(keys).size === keys.length;
  }, 'Duplicate event relations are not accepted');

const derivedTextSchema = boundedVisibleText(SCHEMA_LIMITS.derivedTextLength);

export const derivedRecordSchema = z.object({
  summary: derivedTextSchema.optional(),
  claim: derivedTextSchema.optional(),
  source_event_ids: z.array(opaqueIdSchema)
    .min(1)
    .max(SCHEMA_LIMITS.sourceEventIds)
    .refine(ids => new Set(ids).size === ids.length, 'Source event IDs must be unique'),
}).strict().refine(value => Boolean(value.summary || value.claim), {
  message: 'A derived record needs a summary or claim',
});

const safeAttributeStringSchema = boundedVisibleText(SCHEMA_LIMITS.attributeStringLength, { allowEmpty: true });
const safeAttributeArrayStringSchema = boundedVisibleText(SCHEMA_LIMITS.attributeArrayStringLength, { allowEmpty: true });
const safeAttributeValueSchema = z.union([
  safeAttributeStringSchema,
  z.number().finite(),
  z.boolean(),
  z.array(safeAttributeArrayStringSchema).max(SCHEMA_LIMITS.attributeArrayItems),
]);

const safeAttributeKeySchema = z.string()
  .min(1)
  .max(64)
  .regex(SAFE_ATTRIBUTE_KEY_PATTERN, 'Attribute keys must be lowercase snake_case')
  .refine(key => !SENSITIVE_ATTRIBUTE_KEY_PATTERN.test(key), 'Sensitive attribute keys are not accepted')
  .refine(key => !containsDisallowedSensitiveMaterial(key), 'Sensitive attribute keys are not accepted')
  .refine(key => !['constructor', 'prototype'].includes(key), 'Reserved attribute keys are not accepted');

export const safeAttributesSchema = z.record(safeAttributeKeySchema, safeAttributeValueSchema)
  .refine(attributes => Object.keys(attributes).length <= SCHEMA_LIMITS.attributes, 'Too many attributes');

export const sourceReferenceSchema = z.object({
  stream: opaqueIdSchema,
  event_id: opaqueIdSchema,
}).strict();

export const eventInputSchema = z.object({
  schema_version: z.literal(MEMORY_SCHEMA_VERSION),
  namespace: namespaceSchema,
  actor_type: actorTypeSchema,
  actor_id: opaqueIdSchema.optional(),
  delegated_by: opaqueIdSchema.optional(),
  agent_instance_id: opaqueIdSchema.optional(),
  kind: eventKindSchema,
  speech_act: speechActSchema,
  content: boundedVisibleText(SCHEMA_LIMITS.visibleContentLength),
  occurred_at: timestampSchema,
  context: contextSchema.optional(),
  relations: relationListSchema.optional(),
  derived: derivedRecordSchema.optional(),
  attributes: safeAttributesSchema.optional(),
  source: sourceReferenceSchema,
}).strict();

export const feedbackTargetSchema = z.object({
  type: z.enum(['memory', 'event']),
  id: opaqueIdSchema,
}).strict();

export const feedbackInputBaseSchema = z.object({
  schema_version: z.literal(MEMORY_SCHEMA_VERSION),
  target: feedbackTargetSchema,
  signal: feedbackSignalSchema,
  correction: boundedVisibleText(SCHEMA_LIMITS.correctionLength).optional(),
  related_target: feedbackTargetSchema.optional(),
  actor_id: opaqueIdSchema,
  source: sourceReferenceSchema,
}).strict();

export function refineFeedbackInput(value, context) {
  if (value.signal === 'correction' && !value.correction) {
    context.addIssue({
      code: 'custom',
      path: ['correction'],
      message: 'Correction feedback requires visible correction text',
    });
  }
  if (value.signal === 'superseded' && !value.related_target) {
    context.addIssue({
      code: 'custom',
      path: ['related_target'],
      message: 'Superseded feedback requires a related target',
    });
  }
}

export const feedbackInputSchema = feedbackInputBaseSchema.superRefine(refineFeedbackInput);

export function parseEventInput(input) {
  const result = eventInputSchema.safeParse(input);
  if (!result.success) throw new MemorySchemaValidationError('memory event input', result.error.issues);
  return result.data;
}

export function parseFeedbackInput(input) {
  const result = feedbackInputSchema.safeParse(input);
  if (!result.success) throw new MemorySchemaValidationError('memory feedback input', result.error.issues);
  return result.data;
}

export function parseSafeAttributes(input) {
  const result = safeAttributesSchema.safeParse(input);
  if (!result.success) throw new MemorySchemaValidationError('memory attributes', result.error.issues);
  return result.data;
}
