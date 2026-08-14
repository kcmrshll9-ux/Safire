import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { opaqueJsonFilename } from '../lib/memory/filesystem.mjs';
import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import {
  canonicalJson,
  digestRecord,
  sha256,
} from '../lib/memory/records.mjs';
import {
  MemoryIdempotencyConflictError,
  MemoryResourceLimitError,
  createMemoryStore,
} from '../lib/memory/store.mjs';

function profile(name, overrides = {}) {
  return createPortableMcpProfile({
    profileId: `profile:${name}`,
    principal: { id: `agent:${name}`, type: 'agent', displayName: `${name} display` },
    agentInstance: { id: `agent_instance:${name}:desktop`, type: 'agent_instance' },
    ingestedBy: { id: `adapter:${name}` },
    sourceIdentity: `mcp:${name}`,
    allowedActors: [],
    namespaceGrants: [
      { namespace: `agents/${name}`, read: true, write: true, descendants: true },
      { namespace: 'shared/demo', read: true, write: true, descendants: true },
    ],
    ...overrides,
  });
}

function event(name, overrides = {}) {
  const actor = overrides.actorName || 'harry';
  const { actorName: _actorName, ...rest } = overrides;
  return {
    schema_version: 1,
    namespace: `agents/${actor}`,
    actor_type: 'agent',
    actor_id: `agent:${actor}`,
    agent_instance_id: `agent_instance:${actor}:desktop`,
    kind: 'visible_agent_response',
    speech_act: 'assertion',
    content: `Synthetic bounded-memory record ${name}.`,
    occurred_at: '2026-08-14T17:00:00.000Z',
    source: { stream: `stream.${actor}`, event_id: name },
    ...rest,
  };
}

async function temporaryVault(t, prefix = 'safire-memory-resource-') {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return vault;
}

function assertGenericResourceError(error) {
  assert.ok(error instanceof MemoryResourceLimitError);
  assert.equal(error.code, 'MEMORY_RESOURCE_LIMIT');
  assert.equal(error.message, 'Safire memory resource limit exceeded');
  assert.equal(Object.hasOwn(error, 'details'), false);
  return true;
}

function reseal(record) {
  const { integrity: _integrity, ...unsigned } = record;
  return {
    ...unsigned,
    integrity: { algorithm: 'sha256', digest: digestRecord(unsigned) },
  };
}

test('collection reads use bounded concurrency and default exact get performs no collection scan', async (t) => {
  const vault = await temporaryVault(t);
  const harry = profile('harry');
  const writer = createMemoryStore({ vaultDir: vault, profile: harry });
  const recorded = await writer.recordEvents(
    Array.from({ length: 24 }, (_, index) => event(`bounded.${index}`)),
  );
  const targetId = recorded.results[7].event.event_id;

  let activeReads = 0;
  let maximumReads = 0;
  const reader = createMemoryStore({
    vaultDir: vault,
    profile: harry,
    resourceLimits: { readConcurrency: 3 },
    faultInjector: async (stage) => {
      if (stage === 'before_collection_record_read') {
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        await new Promise(resolve => setTimeout(resolve, 4));
      } else if (stage === 'after_collection_record_read') {
        activeReads -= 1;
      }
    },
  });
  const search = await reader.search({ query: 'bounded-memory record' });
  assert.equal(search.count, 24);
  assert.ok(maximumReads > 1);
  assert.ok(maximumReads <= 3);
  assert.equal(activeReads, 0);

  const exactReader = createMemoryStore({
    vaultDir: vault,
    profile: harry,
    faultInjector: async (stage) => {
      if (stage === 'before_collection_record_read') {
        throw new Error('exact get attempted a collection scan');
      }
    },
  });
  const exact = await exactReader.get(targetId);
  assert.equal(exact.event.event_id, targetId);
  assert.deepEqual(exact.feedback, []);
  assert.deepEqual(exact.incoming_relations, []);
  assert.deepEqual(exact.expansions, { feedback: false, relations: false });
});

test('request record and byte limits fail generically before sidecar mutation', async (t) => {
  const recordVault = await temporaryVault(t, 'safire-memory-request-records-');
  const recordStore = createMemoryStore({
    vaultDir: recordVault,
    profile: profile('harry'),
    resourceLimits: { maxRecordsPerRequest: 2 },
  });
  await assert.rejects(
    () => recordStore.recordEvents([event('record.1'), event('record.2'), event('record.3')]),
    assertGenericResourceError,
  );
  await assert.rejects(() => fs.stat(path.join(recordVault, '.safire')), { code: 'ENOENT' });

  const byteVault = await temporaryVault(t, 'safire-memory-request-bytes-');
  const byteStore = createMemoryStore({
    vaultDir: byteVault,
    profile: profile('harry'),
    resourceLimits: { maxBytesPerRequest: 128 },
  });
  await assert.rejects(
    () => byteStore.recordEvents([event('bytes.1')]),
    assertGenericResourceError,
  );
  await assert.rejects(() => fs.stat(path.join(byteVault, '.safire')), { code: 'ENOENT' });
});

test('namespace and stable-profile quotas reject only new unique writes without eviction', async (t) => {
  const vault = await temporaryVault(t);
  const harryProfile = profile('harry');
  const limited = createMemoryStore({
    vaultDir: vault,
    profile: harryProfile,
    resourceLimits: {
      maxRecordsPerNamespace: 2,
      maxRecordsPerProfile: 2,
    },
  });
  const firstInput = event('quota.1');
  const first = await limited.recordEvents([firstInput, event('quota.2')]);
  assert.equal(first.created_count, 2);
  const duplicate = await limited.recordEvents([firstInput]);
  assert.equal(duplicate.duplicate_count, 1);
  await assert.rejects(() => limited.recordEvents([event('quota.3')]), assertGenericResourceError);
  assert.equal((await limited.get(first.results[0].event.event_id)).event.content, firstInput.content);
  assert.equal((await createMemoryStore({ vaultDir: vault, profile: harryProfile }).status()).counts.events, 2);

  const eventDirectory = path.join(vault, '.safire', 'memory', 'v1', 'records', 'events');
  const [eventName] = await fs.readdir(eventDirectory);
  const firstEventBytes = (await fs.stat(path.join(eventDirectory, eventName))).size;
  const byteLimited = createMemoryStore({
    vaultDir: vault,
    profile: harryProfile,
    resourceLimits: {
      maxBytesPerNamespace: firstEventBytes * 2,
      maxBytesPerProfile: firstEventBytes * 2,
    },
  });
  await assert.rejects(() => byteLimited.recordEvents([event('quota.bytes')]), assertGenericResourceError);
});

test('profile quota ownership is isolated in a shared namespace and metrics retain stable actors', async (t) => {
  const vault = await temporaryVault(t);
  const harryProfile = profile('harry');
  const syntheticProfile = profile('synthetic');
  const quota = { maxRecordsPerProfile: 1, maxRecordsPerNamespace: 10 };
  const harryLimited = createMemoryStore({ vaultDir: vault, profile: harryProfile, resourceLimits: quota });
  const syntheticLimited = createMemoryStore({ vaultDir: vault, profile: syntheticProfile, resourceLimits: quota });
  const harryRecord = await harryLimited.recordEvents([event('shared.harry', {
    namespace: 'shared/demo',
    content: 'Shared stable actor metric target.',
  })]);
  await syntheticLimited.recordEvents([event('shared.synthetic', {
    actorName: 'synthetic',
    namespace: 'shared/demo',
    content: 'A second profile can use its own quota in the shared namespace.',
  })]);
  await assert.rejects(
    () => harryLimited.recordEvents([event('shared.harry.2', { namespace: 'shared/demo' })]),
    assertGenericResourceError,
  );
  await assert.rejects(
    () => syntheticLimited.recordEvents([event('shared.synthetic.2', {
      actorName: 'synthetic', namespace: 'shared/demo',
    })]),
    assertGenericResourceError,
  );

  const eventId = harryRecord.results[0].event.event_id;
  const harry = createMemoryStore({ vaultDir: vault, profile: harryProfile });
  const synthetic = createMemoryStore({ vaultDir: vault, profile: syntheticProfile });
  await harry.recordFeedback([
    {
      schema_version: 1,
      target: { type: 'event', id: eventId },
      signal: 'useful',
      actor_id: 'agent:harry',
      source: { stream: 'feedback.harry', event_id: 'agent' },
    },
    {
      schema_version: 1,
      target: { type: 'event', id: eventId },
      signal: 'not_useful',
      actor_id: 'agent_instance:harry:desktop',
      source: { stream: 'feedback.harry', event_id: 'instance' },
    },
  ]);
  await synthetic.recordFeedback([{
    schema_version: 1,
    target: { type: 'event', id: eventId },
    signal: 'useful',
    actor_id: 'agent:synthetic',
    source: { stream: 'feedback.synthetic', event_id: 'agent' },
  }]);
  const result = (await harry.search({ query: 'stable actor metric target' })).results[0];
  assert.equal(result.activity_by_stable_actor['agent:harry'].events, 1);
  assert.equal(result.activity_by_stable_actor['agent:harry'].feedback, 1);
  assert.equal(result.activity_by_stable_actor['agent:harry'].signals.useful, 1);
  assert.equal(result.activity_by_stable_actor['agent_instance:harry:desktop'].feedback, 1);
  assert.equal(result.activity_by_stable_actor['agent_instance:harry:desktop'].signals.not_useful, 1);
  assert.equal(result.activity_by_stable_actor['agent:synthetic'].feedback, 1);
});

test('feedback and relation expansion limits are shared across an exact request', async (t) => {
  const vault = await temporaryVault(t);
  const harryProfile = profile('harry');
  const writer = createMemoryStore({ vaultDir: vault, profile: harryProfile });
  const target = await writer.recordEvents([event('expansion.target')]);
  const targetId = target.results[0].event.event_id;
  await writer.recordFeedback(Array.from({ length: 3 }, (_, index) => ({
    schema_version: 1,
    target: { type: 'event', id: targetId },
    signal: 'useful',
    actor_id: 'agent:harry',
    source: { stream: 'feedback.expansion', event_id: `feedback.${index}` },
  })));
  await writer.recordEvents(Array.from({ length: 3 }, (_, index) => event(`relation.${index}`, {
    relations: [{ type: 'supports', target_event_id: targetId }],
  })));
  const reader = createMemoryStore({
    vaultDir: vault,
    profile: harryProfile,
    resourceLimits: { maxFeedbackExpansion: 2, maxRelationExpansion: 2 },
  });
  assert.equal((await reader.get(targetId)).event.event_id, targetId);
  await assert.rejects(
    () => reader.get(targetId, { includeFeedback: true }),
    assertGenericResourceError,
  );
  await assert.rejects(
    () => reader.get(targetId, { includeRelations: true }),
    assertGenericResourceError,
  );
});

test('legacy display-name digests retry safely while stable actor changes conflict', async (t) => {
  const vault = await temporaryVault(t);
  const oldProfile = profile('harry', {
    principal: { id: 'agent:harry', type: 'agent', displayName: 'Old display label' },
    allowedActors: [{
      id: 'automation:runner',
      type: 'automation',
      delegatedBy: 'agent:harry',
    }],
  });
  const input = event('legacy.display');
  const first = await createMemoryStore({ vaultDir: vault, profile: oldProfile }).recordEvents([input]);
  const stored = first.results[0].event;
  const legacyDigest = sha256(canonicalJson({
    input,
    actor: stored.actor,
    ingested_by: stored.ingested_by,
    agent_instance: stored.agent_instance,
    delegated_by: stored.delegated_by,
    source: stored.source,
  }));
  const legacyEvent = reseal({
    ...stored,
    idempotency: { ...stored.idempotency, request_digest: legacyDigest },
  });
  const root = path.join(vault, '.safire', 'memory', 'v1');
  const eventPath = path.join(root, 'records', 'events', opaqueJsonFilename(stored.event_id));
  await fs.writeFile(eventPath, `${JSON.stringify(legacyEvent, null, 2)}\n`, 'utf8');
  const markerPath = path.join(
    root,
    'records',
    'idempotency',
    opaqueJsonFilename(`event:${stored.idempotency.source_key_digest}`),
  );
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  const legacyMarker = reseal({
    ...marker,
    request_digest: legacyDigest,
    record_digest: legacyEvent.integrity.digest,
  });
  await fs.writeFile(markerPath, `${JSON.stringify(legacyMarker, null, 2)}\n`, 'utf8');

  const renamedProfile = profile('harry', {
    principal: { id: 'agent:harry', type: 'agent', displayName: 'New display label' },
    allowedActors: [{
      id: 'automation:runner',
      type: 'automation',
      delegatedBy: 'agent:harry',
    }],
  });
  const reopened = createMemoryStore({ vaultDir: vault, profile: renamedProfile });
  const duplicate = await reopened.recordEvents([input]);
  assert.equal(duplicate.duplicate_count, 1);
  assert.equal(duplicate.results[0].event.event_id, stored.event_id);
  const changedActor = event('legacy.display', {
    actor_type: 'automation',
    actor_id: 'automation:runner',
    delegated_by: 'agent:harry',
    kind: 'automation_decision',
  });
  delete changedActor.agent_instance_id;
  await assert.rejects(
    () => reopened.recordEvents([changedActor]),
    MemoryIdempotencyConflictError,
  );
});
