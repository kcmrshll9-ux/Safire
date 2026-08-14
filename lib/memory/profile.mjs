import {
  canonicalizeNamespace as canonicalizeMemoryNamespace,
  containsDisallowedSensitiveMaterial,
  parseOpaqueId,
} from './schema.mjs';

const PROFILE_VERSION = 1;

export const PROFILE_TYPES = Object.freeze({
  PORTABLE_MCP: 'portable_mcp',
  TRUSTED_BRIDGE: 'trusted_bridge',
});

export const ACTOR_TYPES = Object.freeze({
  AGENT: 'agent',
  AGENT_INSTANCE: 'agent_instance',
  AUTOMATION: 'automation',
  EXTERNAL_SERVICE: 'external_service',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
  USER: 'user',
});

const PROFILE_TYPE_VALUES = new Set(Object.values(PROFILE_TYPES));
const ACTOR_TYPE_VALUES = new Set(Object.values(ACTOR_TYPES));
const VALIDATED_PROFILES = new WeakSet();

export class ProfileValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ProfileValidationError';
    this.code = 'INVALID_MEMORY_PROFILE';
  }
}

export class ProfileAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileAuthorizationError';
    this.code = 'MEMORY_PROFILE_DENIED';
  }
}

function validationError(message) {
  throw new ProfileValidationError(message);
}

function authorizationError(message) {
  throw new ProfileAuthorizationError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) validationError(`${label} must be an object`);
  return value;
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) validationError(`${label} contains unsupported field ${key}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeStableId(value, label) {
  if (typeof value !== 'string') validationError(`${label} must be a stable string identifier`);
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  try {
    parseOpaqueId(normalized);
  } catch {
    validationError(`${label} is not a valid stable identifier`);
  }
  return normalized;
}

function normalizeActorType(value, label = 'actor type') {
  if (typeof value !== 'string') validationError(`${label} is required`);
  const normalized = value.normalize('NFKC').trim().toLowerCase().replaceAll('-', '_');
  if (!ACTOR_TYPE_VALUES.has(normalized)) validationError(`${label} is unsupported`);
  return normalized;
}

function normalizeDisplayName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') validationError('actor display_name must be a string');
  const normalized = value.normalize('NFKC').trim();
  if (!normalized
      || normalized.length > 200
      || /[\u0000-\u001f\u007f]/.test(normalized)
      || containsDisallowedSensitiveMaterial(normalized)) {
    validationError('actor display_name is invalid');
  }
  return normalized;
}

function aliasedValue(raw, keys, label, normalize = value => value) {
  const entries = keys.filter(key => raw[key] !== undefined).map(key => [key, normalize(raw[key])]);
  if (!entries.length) return undefined;
  const first = entries[0][1];
  for (const [, value] of entries.slice(1)) {
    if (value !== first) validationError(`${label} aliases disagree`);
  }
  return first;
}

function booleanAlias(raw, keys, label, fallback = false) {
  const value = aliasedValue(raw, keys, label, candidate => {
    if (typeof candidate !== 'boolean') validationError(`${label} must be a boolean`);
    return candidate;
  });
  return value ?? fallback;
}

export function normalizeActorDescriptor(raw) {
  requirePlainObject(raw, 'actor descriptor');
  assertKnownKeys(raw, new Set([
    'id', 'type', 'kind', 'actor_type', 'display_name', 'displayName', 'label',
    'delegated_by', 'delegatedBy',
  ]), 'actor descriptor');

  const id = normalizeStableId(raw.id, 'actor id');
  const type = aliasedValue(raw, ['type', 'kind', 'actor_type'], 'actor type', normalizeActorType);
  if (!type) validationError('actor type is required');
  const displayName = aliasedValue(
    raw,
    ['display_name', 'displayName', 'label'],
    'actor display_name',
    normalizeDisplayName,
  );
  const delegatedBy = aliasedValue(
    raw,
    ['delegated_by', 'delegatedBy'],
    'actor delegated_by',
    value => normalizeStableId(value, 'actor delegated_by'),
  );
  if (!id.startsWith(`${type}:`)) {
    validationError(`actor id must use the ${type}: prefix`);
  }

  return deepFreeze({
    id,
    type,
    ...(displayName === undefined ? {} : { display_name: displayName }),
    ...(delegatedBy === undefined ? {} : { delegated_by: delegatedBy }),
  });
}

export function canonicalizeNamespace(value) {
  try {
    return canonicalizeMemoryNamespace(value);
  } catch {
    validationError('namespace is invalid');
  }
}

function normalizeNamespaceGrant(raw) {
  requirePlainObject(raw, 'namespace grant');
  assertKnownKeys(raw, new Set(['namespace', 'read', 'write', 'descendants']), 'namespace grant');
  const namespace = canonicalizeNamespace(raw.namespace);
  const read = booleanAlias(raw, ['read'], 'namespace grant read');
  const write = booleanAlias(raw, ['write'], 'namespace grant write');
  const descendants = booleanAlias(raw, ['descendants'], 'namespace grant descendants');
  if (!read && !write) validationError(`namespace grant ${namespace} must allow read or write`);
  return deepFreeze({ namespace, read, write, descendants });
}

function profileType(raw) {
  const value = aliasedValue(raw, ['profile_type', 'profileType', 'type'], 'profile type', candidate => {
    if (typeof candidate !== 'string') validationError('profile type must be a string');
    const normalized = candidate.normalize('NFKC').trim().toLowerCase().replaceAll('-', '_');
    if (!PROFILE_TYPE_VALUES.has(normalized)) validationError('profile type is unsupported');
    return normalized;
  });
  if (!value) validationError('profile type is required');
  return value;
}

function profileId(raw) {
  const value = aliasedValue(
    raw,
    ['profile_id', 'profileId', 'id'],
    'profile id',
    candidate => normalizeStableId(candidate, 'profile id'),
  );
  if (!value) validationError('profile id is required');
  return value;
}

function normalizeIngestedBy(raw, type, id) {
  requirePlainObject(raw, 'ingested_by');
  assertKnownKeys(raw, new Set(['id', 'adapter_type', 'adapterType', 'profile_id', 'profileId']), 'ingested_by');
  const adapterId = normalizeStableId(raw.id, 'ingested_by id');
  const claimedType = aliasedValue(raw, ['adapter_type', 'adapterType'], 'ingested_by adapter_type', candidate => {
    if (typeof candidate !== 'string') validationError('ingested_by adapter_type must be a string');
    return candidate.normalize('NFKC').trim().toLowerCase().replaceAll('-', '_');
  });
  if (claimedType !== undefined && claimedType !== type) {
    validationError('ingested_by adapter_type must match the profile type');
  }
  const claimedProfile = aliasedValue(
    raw,
    ['profile_id', 'profileId'],
    'ingested_by profile_id',
    candidate => normalizeStableId(candidate, 'ingested_by profile_id'),
  );
  if (claimedProfile !== undefined && claimedProfile !== id) {
    validationError('ingested_by profile_id must match the profile id');
  }
  return deepFreeze({ id: adapterId, adapter_type: type, profile_id: id });
}

function trustConfiguration(raw, type) {
  const trust = raw.trust === undefined ? {} : requirePlainObject(raw.trust, 'profile trust');
  assertKnownKeys(trust, new Set(['accept_user_events', 'acceptUserEvents']), 'profile trust');
  const topLevel = aliasedValue(raw, ['accept_user_events', 'acceptUserEvents'], 'accept_user_events', candidate => {
    if (typeof candidate !== 'boolean') validationError('accept_user_events must be a boolean');
    return candidate;
  });
  const nested = aliasedValue(trust, ['accept_user_events', 'acceptUserEvents'], 'trust accept_user_events', candidate => {
    if (typeof candidate !== 'boolean') validationError('trust accept_user_events must be a boolean');
    return candidate;
  });
  if (topLevel !== undefined && nested !== undefined && topLevel !== nested) {
    validationError('accept_user_events settings disagree');
  }
  const acceptUserEvents = topLevel ?? nested ?? false;
  if (type === PROFILE_TYPES.PORTABLE_MCP && acceptUserEvents) {
    validationError('portable MCP profiles cannot accept user events');
  }
  return deepFreeze({ accept_user_events: type === PROFILE_TYPES.TRUSTED_BRIDGE && acceptUserEvents });
}

function arrayAlias(raw, keys, label) {
  const supplied = keys.filter(key => raw[key] !== undefined);
  if (!supplied.length) return [];
  if (supplied.length > 1) validationError(`${label} may be supplied only once`);
  const value = raw[supplied[0]];
  if (!Array.isArray(value)) validationError(`${label} must be an array`);
  return value;
}

function actorAlias(raw, keys, label) {
  const supplied = keys.filter(key => raw[key] !== undefined);
  if (!supplied.length) validationError(`${label} is required`);
  if (supplied.length > 1) validationError(`${label} may be supplied only once`);
  return normalizeActorDescriptor(raw[supplied[0]]);
}

function sourceIdentity(raw) {
  const value = aliasedValue(
    raw,
    ['source_identity', 'sourceIdentity'],
    'source_identity',
    candidate => normalizeStableId(candidate, 'source_identity'),
  );
  if (!value) validationError('source_identity is required');
  return value;
}

function ingestedByAlias(raw, type, id) {
  const supplied = ['ingested_by', 'ingestedBy'].filter(key => raw[key] !== undefined);
  if (!supplied.length) validationError('ingested_by is required');
  if (supplied.length > 1) validationError('ingested_by may be supplied only once');
  return normalizeIngestedBy(raw[supplied[0]], type, id);
}

function buildProfile(raw, forcedType) {
  requirePlainObject(raw, 'profile');
  assertKnownKeys(raw, new Set([
    'version', 'profile_id', 'profileId', 'id', 'profile_type', 'profileType', 'type',
    'principal', 'agent_instance', 'agentInstance', 'ingested_by', 'ingestedBy',
    'source_identity', 'sourceIdentity', 'allowed_actors', 'allowedActors',
    'namespace_grants', 'namespaceGrants', 'trust', 'accept_user_events', 'acceptUserEvents',
  ]), 'profile');
  if (raw.version === undefined && !forcedType) validationError('profile version is required');
  if (raw.version !== undefined && raw.version !== PROFILE_VERSION) {
    validationError(`profile version must be ${PROFILE_VERSION}`);
  }
  const type = forcedType || profileType(raw);
  if (forcedType) {
    for (const key of ['profile_type', 'profileType', 'type']) {
      if (raw[key] !== undefined && profileType({ [key]: raw[key] }) !== forcedType) {
        validationError(`profile type must be ${forcedType}`);
      }
    }
  }
  const id = profileId(raw);
  const trust = trustConfiguration(raw, type);
  const principal = actorAlias(raw, ['principal'], 'principal');
  const agentInstance = actorAlias(raw, ['agent_instance', 'agentInstance'], 'agent_instance');

  if (principal.type !== ACTOR_TYPES.AGENT) validationError('principal must be an agent actor');
  if (principal.delegated_by !== undefined) validationError('principal cannot be delegated');
  if (agentInstance.type !== ACTOR_TYPES.AGENT_INSTANCE) validationError('agent_instance must use the agent_instance actor type');
  if (agentInstance.delegated_by !== undefined) validationError('agent_instance cannot be delegated');
  if (principal.id === agentInstance.id) validationError('principal and agent_instance must have distinct stable ids');

  const allowedActors = arrayAlias(raw, ['allowed_actors', 'allowedActors'], 'allowed_actors').map(normalizeActorDescriptor);
  const actorsById = new Map([[principal.id, principal], [agentInstance.id, agentInstance]]);
  for (const actor of allowedActors) {
    if (actorsById.has(actor.id)) validationError(`duplicate actor id ${actor.id}`);
    if ([ACTOR_TYPES.AGENT, ACTOR_TYPES.AGENT_INSTANCE].includes(actor.type)) {
      validationError('another agent or agent instance cannot be allowlisted in a profile');
    }
    if (actor.type === ACTOR_TYPES.USER) {
      if (type !== PROFILE_TYPES.TRUSTED_BRIDGE || !trust.accept_user_events) {
        validationError('user actors require a trusted bridge configured to accept user events');
      }
      if (actor.delegated_by !== undefined) validationError('user actors cannot be delegated');
    } else if (actor.type === ACTOR_TYPES.AUTOMATION) {
      if (actor.delegated_by !== principal.id) {
        validationError('automation actors must be delegated_by the profile principal');
      }
    } else if (actor.type === ACTOR_TYPES.EXTERNAL_SERVICE) {
      if (actor.delegated_by !== undefined) validationError('external service actors cannot be delegated');
    } else if (actor.type === ACTOR_TYPES.SYSTEM) {
      if (type !== PROFILE_TYPES.TRUSTED_BRIDGE) {
        validationError('system actors require a trusted bridge profile');
      }
      if (actor.delegated_by !== undefined) validationError('system actors cannot be delegated');
    } else if (actor.type === ACTOR_TYPES.UNKNOWN) {
      if (actor.delegated_by !== undefined) validationError('unknown actors cannot be delegated');
    } else {
      validationError(`actor type ${actor.type} cannot be allowlisted`);
    }
    actorsById.set(actor.id, actor);
  }

  const namespaceGrants = arrayAlias(raw, ['namespace_grants', 'namespaceGrants'], 'namespace_grants').map(normalizeNamespaceGrant);
  const seenNamespaces = new Set();
  for (const grant of namespaceGrants) {
    if (seenNamespaces.has(grant.namespace)) validationError(`duplicate namespace grant ${grant.namespace}`);
    seenNamespaces.add(grant.namespace);
  }

  const profile = deepFreeze({
    version: PROFILE_VERSION,
    profile_id: id,
    profile_type: type,
    principal,
    agent_instance: agentInstance,
    ingested_by: ingestedByAlias(raw, type, id),
    source_identity: sourceIdentity(raw),
    allowed_actors: allowedActors,
    namespace_grants: namespaceGrants,
    trust,
  });
  VALIDATED_PROFILES.add(profile);
  return profile;
}

export function createPortableMcpProfile(options) {
  return buildProfile(options, PROFILE_TYPES.PORTABLE_MCP);
}

export function createTrustedBridgeProfile(options) {
  return buildProfile(options, PROFILE_TYPES.TRUSTED_BRIDGE);
}

export function validateProfile(raw) {
  if (VALIDATED_PROFILES.has(raw)) return raw;
  return buildProfile(raw);
}

function asProfile(raw) {
  return VALIDATED_PROFILES.has(raw) ? raw : validateProfile(raw);
}

function actorReference(raw) {
  if (typeof raw === 'string') return { id: normalizeStableId(raw, 'actor reference') };
  requirePlainObject(raw, 'actor reference');
  assertKnownKeys(raw, new Set(['id', 'type', 'kind', 'actor_type']), 'actor reference');
  const id = normalizeStableId(raw.id, 'actor reference id');
  const type = aliasedValue(raw, ['type', 'kind', 'actor_type'], 'actor reference type', normalizeActorType);
  return { id, ...(type === undefined ? {} : { type }) };
}

export function lookupActor(profileInput, reference) {
  const profile = asProfile(profileInput);
  let parsed;
  try {
    parsed = actorReference(reference);
  } catch (error) {
    if (error instanceof ProfileValidationError) return null;
    throw error;
  }
  const actor = [profile.principal, profile.agent_instance, ...profile.allowed_actors]
    .find(candidate => candidate.id === parsed.id);
  if (!actor || (parsed.type !== undefined && parsed.type !== actor.type)) return null;
  return actor;
}

export function assertActorAuthorized(profileInput, reference) {
  const profile = asProfile(profileInput);
  const actor = lookupActor(profile, reference);
  if (!actor) authorizationError('actor is not allowlisted by this profile');
  if (actor.type === ACTOR_TYPES.USER
      && (profile.profile_type !== PROFILE_TYPES.TRUSTED_BRIDGE || !profile.trust.accept_user_events)) {
    authorizationError('user attribution requires a trusted bridge configured by the host');
  }
  if (actor.type === ACTOR_TYPES.AGENT && actor.id !== profile.principal.id) {
    authorizationError('profile cannot claim another agent identity');
  }
  if (actor.type === ACTOR_TYPES.AGENT_INSTANCE && actor.id !== profile.agent_instance.id) {
    authorizationError('profile cannot claim another agent instance');
  }
  if (actor.type === ACTOR_TYPES.AUTOMATION && actor.delegated_by !== profile.principal.id) {
    authorizationError('automation actor is not delegated by the profile principal');
  }
  if (actor.type === ACTOR_TYPES.SYSTEM && profile.profile_type !== PROFILE_TYPES.TRUSTED_BRIDGE) {
    authorizationError('system attribution requires a trusted bridge profile');
  }
  return actor;
}

export function isActorAuthorized(profile, reference) {
  try {
    assertActorAuthorized(profile, reference);
    return true;
  } catch (error) {
    if (error instanceof ProfileAuthorizationError || error instanceof ProfileValidationError) return false;
    throw error;
  }
}

function grantMatches(grant, namespace) {
  return namespace === grant.namespace || (grant.descendants && namespace.startsWith(`${grant.namespace}/`));
}

function hasNamespacePermission(profileInput, namespaceInput, access) {
  const profile = asProfile(profileInput);
  const namespace = canonicalizeNamespace(namespaceInput);
  return profile.namespace_grants.some(grant => grant[access] && grantMatches(grant, namespace));
}

export function canReadNamespace(profile, namespace) {
  try {
    return hasNamespacePermission(profile, namespace, 'read');
  } catch (error) {
    if (error instanceof ProfileValidationError) return false;
    throw error;
  }
}

export function canWriteNamespace(profile, namespace) {
  try {
    return hasNamespacePermission(profile, namespace, 'write');
  } catch (error) {
    if (error instanceof ProfileValidationError) return false;
    throw error;
  }
}

export function assertNamespaceAccess(profile, namespaceInput, access) {
  if (!['read', 'write'].includes(access)) validationError('namespace access must be read or write');
  const namespace = canonicalizeNamespace(namespaceInput);
  if (!hasNamespacePermission(profile, namespace, access)) {
    authorizationError(`${access} access to namespace ${namespace} is not granted`);
  }
  return namespace;
}

function normalizeOpaqueToken(value, label) {
  if (typeof value !== 'string') validationError(`${label} must be a string`);
  const normalized = value.normalize('NFKC').trim();
  try {
    parseOpaqueId(normalized);
  } catch {
    validationError(`${label} is invalid`);
  }
  return normalized;
}

function normalizeSource(raw, identity) {
  requirePlainObject(raw, 'attribution source');
  assertKnownKeys(raw, new Set(['stream', 'event_id', 'eventId']), 'attribution source');
  const stream = normalizeOpaqueToken(raw.stream, 'source stream');
  const eventId = aliasedValue(
    raw,
    ['event_id', 'eventId'],
    'source event_id',
    candidate => normalizeOpaqueToken(candidate, 'source event_id'),
  );
  if (!eventId) validationError('source event_id is required');
  return deepFreeze({ identity, stream, event_id: eventId });
}

function strictAttributionInput(raw) {
  requirePlainObject(raw, 'attribution input');
  const forbidden = new Set([
    'ingested_by', 'ingestedBy', 'source_identity', 'sourceIdentity',
    'agent_instance', 'agentInstance', 'delegated_by', 'delegatedBy',
  ]);
  for (const key of Object.keys(raw)) {
    if (forbidden.has(key)) authorizationError(`${key} is fixed by the profile and cannot be caller supplied`);
  }
  assertKnownKeys(raw, new Set([
    'actor', 'source', 'trusted_user_feedback', 'trustedUserFeedback',
    'user_confirmed', 'userConfirmed', 'user_rejected', 'userRejected',
  ]), 'attribution input');
  if (raw.actor === undefined) validationError('attribution actor is required');
  if (raw.source === undefined) validationError('attribution source is required');
}

export function resolveAttribution(profileInput, input) {
  const profile = asProfile(profileInput);
  strictAttributionInput(input);
  const actor = assertActorAuthorized(profile, input.actor);
  const trustedUserFeedback = booleanAlias(
    input,
    ['trusted_user_feedback', 'trustedUserFeedback'],
    'trusted_user_feedback',
  );
  const userConfirmed = booleanAlias(input, ['user_confirmed', 'userConfirmed'], 'user_confirmed');
  const userRejected = booleanAlias(input, ['user_rejected', 'userRejected'], 'user_rejected');
  if (userConfirmed && userRejected) validationError('user_confirmed and user_rejected cannot both be true');

  const hasTrustedUserSignal = trustedUserFeedback || userConfirmed || userRejected;
  if (hasTrustedUserSignal) {
    if (actor.type !== ACTOR_TYPES.USER) {
      authorizationError('trusted user feedback requires an allowlisted user actor');
    }
    if (profile.profile_type !== PROFILE_TYPES.TRUSTED_BRIDGE || !profile.trust.accept_user_events) {
      authorizationError('trusted user feedback requires a trusted bridge configured by the host');
    }
  }

  const delegatedBy = actor.type === ACTOR_TYPES.AUTOMATION
    ? assertActorAuthorized(profile, actor.delegated_by)
    : null;
  const source = normalizeSource(input.source, profile.source_identity);

  return deepFreeze({
    actor,
    ingested_by: profile.ingested_by,
    agent_instance: profile.agent_instance,
    delegated_by: delegatedBy,
    source,
    trusted_user_feedback: hasTrustedUserSignal,
    user_confirmed: userConfirmed,
    user_rejected: userRejected,
  });
}
