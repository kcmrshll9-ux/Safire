import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVENTED_TRUSTED_BRIDGE_ENVELOPE,
  TRUSTED_BRIDGE_ENVELOPE_SCHEMA_ID,
  TRUSTED_BRIDGE_FEEDBACK_ENVELOPE_SCHEMA_ID,
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

const feedbackEnvelope = (overrides = {}) => ({
  schema_version: 1,
  target: { type: 'event', id: 'evt_11111111-1111-4111-8111-111111111111' },
  signal: 'user_confirmed',
  source: { stream: 'hermes:feedback', event_id: 'feedback_source_01' },
  ...overrides,
});

const GITHUB_TOKEN_IDENTIFIER = `ghp_${'A'.repeat(36)}`;

test('trusted bridge requires a normalized trusted_bridge profile and injected callbacks', () => {
  const authenticate = async () => successfulAuthentication();
  const recordEvents = async () => ({ ok: true });
  assert.throws(() => createTrustedBridge({ profile: { profile_type: 'portable_mcp' }, authenticate, recordEvents }), TrustedBridgeError);
  assert.throws(() => createTrustedBridge({ profile: profile(), recordEvents }), /authenticate callback/);
  assert.throws(() => createTrustedBridge({ profile: profile(), authenticate }), /recordEvents callback/);
  assert.throws(
    () => createTrustedBridge({ profile: profile(), authenticate, recordEvents, recordFeedback: true }),
    /recordFeedback must be a function/,
  );
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
  assert.equal(receivedMetadata.operation, 'event');
  assert.equal(receivedMetadata.envelope_schema, TRUSTED_BRIDGE_ENVELOPE_SCHEMA_ID);
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

test('credential-like identifiers are rejected before event or feedback authentication without echo', async () => {
  let authenticationCalls = 0;
  let eventRecordingCalls = 0;
  let feedbackRecordingCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => {
      authenticationCalls += 1;
      return successfulAuthentication();
    },
    recordEvents: async () => { eventRecordingCalls += 1; },
    recordFeedback: async () => { feedbackRecordingCalls += 1; },
  });

  const attempts = [
    () => bridge.ingest(envelope({
      source: { stream: GITHUB_TOKEN_IDENTIFIER, event_id: 'source_event_01' },
    })),
    () => bridge.ingest(envelope({
      context: { conversation_id: 'conversation_01', session_id: GITHUB_TOKEN_IDENTIFIER },
    })),
    () => bridge.ingestFeedback(feedbackEnvelope({
      target: { type: 'event', id: GITHUB_TOKEN_IDENTIFIER },
    })),
    () => bridge.ingestFeedback(feedbackEnvelope({
      source: { stream: 'hermes:feedback', event_id: GITHUB_TOKEN_IDENTIFIER },
    })),
  ];
  for (const attempt of attempts) {
    let thrown;
    try { await attempt(); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof MemorySchemaValidationError);
    assert.doesNotMatch(thrown.message, new RegExp(GITHUB_TOKEN_IDENTIFIER, 'i'));
    assert.doesNotMatch(JSON.stringify(thrown), new RegExp(GITHUB_TOKEN_IDENTIFIER, 'i'));
  }
  assert.equal(authenticationCalls, 0);
  assert.equal(eventRecordingCalls, 0);
  assert.equal(feedbackRecordingCalls, 0);
});

test('credential-like authenticated actor identifiers fail closed without recording or echo', async () => {
  let recordingCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => successfulAuthentication({ actor_id: GITHUB_TOKEN_IDENTIFIER }),
    recordEvents: async () => { recordingCalls += 1; },
  });
  await assert.rejects(
    () => bridge.ingest(envelope()),
    error => error instanceof TrustedBridgeAuthenticationError
      && !error.message.toLowerCase().includes(GITHUB_TOKEN_IDENTIFIER.toLowerCase()),
  );
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

test('event-only bridge construction remains compatible and feedback fails closed when not configured', async () => {
  let authenticationCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => {
      authenticationCalls += 1;
      return successfulAuthentication();
    },
    recordEvents: async () => ({ ok: true }),
  });

  assert.equal(typeof bridge.ingest, 'function');
  assert.equal(typeof bridge.ingestFeedback, 'function');
  await assert.rejects(
    () => bridge.ingestFeedback(feedbackEnvelope()),
    error => error instanceof TrustedBridgeError
      && error.code === 'TRUSTED_BRIDGE_FEEDBACK_NOT_CONFIGURED',
  );
  assert.equal(authenticationCalls, 0);
});

test('feedback authentication receives frozen operation-bound metadata and supplies the only actor ID', async () => {
  let receivedMetadata;
  let receivedContext;
  let recorded;
  const authContext = { connection: 'invented-feedback-session' };
  const correction = 'Use the amber checklist instead.';
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async (metadata, context) => {
      receivedMetadata = metadata;
      receivedContext = context;
      return successfulAuthentication({ actor_id: 'USER:EXAMPLE-OWNER' });
    },
    recordEvents: async () => ({ ok: true }),
    recordFeedback: async feedback => {
      recorded = feedback;
      return { accepted: feedback.length };
    },
  });

  const result = await bridge.ingestFeedback(feedbackEnvelope({
    signal: 'correction',
    correction,
  }), authContext);

  assert.equal(bridge.feedback_schema_id, TRUSTED_BRIDGE_FEEDBACK_ENVELOPE_SCHEMA_ID);
  assert.equal(receivedContext, authContext);
  assert.equal(receivedMetadata.operation, 'feedback');
  assert.equal(receivedMetadata.envelope_schema, TRUSTED_BRIDGE_FEEDBACK_ENVELOPE_SCHEMA_ID);
  assert.deepEqual(receivedMetadata.target, feedbackEnvelope().target);
  assert.equal(receivedMetadata.signal, 'correction');
  assert.equal(receivedMetadata.correction_length, Buffer.byteLength(correction, 'utf8'));
  assert.match(receivedMetadata.correction_sha256, /^[a-f0-9]{64}$/);
  assert.match(receivedMetadata.payload_sha256, /^[a-f0-9]{64}$/);
  assert.equal('correction' in receivedMetadata, false);
  assert.equal('actor_id' in receivedMetadata, false);
  assert.equal(Object.isFrozen(receivedMetadata), true);
  assert.equal(Object.isFrozen(receivedMetadata.target), true);
  assert.equal(Object.isFrozen(receivedMetadata.source), true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].actor_id, 'user:example-owner');
  assert.equal(recorded[0].correction, correction);
  assert.deepEqual(result.feedback, recorded[0]);
  assert.deepEqual(result.record_result, { accepted: 1 });
});

test('strict feedback envelopes reject actor claims and invalid content before authentication', async () => {
  let authenticationCalls = 0;
  let recordingCalls = 0;
  const bridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => {
      authenticationCalls += 1;
      return successfulAuthentication();
    },
    recordEvents: async () => {},
    recordFeedback: async () => { recordingCalls += 1; },
  });
  const invalid = [
    { ...feedbackEnvelope(), actor_id: 'user:claimed' },
    { ...feedbackEnvelope(), actor_type: 'user' },
    feedbackEnvelope({ source: { stream: 'hermes', event_id: 'feedback_01', identity: 'user' } }),
    { ...feedbackEnvelope(), lifecycle: 'active' },
    feedbackEnvelope({ signal: 'correction' }),
    feedbackEnvelope({ signal: 'superseded' }),
    feedbackEnvelope({ signal: 'correction', correction: 'password=not-accepted-here' }),
  ];

  for (const candidate of invalid) {
    await assert.rejects(() => bridge.ingestFeedback(candidate), MemorySchemaValidationError);
  }
  assert.equal(authenticationCalls, 0);
  assert.equal(recordingCalls, 0);
});

test('feedback authentication failures and invalid results never call recordFeedback', async () => {
  let recordingCalls = 0;
  const recordFeedback = async () => { recordingCalls += 1; };
  const throwingBridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => { throw new Error('provider details must not escape'); },
    recordEvents: async () => {},
    recordFeedback,
  });
  await assert.rejects(
    () => throwingBridge.ingestFeedback(feedbackEnvelope()),
    error => error instanceof TrustedBridgeAuthenticationError && !error.message.includes('provider details'),
  );

  const invalidResultBridge = createTrustedBridge({
    profile: profile(),
    authenticate: async () => ({ authenticated: false, role: 'user', actor_id: 'claimed_user' }),
    recordEvents: async () => {},
    recordFeedback,
  });
  await assert.rejects(
    () => invalidResultBridge.ingestFeedback(feedbackEnvelope()),
    TrustedBridgeAuthenticationError,
  );
  assert.equal(recordingCalls, 0);
});

test('feedback role, actor, and user-only signal authorization fail before recording', async () => {
  let recordingCalls = 0;
  const cases = [
    successfulAuthentication({
      role: 'agent',
      actor_id: 'agent:harry',
      agent_instance_id: 'agent_instance:harry:bridge',
    }),
    successfulAuthentication({
      role: 'agent',
      actor_id: 'user:example-owner',
      agent_instance_id: 'agent_instance:harry:bridge',
    }),
  ];

  for (const authentication of cases) {
    const bridge = createTrustedBridge({
      profile: profile(),
      authenticate: async () => authentication,
      recordEvents: async () => {},
      recordFeedback: async () => { recordingCalls += 1; },
    });
    await assert.rejects(
      () => bridge.ingestFeedback(feedbackEnvelope()),
      TrustedBridgeAuthorizationError,
    );
  }
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
