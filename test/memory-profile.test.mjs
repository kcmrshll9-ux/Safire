import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_TYPES,
  PROFILE_TYPES,
  ProfileAuthorizationError,
  ProfileValidationError,
  assertActorAuthorized,
  assertNamespaceAccess,
  canReadNamespace,
  canWriteNamespace,
  canonicalizeNamespace,
  createPortableMcpProfile,
  createTrustedBridgeProfile,
  isActorAuthorized,
  lookupActor,
  resolveAttribution,
  validateProfile,
} from '../lib/memory/profile.mjs';

function harryPortableProfile(overrides = {}) {
  return createPortableMcpProfile({
    profileId: 'profile:harry-local',
    principal: { id: 'agent:harry', type: 'agent', displayName: 'Harry' },
    agentInstance: { id: 'agent_instance:harry:desktop', type: 'agent_instance', displayName: 'Harry desktop' },
    ingestedBy: { id: 'adapter:safire-mcp:harry' },
    sourceIdentity: 'mcp:harry-local',
    allowedActors: [
      { id: 'automation:moltbook', type: 'automation', displayName: 'Moltbook', delegatedBy: 'agent:harry' },
      { id: 'external_service:research-api', type: 'external_service', displayName: 'Research API' },
    ],
    namespaceGrants: [
      { namespace: 'Harry', read: true, write: true, descendants: true },
      { namespace: 'Moltbook', read: true, write: true, descendants: true },
      { namespace: 'Shared/Research', read: true, write: false, descendants: false },
    ],
    ...overrides,
  });
}

test('portable profile keeps Harry and delegated Moltbook attribution separate', () => {
  const profile = harryPortableProfile();

  assert.equal(profile.version, 1);
  assert.equal(profile.profile_id, 'profile:harry-local');
  assert.equal(profile.profile_type, PROFILE_TYPES.PORTABLE_MCP);
  assert.equal(profile.principal.type, ACTOR_TYPES.AGENT);
  assert.equal(profile.agent_instance.type, ACTOR_TYPES.AGENT_INSTANCE);
  assert.notEqual(profile.principal.id, profile.agent_instance.id);
  assert.deepEqual(profile.ingested_by, {
    id: 'adapter:safire-mcp:harry',
    adapter_type: 'portable_mcp',
    profile_id: 'profile:harry-local',
  });
  assert.equal(profile.source_identity, 'mcp:harry-local');
  assert.equal(Object.isFrozen(profile), true);

  const moltbook = lookupActor(profile, 'AUTOMATION:MOLTBOOK');
  assert.equal(moltbook?.delegated_by, 'agent:harry');
  assert.equal(isActorAuthorized(profile, { id: 'automation:moltbook', type: 'automation' }), true);

  const attribution = resolveAttribution(profile, {
    actor: 'automation:moltbook',
    source: { stream: 'Moltbook.Daily', eventId: 'cron-2026-08-14T08:00:00Z' },
  });
  assert.equal(attribution.actor.id, 'automation:moltbook');
  assert.equal(attribution.delegated_by.id, 'agent:harry');
  assert.equal(attribution.agent_instance.id, 'agent_instance:harry:desktop');
  assert.equal(attribution.ingested_by.id, 'adapter:safire-mcp:harry');
  assert.deepEqual(attribution.source, {
    identity: 'mcp:harry-local',
    stream: 'Moltbook.Daily',
    event_id: 'cron-2026-08-14T08:00:00Z',
  });
  assert.notEqual(attribution.actor, attribution.delegated_by);
  assert.notEqual(attribution.actor, attribution.agent_instance);
  assert.equal(attribution.trusted_user_feedback, false);
});

test('namespace grants are canonical, case-insensitive, descendant-aware, and explicit', () => {
  const profile = harryPortableProfile();

  assert.equal(canonicalizeNamespace(' HARRY/Projects/Launch '), 'harry/projects/launch');
  assert.throws(() => canonicalizeNamespace(' /HARRY\\Projects/Launch/ '), ProfileValidationError);
  assert.equal(canReadNamespace(profile, 'HARRY/PRIVATE'), true);
  assert.equal(canWriteNamespace(profile, 'harry/projects/launch'), true);
  assert.equal(canReadNamespace(profile, 'shared/research'), true);
  assert.equal(canWriteNamespace(profile, 'SHARED/RESEARCH'), false);
  assert.equal(canReadNamespace(profile, 'shared/research/child'), false);
  assert.equal(canReadNamespace(profile, 'harry-private'), false);
  assert.equal(canReadNamespace(profile, 'atlas'), false);
  assert.equal(assertNamespaceAccess(profile, 'MOLTBOOK/Daily', 'write'), 'moltbook/daily');
  assert.throws(
    () => assertNamespaceAccess(profile, 'external/other', 'read'),
    ProfileAuthorizationError,
  );
});

test('a second agent cannot claim Harry identity or access Harry-private namespaces', () => {
  const atlas = createPortableMcpProfile({
    profile_id: 'profile:atlas-local',
    principal: { id: 'agent:atlas', type: 'agent' },
    agent_instance: { id: 'agent_instance:atlas:desktop', type: 'agent_instance' },
    ingested_by: { id: 'adapter:safire-mcp:atlas', adapter_type: 'portable_mcp', profile_id: 'profile:atlas-local' },
    source_identity: 'mcp:atlas-local',
    allowed_actors: [],
    namespace_grants: [{ namespace: 'atlas', read: true, write: true, descendants: true }],
  });

  assert.equal(isActorAuthorized(atlas, 'agent:harry'), false);
  assert.equal(lookupActor(atlas, 'agent:harry'), null);
  assert.equal(canReadNamespace(atlas, 'harry/private'), false);
  assert.equal(canWriteNamespace(atlas, 'HARRY/PRIVATE'), false);
  assert.throws(
    () => resolveAttribution(atlas, {
      actor: { id: 'agent:harry', type: 'agent' },
      source: { stream: 'harry.private', event_id: 'forged-event' },
    }),
    ProfileAuthorizationError,
  );

  assert.throws(
    () => harryPortableProfile({
      allowedActors: [{ id: 'agent:atlas', type: 'agent' }],
    }),
    /another agent or agent instance cannot be allowlisted/,
  );
});

test('ordinary MCP profiles reject user impersonation and caller-controlled trust fields', () => {
  const profile = harryPortableProfile();

  assert.equal(isActorAuthorized(profile, { id: 'agent:harry', type: 'user' }), false);
  assert.throws(() => assertActorAuthorized(profile, 'user:example-owner'), ProfileAuthorizationError);
  assert.throws(
    () => harryPortableProfile({
      allowedActors: [{ id: 'user:example-owner', type: 'user' }],
    }),
    /user actors require a trusted bridge/,
  );
  assert.throws(
    () => harryPortableProfile({ acceptUserEvents: true }),
    /portable MCP profiles cannot accept user events/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:harry',
      source: { stream: 'harry.general', event_id: 'event-1' },
      user_confirmed: true,
    }),
    /trusted user feedback requires an allowlisted user actor/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:harry',
      ingested_by: { id: 'adapter:forged' },
      source: { stream: 'harry.general', event_id: 'event-2' },
    }),
    /fixed by the profile/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:harry',
      source_identity: 'mcp:forged',
      source: { stream: 'harry.general', event_id: 'event-3' },
    }),
    /fixed by the profile/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:harry',
      source: { identity: 'mcp:forged', stream: 'harry.general', event_id: 'event-4' },
    }),
    /unsupported field identity/,
  );
});

test('trusted bridge accepts attributable user feedback only when host-configured', () => {
  assert.throws(
    () => createTrustedBridgeProfile({
      profileId: 'profile:harry-bridge-disabled',
      principal: { id: 'agent:harry', type: 'agent' },
      agentInstance: { id: 'agent_instance:harry:bridge', type: 'agent_instance' },
      ingestedBy: { id: 'adapter:trusted-bridge:harry' },
      sourceIdentity: 'bridge:harry-local',
      allowedActors: [{ id: 'user:example-owner', type: 'user' }],
      namespaceGrants: [{ namespace: 'harry', read: true, write: true, descendants: true }],
    }),
    /user actors require a trusted bridge configured to accept user events/,
  );

  const bridge = createTrustedBridgeProfile({
    profileId: 'profile:harry-bridge',
    principal: { id: 'agent:harry', type: 'agent' },
    agentInstance: { id: 'agent_instance:harry:bridge', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:trusted-bridge:harry' },
    sourceIdentity: 'bridge:harry-local',
    acceptUserEvents: true,
    allowedActors: [{ id: 'user:example-owner', type: 'user', displayName: 'Example Owner' }],
    namespaceGrants: [{ namespace: 'harry', read: true, write: true, descendants: true }],
  });
  const confirmation = resolveAttribution(bridge, {
    actor: 'USER:EXAMPLE-OWNER',
    source: { stream: 'Harry.User-Feedback', event_id: 'feedback-42' },
    user_confirmed: true,
  });
  assert.equal(confirmation.actor.id, 'user:example-owner');
  assert.equal(confirmation.delegated_by, null);
  assert.equal(confirmation.ingested_by.adapter_type, PROFILE_TYPES.TRUSTED_BRIDGE);
  assert.equal(confirmation.trusted_user_feedback, true);
  assert.equal(confirmation.user_confirmed, true);
  assert.equal(confirmation.user_rejected, false);

  assert.throws(
    () => resolveAttribution(bridge, {
      actor: 'agent:harry',
      source: { stream: 'harry.user-feedback', event_id: 'feedback-43' },
      user_rejected: true,
    }),
    /trusted user feedback requires an allowlisted user actor/,
  );
  assert.throws(
    () => resolveAttribution(bridge, {
      actor: 'user:example-owner',
      source: { stream: 'harry.user-feedback', event_id: 'feedback-44' },
      user_confirmed: true,
      user_rejected: true,
    }),
    ProfileValidationError,
  );
});

test('validated profiles are canonical, immutable, and reject ambiguous ACLs', () => {
  const profile = harryPortableProfile();
  assert.equal(validateProfile(profile), profile);
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(profile))), profile);
  assert.equal(profile.namespace_grants[0].namespace, 'harry');
  assert.equal(Object.isFrozen(profile.namespace_grants), true);
  assert.equal(Object.isFrozen(profile.allowed_actors), true);

  assert.throws(
    () => harryPortableProfile({
      namespaceGrants: [
        { namespace: 'Harry/Projects', read: true, write: false, descendants: false },
        { namespace: 'harry/projects', read: false, write: true, descendants: false },
      ],
    }),
    /duplicate namespace grant harry\/projects/,
  );
  assert.throws(
    () => canonicalizeNamespace('harry/../private'),
    ProfileValidationError,
  );
  assert.throws(() => harryPortableProfile({ unexpected_policy: true }), /unsupported field unexpected_policy/);
  assert.throws(() => harryPortableProfile({ version: 2 }), /profile version must be 1/);
});

test('unknown actors require explicit allowlisting and system actors remain trusted-bridge only', () => {
  const unknownProfile = harryPortableProfile({
    allowedActors: [{ id: 'unknown:legacy-import', type: 'unknown' }],
  });
  const unknown = resolveAttribution(unknownProfile, {
    actor: 'unknown:legacy-import',
    source: { stream: 'legacy.import', event_id: 'legacy-1' },
  });
  assert.equal(unknown.actor.type, ACTOR_TYPES.UNKNOWN);
  assert.equal(unknown.delegated_by, null);

  assert.throws(
    () => harryPortableProfile({
      allowedActors: [{ id: 'system:safire', type: 'system' }],
    }),
    /system actors require a trusted bridge profile/,
  );

  const bridge = createTrustedBridgeProfile({
    profileId: 'profile:system-bridge',
    principal: { id: 'agent:harry', type: 'agent' },
    agentInstance: { id: 'agent_instance:harry:system-bridge', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:trusted-bridge:system' },
    sourceIdentity: 'bridge:system-local',
    allowedActors: [{ id: 'system:safire', type: 'system' }],
    namespaceGrants: [{ namespace: 'harry/system', read: true, write: true, descendants: true }],
  });
  const system = resolveAttribution(bridge, {
    actor: 'system:safire',
    source: { stream: 'safire.system', event_id: 'system-1' },
  });
  assert.equal(system.actor.type, ACTOR_TYPES.SYSTEM);
  assert.equal(system.ingested_by.adapter_type, PROFILE_TYPES.TRUSTED_BRIDGE);
});
