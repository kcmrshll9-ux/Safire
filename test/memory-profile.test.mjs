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
import {
  SYNTHETIC_SENSITIVE_FIXTURES,
  escapeRegExp,
} from '../test-support/memory-sensitive-fixtures.mjs';

function examplePortableProfile(overrides = {}) {
  return createPortableMcpProfile({
    profileId: 'profile:example-local',
    principal: { id: 'agent:example', type: 'agent', displayName: 'Example' },
    agentInstance: { id: 'agent_instance:example:desktop', type: 'agent_instance', displayName: 'Example desktop' },
    ingestedBy: { id: 'adapter:safire-mcp:example' },
    sourceIdentity: 'mcp:example-local',
    allowedActors: [
      { id: 'automation:indexer', type: 'automation', displayName: 'Indexer', delegatedBy: 'agent:example' },
      { id: 'external_service:research-api', type: 'external_service', displayName: 'Research API' },
    ],
    namespaceGrants: [
      { namespace: 'Example', read: true, write: true, descendants: true },
      { namespace: 'Indexer', read: true, write: true, descendants: true },
      { namespace: 'Shared/Research', read: true, write: false, descendants: false },
    ],
    ...overrides,
  });
}

test('portable profile keeps Example and delegated Indexer attribution separate', () => {
  const profile = examplePortableProfile();

  assert.equal(profile.version, 1);
  assert.equal(profile.profile_id, 'profile:example-local');
  assert.equal(profile.profile_type, PROFILE_TYPES.PORTABLE_MCP);
  assert.equal(profile.principal.type, ACTOR_TYPES.AGENT);
  assert.equal(profile.agent_instance.type, ACTOR_TYPES.AGENT_INSTANCE);
  assert.notEqual(profile.principal.id, profile.agent_instance.id);
  assert.deepEqual(profile.ingested_by, {
    id: 'adapter:safire-mcp:example',
    adapter_type: 'portable_mcp',
    profile_id: 'profile:example-local',
  });
  assert.equal(profile.source_identity, 'mcp:example-local');
  assert.equal(Object.isFrozen(profile), true);

  const indexer = lookupActor(profile, 'AUTOMATION:INDEXER');
  assert.equal(indexer?.delegated_by, 'agent:example');
  assert.equal(isActorAuthorized(profile, { id: 'automation:indexer', type: 'automation' }), true);

  const attribution = resolveAttribution(profile, {
    actor: 'automation:indexer',
    source: { stream: 'Indexer.Daily', eventId: 'cron-2026-08-14T08:00:00Z' },
  });
  assert.equal(attribution.actor.id, 'automation:indexer');
  assert.equal(attribution.delegated_by.id, 'agent:example');
  assert.equal(attribution.agent_instance.id, 'agent_instance:example:desktop');
  assert.equal(attribution.ingested_by.id, 'adapter:safire-mcp:example');
  assert.deepEqual(attribution.source, {
    identity: 'mcp:example-local',
    stream: 'Indexer.Daily',
    event_id: 'cron-2026-08-14T08:00:00Z',
  });
  assert.notEqual(attribution.actor, attribution.delegated_by);
  assert.notEqual(attribution.actor, attribution.agent_instance);
  assert.equal(attribution.trusted_user_feedback, false);
});

test('namespace grants are canonical, case-insensitive, descendant-aware, and explicit', () => {
  const profile = examplePortableProfile();

  assert.equal(canonicalizeNamespace(' EXAMPLE/Projects/Launch '), 'example/projects/launch');
  assert.throws(() => canonicalizeNamespace(' /EXAMPLE\\Projects/Launch/ '), ProfileValidationError);
  assert.equal(canReadNamespace(profile, 'EXAMPLE/PRIVATE'), true);
  assert.equal(canWriteNamespace(profile, 'example/projects/launch'), true);
  assert.equal(canReadNamespace(profile, 'shared/research'), true);
  assert.equal(canWriteNamespace(profile, 'SHARED/RESEARCH'), false);
  assert.equal(canReadNamespace(profile, 'shared/research/child'), false);
  assert.equal(canReadNamespace(profile, 'example-private'), false);
  assert.equal(canReadNamespace(profile, 'atlas'), false);
  assert.equal(assertNamespaceAccess(profile, 'INDEXER/Daily', 'write'), 'indexer/daily');
  assert.throws(
    () => assertNamespaceAccess(profile, 'external/other', 'read'),
    ProfileAuthorizationError,
  );
});

test('a second agent cannot claim Example identity or access Example-private namespaces', () => {
  const atlas = createPortableMcpProfile({
    profile_id: 'profile:atlas-local',
    principal: { id: 'agent:atlas', type: 'agent' },
    agent_instance: { id: 'agent_instance:atlas:desktop', type: 'agent_instance' },
    ingested_by: { id: 'adapter:safire-mcp:atlas', adapter_type: 'portable_mcp', profile_id: 'profile:atlas-local' },
    source_identity: 'mcp:atlas-local',
    allowed_actors: [],
    namespace_grants: [{ namespace: 'atlas', read: true, write: true, descendants: true }],
  });

  assert.equal(isActorAuthorized(atlas, 'agent:example'), false);
  assert.equal(lookupActor(atlas, 'agent:example'), null);
  assert.equal(canReadNamespace(atlas, 'example/private'), false);
  assert.equal(canWriteNamespace(atlas, 'EXAMPLE/PRIVATE'), false);
  assert.throws(
    () => resolveAttribution(atlas, {
      actor: { id: 'agent:example', type: 'agent' },
      source: { stream: 'example.private', event_id: 'forged-event' },
    }),
    ProfileAuthorizationError,
  );

  assert.throws(
    () => examplePortableProfile({
      allowedActors: [{ id: 'agent:atlas', type: 'agent' }],
    }),
    /another agent or agent instance cannot be allowlisted/,
  );
});

test('ordinary MCP profiles reject user impersonation and caller-controlled trust fields', () => {
  const profile = examplePortableProfile();

  assert.equal(isActorAuthorized(profile, { id: 'agent:example', type: 'user' }), false);
  assert.throws(() => assertActorAuthorized(profile, 'user:example-owner'), ProfileAuthorizationError);
  assert.throws(
    () => examplePortableProfile({
      allowedActors: [{ id: 'user:example-owner', type: 'user' }],
    }),
    /user actors require a trusted bridge/,
  );
  assert.throws(
    () => examplePortableProfile({ acceptUserEvents: true }),
    /portable MCP profiles cannot accept user events/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:example',
      source: { stream: 'example.general', event_id: 'event-1' },
      user_confirmed: true,
    }),
    /trusted user feedback requires an allowlisted user actor/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:example',
      ingested_by: { id: 'adapter:forged' },
      source: { stream: 'example.general', event_id: 'event-2' },
    }),
    /fixed by the profile/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:example',
      source_identity: 'mcp:forged',
      source: { stream: 'example.general', event_id: 'event-3' },
    }),
    /fixed by the profile/,
  );
  assert.throws(
    () => resolveAttribution(profile, {
      actor: 'agent:example',
      source: { identity: 'mcp:forged', stream: 'example.general', event_id: 'event-4' },
    }),
    /attribution source contains an unsupported field/,
  );
});

test('trusted bridge accepts attributable user feedback only when host-configured', () => {
  assert.throws(
    () => createTrustedBridgeProfile({
      profileId: 'profile:example-bridge-disabled',
      principal: { id: 'agent:example', type: 'agent' },
      agentInstance: { id: 'agent_instance:example:bridge', type: 'agent_instance' },
      ingestedBy: { id: 'adapter:trusted-bridge:example' },
      sourceIdentity: 'bridge:example-local',
      allowedActors: [{ id: 'user:example-owner', type: 'user' }],
      namespaceGrants: [{ namespace: 'example', read: true, write: true, descendants: true }],
    }),
    /user actors require a trusted bridge configured to accept user events/,
  );

  const bridge = createTrustedBridgeProfile({
    profileId: 'profile:example-bridge',
    principal: { id: 'agent:example', type: 'agent' },
    agentInstance: { id: 'agent_instance:example:bridge', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:trusted-bridge:example' },
    sourceIdentity: 'bridge:example-local',
    acceptUserEvents: true,
    allowedActors: [{ id: 'user:example-owner', type: 'user', displayName: 'Example Owner' }],
    namespaceGrants: [{ namespace: 'example', read: true, write: true, descendants: true }],
  });
  const confirmation = resolveAttribution(bridge, {
    actor: 'USER:EXAMPLE-OWNER',
    source: { stream: 'Example.User-Feedback', event_id: 'feedback-42' },
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
      actor: 'agent:example',
      source: { stream: 'example.user-feedback', event_id: 'feedback-43' },
      user_rejected: true,
    }),
    /trusted user feedback requires an allowlisted user actor/,
  );
  assert.throws(
    () => resolveAttribution(bridge, {
      actor: 'user:example-owner',
      source: { stream: 'example.user-feedback', event_id: 'feedback-44' },
      user_confirmed: true,
      user_rejected: true,
    }),
    ProfileValidationError,
  );
});

test('validated profiles are canonical, immutable, and reject ambiguous ACLs', () => {
  const profile = examplePortableProfile();
  assert.equal(validateProfile(profile), profile);
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(profile))), profile);
  assert.equal(profile.namespace_grants[0].namespace, 'example');
  assert.equal(Object.isFrozen(profile.namespace_grants), true);
  assert.equal(Object.isFrozen(profile.allowed_actors), true);

  assert.throws(
    () => examplePortableProfile({
      namespaceGrants: [
        { namespace: 'Example/Projects', read: true, write: false, descendants: false },
        { namespace: 'example/projects', read: false, write: true, descendants: false },
      ],
    }),
    /duplicate namespace grant example\/projects/,
  );
  assert.throws(
    () => canonicalizeNamespace('example/../private'),
    ProfileValidationError,
  );
  assert.throws(
    () => examplePortableProfile({ unexpected_policy: true }),
    error => error instanceof ProfileValidationError
      && error.code === 'INVALID_MEMORY_PROFILE'
      && error.message === 'profile contains an unsupported field',
  );
  assert.throws(() => examplePortableProfile({ version: 2 }), /profile version must be 1/);
});

test('unknown credential-shaped property names reject generically without error echo', () => {
  const exactCandidates = [
    `AKIA${'A'.repeat(16)}`,
    `ASIA${'A'.repeat(16)}`,
  ];
  const candidates = [...new Set([
    ...exactCandidates.flatMap(candidate => [
      candidate,
      `_${candidate}`,
      `${candidate}_`,
      `_${candidate}_`,
    ]),
    ...SYNTHETIC_SENSITIVE_FIXTURES.map(({ value }) => value),
  ])];
  const validProfile = examplePortableProfile();

  for (const candidate of candidates) {
    const attempts = [
      () => examplePortableProfile({ [candidate]: true }),
      () => examplePortableProfile({
        principal: { id: 'agent:example', type: 'agent', [candidate]: true },
      }),
      () => examplePortableProfile({
        agentInstance: {
          id: 'agent_instance:example:desktop',
          type: 'agent_instance',
          [candidate]: true,
        },
      }),
      () => examplePortableProfile({
        ingestedBy: { id: 'adapter:safire-mcp:example', [candidate]: true },
      }),
      () => examplePortableProfile({
        trust: { [candidate]: true },
      }),
      () => examplePortableProfile({
        allowedActors: [{
          id: 'external_service:research-api',
          type: 'external_service',
          [candidate]: true,
        }],
      }),
      () => examplePortableProfile({
        namespaceGrants: [{
          namespace: 'example',
          read: true,
          write: true,
          descendants: true,
          [candidate]: true,
        }],
      }),
      () => resolveAttribution(validProfile, {
        actor: 'agent:example',
        source: { stream: 'example.general', event_id: 'event-unknown-root' },
        [candidate]: true,
      }),
      () => resolveAttribution(validProfile, {
        actor: 'agent:example',
        source: {
          stream: 'example.general',
          event_id: 'event-unknown-source',
          [candidate]: true,
        },
      }),
    ];

    for (const attempt of attempts) {
      let thrown;
      try { attempt(); } catch (error) { thrown = error; }
      assert.ok(thrown instanceof ProfileValidationError);
      assert.equal(thrown.code, 'INVALID_MEMORY_PROFILE');
      assert.match(thrown.message, /contains an unsupported field/);
      const serialized = JSON.stringify({
        name: thrown.name,
        code: thrown.code,
        message: thrown.message,
      });
      const pattern = new RegExp(escapeRegExp(candidate), 'i');
      assert.doesNotMatch(String(thrown), pattern);
      assert.doesNotMatch(JSON.stringify(thrown), pattern);
      assert.doesNotMatch(serialized, pattern);
    }
  }
});

test('profile identifiers, namespaces, and display names reject credential-like text without echoing it', () => {
  const credentials = [
    `ghp_${'A'.repeat(36)}`,
    `github_pat_${'A'.repeat(82)}`,
    ...SYNTHETIC_SENSITIVE_FIXTURES.map(({ value }) => value),
  ];
  for (const credential of credentials) {
    const attempts = [
      () => examplePortableProfile({
        principal: { id: 'agent:example', type: 'agent', displayName: credential },
      }),
      () => examplePortableProfile({
        principal: { id: `agent:${credential}`, type: 'agent' },
        allowedActors: [],
      }),
      () => examplePortableProfile({
        agentInstance: { id: `agent_instance:${credential}`, type: 'agent_instance' },
      }),
      () => examplePortableProfile({
        agentInstance: {
          id: 'agent_instance:example:desktop',
          type: 'agent_instance',
          displayName: credential,
        },
      }),
      () => examplePortableProfile({ profileId: credential }),
      () => examplePortableProfile({ sourceIdentity: credential }),
      () => examplePortableProfile({ ingestedBy: { id: `adapter:${credential}` } }),
      () => examplePortableProfile({
        ingestedBy: { id: 'adapter:safire-mcp:example', profileId: credential },
      }),
      () => examplePortableProfile({
        allowedActors: [{ id: `external_service:${credential}`, type: 'external_service' }],
      }),
      () => examplePortableProfile({
        allowedActors: [{
          id: 'external_service:synthetic',
          type: 'external_service',
          displayName: credential,
        }],
      }),
      () => examplePortableProfile({
        allowedActors: [{
          id: 'automation:synthetic',
          type: 'automation',
          delegatedBy: `agent:${credential}`,
        }],
      }),
      () => examplePortableProfile({
        namespaceGrants: [
          { namespace: `shared/${credential}`, read: true, write: true, descendants: true },
        ],
      }),
    ];
    for (const attempt of attempts) {
      let thrown;
      try { attempt(); } catch (error) { thrown = error; }
      assert.ok(thrown instanceof ProfileValidationError);
      const pattern = new RegExp(escapeRegExp(credential), 'i');
      assert.doesNotMatch(thrown.message, pattern);
      assert.doesNotMatch(JSON.stringify(thrown), pattern);
    }
  }

  const upperNpm = `NPM_${'A'.repeat(36)}`;
  assert.throws(
    () => examplePortableProfile({ profileId: upperNpm }),
    error => error instanceof ProfileValidationError
      && !error.message.includes(upperNpm),
  );
});

test('over-limit profile identifiers and labels reject before normalization without echo', () => {
  const token = SYNTHETIC_SENSITIVE_FIXTURES.find(({ family }) => family === 'npm').value;
  const oversizedId = `${token}:${'x'.repeat(121)}`;
  const oversizedLabel = `${token} ${'x'.repeat(161)}`;
  assert.equal(oversizedId.length, 162);
  assert.equal(oversizedLabel.length, 202);

  const originalNormalize = String.prototype.normalize;
  const normalizedOversizedValues = [];
  String.prototype.normalize = function patchedNormalize(...args) {
    const value = String(this);
    if (value === oversizedId || value === oversizedLabel) normalizedOversizedValues.push(value);
    return originalNormalize.apply(this, args);
  };
  try {
    for (const attempt of [
      () => examplePortableProfile({ profileId: oversizedId }),
      () => examplePortableProfile({
        principal: { id: 'agent:example', type: 'agent', displayName: oversizedLabel },
      }),
    ]) {
      let thrown;
      try { attempt(); } catch (error) { thrown = error; }
      assert.ok(thrown instanceof ProfileValidationError);
      assert.doesNotMatch(thrown.message, new RegExp(escapeRegExp(token), 'i'));
    }
  } finally {
    String.prototype.normalize = originalNormalize;
  }
  assert.deepEqual(normalizedOversizedValues, []);
});

test('unknown actors require explicit allowlisting and system actors remain trusted-bridge only', () => {
  const unknownProfile = examplePortableProfile({
    allowedActors: [{ id: 'unknown:legacy-import', type: 'unknown' }],
  });
  const unknown = resolveAttribution(unknownProfile, {
    actor: 'unknown:legacy-import',
    source: { stream: 'legacy.import', event_id: 'legacy-1' },
  });
  assert.equal(unknown.actor.type, ACTOR_TYPES.UNKNOWN);
  assert.equal(unknown.delegated_by, null);

  assert.throws(
    () => examplePortableProfile({
      allowedActors: [{ id: 'system:safire', type: 'system' }],
    }),
    /system actors require a trusted bridge profile/,
  );

  const bridge = createTrustedBridgeProfile({
    profileId: 'profile:system-bridge',
    principal: { id: 'agent:example', type: 'agent' },
    agentInstance: { id: 'agent_instance:example:system-bridge', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:trusted-bridge:system' },
    sourceIdentity: 'bridge:system-local',
    allowedActors: [{ id: 'system:safire', type: 'system' }],
    namespaceGrants: [{ namespace: 'example/system', read: true, write: true, descendants: true }],
  });
  const system = resolveAttribution(bridge, {
    actor: 'system:safire',
    source: { stream: 'safire.system', event_id: 'system-1' },
  });
  assert.equal(system.actor.type, ACTOR_TYPES.SYSTEM);
  assert.equal(system.ingested_by.adapter_type, PROFILE_TYPES.TRUSTED_BRIDGE);
});
