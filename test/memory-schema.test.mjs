import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_TYPES,
  EVENT_KINDS,
  FEEDBACK_SIGNALS,
  MEMORY_SCHEMA_VERSION,
  RELATION_TYPES,
  SCHEMA_LIMITS,
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
import {
  SYNTHETIC_PROVIDER_FIXTURES,
  SYNTHETIC_RAW_JWT,
  SYNTHETIC_SENSITIVE_FIXTURES,
  escapeRegExp,
} from '../test-support/memory-sensitive-fixtures.mjs';

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

const GITHUB_TOKEN_IDENTIFIERS = Object.freeze([
  `ghp_${'A'.repeat(36)}`,
  `github_pat_${'A'.repeat(82)}`,
]);
const SENSITIVE_IDENTIFIER_VALUES = Object.freeze([
  ...GITHUB_TOKEN_IDENTIFIERS,
  ...SYNTHETIC_SENSITIVE_FIXTURES.map(({ value }) => value),
]);

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
    GITHUB_TOKEN_IDENTIFIERS[1],
    ...SYNTHETIC_SENSITIVE_FIXTURES.map(({ value }) => value),
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

test('credential-like material is rejected from every caller-controlled identifier without echoing it', () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    for (const credential of SENSITIVE_IDENTIFIER_VALUES) {
      assert.equal(containsDisallowedSensitiveMaterial(credential), true);
      assert.equal(isOpaqueId(credential), false);

      const eventInputs = [
        validEvent({ namespace: `harry/${credential}` }),
        validEvent({ actor_id: credential }),
        validEvent({ delegated_by: credential }),
        validEvent({ agent_instance_id: credential }),
        validEvent({ content: credential }),
        validEvent({ source: { stream: credential, event_id: 'source_event_01' } }),
        validEvent({ source: { stream: 'hermes:conversation', event_id: credential } }),
        validEvent({ relations: [{ type: 'supports', target_event_id: credential }] }),
        validEvent({ derived: { summary: credential, source_event_ids: ['event_user_01'] } }),
        validEvent({ derived: { claim: credential, source_event_ids: ['event_user_01'] } }),
        validEvent({ derived: { claim: 'A visible claim.', source_event_ids: [credential] } }),
        validEvent({ attributes: { visible_label: credential } }),
      ];
      const attributeKey = credential.toLowerCase();
      if (/^[a-z][a-z0-9_]*$/.test(attributeKey)
          && attributeKey.length <= 64
          && containsDisallowedSensitiveMaterial(attributeKey)) {
        eventInputs.push(validEvent({ attributes: { [attributeKey]: 'visible' } }));
      }
      for (const contextKey of [
        'conversation_id', 'session_id', 'thread_id', 'turn_id', 'message_id',
        'tool_call_id', 'automation_run_id',
      ]) {
        eventInputs.push(validEvent({ context: { [contextKey]: credential } }));
      }

      const feedbackBase = {
        schema_version: 1,
        target: { type: 'event', id: 'event_01' },
        signal: 'superseded',
        related_target: { type: 'event', id: 'event_02' },
        actor_id: 'actor_user',
        source: { stream: 'hermes:feedback', event_id: 'feedback_source_01' },
      };
      const feedbackInputs = [
        { ...feedbackBase, target: { type: 'event', id: credential } },
        { ...feedbackBase, related_target: { type: 'memory', id: credential } },
        { ...feedbackBase, actor_id: credential },
        { ...feedbackBase, source: { stream: credential, event_id: 'feedback_source_01' } },
        { ...feedbackBase, source: { stream: 'hermes:feedback', event_id: credential } },
        {
          schema_version: 1,
          target: { type: 'event', id: 'event_01' },
          signal: 'correction',
          correction: credential,
          actor_id: 'actor_user',
          source: { stream: 'hermes:feedback', event_id: 'feedback_source_01' },
        },
      ];

      for (const parse of [
        ...eventInputs.map(input => () => parseEventInput(input)),
        ...feedbackInputs.map(input => () => parseFeedbackInput(input)),
        () => parseOpaqueId(credential),
      ]) {
        let thrown;
        try { parse(); } catch (error) { thrown = error; }
        assert.ok(thrown instanceof MemorySchemaValidationError);
        assert.doesNotMatch(JSON.stringify(thrown), new RegExp(escapeRegExp(credential), 'i'));
        assert.doesNotMatch(thrown.message, new RegExp(escapeRegExp(credential), 'i'));
      }
    }
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logged, []);
});

test('fine-grained GitHub token detection follows the exact documented prefix and length', () => {
  const valid = `github_pat_${'Z'.repeat(82)}`;
  assert.equal(containsDisallowedSensitiveMaterial(valid), true);
  assert.equal(containsDisallowedSensitiveMaterial(`GITHUB_PAT_${'Z'.repeat(82)}`), false);
  assert.equal(containsDisallowedSensitiveMaterial(`github_pat_${'Z'.repeat(81)}`), false);
  assert.equal(containsDisallowedSensitiveMaterial(`github_pat_${'Z'.repeat(83)}`), false);
  assert.equal(containsDisallowedSensitiveMaterial('A GitHub PAT should be stored outside memory.'), false);
});

test('AWS access key IDs use ASCII-alphanumeric boundaries and exact case-sensitive shapes', () => {
  const fullwidthAscii = value => [...value].map((character) => {
    const code = character.codePointAt(0);
    return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : character;
  }).join('');

  for (const prefix of ['AKIA', 'ASIA']) {
    const value = `${prefix}${'A'.repeat(16)}`;
    for (const candidate of [
      value,
      `_${value}`,
      `${value}_`,
      `_${value}_`,
      `(${value})`,
      `[${value}]`,
      ` ${value} `,
      `visible: ${value}, retained`,
      `Bearer ${value}`,
      fullwidthAscii(value),
      `${value.slice(0, 2)}\u200B${value.slice(2)}`,
      `${value.slice(0, 2)}\u2060${value.slice(2)}`,
    ]) {
      assert.equal(containsDisallowedSensitiveMaterial(candidate), true, `${prefix}: ${candidate}`);
    }

    for (const candidate of [
      `x${value}`,
      `${value}x`,
      `1${value}`,
      `${value}1`,
      `x${value}9`,
      `${prefix}${'A'.repeat(15)}`,
      `${prefix}${'A'.repeat(17)}`,
      `${prefix.toLowerCase()}${'A'.repeat(16)}`,
      `${prefix}${'A'.repeat(8)}/${'A'.repeat(7)}`,
      `${prefix}${'A'.repeat(8)}a${'A'.repeat(7)}`,
    ]) {
      assert.equal(containsDisallowedSensitiveMaterial(candidate), false, `${prefix}: ${candidate}`);
    }
  }
});

test('provider credentials remain detectable when delimited by underscores', () => {
  const credentials = [
    ...GITHUB_TOKEN_IDENTIFIERS,
    ...SYNTHETIC_PROVIDER_FIXTURES.map(({ value }) => value),
    `sk-proj-${'A'.repeat(48)}`,
    `xoxb-${'A'.repeat(24)}`,
  ];

  for (const credential of credentials) {
    for (const candidate of [
      `_${credential}`,
      `${credential}_`,
      `_${credential}_`,
    ]) {
      assert.equal(
        containsDisallowedSensitiveMaterial(candidate),
        true,
        candidate,
      );
    }
  }
});

test('provider token detection is boundary-aware, normalization-safe, and narrowly shaped', () => {
  const fullwidthAscii = value => [...value].map((character) => {
    const code = character.codePointAt(0);
    return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : character;
  }).join('');

  for (const { family, value } of SYNTHETIC_SENSITIVE_FIXTURES) {
    for (const candidate of [
      value,
      `${value} followed by visible prose`,
      `visible prose (${value}) continues`,
      `visible prose ends with ${value}`,
      `[${value}],`,
      `${value}.`,
    ]) {
      assert.equal(containsDisallowedSensitiveMaterial(candidate), true, family);
    }
    assert.equal(
      containsDisallowedSensitiveMaterial(`x${value}`),
      value.startsWith('_'),
      `${family} left boundary`,
    );
    assert.equal(containsDisallowedSensitiveMaterial(fullwidthAscii(value)), true, `${family} NFKC`);
    assert.equal(
      containsDisallowedSensitiveMaterial(`${value.slice(0, 1)}\u200B${value.slice(1)}`),
      true,
      `${family} zero-width space`,
    );
    assert.equal(
      containsDisallowedSensitiveMaterial(`${value.slice(0, 1)}\u2060${value.slice(1)}`),
      true,
      `${family} word joiner`,
    );
  }

  for (const candidate of [
    `npm_${'A'.repeat(35)}`,
    `npm_${'A'.repeat(37)}`,
    `NPM_${'A'.repeat(36)}`,
    `npm_${'A'.repeat(18)}/${'A'.repeat(17)}`,
    `glpat-${'A'.repeat(19)}`,
    `glpat-${'A'.repeat(21)}`,
    `glpat-${'A'.repeat(10)}/${'A'.repeat(9)}`,
    `glpat-${'A'.repeat(20)}.${'a'.repeat(9)}`,
    `glpat-${'A'.repeat(26)}.${'a'.repeat(9)}`,
    `glpat-${'A'.repeat(13)}/${'A'.repeat(13)}.${'a'.repeat(9)}`,
    `glpat-${'A'.repeat(27)}.${'a'.repeat(8)}`,
    `glpat-${'A'.repeat(27)}.${'a'.repeat(10)}`,
    `glpat-${'A'.repeat(27)}.${'A'.repeat(9)}`,
    `glpat-${'A'.repeat(301)}.${'a'.repeat(9)}`,
    `AIza${'A'.repeat(34)}`,
    `AIza${'A'.repeat(36)}`,
    `AIza${'A'.repeat(17)}+${'A'.repeat(17)}`,
    `aiza${'A'.repeat(35)}`,
    `sk_test_${'A'.repeat(19)}`,
    `sk_live_${'A'.repeat(10)}-${'A'.repeat(9)}`,
    `rk_live_${'A'.repeat(248)}`,
    `pk_test_${'A'.repeat(24)}`,
    `sk_prod_${'A'.repeat(24)}`,
    `hf_${'A'.repeat(33)}`,
    `hf_${'A'.repeat(35)}`,
    `hf_${'A'.repeat(17)}_${'A'.repeat(16)}`,
    `HF_${'A'.repeat(34)}`,
  ]) {
    assert.equal(containsDisallowedSensitiveMaterial(candidate), false);
  }

  for (const candidate of [
    `glpat-${'A'.repeat(300)}.${'a'.repeat(9)}`,
    `sk_test_${'A'.repeat(20)}`,
    `rk_live_${'A'.repeat(247)}`,
  ]) {
    assert.equal(containsDisallowedSensitiveMaterial(candidate), true);
  }

  for (const prose of [
    'AWS STS issued temporary credentials',
    'rotate the AWS access key',
    'AWS STS issues temporary access key IDs with an ASIA prefix.',
    'The ASIA prefix by itself is not an access key ID.',
    'npm access tokens belong in a credential manager.',
    'The npm_ prefix alone is not a token.',
    'GitLab personal access tokens commonly begin with glpat-.',
    'Google documents API key strings beginning with AIza.',
    'Stripe server keys use sk_test_ or rk_live_ prefixes.',
    'Hugging Face examples abbreviate tokens as hf_....',
    'JWT compact notation is often described as header.payload.signature.',
  ]) {
    assert.equal(containsDisallowedSensitiveMaterial(prose), false);
  }

  const upperNpm = `NPM_${'A'.repeat(36)}`;
  assert.equal(containsDisallowedSensitiveMaterial(upperNpm), false);
  assert.throws(() => canonicalizeNamespace(`agents/${upperNpm}`), MemorySchemaValidationError);
});

test('raw JWT detection requires a bounded canonical three-part signed JSON structure', () => {
  const segment = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = segment({ alg: 'HS256' });
  const payload = segment({});
  const signature = Buffer.alloc(16, 0x5a).toString('base64url');
  const underscoreSignature = Buffer.alloc(16, 0xff).toString('base64url');
  const maximumSignature = Buffer.alloc(6_144, 0x5a).toString('base64url');
  const token = `${header}.${payload}.${signature}`;
  const underscoreToken = `${header}.${payload}.${underscoreSignature}`;

  assert.equal(token, SYNTHETIC_RAW_JWT);
  assert.equal(underscoreSignature, '_____________________w');
  assert.equal(maximumSignature.length, 8_192);
  for (const candidate of [
    token,
    `(${token})`,
    `${token},`,
    `${token}.`,
    `.${token}`,
    `_${token}`,
    `${token}_`,
    `_${token}_`,
  ]) {
    assert.equal(containsDisallowedSensitiveMaterial(candidate), true);
  }
  assert.equal(containsDisallowedSensitiveMaterial(`${header}.${payload}.${maximumSignature}`), true);
  assert.equal(
    containsDisallowedSensitiveMaterial(`${header}.${payload}.${'A'.repeat(8_193)}`),
    true,
  );
  for (const candidate of [
    underscoreToken,
    `_${underscoreToken}`,
    `${underscoreToken}_`,
    `_${underscoreToken}_`,
  ]) {
    assert.equal(containsDisallowedSensitiveMaterial(candidate), true);
  }
  const maximumVisibleContent = `${underscoreToken}${'x'.repeat(
    SCHEMA_LIMITS.visibleContentLength - underscoreToken.length
  )}`;
  assert.equal(maximumVisibleContent.length, SCHEMA_LIMITS.visibleContentLength);
  assert.equal(containsDisallowedSensitiveMaterial(maximumVisibleContent), true);
  assert.throws(
    () => parseEventInput(validEvent({ content: maximumVisibleContent })),
    MemorySchemaValidationError,
  );

  const invalidUtf8 = Buffer.from([0xff]).toString('base64url');
  const invalidJson = Buffer.from('not-json', 'utf8').toString('base64url');
  const negatives = [
    'alpha.beta.gamma',
    `${header}.${payload}`,
    `${header}..${signature}`,
    `${header}.${payload}.`,
    `${header}.${payload}.${signature}=`,
    `${header}.${payload}.${signature.slice(0, 5)} ${signature.slice(5)}`,
    `a.${token}`,
    `${token}.a`,
    `${segment({})}.${payload}.${signature}`,
    `${segment({ alg: '' })}.${payload}.${signature}`,
    `${segment({ alg: '   ' })}.${payload}.${signature}`,
    `${segment({ alg: 1 })}.${payload}.${signature}`,
    `${segment([{ alg: 'HS256' }])}.${payload}.${signature}`,
    `${header}.${segment([])}.${signature}`,
    `${header}.${invalidUtf8}.${signature}`,
    `${header}.${invalidJson}.${signature}`,
    `${header}.e31.${signature}`,
    `${header}.${payload}.${Buffer.alloc(15, 0x5a).toString('base64url')}`,
    `${'A'.repeat(1_025)}.${payload}.${signature}`,
    `${header}.${'A'.repeat(16_385)}.${signature}`,
  ];
  for (const candidate of negatives) {
    assert.equal(containsDisallowedSensitiveMaterial(candidate), false);
  }
});

test('over-limit values fail generically before sensitive normalization or scanning', () => {
  const token = SYNTHETIC_PROVIDER_FIXTURES.find(({ family }) => family === 'npm').value;
  const overLimitVisible = maximum => `${token} ${'x'.repeat(maximum - token.length)}`;
  const attempts = [
    () => parseEventInput(validEvent({ content: overLimitVisible(SCHEMA_LIMITS.visibleContentLength) })),
    () => parseEventInput(validEvent({ attributes: {
      visible_label: overLimitVisible(SCHEMA_LIMITS.attributeStringLength),
    } })),
    () => parseFeedbackInput({
      schema_version: 1,
      target: { type: 'event', id: 'event_01' },
      signal: 'correction',
      correction: overLimitVisible(SCHEMA_LIMITS.correctionLength),
      actor_id: 'actor_user',
      source: { stream: 'hermes:feedback', event_id: 'feedback_source_01' },
    }),
    () => parseOpaqueId(`${'x'.repeat(120)}:${token}`),
  ];
  for (const attempt of attempts) {
    let thrown;
    try { attempt(); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof MemorySchemaValidationError);
    assert.equal(thrown.issues.some(issue => issue.message.includes('Sensitive')), false);
    assert.doesNotMatch(JSON.stringify(thrown), new RegExp(escapeRegExp(token), 'i'));
  }

  const oversizedNamespace = `${'x'.repeat(216)}/${token}`;
  assert.equal(oversizedNamespace.length, SCHEMA_LIMITS.namespaceLength + 1);
  const originalNormalize = String.prototype.normalize;
  let oversizedNormalizationCalls = 0;
  String.prototype.normalize = function patchedNormalize(...args) {
    if (String(this) === oversizedNamespace) oversizedNormalizationCalls += 1;
    return originalNormalize.apply(this, args);
  };
  try {
    assert.throws(() => canonicalizeNamespace(oversizedNamespace), MemorySchemaValidationError);
  } finally {
    String.prototype.normalize = originalNormalize;
  }
  assert.equal(oversizedNormalizationCalls, 0);
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
