import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRecordBelongsToManifest,
  buildEventRecord,
  buildFeedbackRecord,
  buildMemoryRecord,
  buildVaultManifest,
  canonicalJson,
  regenerateVaultManifest,
  sourceKeyDigest,
  verifyRecordIntegrity,
} from '../lib/memory/records.mjs';

const input = (sourceEvent = 'turn:1') => ({
  schema_version: 1,
  namespace: 'agents/harry',
  actor_type: 'agent',
  actor_id: 'agent:harry',
  kind: 'visible_agent_response',
  speech_act: 'proposal',
  content: 'Use the crimson launch checklist.',
  occurred_at: '2026-08-14T17:00:00.000Z',
  source: { stream: 'conversation:alpha', event_id: sourceEvent },
});

const attribution = (sourceEvent = 'turn:1') => ({
  actor: { type: 'agent', id: 'agent:harry', label: 'Harry' },
  ingested_by: { adapter_id: 'safire-memory-mcp', profile_id: 'harry', trust: 'portable_mcp' },
  agent_instance: { type: 'agent_instance', id: 'agent_instance:harry-primary' },
  delegated_by: null,
  source: { identity: 'mcp:harry-primary', stream: 'conversation:alpha', event_id: sourceEvent },
});

test('canonical JSON and record digests are stable across property order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
  const manifest = buildVaultManifest({
    vaultId: 'vlt_11111111-1111-4111-8111-111111111111',
    createdAt: '2026-08-14T17:00:00.000Z',
  });
  assert.equal(verifyRecordIntegrity(manifest), true);
  assert.equal(verifyRecordIntegrity({ ...manifest, revision: 2 }), false);
});

test('event envelopes keep every attribution and provenance role separate', () => {
  const event = buildEventRecord({
    vaultId: 'vlt_11111111-1111-4111-8111-111111111111',
    input: input(),
    attribution: attribution(),
    eventId: 'evt_11111111-1111-4111-8111-111111111111',
    memoryId: 'mem_11111111-1111-4111-8111-111111111111',
    ingestedAt: '2026-08-14T17:00:01.000Z',
  });

  assert.deepEqual(event.actor, { type: 'agent', id: 'agent:harry', label: 'Harry' });
  assert.equal(event.ingested_by.profile_id, 'harry');
  assert.equal(event.agent_instance.id, 'agent_instance:harry-primary');
  assert.equal(event.delegated_by, null);
  assert.deepEqual(event.source, {
    identity: 'mcp:harry-primary', stream: 'conversation:alpha', event_id: 'turn:1',
  });
  assert.equal(verifyRecordIntegrity(event), true);
});

test('source idempotency uses identity, stream, and real source event ID rather than text', () => {
  const first = sourceKeyDigest(attribution('turn:1').source);
  const duplicate = sourceKeyDigest(attribution('turn:1').source);
  const repeatedTextAtAnotherTurn = sourceKeyDigest(attribution('turn:2').source);
  const sameTurnFromAnotherAdapter = sourceKeyDigest({ ...attribution('turn:1').source, identity: 'bridge:hermes' });

  assert.equal(first, duplicate);
  assert.notEqual(first, repeatedTextAtAnotherTurn);
  assert.notEqual(first, sameTurnFromAnotherAdapter);
});

test('feedback envelopes preserve actor-specific signals without mutating the event', () => {
  const feedback = buildFeedbackRecord({
    vaultId: 'vlt_11111111-1111-4111-8111-111111111111',
    input: {
      schema_version: 1,
      target: { type: 'memory', id: 'mem_11111111-1111-4111-8111-111111111111' },
      signal: 'useful',
      actor_id: 'agent:harry',
      source: { stream: 'feedback:alpha', event_id: 'feedback:1' },
    },
    attribution: {
      ...attribution(),
      source: { identity: 'mcp:harry-primary', stream: 'feedback:alpha', event_id: 'feedback:1' },
    },
    namespace: 'agents/harry',
    feedbackId: 'fbk_11111111-1111-4111-8111-111111111111',
    recordedAt: '2026-08-14T17:01:00.000Z',
  });
  assert.equal(feedback.signal, 'useful');
  assert.equal(feedback.actor.type, 'agent');
  assert.equal(feedback.target.type, 'memory');
  assert.equal(feedback.namespace, 'agents/harry');
  assert.equal(verifyRecordIntegrity(feedback), true);
});

test('event-backed memory items retain every derived source event ID', () => {
  const event = buildEventRecord({
    vaultId: 'vlt_11111111-1111-4111-8111-111111111111',
    input: {
      ...input(),
      kind: 'explicit_conclusion',
      speech_act: 'conclusion',
      derived: {
        claim: 'The two visible events support the launch conclusion.',
        source_event_ids: ['evt_source_1', 'evt_source_2'],
      },
    },
    attribution: attribution(),
    eventId: 'evt_33333333-3333-4333-8333-333333333333',
    memoryId: 'mem_33333333-3333-4333-8333-333333333333',
    ingestedAt: '2026-08-14T17:02:00.000Z',
  });
  const memory = buildMemoryRecord(event);
  assert.deepEqual(memory.source_event_ids, ['evt_source_1', 'evt_source_2']);
  assert.equal(memory.event_id, event.event_id);
  assert.equal(verifyRecordIntegrity(memory), true);
});

test('moving or copying a manifest preserves identity; regeneration requires explicit clone intent', () => {
  const original = buildVaultManifest({
    vaultId: 'vlt_11111111-1111-4111-8111-111111111111',
    createdAt: '2026-08-14T17:00:00.000Z',
  });
  const copied = structuredClone(original);
  assert.equal(copied.vault_id, original.vault_id);
  assert.throws(() => regenerateVaultManifest(copied, {
    vaultId: 'vlt_22222222-2222-4222-8222-222222222222',
    regeneratedAt: '2026-08-14T18:00:00.000Z',
  }), /confirmation/i);

  const clone = regenerateVaultManifest(copied, {
    vaultId: 'vlt_22222222-2222-4222-8222-222222222222',
    regeneratedAt: '2026-08-14T18:00:00.000Z',
    confirmIndependentClone: true,
  });
  assert.equal(clone.vault_id, 'vlt_22222222-2222-4222-8222-222222222222');
  assert.deepEqual(clone.lineage, ['vlt_11111111-1111-4111-8111-111111111111']);
  assert.equal(clone.revision, 2);
  assert.equal(verifyRecordIntegrity(clone), true);

  const legacyEvent = buildEventRecord({
    vaultId: original.vault_id,
    input: input(),
    attribution: attribution(),
    ingestedAt: '2026-08-14T17:00:01.000Z',
  });
  assert.equal(assertRecordBelongsToManifest(legacyEvent, clone), legacyEvent);
});
