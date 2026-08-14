import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVENTED_TRUSTED_BRIDGE_ENVELOPE,
  TRUSTED_BRIDGE_KIND_GRANTS,
  TrustedBridgeAuthenticationError,
  TrustedBridgeAuthorizationError,
  TrustedBridgeError,
  createTrustedBridge,
  simulateTrustedBridge,
} from '../lib/memory/trusted-bridge.mjs';
import { MemorySchemaValidationError } from '../lib/memory/schema.mjs';
import { createTrustedBridgeProfile } from '../lib/memory/profile.mjs';

const profile = ({ acceptUserEvents = true, allowedActors, namespaceGrants } = {}) => createTrustedBridgeProfile({
  profile_id: 'profile:trusted-bridge-test',
  principal: { id: 'agent:harry', type: 'agent' },
  agent_instance: { id: 'agent_instance:harry:bridge', type: 'agent_instance' },
  ingested_by: { id: 'adapter:trusted-bridge:test' },
  source_identity: 'bridge:invented',
  accept_user_events: acceptUserEvents,
  allowed_actors: allowedActors || [
    { id: 'user:example-owner', type: 'user' },
    { id: 'automation:moltbook', type: 'automation', delegated_by: 'agent:harry' },
    { id: 'external_service:research-api', type: 'external_service' },
  ],
  namespace_grants: namespaceGrants || [
    { namespace: 'examples/invented', read: true, write: true, descendants: true },
    { namespace: 'harry/projects', read: true, write: true, descendants: true },
  ],
});

const envelope = (overrides = {}) => ({
  schema_version: 1,
  namespace: 'Harry/Projects',
  kind: 'visible_user_message',
  speech_act: 'request',
  content: 'Please inspect the visible project result.',
  occurred_at: '2026-08-14T09:30:00.000-07:00',
  context: { conversation_id: 'conversation_01', message_id: 'message_01' },
  source: { stream: 'hermes:conversation', event_id: 'source_event_01' },
  ...overrides,
});

const successfulAuthentication = (overrides = {}) => ({
  authenticated: true,
  role: 'user',
  actor_id: 'user:example-owner',
  ...overrides,
});

test('trusted bridge requires a normalized trusted_bridge profile and injected callbacks', () => {
  const authenticate = async () => successfulAuthentication();
  const recordEvents = async () => ({ ok: true });
  assert.throws(() => createTrustedBridge({ profile: { profile_type: 'portable_mcp' }, authenticate, recordEvents }), TrustedBridgeError);
  assert.throws(() => createTrustedBridge({ profile: profile(), recordEvents }), /authenticate callback/);
  assert.throws(() => createTrustedBridge({ profile: profile(), authenticate }), /recordEvents callback/);
});

test('authentication receives frozen metadata and auth context, never visible content', async () => {
  let receivedMetadata;
  let receivedContext;
  const authContext = { connection: 'invented-local-session' };
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async (metadata, context) => {
      receivedMetadata = metadata;
      receivedContext = context;
      return successfulAuthentication();
    },
    recordEvents: async () => ({ ok: true }),
  });
  await bridge.ingest(envelope(), authContext);
  assert.equal(receivedContext, authContext);
  assert.equal(receivedMetadata.namespace, 'harry/projects');
  assert.equal(receivedMetadata.content_length > 0, true);
  assert.match(receivedMetadata.content_sha256, /^[a-f0-9]{64}$/);
  assert.match(receivedMetadata.payload_sha256, /^[a-f0-9]{64}$/);
  assert.equal('content' in receivedMetadata, false);
  assert.equal('derived' in receivedMetadata, false);
  assert.equal('attributes' in receivedMetadata, false);
  assert.equal(Object.isFrozen(receivedMetadata), true);
  assert.equal(Object.isFrozen(receivedMetadata.source), true);
});

test('normalized actor attribution comes only from successful authentication', async () => {
  let recorded;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => successfulAuthentication({ actor_id: 'USER:EXAMPLE-OWNER' }),
    recordEvents: async events => { recorded = events; return { accepted: events.length }; },
  });
  const result = await bridge.ingest(envelope());
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].actor_type, 'user');
  assert.equal(recorded[0].actor_id, 'user:example-owner');
  assert.equal(recorded[0].agent_instance_id, 'agent_instance:harry:bridge');
  assert.equal(recorded[0].namespace, 'harry/projects');
  assert.deepEqual(result.event, recorded[0]);
  assert.deepEqual(result.record_result, { accepted: 1 });
});

test('strict envelopes reject actor claims, source identity, unknown fields, credentials, and private reasoning before authentication', async () => {
  let authenticationCalls = 0;
  let recordingCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => { authenticationCalls += 1; return successfulAuthentication(); },
    recordEvents: async () => { recordingCalls += 1; },
  });
  const invalid = [
    { ...envelope(), actor_type: 'user' },
    { ...envelope(), actor_id: 'claimed_user' },
    { ...envelope(), delegated_by: 'claimed_delegator' },
    { ...envelope(), agent_instance_id: 'claimed_agent' },
    envelope({ source: { stream: 'hermes', event_id: 'source_01', identity: 'user' } }),
    { ...envelope(), lifecycle: 'active' },
    envelope({ content: 'password=not-accepted-here' }),
    envelope({ content: 'chain-of-thought: hidden trace' }),
  ];
  for (const candidate of invalid) {
    await assert.rejects(() => bridge.ingest(candidate), MemorySchemaValidationError);
  }
  assert.equal(authenticationCalls, 0);
  assert.equal(recordingCalls, 0);
});

test('authentication failures and untrusted results never call recordEvents', async () => {
  let recordingCalls = 0;
  const recordEvents = async () => { recordingCalls += 1; };
  const throwingBridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => { throw new Error('provider details must not escape'); },
    recordEvents,
  });
  await assert.rejects(
    () => throwingBridge.ingest(envelope()),
    error => error instanceof TrustedBridgeAuthenticationError && !error.message.includes('provider details'),
  );

  const invalidResultBridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => ({ authenticated: false, role: 'user', actor_id: 'claimed_user' }),
    recordEvents,
  });
  await assert.rejects(() => invalidResultBridge.ingest(envelope()), TrustedBridgeAuthenticationError);
  assert.equal(recordingCalls, 0);
});

test('authenticated roles have closed exact-kind grants', async () => {
  assert.deepEqual(TRUSTED_BRIDGE_KIND_GRANTS, {
    user: [
      'visible_user_message',
      'supplied_file',
      'supplied_link',
      'user_result_interaction',
    ],
    agent: [
      'visible_agent_response',
      'delegated_instruction',
      'tool_prompt',
      'tool_call',
      'observable_action',
      'explicit_conclusion',
    ],
    automation: [
      'automation_decision',
      'delegated_instruction',
      'tool_prompt',
      'tool_call',
      'observable_action',
      'explicit_conclusion',
    ],
    external_service: [
      'tool_result',
      'external_observation',
    ],
  });

  const representative = [
    ['user', 'user:example-owner', 'visible_user_message', 'user'],
    ['agent', 'agent:harry', 'visible_agent_response', 'agent'],
    ['agent', 'agent_instance:harry:bridge', 'tool_call', 'agent_instance'],
    ['automation', 'automation:moltbook', 'automation_decision', 'automation'],
    ['external_service', 'external_service:research-api', 'tool_result', 'external_service'],
  ];
  for (const [role, actorId, kind, expectedActorType] of representative) {
    let recorded;
    const bridge = createTrustedBridge({
      profile: profile(),
      authenticate: async () => successfulAuthentication({
        role,
        actor_id: actorId,
        ...(role === 'agent' ? { agent_instance_id: 'agent_instance:harry:bridge' } : {}),
      }),
      recordEvents: async events => { recorded = events; },
    });
    await bridge.ingest(envelope({ kind }));
    assert.equal(recorded[0].actor_type, expectedActorType);
    assert.equal(TRUSTED_BRIDGE_KIND_GRANTS[role].includes(kind), true);
  }
});

test('role-kind mismatches are rejected without recording', async () => {
  let recordingCalls = 0;
  const pairs = [
    ['user', 'user:example-owner', 'visible_agent_response'],
    ['agent', 'agent:harry', 'visible_user_message'],
    ['automation', 'automation:moltbook', 'tool_result'],
    ['external_service', 'external_service:research-api', 'automation_decision'],
  ];
  for (const [role, actorId, kind] of pairs) {
    const bridge = createTrustedBridge({
      profile: profile(),
      authenticate: async () => successfulAuthentication({ role, actor_id: actorId }),
      recordEvents: async () => { recordingCalls += 1; },
    });
    await assert.rejects(() => bridge.ingest(envelope({ kind })), TrustedBridgeAuthorizationError);
  }
  assert.equal(recordingCalls, 0);
});

test('authenticated role must match the allowlisted actor type', async () => {
  let recordingCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => successfulAuthentication({
      role: 'agent',
      actor_id: 'user:example-owner',
      agent_instance_id: 'agent_instance:harry:bridge',
    }),
    recordEvents: async () => { recordingCalls += 1; },
  });
  await assert.rejects(
    () => bridge.ingest(envelope({ kind: 'visible_agent_response' })),
    TrustedBridgeAuthorizationError,
  );
  assert.equal(recordingCalls, 0);
});

test('profile namespace write grants are enforced before recording', async () => {
  let recordingCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile({
      namespaceGrants: [
        { namespace: 'elsewhere', read: true, write: true, descendants: true },
      ],
    }),
    authenticate: async () => successfulAuthentication(),
    recordEvents: async () => { recordingCalls += 1; },
  });
  await assert.rejects(() => bridge.ingest(envelope()), TrustedBridgeAuthorizationError);
  assert.equal(recordingCalls, 0);
});

test('user events require explicit trusted_bridge user-event trust', async () => {
  let recordingCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile({
      acceptUserEvents: false,
      allowedActors: [
        { id: 'automation:moltbook', type: 'automation', delegated_by: 'agent:harry' },
        { id: 'external_service:research-api', type: 'external_service' },
      ],
    }),
    authenticate: async () => successfulAuthentication(),
    recordEvents: async () => { recordingCalls += 1; },
  });
  await assert.rejects(() => bridge.ingest(envelope()), TrustedBridgeAuthorizationError);
  assert.equal(recordingCalls, 0);
});

test('delegation and agent-instance attribution can only arrive in authenticated results', async () => {
  let recorded;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => successfulAuthentication({
      role: 'automation',
      actor_id: 'automation:moltbook',
      delegated_by: 'agent:harry',
    }),
    recordEvents: async events => { recorded = events; },
  });
  await bridge.ingest(envelope({ kind: 'automation_decision' }));
  assert.equal(recorded[0].actor_type, 'automation');
  assert.equal(recorded[0].delegated_by, 'agent:harry');
});

test('simulateTrustedBridge is explicit and uses only the invented envelope', async () => {
  let recorded;
  const result = await simulateTrustedBridge({
    profile: profile(),
    authenticate: async () => successfulAuthentication({ actor_id: 'user:example-owner' }),
    recordEvents: async events => { recorded = events; return 'simulated'; },
  });
  assert.equal(recorded[0].content, INVENTED_TRUSTED_BRIDGE_ENVELOPE.content);
  assert.equal(recorded[0].namespace, 'examples/invented');
  assert.equal(result.record_result, 'simulated');
});
