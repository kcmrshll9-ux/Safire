import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import { opaqueJsonFilename, serializeJson } from '../lib/memory/filesystem.mjs';
import { digestRecord } from '../lib/memory/records.mjs';
import { createMemoryStore } from '../lib/memory/store.mjs';

function markerProfile() {
  return createPortableMcpProfile({
    profileId: 'profile:marker-integrity',
    principal: { id: 'agent:marker-integrity', type: 'agent', displayName: 'Marker integrity agent' },
    agentInstance: { id: 'agent_instance:marker-integrity:test', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:marker-integrity' },
    sourceIdentity: 'mcp:marker-integrity',
    allowedActors: [],
    namespaceGrants: [
      { namespace: 'agents/marker-integrity', read: true, write: true, descendants: true },
    ],
  });
}

function event(eventId, overrides = {}) {
  return {
    schema_version: 1,
    namespace: 'agents/marker-integrity',
    actor_type: 'agent',
    actor_id: 'agent:marker-integrity',
    agent_instance_id: 'agent_instance:marker-integrity:test',
    kind: 'visible_agent_response',
    speech_act: 'assertion',
    content: `Marker integrity event ${eventId}.`,
    occurred_at: '2026-08-14T17:00:00.000Z',
    context: { conversation_id: 'marker.integrity', turn_id: eventId },
    source: { stream: 'marker.integrity', event_id: eventId },
    ...overrides,
  };
}

function feedback(targetId, eventId, overrides = {}) {
  return {
    schema_version: 1,
    target: { type: 'event', id: targetId },
    signal: 'useful',
    actor_id: 'agent:marker-integrity',
    source: { stream: 'marker.integrity.feedback', event_id: eventId },
    ...overrides,
  };
}

async function temporaryVault(t) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-marker-integrity-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return vault;
}

function recordsRoot(vault) {
  return path.join(vault, '.safire', 'memory', 'v1', 'records');
}

async function markerState(vault, operation, recordId) {
  const directory = path.join(recordsRoot(vault), 'idempotency');
  for (const name of await fs.readdir(directory)) {
    const markerPath = path.join(directory, name);
    const bytes = await fs.readFile(markerPath);
    const value = JSON.parse(bytes.toString('utf8'));
    const matches = operation === 'event'
      ? value.operation === operation && value.event_id === recordId
      : value.operation === operation && value.feedback_id === recordId;
    if (matches) return { path: markerPath, bytes, value };
  }
  throw new Error(`Unable to find ${operation} marker`);
}

async function recordSnapshot(vault) {
  const snapshot = {};
  for (const collection of ['events', 'feedback', 'memories']) {
    const directory = path.join(recordsRoot(vault), collection);
    snapshot[collection] = [];
    for (const name of (await fs.readdir(directory)).sort()) {
      snapshot[collection].push([name, (await fs.readFile(path.join(directory, name))).toString('base64')]);
    }
  }
  return snapshot;
}

function reseal(value, patch) {
  const next = { ...value, ...patch };
  next.integrity = { algorithm: 'sha256', digest: digestRecord(next) };
  return next;
}

async function storedRecord(vault, collection, id) {
  const recordPath = path.join(recordsRoot(vault), collection, opaqueJsonFilename(id));
  return JSON.parse(await fs.readFile(recordPath, 'utf8'));
}

async function writeStoredRecord(vault, collection, id, value) {
  const recordPath = path.join(recordsRoot(vault), collection, opaqueJsonFilename(id));
  await fs.writeFile(recordPath, serializeJson(value), { flag: 'wx' });
  return recordPath;
}

function transactionInvalid(error) {
  return error?.code === 'MEMORY_TRANSACTION_INVALID';
}

test('a missing event marker fails closed for reads and all retries without changing records', async (t) => {
  const vault = await temporaryVault(t);
  const profile = markerProfile();
  const input = event('missing.event.marker');
  const store = createMemoryStore({ vaultDir: vault, profile });
  const recorded = await store.recordEvents([input]);
  const eventId = recorded.results[0].event.event_id;
  const marker = await markerState(vault, 'event', eventId);
  await fs.unlink(marker.path);
  const before = await recordSnapshot(vault);

  await assert.rejects(() => store.get(eventId), transactionInvalid);
  await assert.rejects(() => store.search({ query: '' }), transactionInvalid);
  await assert.rejects(() => store.status(), transactionInvalid);
  await assert.rejects(() => store.recordEvents([input]), transactionInvalid);
  await assert.rejects(
    () => store.recordEvents([{ ...input, content: 'Changed content must not adopt the orphan.' }]),
    transactionInvalid,
  );
  await assert.rejects(
    () => store.recordEvents([event('orphan.reference', {
      relations: [{ type: 'supports', target_event_id: eventId }],
    })]),
    transactionInvalid,
  );
  await assert.rejects(
    () => store.recordFeedback([feedback(eventId, 'orphan.feedback.target')]),
    transactionInvalid,
  );

  const peer = createMemoryStore({ vaultDir: vault, profile });
  const concurrent = await Promise.allSettled([
    store.recordEvents([input]),
    peer.recordEvents([input]),
  ]);
  assert.equal(concurrent.every(result => (
    result.status === 'rejected' && transactionInvalid(result.reason)
  )), true);
  assert.deepEqual(await recordSnapshot(vault), before);
});

test('a missing feedback marker fails closed for reads and all retries without changing records', async (t) => {
  const vault = await temporaryVault(t);
  const profile = markerProfile();
  const store = createMemoryStore({ vaultDir: vault, profile });
  const recorded = await store.recordEvents([event('feedback.target')]);
  const eventId = recorded.results[0].event.event_id;
  const input = feedback(eventId, 'missing.feedback.marker');
  const appended = await store.recordFeedback([input]);
  const feedbackId = appended.results[0].feedback.feedback_id;
  const marker = await markerState(vault, 'feedback', feedbackId);
  await fs.unlink(marker.path);
  const before = await recordSnapshot(vault);

  await assert.rejects(() => store.get(eventId, { includeFeedback: true }), transactionInvalid);
  await assert.rejects(() => store.search({ query: '' }), transactionInvalid);
  await assert.rejects(() => store.status(), transactionInvalid);
  await assert.rejects(() => store.recordFeedback([input]), transactionInvalid);
  await assert.rejects(
    () => store.recordFeedback([{ ...input, signal: 'not_useful' }]),
    transactionInvalid,
  );
  assert.deepEqual(await recordSnapshot(vault), before);
});

test('malformed event and feedback markers fail closed without being repaired or discarded', async (t) => {
  for (const operation of ['event', 'feedback']) {
    await t.test(operation, async (t) => {
      const vault = await temporaryVault(t);
      const profile = markerProfile();
      const store = createMemoryStore({ vaultDir: vault, profile });
      const recorded = await store.recordEvents([event(`malformed.${operation}.target`)]);
      const eventId = recorded.results[0].event.event_id;
      let input = event(`malformed.${operation}.source`);
      let recordId;
      if (operation === 'event') {
        const appended = await store.recordEvents([input]);
        recordId = appended.results[0].event.event_id;
      } else {
        input = feedback(eventId, 'malformed.feedback.source');
        const appended = await store.recordFeedback([input]);
        recordId = appended.results[0].feedback.feedback_id;
      }
      const marker = await markerState(vault, operation, recordId);
      const malformed = Buffer.from('{"truncated":true\n', 'utf8');
      await fs.writeFile(marker.path, malformed);
      const before = await recordSnapshot(vault);

      const read = operation === 'event'
        ? () => store.get(recordId)
        : () => store.get(eventId, { includeFeedback: true });
      const retry = operation === 'event'
        ? () => store.recordEvents([input])
        : () => store.recordFeedback([input]);
      await assert.rejects(read, error => error?.code === 'MEMORY_JSON_INVALID');
      await assert.rejects(retry, error => error?.code === 'MEMORY_JSON_INVALID');
      assert.deepEqual(await fs.readFile(marker.path), malformed);
      assert.deepEqual(await recordSnapshot(vault), before);
    });
  }
});

test('present falsey batch membership never downgrades a protected marker to legacy state', async (t) => {
  for (const operation of ['event', 'feedback']) {
    for (const batch of [null, false]) {
      await t.test(`${operation}/${String(batch)}`, async (t) => {
        const vault = await temporaryVault(t);
        const profile = markerProfile();
        const store = createMemoryStore({ vaultDir: vault, profile });
        const target = await store.recordEvents([event(`falsey.${operation}.${String(batch)}.target`)]);
        const targetId = target.results[0].event.event_id;
        let input = event(`falsey.${operation}.${String(batch)}.source`);
        let recordId;
        if (operation === 'event') {
          const appended = await store.recordEvents([input]);
          recordId = appended.results[0].event.event_id;
        } else {
          input = feedback(targetId, `falsey.${operation}.${String(batch)}.source`);
          const appended = await store.recordFeedback([input]);
          recordId = appended.results[0].feedback.feedback_id;
        }
        const marker = await markerState(vault, operation, recordId);
        const corrupted = serializeJson(reseal(marker.value, { batch }));
        await fs.writeFile(marker.path, corrupted, 'utf8');
        const before = await recordSnapshot(vault);

        const read = operation === 'event'
          ? () => store.get(recordId)
          : () => store.get(targetId, { includeFeedback: true });
        const retry = operation === 'event'
          ? () => store.recordEvents([input])
          : () => store.recordFeedback([input]);
        await assert.rejects(read, transactionInvalid);
        await assert.rejects(retry, transactionInvalid);
        assert.equal(await fs.readFile(marker.path, 'utf8'), corrupted);
        assert.deepEqual(await recordSnapshot(vault), before);
      });
    }
  }
});

test('valid but mismatched event and feedback markers fail closed without changing records', async (t) => {
  for (const operation of ['event', 'feedback']) {
    await t.test(operation, async (t) => {
      const vault = await temporaryVault(t);
      const profile = markerProfile();
      const store = createMemoryStore({ vaultDir: vault, profile });
      const recorded = await store.recordEvents([event(`mismatch.${operation}.target`)]);
      const targetId = recorded.results[0].event.event_id;
      let firstInput;
      let firstId;
      let secondId;
      if (operation === 'event') {
        firstInput = event('mismatch.event.first');
        const first = await store.recordEvents([firstInput]);
        const second = await store.recordEvents([event('mismatch.event.second')]);
        firstId = first.results[0].event.event_id;
        secondId = second.results[0].event.event_id;
      } else {
        firstInput = feedback(targetId, 'mismatch.feedback.first');
        const first = await store.recordFeedback([firstInput]);
        const second = await store.recordFeedback([feedback(targetId, 'mismatch.feedback.second')]);
        firstId = first.results[0].feedback.feedback_id;
        secondId = second.results[0].feedback.feedback_id;
      }
      const firstMarker = await markerState(vault, operation, firstId);
      const secondMarker = await markerState(vault, operation, secondId);
      await fs.writeFile(firstMarker.path, secondMarker.bytes);
      const before = await recordSnapshot(vault);

      const read = operation === 'event'
        ? () => store.get(firstId)
        : () => store.get(targetId, { includeFeedback: true });
      const retry = operation === 'event'
        ? () => store.recordEvents([firstInput])
        : () => store.recordFeedback([firstInput]);
      await assert.rejects(read, transactionInvalid);
      await assert.rejects(retry, transactionInvalid);
      assert.deepEqual(await recordSnapshot(vault), before);
    });
  }
});

test('sealed marker target and digest mismatches fail closed for events and feedback', async (t) => {
  for (const operation of ['event', 'feedback']) {
    for (const mismatch of ['nonexistent_target', 'wrong_existing_target', 'record_digest', 'request_digest']) {
      await t.test(`${operation}/${mismatch}`, async (t) => {
        const vault = await temporaryVault(t);
        const profile = markerProfile();
        const store = createMemoryStore({ vaultDir: vault, profile });
        const target = await store.recordEvents([event(`${operation}.${mismatch}.target`)]);
        const targetId = target.results[0].event.event_id;
        let firstInput;
        let firstRecord;
        let secondRecord;
        if (operation === 'event') {
          firstInput = event(`${mismatch}.event.first`);
          const first = await store.recordEvents([firstInput]);
          const second = await store.recordEvents([event(`${mismatch}.event.second`)]);
          firstRecord = first.results[0].event;
          secondRecord = second.results[0].event;
        } else {
          firstInput = feedback(targetId, `${mismatch}.feedback.first`);
          const first = await store.recordFeedback([firstInput]);
          const second = await store.recordFeedback([feedback(targetId, `${mismatch}.feedback.second`)]);
          firstRecord = first.results[0].feedback;
          secondRecord = second.results[0].feedback;
        }
        const identityKey = operation === 'event' ? 'event_id' : 'feedback_id';
        const marker = await markerState(vault, operation, firstRecord[identityKey]);
        let patch;
        if (mismatch === 'nonexistent_target') {
          patch = operation === 'event'
            ? { event_id: `evt_${randomUUID()}`, memory_id: `mem_${randomUUID()}` }
            : { feedback_id: `fbk_${randomUUID()}` };
        } else if (mismatch === 'wrong_existing_target') {
          patch = operation === 'event'
            ? {
              event_id: secondRecord.event_id,
              memory_id: secondRecord.memory_id,
              record_digest: secondRecord.integrity.digest,
              request_digest: secondRecord.idempotency.request_digest,
            }
            : {
              feedback_id: secondRecord.feedback_id,
              record_digest: secondRecord.integrity.digest,
              request_digest: secondRecord.idempotency.request_digest,
            };
        } else if (mismatch === 'record_digest') {
          patch = { record_digest: '0'.repeat(64) };
        } else {
          patch = { request_digest: '1'.repeat(64) };
        }
        const corrupted = reseal(marker.value, patch);
        const corruptedBytes = serializeJson(corrupted);
        await fs.writeFile(marker.path, corruptedBytes, 'utf8');
        const before = await recordSnapshot(vault);

        const read = operation === 'event'
          ? () => store.get(firstRecord.event_id)
          : () => store.get(targetId, { includeFeedback: true });
        const retry = operation === 'event'
          ? () => store.recordEvents([firstInput])
          : () => store.recordFeedback([firstInput]);
        await assert.rejects(read, transactionInvalid);
        await assert.rejects(retry, transactionInvalid);
        assert.equal(await fs.readFile(marker.path, 'utf8'), corruptedBytes);
        assert.deepEqual(await recordSnapshot(vault), before);
      });
    }
  }
});

test('duplicate sealed records claiming one source key fail closed without cleanup', async (t) => {
  for (const operation of ['event', 'feedback']) {
    await t.test(operation, async (t) => {
      const vault = await temporaryVault(t);
      const profile = markerProfile();
      const store = createMemoryStore({ vaultDir: vault, profile });
      const target = await store.recordEvents([event(`duplicate.${operation}.target`)]);
      const targetId = target.results[0].event.event_id;
      let input;
      let duplicateId;
      if (operation === 'event') {
        input = event('duplicate.event.source');
        const first = await store.recordEvents([input]);
        const originalEvent = await storedRecord(vault, 'events', first.results[0].event.event_id);
        const originalMemory = await storedRecord(vault, 'memories', first.results[0].memory.memory_id);
        duplicateId = `evt_${randomUUID()}`;
        const duplicateMemoryId = `mem_${randomUUID()}`;
        await writeStoredRecord(vault, 'events', duplicateId, reseal(originalEvent, {
          event_id: duplicateId,
          memory_id: duplicateMemoryId,
        }));
        await writeStoredRecord(vault, 'memories', duplicateMemoryId, reseal(originalMemory, {
          event_id: duplicateId,
          memory_id: duplicateMemoryId,
          source_event_ids: [duplicateId],
        }));
      } else {
        input = feedback(targetId, 'duplicate.feedback.source');
        const first = await store.recordFeedback([input]);
        const original = await storedRecord(vault, 'feedback', first.results[0].feedback.feedback_id);
        duplicateId = `fbk_${randomUUID()}`;
        await writeStoredRecord(vault, 'feedback', duplicateId, reseal(original, {
          feedback_id: duplicateId,
        }));
      }
      const before = await recordSnapshot(vault);

      await assert.rejects(() => store.status(), transactionInvalid);
      await assert.rejects(
        operation === 'event'
          ? () => store.get(duplicateId)
          : () => store.get(targetId, { includeFeedback: true }),
        transactionInvalid,
      );
      await assert.rejects(
        operation === 'event'
          ? () => store.recordEvents([input])
          : () => store.recordFeedback([input]),
        transactionInvalid,
      );
      assert.deepEqual(await recordSnapshot(vault), before);
    });
  }
});

test('a surviving verified journal safely creates the missing marker and batch receipt', async (t) => {
  for (const operation of ['event', 'feedback']) {
    await t.test(operation, async (t) => {
      const vault = await temporaryVault(t);
      const profile = markerProfile();
      const base = createMemoryStore({ vaultDir: vault, profile });
      let input;
      if (operation === 'event') {
        input = event('journal.repairs.event.marker');
      } else {
        const target = await base.recordEvents([event('journal.repairs.feedback.target')]);
        input = feedback(target.results[0].event.event_id, 'journal.repairs.feedback.marker');
      }
      let stopped = false;
      const interrupted = createMemoryStore({
        vaultDir: vault,
        profile,
        faultInjector(stage) {
          const expected = operation === 'event' ? 'after_memory_create' : 'after_feedback_create';
          if (!stopped && stage === expected) {
            stopped = true;
            throw new Error('stop before marker publication');
          }
        },
      });
      const write = operation === 'event'
        ? () => interrupted.recordEvents([input])
        : () => interrupted.recordFeedback([input]);
      await assert.rejects(write, /stop before marker publication/);

      const markerDirectory = path.join(recordsRoot(vault), 'idempotency');
      const markerCountBefore = (await fs.readdir(markerDirectory)).length;
      const recovered = createMemoryStore({ vaultDir: vault, profile });
      const status = await recovered.status();
      const markerCountAfter = (await fs.readdir(markerDirectory)).length;
      assert.equal(markerCountAfter, markerCountBefore + 2);
      assert.equal(status.pending_transactions, 0);
      const replay = operation === 'event'
        ? await recovered.recordEvents([input])
        : await recovered.recordFeedback([input]);
      assert.equal(replay.duplicate_count, 1);
    });
  }
});

test('sealed records with incomplete idempotency metadata fail generically instead of throwing TypeError', async (t) => {
  for (const operation of ['event', 'feedback']) {
    for (const defect of ['missing', 'invalid_digest']) {
      await t.test(`${operation}/${defect}`, async (t) => {
        const vault = await temporaryVault(t);
        const profile = markerProfile();
        const store = createMemoryStore({ vaultDir: vault, profile });
        const target = await store.recordEvents([event(`record.idempotency.${operation}.${defect}`)]);
        const targetId = target.results[0].event.event_id;
        let recordId = targetId;
        let collection = 'events';
        if (operation === 'feedback') {
          const appended = await store.recordFeedback([
            feedback(targetId, `record.idempotency.feedback.${defect}`),
          ]);
          recordId = appended.results[0].feedback.feedback_id;
          collection = 'feedback';
        }
        const original = await storedRecord(vault, collection, recordId);
        let corrupted;
        if (defect === 'missing') {
          const { idempotency: _idempotency, integrity: _integrity, ...withoutIdempotency } = original;
          corrupted = reseal(withoutIdempotency, {});
        } else {
          corrupted = reseal(original, {
            idempotency: { ...original.idempotency, source_key_digest: 'invalid' },
          });
        }
        const recordPath = path.join(recordsRoot(vault), collection, opaqueJsonFilename(recordId));
        const corruptedBytes = serializeJson(corrupted);
        await fs.writeFile(recordPath, corruptedBytes, 'utf8');

        const read = operation === 'event'
          ? () => store.get(recordId)
          : () => store.get(targetId, { includeFeedback: true });
        await assert.rejects(read, transactionInvalid);
        await assert.rejects(() => store.status(), transactionInvalid);
        assert.equal(await fs.readFile(recordPath, 'utf8'), corruptedBytes);
      });
    }
  }
});
