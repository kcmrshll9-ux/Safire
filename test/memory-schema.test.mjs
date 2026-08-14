import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_TYPES,
  EVENT_KINDS,
  FEEDBACK_SIGNALS,
  MEMORY_SCHEMA_VERSION,
  RELATION_TYPES,
  SPEECH_ACTS,
  MemorySchemaValidationError,
  canonicalizeNamespace,
  containsDisallowedSensitiveMaterial,
  isOpaqueId,
  parseEventInput,
  parseFeedbackInput,
  parseOpaqueId,
  parseSafeAttributes,
} from '../lib/memory/schema.mjs';

const validEvent = (overrides = {}) => ({
  schema_version: MEMORY_SCHEMA_VERSION,
  namespace: 'Harry/Projects',
  actor_type: 'agent_instance',
  actor_id: 'actor_harry',
  delegated_by: 'actor_user',
  agent_instance_id: 'agent_instance_01',
  kind: 'visible_agent_response',
  speech_act: 'proposal',
  content: 'A visible response containing only user-facing reasoning and conclusions.',
  occurred_at: '2026-08-14T09:30:00.000-07:00',
  context: {
    conversation_id: 'conversation_01',
    session_id: 'session_01',
    thread_id: 'thread_01',
    turn_id: 'turn_01',
    message_id: 'message_01',
    tool_call_id: 'tool_call_01',
    automation_run_id: 'automation_run_01',
  },
  relations: [
    { type: 'replies_to', target_event_id: 'event_user_01' },
    { type: 'belongs_to', target_event_id: 'event_project_01' },
  ],
  derived: {
    summary: 'Harry proposed the visible plan.',
    claim: 'The proposal came from Harry, not the user.',
    source_event_ids: ['event_user_01', 'event_agent_01'],
  },
  attributes: {
    mime_type: 'text/plain',
    attempt: 1,
    visible: true,
    labels: ['planning', 'stage_one'],
  },
  source: { stream: 'hermes:conversation', event_id: 'source_event_01' },
  ...overrides,
});

test('Stage 1 vocabularies are fixed and exported', () => {
  assert.deepEqual([...ACTOR_TYPES], ['user', 'agent', 'agent_instance', 'automation', 'external_service', 'system', 'unknown']);
  assert.deepEqual([...EVENT_KINDS], [
    'visible_user_message', 'visible_agent_response', 'delegated_instruction', 'tool_prompt', 'tool_call',
    'tool_result', 'observable_action', 'automation_decision', 'explicit_conclusion', 'supplied_file',
    'supplied_link', 'user_result_interaction', 'external_observation',
  ]);
  assert.deepEqual([...SPEECH_ACTS], ['request', 'assertion', 'preference', 'proposal', 'correction', 'approval', 'rejection', 'observation', 'conclusion', 'unknown']);
  assert.deepEqual([...RELATION_TYPES], ['replies_to', 'causes', 'results_in', 'corrects', 'approves', 'rejects', 'contradicts', 'supports', 'belongs_to']);
  assert.deepEqual([...FEEDBACK_SIGNALS], ['useful', 'not_useful', 'correction', 'superseded', 'user_confirmed', 'user_rejected']);
  assert.equal(Object.isFrozen(ACTOR_TYPES), true);
});

test('logical namespaces canonicalize case-insensitively', () => {
  assert.equal(canonicalizeNamespace('  Harry/Projects.alpha  '), 'harry/projects.alpha');
  assert.equal(parseEventInput(validEvent()).namespace, 'harry/projects');
});

test('logical namespaces reject traversal, absolute paths, backslashes, and encoded bypasses', () => {
  for (const namespace of [
    '../harry', 'harry/../user', '/harry/user', 'C:/harry/user', 'harry\\user',
    'harry//user', 'harry/user/', 'harry/%2e%2e/user', '//server/share', '.', '..',
  ]) {
    assert.throws(() => canonicalizeNamespace(namespace), MemorySchemaValidationError, namespace);
  }
});

test('opaque IDs are portable identifiers rather than paths or free text', () => {
  for (const id of ['event_01', '01J5ABCDEF1234567890ABCD', '550e8400-e29b-41d4-a716-446655440000', 'hermes:turn.42']) {
    assert.equal(isOpaqueId(id), true);
    assert.equal(parseOpaqueId(id), id);
  }
  for (const id of ['', '../event', 'event/01', 'event\\01', 'event 01', '/absolute']) {
    assert.equal(isOpaqueId(id), false);
    assert.throws(() => parseOpaqueId(id), MemorySchemaValidationError);
  }
});

test('strict event parsing accepts the complete approved input and canonicalizes it', () => {
  const parsed = parseEventInput(validEvent());
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.namespace, 'harry/projects');
  assert.equal(parsed.context.session_id, 'session_01');
  assert.equal(parsed.context.automation_run_id, 'automation_run_01');
  assert.deepEqual(parsed.relations.map(relation => relation.type), ['replies_to', 'belongs_to']);
  assert.deepEqual(parsed.derived.source_event_ids, ['event_user_01', 'event_agent_01']);
  assert.deepEqual(parsed.source, { stream: 'hermes:conversation', event_id: 'source_event_01' });
  assert.equal('identity' in parsed.source, false);
});

test('event inputs reject unknown versions, vocabularies, fields, and source identity spoofing', () => {
  const invalidInputs = [
    validEvent({ schema_version: 2 }),
    validEvent({ actor_type: 'human' }),
    validEvent({ kind: 'visible_message' }),
    validEvent({ speech_act: 'question' }),
    { ...validEvent(), lifecycle: 'active' },
    validEvent({ source: { stream: 'hermes', event_id: 'source_01', identity: 'user' } }),
    validEvent({ context: { conversation_id: 'conversation_01', workspace_id: 'workspace_01' } }),
    validEvent({ relations: [{ type: 'replied_to', target_event_id: 'event_01' }] }),
    validEvent({ relations: [{ type: 'replies_to', target_id: 'event_01' }] }),
  ];
  for (const input of invalidInputs) assert.throws(() => parseEventInput(input), MemorySchemaValidationError);
});

test('derived summaries and claims require complete, unique source event IDs', () => {
  assert.throws(() => parseEventInput(validEvent({ derived: { summary: 'Derived summary', source_event_ids: [] } })), MemorySchemaValidationError);
  assert.throws(() => parseEventInput(validEvent({ derived: { source_event_ids: ['event_01'] } })), MemorySchemaValidationError);
  assert.throws(() => parseEventInput(validEvent({ derived: { claim: 'Derived claim', source_event_ids: ['event_01', 'event_01'] } })), MemorySchemaValidationError);
});

test('event relations are active-direction event links and reject duplicate edges', () => {
  assert.throws(() => parseEventInput(validEvent({
    relations: [
      { type: 'supports', target_event_id: 'event_01' },
      { type: 'supports', target_event_id: 'event_01' },
    ],
  })), MemorySchemaValidationError);
});

test('safe attributes allow bounded scalars and string lists but reject nested or sensitive data', () => {
  assert.deepEqual(parseSafeAttributes({ tool_name: 'browser', count: 2, successful: true, tags: ['public', 'visible'] }), {
    tool_name: 'browser', count: 2, successful: true, tags: ['public', 'visible'],
  });
  for (const attributes of [
    { Nested: 'not lowercase' },
    { nested: { value: 'not a scalar' } },
    { api_key: 'not accepted' },
    { constructor: 'not accepted' },
    { note: 'authorization: Bearer abcdefghijklmnopqrstuvwxyz' },
  ]) {
    assert.throws(() => parseSafeAttributes(attributes), MemorySchemaValidationError);
  }
});

test('credential, token, and private-reasoning content is rejected without logging or echoing it', () => {
  const secrets = [
    'password=correct-horse-battery-staple',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN PRIVATE KEY-----',
    'chain-of-thought: hidden intermediate reasoning',
  ];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    for (const secret of secrets) {
      assert.equal(containsDisallowedSensitiveMaterial(secret), true);
      let thrown;
      try { parseEventInput(validEvent({ content: secret })); } catch (error) { thrown = error; }
      assert.ok(thrown instanceof MemorySchemaValidationError);
      assert.doesNotMatch(JSON.stringify(thrown), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logged, []);
});

test('strict feedback parsing covers targets, fixed signals, correction, actor, and source', () => {
  const parsed = parseFeedbackInput({
    schema_version: 1,
    target: { type: 'memory', id: 'memory_01' },
    signal: 'correction',
    correction: 'The visible date should be August 15.',
    related_target: { type: 'event', id: 'event_01' },
    actor_id: 'actor_user',
    source: { stream: 'hermes:feedback', event_id: 'feedback_source_01' },
  });
  assert.equal(parsed.signal, 'correction');
  assert.equal(parsed.related_target.type, 'event');

  const invalidFeedback = [
    { ...parsed, signal: 'explicit_recall' },
    { ...parsed, target: { type: 'note', id: 'note_01' } },
    { ...parsed, actor_id: '../actor' },
    { ...parsed, source: { ...parsed.source, identity: 'user' } },
    { ...parsed, score: 1 },
    { ...parsed, correction: 'private reasoning: hidden trace' },
  ];
  for (const feedback of invalidFeedback) assert.throws(() => parseFeedbackInput(feedback), MemorySchemaValidationError);
});

test('correction and supersession feedback require their semantic payloads', () => {
  const base = {
    schema_version: 1,
    target: { type: 'memory', id: 'memory_01' },
    actor_id: 'actor_user',
    source: { stream: 'hermes:feedback', event_id: 'feedback_source_02' },
  };

  assert.throws(
    () => parseFeedbackInput({ ...base, signal: 'correction' }),
    MemorySchemaValidationError,
  );
  assert.throws(
    () => parseFeedbackInput({ ...base, signal: 'superseded' }),
    MemorySchemaValidationError,
  );

  assert.equal(parseFeedbackInput({
    ...base,
    signal: 'correction',
    correction: 'Use the corrected visible date.',
  }).signal, 'correction');
  assert.equal(parseFeedbackInput({
    ...base,
    signal: 'superseded',
    related_target: { type: 'event', id: 'event_replacement_01' },
  }).signal, 'superseded');
});
