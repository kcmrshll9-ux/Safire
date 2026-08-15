import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import {
  MemoryIdempotencyConflictError,
  MemoryNotFoundError,
  createMemoryStore,
} from '../lib/memory/store.mjs';

function batchProfile() {
  return createPortableMcpProfile({
    profileId: 'profile:batch-atomicity',
    principal: { id: 'agent:batch', type: 'agent', displayName: 'Batch test agent' },
    agentInstance: { id: 'agent_instance:batch:test', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:safire-memory-mcp:batch-test' },
    sourceIdentity: 'mcp:batch-test',
    allowedActors: [],
    namespaceGrants: [
      { namespace: 'agents/batch', read: true, write: true, descendants: true },
    ],
  });
}

function event(eventId, overrides = {}) {
  return {
    schema_version: 1,
    namespace: 'agents/batch',
    actor_type: 'agent',
    actor_id: 'agent:batch',
    agent_instance_id: 'agent_instance:batch:test',
    kind: 'visible_agent_response',
    speech_act: 'proposal',
    content: `Batch event ${eventId}.`,
    occurred_at: '2026-08-14T17:00:00.000Z',
    context: { conversation_id: 'batch.atomicity', turn_id: eventId },
    source: { stream: 'batch.atomicity', event_id: eventId },
    ...overrides,
  };
}

function feedback(target, eventId, overrides = {}) {
  return {
    schema_version: 1,
    target,
    signal: 'useful',
    actor_id: 'agent:batch',
    source: { stream: 'batch.feedback', event_id: eventId },
    ...overrides,
  };
}

async function temporaryVault(t, prefix = 'safire-memory-batch-') {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return vault;
}

test('event batches reject a later missing reference without committing an earlier valid event', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
  const inputs = [
    event('reference.valid', { content: 'This valid prefix must not be committed.' }),
    event('reference.missing', {
      relations: [{ type: 'supports', target_event_id: 'evt_missing-reference' }],
    }),
  ];

  await assert.rejects(() => store.recordEvents(inputs), MemoryNotFoundError);

  const status = await store.status();
  assert.equal(status.counts.events, 0);
  assert.equal(status.counts.memories, 0);
  assert.equal(status.pending_transactions, 0);
});

test('feedback batches reject a later missing target without committing earlier valid feedback', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
  const recorded = await store.recordEvents([event('feedback.target')]);
  const validTarget = { type: 'memory', id: recorded.results[0].memory.memory_id };
  const inputs = [
    feedback(validTarget, 'valid'),
    feedback({ type: 'event', id: 'evt_missing-feedback-target' }, 'missing'),
  ];

  await assert.rejects(() => store.recordFeedback(inputs), MemoryNotFoundError);

  const status = await store.status();
  assert.equal(status.counts.events, 1);
  assert.equal(status.counts.memories, 1);
  assert.equal(status.counts.feedback, 0);
  assert.equal(status.pending_transactions, 0);
});

test('a later existing-marker conflict prevents an earlier new event from committing', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
  const existing = event('marker.existing', { content: 'The original idempotent payload.' });
  await store.recordEvents([existing]);

  await assert.rejects(
    () => store.recordEvents([
      event('marker.new-prefix', { content: 'This new prefix must not be committed.' }),
      { ...existing, content: 'A conflicting payload for the existing source tuple.' },
    ]),
    MemoryIdempotencyConflictError,
  );

  const status = await store.status();
  assert.equal(status.counts.events, 1);
  assert.equal(status.counts.memories, 1);
  assert.equal(status.pending_transactions, 0);
  assert.equal((await store.search({ query: 'new prefix' })).count, 0);
});

test('same-source events with different payloads conflict before any batch member commits', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
  const first = event('source.conflict', { content: 'The first payload.' });
  const second = { ...first, content: 'The second payload.' };

  await assert.rejects(
    () => store.recordEvents([first, second]),
    MemoryIdempotencyConflictError,
  );

  const status = await store.status();
  assert.equal(status.counts.events, 0);
  assert.equal(status.counts.memories, 0);
  assert.equal(status.pending_transactions, 0);
});

test('an exact duplicate within one event batch creates one record and returns the same IDs', async (t) => {
  const vault = await temporaryVault(t);
  const store = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
  const input = event('source.duplicate');

  const result = await store.recordEvents([input, input]);

  assert.equal(result.created_count, 1);
  assert.equal(result.recovered_count, 0);
  assert.equal(result.duplicate_count, 1);
  assert.deepEqual(result.results.map((item) => item.status), ['created', 'duplicate']);
  assert.equal(result.results[0].event.event_id, result.results[1].event.event_id);
  assert.equal(result.results[0].memory.memory_id, result.results[1].memory.memory_id);
  const status = await store.status();
  assert.equal(status.counts.events, 1);
  assert.equal(status.counts.memories, 1);
});

test('an interrupted two-event batch recovers every member rather than only a committed prefix', async (t) => {
  for (const failureStage of [
    'after_journal_create',
    'after_event_create',
    'after_memory_create',
    'after_idempotency_create',
    'after_batch_receipt_create',
  ]) {
    await t.test(failureStage, async (t) => {
      const vault = await temporaryVault(t, `safire-event-batch-${failureStage}-`);
      const inputs = [event(`${failureStage}.one`), event(`${failureStage}.two`)];
      let failed = false;
      const crashing = createMemoryStore({
        vaultDir: vault,
        profile: batchProfile(),
        faultInjector(stage) {
          if (!failed && stage === failureStage) {
            failed = true;
            throw new Error(`invented event batch crash at ${failureStage}`);
          }
        },
      });

      await assert.rejects(
        () => crashing.recordEvents(inputs),
        new RegExp(`invented event batch crash at ${failureStage}`),
      );

      const recovered = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
      const status = await recovered.status();
      assert.equal(status.counts.events, 2);
      assert.equal(status.counts.memories, 2);
      assert.equal(status.pending_transactions, 0);
      const replay = await recovered.recordEvents(inputs);
      assert.equal(replay.created_count, 0);
      assert.equal(replay.duplicate_count, 2);
    });
  }
});

test('an interrupted two-feedback batch recovers every member rather than only a committed prefix', async (t) => {
  for (const failureStage of [
    'after_journal_create',
    'after_feedback_create',
    'after_idempotency_create',
    'after_batch_receipt_create',
  ]) {
    await t.test(failureStage, async (t) => {
      const vault = await temporaryVault(t, `safire-feedback-batch-${failureStage}-`);
      const base = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
      const recorded = await base.recordEvents([event(`${failureStage}.target`)]);
      const target = { type: 'event', id: recorded.results[0].event.event_id };
      const inputs = [
        feedback(target, `${failureStage}.one`),
        feedback(target, `${failureStage}.two`),
      ];
      let failed = false;
      const crashing = createMemoryStore({
        vaultDir: vault,
        profile: batchProfile(),
        faultInjector(stage) {
          if (!failed && stage === failureStage) {
            failed = true;
            throw new Error(`invented feedback batch crash at ${failureStage}`);
          }
        },
      });

      await assert.rejects(
        () => crashing.recordFeedback(inputs),
        new RegExp(`invented feedback batch crash at ${failureStage}`),
      );

      const recovered = createMemoryStore({ vaultDir: vault, profile: batchProfile() });
      const status = await recovered.status();
      assert.equal(status.counts.events, 1);
      assert.equal(status.counts.memories, 1);
      assert.equal(status.counts.feedback, 2);
      assert.equal(status.pending_transactions, 0);
      const replay = await recovered.recordFeedback(inputs);
      assert.equal(replay.created_count, 0);
      assert.equal(replay.duplicate_count, 2);
    });
  }
});
