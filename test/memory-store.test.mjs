import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPortableMcpProfile,
  createTrustedBridgeProfile,
} from '../lib/memory/profile.mjs';
import { journalDirectory, opaqueJsonFilename } from '../lib/memory/filesystem.mjs';
import {
  MemoryDisabledError,
  MemoryIdempotencyConflictError,
  MemoryNotFoundError,
  createMemoryStore,
  createTrustedMemoryBridge,
} from '../lib/memory/store.mjs';
import {
  SYNTHETIC_SENSITIVE_FIXTURES,
  escapeRegExp,
} from '../test-support/memory-sensitive-fixtures.mjs';

function exampleProfile(overrides = {}) {
  return createPortableMcpProfile({
    profileId: 'profile:example-local',
    principal: { id: 'agent:example', type: 'agent', displayName: 'Example' },
    agentInstance: { id: 'agent_instance:example:desktop', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:safire-memory-mcp:example' },
    sourceIdentity: 'mcp:example-local',
    allowedActors: [
      { id: 'automation:indexer', type: 'automation', delegatedBy: 'agent:example' },
      { id: 'external_service:browser', type: 'external_service' },
    ],
    namespaceGrants: [
      { namespace: 'agents/example', read: true, write: true, descendants: true },
      { namespace: 'automation/indexer', read: true, write: true, descendants: true },
      { namespace: 'shared/demo', read: true, write: true, descendants: true },
    ],
    ...overrides,
  });
}

function syntheticProfile(overrides = {}) {
  return createPortableMcpProfile({
    profileId: 'profile:synthetic-local',
    principal: { id: 'agent:synthetic', type: 'agent' },
    agentInstance: { id: 'agent_instance:synthetic:test', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:safire-memory-mcp:synthetic' },
    sourceIdentity: 'mcp:synthetic-local',
    allowedActors: [],
    namespaceGrants: [
      { namespace: 'agents/synthetic', read: true, write: true, descendants: true },
    ],
    ...overrides,
  });
}

function trustedProfile() {
  return createTrustedBridgeProfile({
    profileId: 'profile:example-bridge',
    principal: { id: 'agent:example', type: 'agent' },
    agentInstance: { id: 'agent_instance:example:bridge', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:trusted-bridge:example' },
    sourceIdentity: 'bridge:example-local',
    acceptUserEvents: true,
    allowedActors: [{ id: 'user:owner', type: 'user', displayName: 'Vault owner' }],
    namespaceGrants: [
      { namespace: 'agents/example', read: true, write: true, descendants: true },
      { namespace: 'shared/demo', read: true, write: true, descendants: true },
    ],
  });
}

function event(overrides = {}) {
  return {
    schema_version: 1,
    namespace: 'agents/example',
    actor_type: 'agent',
    actor_id: 'agent:example',
    agent_instance_id: 'agent_instance:example:desktop',
    kind: 'visible_agent_response',
    speech_act: 'proposal',
    content: 'Use the crimson launch checklist.',
    occurred_at: '2026-08-14T17:00:00.000Z',
    context: { conversation_id: 'conversation.alpha', turn_id: 'turn.1' },
    source: { stream: 'conversation.alpha', event_id: 'turn.1' },
    ...overrides,
  };
}

function trustedEventEnvelope(overrides = {}) {
  const {
    actor_type: _actorType,
    actor_id: _actorId,
    delegated_by: _delegatedBy,
    agent_instance_id: _agentInstanceId,
    ...envelope
  } = event(overrides);
  return envelope;
}

async function temporaryVault(t, prefix = 'safire-memory-store-') {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return vault;
}

async function readTreeText(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await readTreeText(entryPath));
    else chunks.push(await fs.readFile(entryPath, 'utf8'));
  }
  return chunks.join('\n');
}

async function snapshotTree(directory, relative = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const snapshot = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relative, entry.name);
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot.push({ path: relativePath, type: 'directory' });
      snapshot.push(...await snapshotTree(entryPath, relativePath));
    } else {
      snapshot.push({
        path: relativePath,
        type: 'file',
        bytes: (await fs.readFile(entryPath)).toString('base64'),
      });
    }
  }
  return snapshot;
}

test('initializes a stable sidecar and records fully attributed event-backed memory', async (t) => {
  const vault = await temporaryVault(t);
  const notePath = path.join(vault, 'Existing.md');
  await fs.writeFile(notePath, '# Existing\n', 'utf8');
  const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });

  const recorded = await store.recordEvents([event()]);
  assert.equal(recorded.created_count, 1);
  const { event: storedEvent, memory } = recorded.results[0];
  assert.match(storedEvent.event_id, /^evt_/);
  assert.match(memory.memory_id, /^mem_/);
  assert.equal(memory.event_id, storedEvent.event_id);
  assert.deepEqual(memory.source_event_ids, [storedEvent.event_id]);
  assert.equal(storedEvent.actor.id, 'agent:example');
  assert.equal(storedEvent.ingested_by.id, 'adapter:safire-memory-mcp:example');
  assert.equal(storedEvent.agent_instance.id, 'agent_instance:example:desktop');
  assert.equal(storedEvent.delegated_by, null);
  assert.deepEqual(storedEvent.source, {
    identity: 'mcp:example-local', stream: 'conversation.alpha', event_id: 'turn.1',
  });

  const status = await store.status();
  assert.equal(status.enabled, true);
  assert.match(status.vault_id, /^vlt_/);
  assert.deepEqual(status.counts, { actors: 4, events: 1, memories: 1, feedback: 0 });
  assert.equal(status.pending_transactions, 0);
  assert.equal(await fs.readFile(notePath, 'utf8'), '# Existing\n');
  const manifest = JSON.parse(await fs.readFile(path.join(vault, '.safire', 'memory', 'v1', 'manifest.json'), 'utf8'));
  assert.equal(manifest.vault_id, status.vault_id);
});

test('source-tuple idempotency returns the original event without content deduplication', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const first = await store.recordEvents([event()]);
  const duplicate = await store.recordEvents([event()]);
  assert.equal(duplicate.duplicate_count, 1);
  assert.equal(duplicate.results[0].event.event_id, first.results[0].event.event_id);
  await assert.rejects(
    () => store.recordEvents([event({ content: 'A changed payload with the same source ID.' })]),
    MemoryIdempotencyConflictError,
  );

  const repeatedText = await store.recordEvents([event({
    source: { stream: 'conversation.alpha', event_id: 'turn.2' },
    context: { conversation_id: 'conversation.alpha', turn_id: 'turn.2' },
  })]);
  assert.notEqual(repeatedText.results[0].event.event_id, first.results[0].event.event_id);
  assert.equal((await store.status()).counts.events, 2);
});

test('Indexer remains an automation delegated by Example and never becomes user interest', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const result = await store.recordEvents([event({
    namespace: 'automation/indexer/daily',
    actor_type: 'automation',
    actor_id: 'automation:indexer',
    delegated_by: 'agent:example',
    kind: 'automation_decision',
    speech_act: 'conclusion',
    content: 'The scheduled public check completed with no visible changes.',
    context: { automation_run_id: 'indexer.run.1' },
    source: { stream: 'indexer.daily', event_id: 'run.1' },
  })]);
  const stored = result.results[0].event;
  assert.equal(stored.actor.type, 'automation');
  assert.equal(stored.delegated_by.id, 'agent:example');
  assert.equal(stored.agent_instance.id, 'agent_instance:example:desktop');

  const search = await store.search({ query: 'scheduled public check' });
  assert.equal(search.results[0].actor.type, 'automation');
  assert.equal(search.results[0].activity.user, 0);
  assert.equal(search.results[0].activity.automation, 1);
});

test('namespace ACLs isolate a synthetic second agent and make sharing explicit', async (t) => {
  const vault = await temporaryVault(t);
  const example = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const privateRecord = await example.recordEvents([event()]);
  await example.recordEvents([event({
    namespace: 'shared/demo',
    content: 'An explicitly shared invented fact.',
    source: { stream: 'shared.demo', event_id: 'shared.1' },
  })]);

  const synthetic = createMemoryStore({ vaultDir: vault, profile: syntheticProfile() });
  await synthetic.recordEvents([event({
    namespace: 'agents/synthetic',
    actor_type: 'agent',
    actor_id: 'agent:synthetic',
    agent_instance_id: 'agent_instance:synthetic:test',
    content: 'Synthetic agent private memory.',
    source: { stream: 'synthetic.test', event_id: 'turn.1' },
  })]);
  assert.equal((await synthetic.search({ query: '' })).count, 1);
  await assert.rejects(() => synthetic.get(privateRecord.results[0].event.event_id), MemoryNotFoundError);
  await assert.rejects(() => synthetic.search({ namespaces: ['agents/example'] }), /not granted/i);
  await assert.rejects(
    () => synthetic.recordEvents([event({ namespace: 'agents/synthetic' })]),
    /actor is not allowlisted/i,
  );

  const sharingProfile = syntheticProfile({
    profileId: 'profile:synthetic-shared',
    ingestedBy: { id: 'adapter:safire-memory-mcp:synthetic-shared' },
    sourceIdentity: 'mcp:synthetic-shared',
    namespaceGrants: [
      { namespace: 'agents/synthetic', read: true, write: true, descendants: true },
      { namespace: 'shared/demo', read: true, write: false, descendants: true },
    ],
  });
  const shared = createMemoryStore({ vaultDir: vault, profile: sharingProfile });
  const results = await shared.search({ query: 'explicitly shared' });
  assert.equal(results.count, 1);
  assert.equal(results.results[0].namespace, 'shared/demo');
  assert.deepEqual((await shared.status()).counts, {
    actors: 2,
    events: 2,
    memories: 2,
    feedback: 0,
  });
});

test('ACL projections and replays disclose no hidden provenance, dependent feedback, digest, or shape oracle', async (t) => {
  const vault = await temporaryVault(t);
  const broad = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const privateTarget = await broad.recordEvents([event()]);
  const privateEventId = privateTarget.results[0].event.event_id;
  const privateMemoryId = privateTarget.results[0].memory.memory_id;
  const sharedInput = event({
    namespace: 'shared/demo',
    content: 'A shared event that cites a private event.',
    relations: [{ type: 'supports', target_event_id: privateEventId }],
    derived: {
      claim: 'The shared event was derived from a separately scoped source.',
      source_event_ids: [privateEventId],
    },
    source: { stream: 'shared.demo', event_id: 'acl-replay.1' },
  });
  const sharedRecord = await broad.recordEvents([sharedInput]);
  const sharedEventId = sharedRecord.results[0].event.event_id;
  const controlRecord = await broad.recordEvents([event({
    namespace: 'shared/demo',
    content: 'A plain visible control record with no cross-namespace dependency.',
    source: { stream: 'shared.demo', event_id: 'acl-replay.control' },
  })]);
  const controlEventId = controlRecord.results[0].event.event_id;
  const privateFeedback = {
    schema_version: 1,
    target: { type: 'event', id: privateEventId },
    signal: 'useful',
    actor_id: 'agent:example',
    source: { stream: 'feedback.example', event_id: 'acl-replay.1' },
  };
  await broad.recordFeedback([privateFeedback]);
  const relatedFeedback = await broad.recordFeedback([{
    schema_version: 1,
    target: { type: 'event', id: sharedEventId },
    signal: 'superseded',
    related_target: { type: 'memory', id: privateMemoryId },
    actor_id: 'agent:example',
    source: { stream: 'feedback.example', event_id: 'acl-replay.shared-related' },
  }]);
  const hiddenDigests = [
    sharedRecord.results[0].event.integrity.digest,
    sharedRecord.results[0].memory.integrity.digest,
    relatedFeedback.results[0].feedback.integrity.digest,
  ];

  const narrow = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile({
      namespaceGrants: [
        { namespace: 'shared/demo', read: true, write: true, descendants: true },
      ],
    }),
  });
  await assert.rejects(() => narrow.recordEvents([sharedInput]), MemoryNotFoundError);
  await assert.rejects(() => narrow.recordFeedback([privateFeedback]), MemoryNotFoundError);
  const visibleSearch = await narrow.search({ query: 'shared event' });
  assert.equal(visibleSearch.count, 1);
  assert.deepEqual(visibleSearch.results[0].relations, []);
  assert.equal(visibleSearch.results[0].derived, null);
  assert.equal('integrity' in visibleSearch.results[0], false);
  assert.equal(visibleSearch.results[0].activity.agent, 1);
  assert.equal(visibleSearch.results[0].signals_by_actor.agent.superseded, 0);
  assert.doesNotMatch(JSON.stringify(visibleSearch), new RegExp(privateEventId));
  assert.doesNotMatch(JSON.stringify(visibleSearch), new RegExp(privateMemoryId));
  const visibleExact = await narrow.get(sharedEventId, {
    includeFeedback: true,
    includeRelations: true,
  });
  assert.deepEqual(visibleExact.event.relations, []);
  assert.equal(visibleExact.event.derived, null);
  assert.equal('integrity' in visibleExact.event, false);
  assert.equal('source_event_ids' in visibleExact.memory, false);
  assert.equal('integrity' in visibleExact.memory, false);
  assert.deepEqual(visibleExact.feedback, []);
  assert.equal(visibleExact.activity.agent, 1);
  assert.equal(visibleExact.signals_by_actor.agent.superseded, 0);
  assert.doesNotMatch(JSON.stringify(visibleExact), new RegExp(privateEventId));
  assert.doesNotMatch(JSON.stringify(visibleExact), new RegExp(privateMemoryId));
  const visibleControl = await narrow.get(controlEventId, {
    includeFeedback: true,
    includeRelations: true,
  });
  assert.equal(visibleControl.event.derived, null);
  assert.deepEqual(visibleControl.event.relations, []);
  assert.equal('integrity' in visibleControl.event, false);
  assert.equal('source_event_ids' in visibleControl.memory, false);
  assert.equal('integrity' in visibleControl.memory, false);
  assert.deepEqual(Object.keys(visibleExact.event).sort(), Object.keys(visibleControl.event).sort());
  assert.deepEqual(Object.keys(visibleExact.memory).sort(), Object.keys(visibleControl.memory).sort());
  const narrowStatus = await narrow.status();
  assert.equal(narrowStatus.counts.feedback, 0);
  for (const digest of hiddenDigests) {
    assert.doesNotMatch(JSON.stringify(visibleSearch), new RegExp(digest));
    assert.doesNotMatch(JSON.stringify(visibleExact), new RegExp(digest));
  }
});

test('credential-like identifiers and echoed queries fail before persistence without value disclosure', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-sensitive-identifiers-');
  const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const credentials = [
    { family: 'github_fine_grained', value: `github_pat_${'A'.repeat(82)}` },
    ...SYNTHETIC_SENSITIVE_FIXTURES,
  ];
  const seed = await store.recordEvents([event()]);
  const beforeRejectedCalls = await snapshotTree(vault);

  for (const { family, value } of credentials) {
    const pattern = new RegExp(escapeRegExp(value), 'i');
    for (const [surface, invalidEvent] of [
      ['content', event({
        content: value,
        source: { stream: 'conversation.alpha', event_id: `sensitive-${family}-content` },
      })],
      ['attribute', event({
        attributes: { visible_label: value },
        source: { stream: 'conversation.alpha', event_id: `sensitive-${family}-attribute` },
      })],
      ['stream', event({
        source: { stream: value, event_id: `sensitive-${family}-stream` },
      })],
      ['context', event({
        context: { conversation_id: 'conversation.alpha', session_id: value },
        source: { stream: 'conversation.alpha', event_id: `sensitive-${family}-context` },
      })],
    ]) {
      await assert.rejects(
        () => store.recordEvents([invalidEvent]),
        error => error.code === 'MEMORY_SCHEMA_VALIDATION_FAILED'
          && !pattern.test(error.message)
          && !pattern.test(JSON.stringify(error)),
        `${family} ${surface}`,
      );
    }
  }

  for (const { family, value } of credentials) {
    const pattern = new RegExp(escapeRegExp(value), 'i');
    await assert.rejects(
      () => store.recordFeedback([{
        schema_version: 1,
        target: { type: 'event', id: seed.results[0].event.event_id },
        signal: 'correction',
        correction: value,
        actor_id: 'agent:example',
        source: { stream: 'feedback.example', event_id: `feedback-${family}-correction` },
      }]),
      error => error.code === 'MEMORY_SCHEMA_VALIDATION_FAILED'
        && !pattern.test(error.message)
        && !pattern.test(JSON.stringify(error)),
      `${family} feedback correction`,
    );
    await assert.rejects(
      () => store.recordFeedback([{
        schema_version: 1,
        target: { type: 'event', id: seed.results[0].event.event_id },
        signal: 'useful',
        actor_id: 'agent:example',
        source: { stream: 'feedback.example', event_id: value },
      }]),
      error => error.code === 'MEMORY_SCHEMA_VALIDATION_FAILED'
        && !pattern.test(error.message)
        && !pattern.test(JSON.stringify(error)),
      `${family} feedback source`,
    );
    await assert.rejects(
      () => store.search({ query: value }),
      error => error.code === 'MEMORY_QUERY_INVALID'
        && !pattern.test(error.message)
        && !pattern.test(JSON.stringify(error)),
      `${family} direct search`,
    );
  }

  const status = await store.status();
  assert.equal(status.counts.events, 1);
  assert.equal(status.counts.feedback, 0);
  const persistedText = await readTreeText(vault);
  for (const { family, value } of credentials) {
    assert.doesNotMatch(persistedText, new RegExp(escapeRegExp(value), 'i'), family);
  }
  assert.deepEqual(await snapshotTree(vault), beforeRejectedCalls);
});

test('stable actor IDs reject conflicting automation delegation across profiles', async (t) => {
  const vault = await temporaryVault(t);
  const example = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  await example.status();
  const conflicting = syntheticProfile({
    allowedActors: [
      { id: 'automation:indexer', type: 'automation', delegatedBy: 'agent:synthetic' },
    ],
  });
  const synthetic = createMemoryStore({ vaultDir: vault, profile: conflicting });
  await assert.rejects(() => synthetic.status(), /stable actor ID/i);
});

test('trusted user messages remain requests and Example proposals never become user preferences', async (t) => {
  const vault = await temporaryVault(t);
  const portable = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  await assert.rejects(() => portable.recordEvents([event({
    actor_type: 'user',
    actor_id: 'user:owner',
    kind: 'visible_user_message',
    speech_act: 'request',
    content: 'Please use the crimson checklist.',
    source: { stream: 'conversation.alpha', event_id: 'user.1' },
  })]), /not allowlisted/i);

  const untrustedBridgeStore = createMemoryStore({ vaultDir: vault, profile: trustedProfile() });
  await assert.rejects(() => untrustedBridgeStore.recordEvents([event({
    actor_type: 'user',
    actor_id: 'user:owner',
    agent_instance_id: 'agent_instance:example:bridge',
    kind: 'visible_user_message',
    speech_act: 'request',
    content: 'Please use the crimson checklist.',
    source: { stream: 'conversation.alpha', event_id: 'user.unauthenticated' },
  })]), /authenticated bridge ingestion/i);

  const { bridge } = createTrustedMemoryBridge({
    vaultDir: vault,
    profile: trustedProfile(),
    authenticate: async (_metadata, context) => (context?.role === 'user'
      ? { authenticated: true, role: 'user', actor_id: 'user:owner' }
      : { authenticated: true, role: 'agent', actor_id: 'agent:example' }),
  });
  const user = (await bridge.ingest(trustedEventEnvelope({
    kind: 'visible_user_message',
    speech_act: 'request',
    content: 'Please use the crimson checklist.',
    source: { stream: 'conversation.alpha', event_id: 'user.1' },
  }), { role: 'user' })).record_result;
  const example = (await bridge.ingest(trustedEventEnvelope({
    speech_act: 'proposal',
    content: 'I propose using the crimson checklist.',
    source: { stream: 'conversation.alpha', event_id: 'agent.1' },
  }), { role: 'agent' })).record_result;
  assert.equal(user.results[0].event.actor.type, 'user');
  assert.equal(user.results[0].event.speech_act, 'request');
  assert.equal(example.results[0].event.actor.type, 'agent');
  assert.equal(example.results[0].event.speech_act, 'proposal');
  assert.notEqual(example.results[0].event.speech_act, 'preference');
  await assert.rejects(() => bridge.ingest(trustedEventEnvelope({
    kind: 'explicit_conclusion',
    speech_act: 'conclusion',
    content: 'A user must not be attributed as an agent conclusion.',
    source: { stream: 'conversation.alpha', event_id: 'user.invalid-kind' },
  }), { role: 'user' }), /cannot record this event kind/i);
});

test('actor-specific feedback is append-only and search always returns attribution', async (t) => {
  const vault = await temporaryVault(t);
  const example = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const recorded = await example.recordEvents([event()]);
  const eventId = recorded.results[0].event.event_id;
  const memoryId = recorded.results[0].memory.memory_id;
  await example.recordFeedback([{
    schema_version: 1,
    target: { type: 'memory', id: memoryId },
    signal: 'useful',
    actor_id: 'agent:example',
    source: { stream: 'feedback.example', event_id: 'feedback.1' },
  }]);

  const untrustedBridgeStore = createMemoryStore({ vaultDir: vault, profile: trustedProfile() });
  await assert.rejects(() => untrustedBridgeStore.recordFeedback([{
    schema_version: 1,
    target: { type: 'event', id: eventId },
    signal: 'user_confirmed',
    actor_id: 'user:owner',
    source: { stream: 'feedback.user', event_id: 'feedback.unauthenticated' },
  }]), /authenticated bridge ingestion/i);

  await assert.rejects(() => example.recordFeedback([{
    schema_version: 1,
    target: { type: 'event', id: eventId },
    signal: 'user_confirmed',
    actor_id: 'agent:example',
    source: { stream: 'feedback.example', event_id: 'feedback.invalid-user-signal' },
  }]), /trusted user actor/i);

  const { bridge } = createTrustedMemoryBridge({
    vaultDir: vault,
    profile: trustedProfile(),
    authenticate: async () => ({
      authenticated: true,
      role: 'user',
      actor_id: 'user:owner',
    }),
  });
  await bridge.ingestFeedback({
    schema_version: 1,
    target: { type: 'event', id: eventId },
    signal: 'user_confirmed',
    source: { stream: 'feedback.user', event_id: 'feedback.1' },
  });
  const correction = (await bridge.ingestFeedback({
    schema_version: 1,
    target: { type: 'event', id: eventId },
    signal: 'correction',
    correction: 'Use the amber checklist instead.',
    source: { stream: 'feedback.user', event_id: 'feedback.2' },
  })).record_result;
  assert.equal(correction.created_count, 1);

  const exact = await example.get(memoryId, { includeFeedback: true });
  assert.equal(exact.event.event_id, eventId);
  assert.equal(exact.feedback.length, 3);
  assert.equal(exact.activity.user, 2);
  assert.equal(exact.activity.agent, 2);
  assert.equal(exact.signals_by_actor.user.user_confirmed, 1);
  assert.equal(exact.signals_by_actor.user.correction, 1);
  const search = await example.search({ query: 'crimson checklist' });
  assert.equal(search.results[0].actor.id, 'agent:example');
  assert.equal(search.results[0].source.identity, 'mcp:example-local');
  assert.equal(search.results[0].ingested_by.profile_id, 'profile:example-local');
  assert.equal(search.results[0].activity.user, 2);
  assert.equal((await example.status()).counts.events, 1);
});

test('derived memory retains every supporting event and corrections preserve originals', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const first = await store.recordEvents([event()]);
  const second = await store.recordEvents([event({
    content: 'The launch date is August 15.',
    speech_act: 'assertion',
    source: { stream: 'conversation.alpha', event_id: 'turn.2' },
  })]);
  const sourceIds = [first.results[0].event.event_id, second.results[0].event.event_id];
  const conclusion = await store.recordEvents([event({
    kind: 'explicit_conclusion',
    speech_act: 'conclusion',
    content: 'The visible sources support the launch plan.',
    relations: sourceIds.map((target_event_id) => ({ type: 'supports', target_event_id })),
    derived: { claim: 'The launch plan has two visible supporting events.', source_event_ids: sourceIds },
    source: { stream: 'conversation.alpha', event_id: 'turn.3' },
  })]);
  const recalled = await store.get(conclusion.results[0].memory.memory_id, {
    includeRelations: true,
  });
  assert.deepEqual(recalled.event.derived.source_event_ids, sourceIds);
  assert.equal('source_event_ids' in recalled.memory, false);
  assert.equal('integrity' in recalled.memory, false);
  assert.equal((await store.status()).counts.events, 3);
  assert.equal((await store.get(first.results[0].event.event_id)).event.content, 'Use the crimson launch checklist.');
});

test('corrections, approvals, rejections, contradictions, and supersession retain source provenance', async (t) => {
  const vault = await temporaryVault(t);
  const example = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const original = await example.recordEvents([event({
    content: 'The invented rollout date is Friday.',
    speech_act: 'assertion',
    source: { stream: 'conversation.provenance', event_id: 'original.1' },
  })]);
  const originalId = original.results[0].event.event_id;
  const { store: bridgeStore, bridge } = createTrustedMemoryBridge({
    vaultDir: vault,
    profile: trustedProfile(),
    authenticate: async () => ({
      authenticated: true,
      role: 'user',
      actor_id: 'user:owner',
    }),
  });
  const userRecords = [];
  for (const [speechAct, relationType, sourceId, content] of [
    ['correction', 'corrects', 'user.correction', 'The invented rollout date is Thursday, not Friday.'],
    ['approval', 'approves', 'user.approval', 'I approve the corrected Thursday date.'],
    ['rejection', 'rejects', 'user.rejection', 'I reject the original Friday date.'],
  ]) {
    userRecords.push((await bridge.ingest(trustedEventEnvelope({
      kind: 'visible_user_message',
      speech_act: speechAct,
      content,
      relations: [{ type: relationType, target_event_id: originalId }],
      source: { stream: 'conversation.provenance', event_id: sourceId },
    }))).record_result.results[0].event);
  }
  const contradiction = (await example.recordEvents([event({
    content: 'The visible correction contradicts the original Friday date.',
    speech_act: 'assertion',
    relations: [{ type: 'contradicts', target_event_id: originalId }],
    source: { stream: 'conversation.provenance', event_id: 'agent.contradiction' },
  })])).results[0].event;
  await bridge.ingestFeedback({
    schema_version: 1,
    target: { type: 'event', id: originalId },
    signal: 'superseded',
    related_target: { type: 'event', id: userRecords[0].event_id },
    source: { stream: 'feedback.provenance', event_id: 'user.superseded' },
  });

  assert.deepEqual(userRecords.map((record) => record.actor.type), ['user', 'user', 'user']);
  assert.deepEqual(
    userRecords.map((record) => record.relations[0].type),
    ['corrects', 'approves', 'rejects'],
  );
  assert.equal(contradiction.relations[0].type, 'contradicts');
  assert.equal(contradiction.actor.type, 'agent');
  const recalled = await bridgeStore.get(originalId, {
    includeFeedback: true,
    includeRelations: true,
  });
  assert.equal(recalled.event.content, 'The invented rollout date is Friday.');
  assert.equal(recalled.event.source.event_id, 'original.1');
  assert.deepEqual(
    recalled.incoming_relations.map((relation) => relation.type).sort(),
    ['approves', 'contradicts', 'corrects', 'rejects'],
  );
  assert.ok(recalled.incoming_relations.every((relation) => relation.source_event_id.startsWith('evt_')));
  assert.equal(recalled.feedback[0].signal, 'superseded');
  assert.equal(recalled.feedback[0].actor.type, 'user');
  assert.equal(recalled.feedback[0].related_target.id, userRecords[0].event_id);
});

test('journal recovery completes every event-ingestion stage after an injected operation failure', async (t) => {
  for (const failureStage of [
    'after_journal_create',
    'after_event_create',
    'after_memory_create',
    'after_idempotency_create',
  ]) {
    await t.test(failureStage, async (t) => {
      const vault = await temporaryVault(t, `safire-memory-${failureStage}-`);
      let failed = false;
      const crashing = createMemoryStore({
        vaultDir: vault,
        profile: exampleProfile(),
        faultInjector(stage) {
          if (!failed && stage === failureStage) {
            failed = true;
            throw new Error('invented crash');
          }
        },
      });
      await assert.rejects(() => crashing.recordEvents([event()]), /invented crash/);

      if (failureStage === 'after_idempotency_create') {
        const sameStoreReplay = await crashing.recordEvents([event()]);
        assert.equal(sameStoreReplay.duplicate_count, 1);
        assert.equal((await crashing.status()).pending_transactions, 0);
      }

      const recovered = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
      const status = await recovered.status();
      assert.equal(status.counts.events, 1);
      assert.equal(status.counts.memories, 1);
      assert.equal(status.pending_transactions, 0);
      const replay = await recovered.recordEvents([event()]);
      assert.equal(replay.duplicate_count, 1);
      assert.equal((await recovered.status()).counts.events, 1);
    });
  }
});

test('journal recovery completes feedback append after injected operation failures', async (t) => {
  for (const failureStage of ['after_journal_create', 'after_feedback_create', 'after_idempotency_create']) {
    await t.test(failureStage, async (t) => {
      const vault = await temporaryVault(t, `safire-feedback-${failureStage}-`);
      const base = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
      const target = await base.recordEvents([event()]);
      const input = {
        schema_version: 1,
        target: { type: 'memory', id: target.results[0].memory.memory_id },
        signal: 'useful',
        actor_id: 'agent:example',
        source: { stream: 'feedback.example', event_id: 'feedback.crash.1' },
      };
      let failed = false;
      const crashing = createMemoryStore({
        vaultDir: vault,
        profile: exampleProfile(),
        faultInjector(stage) {
          if (!failed && stage === failureStage) {
            failed = true;
            throw new Error('invented feedback crash');
          }
        },
      });
      await assert.rejects(() => crashing.recordFeedback([input]), /invented feedback crash/);

      if (failureStage === 'after_idempotency_create') {
        const sameStoreReplay = await crashing.recordFeedback([input]);
        assert.equal(sameStoreReplay.duplicate_count, 1);
        assert.equal((await crashing.status()).pending_transactions, 0);
      }

      const recovered = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
      assert.equal((await recovered.status()).counts.feedback, 1);
      assert.equal((await recovered.status()).pending_transactions, 0);
      assert.equal((await recovered.recordFeedback([input])).duplicate_count, 1);
    });
  }
});

test('exact reads fail closed when valid memory files are swapped', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const first = await store.recordEvents([event()]);
  const second = await store.recordEvents([event({
    content: 'A second valid event-backed memory.',
    source: { stream: 'conversation.alpha', event_id: 'turn.2' },
  })]);
  const memoryDirectory = path.join(vault, '.safire', 'memory', 'v1', 'records', 'memories');
  const firstPath = path.join(memoryDirectory, opaqueJsonFilename(first.results[0].memory.memory_id));
  const secondPath = path.join(memoryDirectory, opaqueJsonFilename(second.results[0].memory.memory_id));
  const [firstBytes, secondBytes] = await Promise.all([fs.readFile(firstPath), fs.readFile(secondPath)]);
  await Promise.all([fs.writeFile(firstPath, secondBytes), fs.writeFile(secondPath, firstBytes)]);

  await assert.rejects(() => store.get(first.results[0].event.event_id), /identity does not match/i);
  await assert.rejects(() => store.search({ query: '' }), /identity does not match/i);
});

test('collection scans reject event and feedback records copied under another opaque key', async (t) => {
  await t.test('event storage key', async (t) => {
    const vault = await temporaryVault(t, 'safire-memory-event-key-');
    const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
    const recorded = await store.recordEvents([event()]);
    const directory = path.join(vault, '.safire', 'memory', 'v1', 'records', 'events');
    const original = path.join(directory, opaqueJsonFilename(recorded.results[0].event.event_id));
    await fs.copyFile(original, path.join(directory, `${'0'.repeat(64)}.json`));
    await assert.rejects(() => store.search({ query: '' }), /storage key/i);
  });

  await t.test('feedback storage key', async (t) => {
    const vault = await temporaryVault(t, 'safire-memory-feedback-key-');
    const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
    const recorded = await store.recordEvents([event()]);
    const feedback = await store.recordFeedback([{
      schema_version: 1,
      target: { type: 'event', id: recorded.results[0].event.event_id },
      signal: 'useful',
      actor_id: 'agent:example',
      source: { stream: 'feedback.example', event_id: 'copied-key.1' },
    }]);
    const directory = path.join(vault, '.safire', 'memory', 'v1', 'records', 'feedback');
    const original = path.join(directory, opaqueJsonFilename(feedback.results[0].feedback.feedback_id));
    await fs.copyFile(original, path.join(directory, `${'f'.repeat(64)}.json`));
    await assert.rejects(() => store.search({ query: '' }), /storage key/i);
  });
});

test('journal recovery rejects an entry renamed away from its transaction identity', async (t) => {
  const vault = await temporaryVault(t);
  let failed = false;
  const crashing = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile(),
    faultInjector(stage) {
      if (!failed && stage === 'after_journal_create') {
        failed = true;
        throw new Error('invented crash before publication');
      }
    },
  });
  await assert.rejects(() => crashing.recordEvents([event()]), /invented crash/);
  const directory = journalDirectory(crashing.layout, 'ingestion');
  const [entry] = await fs.readdir(directory);
  const renamed = `${'0'.repeat(64)}.json`;
  assert.notEqual(entry, renamed);
  await fs.rename(path.join(directory, entry), path.join(directory, renamed));

  const recovering = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  await assert.rejects(() => recovering.status(), /journal entry identity/i);
});

test('concurrent duplicate delivery across store instances creates one event', async (t) => {
  const vault = await temporaryVault(t);
  const left = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const right = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const results = await Promise.all([left.recordEvents([event()]), right.recordEvents([event()])]);
  assert.equal(results.reduce((sum, result) => sum + result.created_count, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.duplicate_count, 0), 1);
  assert.equal(results[0].results[0].event.event_id, results[1].results[0].event.event_id);
  assert.equal((await left.status()).counts.events, 1);
});

test('reads hold one vault snapshot while identity regeneration waits for the lock', async (t) => {
  const vault = await temporaryVault(t);
  let announceRead;
  const readEntered = new Promise((resolve) => { announceRead = resolve; });
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  t.after(() => releaseRead());
  let gateNextEventRead = false;
  const reader = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile(),
    async faultInjector(stage, metadata) {
      if (!gateNextEventRead
          || stage !== 'before_collection_record_read'
          || metadata.collection !== 'events') return;
      gateNextEventRead = false;
      announceRead();
      await readGate;
    },
  });
  const writer = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  await reader.recordEvents([event()]);
  await writer.status();

  gateNextEventRead = true;
  const searchPromise = reader.search({ query: '' });
  await readEntered;
  let regenerationSettled = false;
  const regenerationPromise = writer.regenerateVaultIdentity({ confirmIndependentClone: true })
    .then((manifest) => {
      regenerationSettled = true;
      return manifest;
    });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(regenerationSettled, false);

  releaseRead();
  assert.equal((await searchPromise).count, 1);
  const regenerated = await regenerationPromise;
  assert.equal(regenerated.revision, 2);
  await writer.recordEvents([event({
    content: 'An event written under the regenerated identity.',
    source: { stream: 'conversation.alpha', event_id: 'turn.after-regeneration' },
  })]);
  assert.equal((await reader.search({ query: '' })).count, 2);
});

test('vault copy preserves identity by default and explicit clone regeneration retains history', async (t) => {
  const root = await temporaryVault(t, 'safire-memory-copy-root-');
  const originalPath = path.join(root, 'Original');
  const copyPath = path.join(root, 'Copy');
  await fs.mkdir(originalPath);
  const original = createMemoryStore({ vaultDir: originalPath, profile: exampleProfile() });
  const recorded = await original.recordEvents([event()]);
  const originalStatus = await original.status();
  await fs.cp(originalPath, copyPath, { recursive: true });

  const copied = createMemoryStore({ vaultDir: copyPath, profile: exampleProfile() });
  assert.equal((await copied.status()).vault_id, originalStatus.vault_id);
  await assert.rejects(() => copied.regenerateVaultIdentity(), /literal confirmation/i);
  await assert.rejects(
    () => copied.regenerateVaultIdentity({ confirmIndependentClone: false }),
    /literal confirmation/i,
  );
  await assert.rejects(
    () => copied.regenerateVaultIdentity({ confirmIndependentClone: 'false' }),
    /literal confirmation/i,
  );
  assert.equal((await copied.status()).vault_id, originalStatus.vault_id);
  const regenerated = await copied.regenerateVaultIdentity({ confirmIndependentClone: true });
  assert.notEqual(regenerated.vault_id, originalStatus.vault_id);
  assert.ok(regenerated.lineage.includes(originalStatus.vault_id));
  assert.equal((await copied.initialize()).manifest.vault_id, regenerated.vault_id);
  assert.equal((await copied.initialize()).manifest.revision, 2);
  assert.equal((await copied.get(recorded.results[0].event.event_id)).event.vault_id, originalStatus.vault_id);
});

test('a missing manifest in a populated sidecar fails closed without replacing vault identity', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  const recorded = await store.recordEvents([event()]);
  const manifestPath = path.join(vault, '.safire', 'memory', 'v1', 'manifest.json');
  const originalVaultId = (await store.status()).vault_id;
  await fs.unlink(manifestPath);

  const reopened = createMemoryStore({ vaultDir: vault, profile: exampleProfile() });
  await assert.rejects(() => reopened.status(), /manifest is missing from a nonempty sidecar/i);
  assert.equal(await fs.stat(manifestPath).then(() => true, () => false), false);
  assert.equal(
    await fs.stat(path.join(
      vault,
      '.safire',
      'memory',
      'v1',
      'records',
      'events',
      opaqueJsonFilename(recorded.results[0].event.event_id),
    )).then(() => true, () => false),
    true,
  );
  assert.match(originalVaultId, /^vlt_/);
});

test('relative and filesystem-root vault paths are rejected before filesystem mutation', async () => {
  const relative = `safire-memory-relative-${process.pid}-${Date.now()}`;
  assert.throws(
    () => createMemoryStore({ vaultDir: relative, profile: exampleProfile() }),
    /absolute non-root path/i,
  );
  assert.equal(await fs.stat(path.resolve(relative)).then(() => true, () => false), false);
  assert.throws(
    () => createMemoryStore({ vaultDir: path.parse(path.resolve(relative)).root, profile: exampleProfile() }),
    /absolute non-root path/i,
  );
});

test('disabled memory creates no sidecar and leaves ordinary Safire operation untouched', async (t) => {
  const vault = await temporaryVault(t);
  const disabled = createMemoryStore({ vaultDir: vault, enabled: false });
  assert.equal((await disabled.status()).enabled, false);
  assert.equal(await fs.stat(path.join(vault, '.safire')).then(() => true, () => false), false);
  await assert.rejects(() => disabled.recordEvents([event()]), MemoryDisabledError);
});
