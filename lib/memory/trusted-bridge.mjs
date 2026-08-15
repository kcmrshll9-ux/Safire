import { z } from 'zod';
import {
  MEMORY_SCHEMA_VERSION,
  MemorySchemaValidationError,
  eventInputSchema,
  feedbackInputBaseSchema,
  opaqueIdSchema,
  parseEventInput,
  parseFeedbackInput,
  refineFeedbackInput,
} from './schema.mjs';
import {
  PROFILE_TYPES,
  assertActorAuthorized,
  assertNamespaceAccess,
  validateProfile,
} from './profile.mjs';
import { canonicalJson, sha256 } from './records.mjs';

export const TRUSTED_BRIDGE_SCHEMA_VERSION = 1;
export const TRUSTED_BRIDGE_ENVELOPE_SCHEMA_ID = 'safire.memory.trusted-bridge-envelope/v1';
export const TRUSTED_BRIDGE_FEEDBACK_ENVELOPE_SCHEMA_ID = 'safire.memory.trusted-bridge-feedback-envelope/v1';

export const TRUSTED_BRIDGE_ROLES = Object.freeze([
  'user',
  'agent',
  'automation',
  'external_service',
]);

export const TRUSTED_BRIDGE_KIND_GRANTS = Object.freeze({
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
});

export class TrustedBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrustedBridgeError';
    this.code = code;
  }
}

export class TrustedBridgeAuthenticationError extends TrustedBridgeError {
  constructor() {
    super('TRUSTED_BRIDGE_AUTHENTICATION_FAILED', 'Trusted bridge authentication failed');
    this.name = 'TrustedBridgeAuthenticationError';
  }
}

export class TrustedBridgeAuthorizationError extends TrustedBridgeError {
  constructor(message = 'Trusted bridge event is not authorized') {
    super('TRUSTED_BRIDGE_NOT_AUTHORIZED', message);
    this.name = 'TrustedBridgeAuthorizationError';
  }
}

// The bridge envelope intentionally omits every actor field. The successful
// authenticate callback is the only input used to construct actor attribution.
export const trustedBridgeEnvelopeSchema = eventInputSchema.omit({
  actor_type: true,
  actor_id: true,
  delegated_by: true,
  agent_instance_id: true,
});

export const trustedBridgeFeedbackEnvelopeSchema = feedbackInputBaseSchema
  .omit({ actor_id: true })
  .superRefine(refineFeedbackInput);

export const trustedBridgeAuthenticationResultSchema = z.object({
  authenticated: z.literal(true),
  role: z.enum(TRUSTED_BRIDGE_ROLES),
  actor_id: opaqueIdSchema,
  agent_instance_id: opaqueIdSchema.optional(),
  delegated_by: opaqueIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.agent_instance_id && value.role !== 'agent') {
    context.addIssue({
      code: 'custom',
      path: ['agent_instance_id'],
      message: 'Only an authenticated agent can have an agent instance ID',
    });
  }
  if (value.delegated_by && value.role !== 'automation') {
    context.addIssue({
      code: 'custom',
      path: ['delegated_by'],
      message: 'This authenticated role cannot carry delegated attribution',
    });
  }
});

export function validateTrustedBridgeProfile(profile) {
  let normalized;
  try {
    normalized = validateProfile(profile);
  } catch {
    throw new TrustedBridgeError('INVALID_TRUSTED_BRIDGE_PROFILE', 'A normalized trusted_bridge profile is required');
  }
  if (normalized.profile_type !== PROFILE_TYPES.TRUSTED_BRIDGE) {
    throw new TrustedBridgeError('INVALID_TRUSTED_BRIDGE_PROFILE', 'A normalized trusted_bridge profile is required');
  }
  return normalized;
}

export function parseTrustedBridgeEnvelope(input) {
  const result = trustedBridgeEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new MemorySchemaValidationError('trusted bridge envelope', result.error.issues);
  }
  return result.data;
}

export function parseTrustedBridgeFeedbackEnvelope(input) {
  const result = trustedBridgeFeedbackEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new MemorySchemaValidationError('trusted bridge feedback envelope', result.error.issues);
  }
  return result.data;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function eventAuthenticationMetadata(envelope, profileId) {
  const metadata = {
    schema_version: TRUSTED_BRIDGE_SCHEMA_VERSION,
    envelope_schema: TRUSTED_BRIDGE_ENVELOPE_SCHEMA_ID,
    operation: 'event',
    profile_id: profileId,
    namespace: envelope.namespace,
    kind: envelope.kind,
    speech_act: envelope.speech_act,
    occurred_at: envelope.occurred_at,
    source: { ...envelope.source },
    content_length: Buffer.byteLength(envelope.content, 'utf8'),
    content_sha256: sha256(envelope.content),
    payload_sha256: sha256(canonicalJson(envelope)),
  };
  if (envelope.context) metadata.context = { ...envelope.context };
  return deepFreeze(metadata);
}

function feedbackAuthenticationMetadata(envelope, profileId) {
  const metadata = {
    schema_version: TRUSTED_BRIDGE_SCHEMA_VERSION,
    envelope_schema: TRUSTED_BRIDGE_FEEDBACK_ENVELOPE_SCHEMA_ID,
    operation: 'feedback',
    profile_id: profileId,
    target: { ...envelope.target },
    signal: envelope.signal,
    source: { ...envelope.source },
    payload_sha256: sha256(canonicalJson(envelope)),
  };
  if (envelope.related_target) metadata.related_target = { ...envelope.related_target };
  if (envelope.correction) {
    metadata.correction_length = Buffer.byteLength(envelope.correction, 'utf8');
    metadata.correction_sha256 = sha256(envelope.correction);
  }
  return deepFreeze(metadata);
}

const AUTHENTICATED_ROLE_ACTOR_TYPES = Object.freeze({
  user: Object.freeze(['user']),
  agent: Object.freeze(['agent', 'agent_instance']),
  automation: Object.freeze(['automation']),
  external_service: Object.freeze(['external_service']),
});

function authorizedActor(profile, reference) {
  try {
    return assertActorAuthorized(profile, reference);
  } catch {
    throw new TrustedBridgeAuthorizationError('Authenticated actor is not authorized by this trusted_bridge profile');
  }
}

function authenticatedAttribution(authentication, profile) {
  const actor = authorizedActor(profile, authentication.actor_id);
  if (!AUTHENTICATED_ROLE_ACTOR_TYPES[authentication.role].includes(actor.type)) {
    throw new TrustedBridgeAuthorizationError('Authenticated role does not match the authorized actor');
  }

  let agentInstance = profile.agent_instance;
  if (authentication.agent_instance_id) {
    agentInstance = authorizedActor(profile, {
      id: authentication.agent_instance_id,
      type: 'agent_instance',
    });
  }

  let delegatedBy;
  if (actor.type === 'automation') {
    const expectedDelegator = authorizedActor(profile, actor.delegated_by);
    if (authentication.delegated_by) {
      const authenticatedDelegator = authorizedActor(profile, authentication.delegated_by);
      if (authenticatedDelegator.id !== expectedDelegator.id) {
        throw new TrustedBridgeAuthorizationError('Automation delegation does not match the trusted profile');
      }
    }
    delegatedBy = expectedDelegator.id;
  }

  return { actor, agentInstance, delegatedBy };
}

function actorFields(authentication, profile) {
  const { actor, agentInstance, delegatedBy } = authenticatedAttribution(authentication, profile);
  return {
    actor_type: actor.type,
    actor_id: actor.id,
    ...(agentInstance ? { agent_instance_id: agentInstance.id } : {}),
    ...(delegatedBy ? { delegated_by: delegatedBy } : {}),
  };
}

function authorizeKind(authentication, envelope, profile) {
  if (authentication.role === 'user' && profile.trust.accept_user_events !== true) {
    throw new TrustedBridgeAuthorizationError('The trusted_bridge profile does not accept user events');
  }
  if (!TRUSTED_BRIDGE_KIND_GRANTS[authentication.role].includes(envelope.kind)) {
    throw new TrustedBridgeAuthorizationError('The authenticated role cannot record this event kind');
  }
  try {
    assertNamespaceAccess(profile, envelope.namespace, 'write');
  } catch {
    throw new TrustedBridgeAuthorizationError('The trusted_bridge profile cannot write this namespace');
  }
}

function authorizeFeedback(authentication, envelope, profile, actor) {
  if (authentication.role === 'user' && profile.trust.accept_user_events !== true) {
    throw new TrustedBridgeAuthorizationError('The trusted_bridge profile does not accept user feedback');
  }
  if (['user_confirmed', 'user_rejected'].includes(envelope.signal) && actor.type !== 'user') {
    throw new TrustedBridgeAuthorizationError('User confirmation signals require an authenticated user');
  }
}

async function authenticateRequest(authenticate, metadata, authContext) {
  let rawAuthentication;
  try {
    rawAuthentication = await authenticate(metadata, authContext);
  } catch {
    throw new TrustedBridgeAuthenticationError();
  }
  const authentication = trustedBridgeAuthenticationResultSchema.safeParse(rawAuthentication);
  if (!authentication.success) throw new TrustedBridgeAuthenticationError();
  return authentication.data;
}

export function createTrustedBridge({ profile, authenticate, recordEvents, recordFeedback } = {}) {
  const trustedProfile = validateTrustedBridgeProfile(profile);
  if (typeof authenticate !== 'function') {
    throw new TrustedBridgeError('INVALID_AUTHENTICATE_CALLBACK', 'An async authenticate callback is required');
  }
  if (typeof recordEvents !== 'function') {
    throw new TrustedBridgeError('INVALID_RECORD_EVENTS_CALLBACK', 'A recordEvents callback is required');
  }
  if (recordFeedback !== undefined && typeof recordFeedback !== 'function') {
    throw new TrustedBridgeError('INVALID_RECORD_FEEDBACK_CALLBACK', 'recordFeedback must be a function when supplied');
  }

  const ingest = async (input, authContext) => {
    const envelope = parseTrustedBridgeEnvelope(input);
    const authentication = await authenticateRequest(
      authenticate,
      eventAuthenticationMetadata(envelope, trustedProfile.profile_id),
      authContext,
    );

    authorizeKind(authentication, envelope, trustedProfile);
    const event = parseEventInput({
      ...envelope,
      ...actorFields(authentication, trustedProfile),
      schema_version: MEMORY_SCHEMA_VERSION,
    });
    const record_result = await recordEvents([event]);
    return { event, record_result };
  };

  const ingestFeedback = async (input, authContext) => {
    if (!recordFeedback) {
      throw new TrustedBridgeError(
        'TRUSTED_BRIDGE_FEEDBACK_NOT_CONFIGURED',
        'Feedback ingestion is not configured for this trusted bridge',
      );
    }
    const envelope = parseTrustedBridgeFeedbackEnvelope(input);
    const authentication = await authenticateRequest(
      authenticate,
      feedbackAuthenticationMetadata(envelope, trustedProfile.profile_id),
      authContext,
    );
    const attribution = authenticatedAttribution(authentication, trustedProfile);
    authorizeFeedback(authentication, envelope, trustedProfile, attribution.actor);
    const feedback = parseFeedbackInput({
      ...envelope,
      actor_id: attribution.actor.id,
      schema_version: MEMORY_SCHEMA_VERSION,
    });
    const record_result = await recordFeedback([feedback]);
    return { feedback, record_result };
  };

  return Object.freeze({
    schema_id: TRUSTED_BRIDGE_ENVELOPE_SCHEMA_ID,
    feedback_schema_id: TRUSTED_BRIDGE_FEEDBACK_ENVELOPE_SCHEMA_ID,
    profile_id: trustedProfile.profile_id,
    ingest,
    ingestFeedback,
  });
}

export const INVENTED_TRUSTED_BRIDGE_ENVELOPE = deepFreeze({
  schema_version: TRUSTED_BRIDGE_SCHEMA_VERSION,
  namespace: 'examples/invented',
  kind: 'visible_user_message',
  speech_act: 'request',
  content: 'Please summarize the invented project status.',
  occurred_at: '2026-08-14T12:00:00.000Z',
  context: {
    conversation_id: 'invented_conversation_01',
    message_id: 'invented_message_01',
  },
  source: {
    stream: 'simulator:invented',
    event_id: 'invented_source_event_01',
  },
});

/**
 * Explicit in-process demonstration only. This helper creates no listener,
 * installs no hook, and captures nothing unless the caller invokes it with
 * both authentication and recording callbacks.
 */
export async function simulateTrustedBridge({
  profile,
  authenticate,
  recordEvents,
  envelope = INVENTED_TRUSTED_BRIDGE_ENVELOPE,
  authContext = { simulation: true },
} = {}) {
  const bridge = createTrustedBridge({ profile, authenticate, recordEvents });
  return bridge.ingest(envelope, authContext);
}
