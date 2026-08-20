import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HARD_MAX_MEMORY_JSON_FILE_BYTES,
  ensureMemoryLayout,
  immutableCollectionDirectory,
  immutableRecordPath,
  journalDirectory,
  listImmutableJson,
  opaqueJsonFilename,
} from '../lib/memory/filesystem.mjs';
import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import {
  canonicalJson,
  digestRecord,
  sha256,
} from '../lib/memory/records.mjs';
import {
  DEFAULT_MEMORY_RESOURCE_LIMITS,
  HARD_MEMORY_RESOURCE_LIMITS,
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
  const actor = overrides.actorName || 'example';
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

test('resource configuration accepts exact immutable ceilings and only lower values', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-limit-config-');
  assert.equal(Object.isFrozen(HARD_MEMORY_RESOURCE_LIMITS), true);
  assert.equal(Object.isFrozen(DEFAULT_MEMORY_RESOURCE_LIMITS), true);
  assert.equal(
    HARD_MAX_MEMORY_JSON_FILE_BYTES,
    HARD_MEMORY_RESOURCE_LIMITS.maxBytesPerRequest + (32 * 1024 * 1024),
    'the file cap reserves a fixed envelope above the maximum canonical request',
  );

  for (const [key, maximum] of Object.entries(HARD_MEMORY_RESOURCE_LIMITS)) {
    const exact = createMemoryStore({
      vaultDir: vault,
      profile: profile('example'),
      resourceLimits: { [key]: maximum },
    });
    assert.equal(exact.resourceLimits[key], maximum, `${key} accepts its exact hard ceiling`);
    assert.throws(
      () => createMemoryStore({
        vaultDir: vault,
        profile: profile('example'),
        resourceLimits: { [key]: maximum + 1 },
      }),
      {
        name: 'TypeError',
        message: 'MemoryStore resource limits cannot exceed hard maximums',
      },
      `${key} rejects values above its hard ceiling`,
    );
  }

  const lowered = {
    readConcurrency: 1,
    maxDirectoryEntriesPerOperation: 1,
    maxRecordsPerRequest: 1,
    maxBytesPerRequest: 1,
    maxSearchCandidates: 1,
    maxSearchResults: 1,
    maxRecordsPerProfile: 1,
    maxBytesPerProfile: 1,
    maxRecordsPerNamespace: 1,
    maxBytesPerNamespace: 1,
    maxFeedbackExpansion: 0,
    maxRelationExpansion: 0,
    maxBatchSize: 1,
  };
  const store = createMemoryStore({
    vaultDir: vault,
    profile: profile('example'),
    resourceLimits: lowered,
  });
  assert.deepEqual(store.resourceLimits, lowered);
  await assert.rejects(
    () => store.recordEvents([event('lowered.1'), event('lowered.2')]),
    assertGenericResourceError,
  );
  await assert.rejects(
    () => store.recordFeedback([{}, {}]),
    assertGenericResourceError,
  );
  await assert.rejects(
    () => store.recall(['evt_synthetic_1', 'evt_synthetic_2']),
    assertGenericResourceError,
  );
  await assert.rejects(() => fs.stat(path.join(vault, '.safire')), { code: 'ENOENT' });
});

test('incremental directory enumeration caps valid, unexpected, and mixed entries', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-directory-cap-');
  const layout = await ensureMemoryLayout(vault);
  const actors = immutableCollectionDirectory(layout, 'actors');
  for (const identity of ['valid.1', 'valid.2', 'valid.3']) {
    await fs.writeFile(path.join(actors, opaqueJsonFilename(identity)), '{}\n', 'utf8');
  }
  await assert.rejects(
    () => listImmutableJson(layout, 'actors', { maxEntries: 2 }),
    { code: 'MEMORY_RESOURCE_LIMIT', message: 'Safire memory resource limit exceeded' },
  );

  const feedback = immutableCollectionDirectory(layout, 'feedback');
  await fs.writeFile(path.join(feedback, 'foreign-a.txt'), 'synthetic', 'utf8');
  await fs.writeFile(path.join(feedback, 'foreign-b.tmp'), 'synthetic', 'utf8');
  await fs.mkdir(path.join(feedback, 'foreign-directory'));
  await assert.rejects(
    () => listImmutableJson(layout, 'feedback', { maxEntries: 2 }),
    { code: 'MEMORY_RESOURCE_LIMIT', message: 'Safire memory resource limit exceeded' },
  );

  const events = immutableCollectionDirectory(layout, 'events');
  await fs.writeFile(path.join(events, opaqueJsonFilename('mixed.valid')), '{}\n', 'utf8');
  await fs.writeFile(path.join(events, 'mixed-foreign.txt'), 'synthetic', 'utf8');
  await fs.writeFile(path.join(events, 'mixed-foreign.tmp'), 'synthetic', 'utf8');
  await assert.rejects(
    () => listImmutableJson(layout, 'events', { maxEntries: 2 }),
    { code: 'MEMORY_RESOURCE_LIMIT', message: 'Safire memory resource limit exceeded' },
  );
  assert.equal((await fs.readdir(events)).length, 3, 'the bounded read does not mutate entries');
});

test('incremental enumeration stops and closes its iterator at the first excess entry', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-directory-early-stop-');
  const layout = await ensureMemoryLayout(vault);
  const originalOpendir = fs.opendir;
  let yielded = 0;
  let closed = false;
  fs.opendir = async () => ({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          yielded += 1;
          return {
            done: false,
            value: {
              name: `synthetic-${yielded}.tmp`,
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
          };
        },
        async return() {
          closed = true;
          return { done: true };
        },
      };
    },
  });
  try {
    await assert.rejects(
      () => listImmutableJson(layout, 'events', { maxEntries: 2 }),
      { code: 'MEMORY_RESOURCE_LIMIT' },
    );
  } finally {
    fs.opendir = originalOpendir;
  }
  assert.equal(yielded, 3, 'the iterator stops at limit plus the first excess entry');
  assert.equal(closed, true, 'the interrupted directory iterator is closed');
});

test('manifest initialization uses the configured directory-entry ceiling', async (t) => {
  const acceptedVault = await temporaryVault(t, 'safire-memory-manifest-cap-accepted-');
  const accepted = createMemoryStore({
    vaultDir: acceptedVault,
    profile: profile('example'),
    resourceLimits: { maxDirectoryEntriesPerOperation: 5 },
  });
  await accepted.initialize();
  assert.equal((await accepted.status()).counts.events, 0);

  const rejectedVault = await temporaryVault(t, 'safire-memory-manifest-cap-rejected-');
  const rejected = createMemoryStore({
    vaultDir: rejectedVault,
    profile: profile('example'),
    resourceLimits: { maxDirectoryEntriesPerOperation: 4 },
  });
  await assert.rejects(() => rejected.initialize(), assertGenericResourceError);
  await assert.rejects(
    () => fs.stat(path.join(rejectedVault, '.safire', 'memory', 'v1', 'manifest.json')),
    { code: 'ENOENT' },
  );
});

test('oversized manifest and actor files fail closed before allocation without deletion', async (t) => {
  const manifestVault = await temporaryVault(t, 'safire-memory-oversized-manifest-');
  const manifestLayout = await ensureMemoryLayout(manifestVault);
  const manifestPath = path.join(manifestLayout.rootDir, 'manifest.json');
  await fs.writeFile(manifestPath, '{}\n', 'utf8');
  await fs.truncate(manifestPath, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);
  const manifestStore = createMemoryStore({ vaultDir: manifestVault, profile: profile('example') });
  await assert.rejects(() => manifestStore.initialize(), assertGenericResourceError);
  assert.equal((await fs.stat(manifestPath)).size, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);

  const actorVault = await temporaryVault(t, 'safire-memory-oversized-actor-');
  const exampleProfile = profile('example');
  const writer = createMemoryStore({ vaultDir: actorVault, profile: exampleProfile });
  await writer.initialize();
  const actorPath = immutableRecordPath(writer.layout, 'actors', exampleProfile.principal.id);
  await fs.truncate(actorPath, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);
  const reopened = createMemoryStore({ vaultDir: actorVault, profile: exampleProfile });
  await assert.rejects(() => reopened.initialize(), assertGenericResourceError);
  assert.equal((await fs.stat(actorPath)).size, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);
});

test('direct and collection reads reject deterministic growth after caller pre-stat', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-file-growth-');
  const exampleProfile = profile('example');
  const writer = createMemoryStore({ vaultDir: vault, profile: exampleProfile });
  const created = await writer.recordEvents([event('growth.target')]);
  const eventId = created.results[0].event.event_id;
  const eventPath = immutableRecordPath(writer.layout, 'events', eventId);
  const originalBytes = (await fs.stat(eventPath)).size;

  let directGrown = false;
  const directReader = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    faultInjector: async (stage, metadata) => {
      if (!directGrown && stage === 'before_direct_record_read' && metadata.collection === 'events') {
        directGrown = true;
        await fs.appendFile(eventPath, ' ');
      }
    },
  });
  await assert.rejects(() => directReader.get(eventId), assertGenericResourceError);
  assert.equal((await fs.stat(eventPath)).size, originalBytes + 1);

  let collectionGrown = false;
  const collectionReader = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    faultInjector: async (stage, metadata) => {
      if (!collectionGrown
          && stage === 'before_collection_record_read'
          && metadata.collection === 'events') {
        collectionGrown = true;
        await fs.appendFile(eventPath, ' ');
      }
    },
  });
  await assert.rejects(() => collectionReader.status(), assertGenericResourceError);
  assert.equal((await fs.stat(eventPath)).size, originalBytes + 2);
});

test('oversized journal recovery fails closed without publishing or deleting state', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-oversized-journal-');
  const exampleProfile = profile('example');
  let interrupted = false;
  const writer = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    faultInjector(stage) {
      if (!interrupted && stage === 'after_journal_create') {
        interrupted = true;
        throw new Error('synthetic journal interruption');
      }
    },
  });
  await assert.rejects(
    () => writer.recordEvents([event('journal.oversized')]),
    /synthetic journal interruption/,
  );
  const ingestionDirectory = journalDirectory(writer.layout, 'ingestion');
  const [journalName] = await fs.readdir(ingestionDirectory);
  const journalPath = path.join(ingestionDirectory, journalName);
  await fs.truncate(journalPath, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);

  const reopened = createMemoryStore({ vaultDir: vault, profile: exampleProfile });
  await assert.rejects(() => reopened.status(), assertGenericResourceError);
  assert.equal((await fs.stat(journalPath)).size, HARD_MAX_MEMORY_JSON_FILE_BYTES + 1);
  assert.deepEqual(
    await fs.readdir(immutableCollectionDirectory(writer.layout, 'events')),
    [],
  );
});

test('collection reads use bounded concurrency and default exact get performs no collection scan', async (t) => {
  const vault = await temporaryVault(t);
  const example = profile('example');
  const writer = createMemoryStore({ vaultDir: vault, profile: example });
  const recorded = await writer.recordEvents(
    Array.from({ length: 24 }, (_, index) => event(`bounded.${index}`)),
  );
  const targetId = recorded.results[7].event.event_id;

  let activeReads = 0;
  let maximumReads = 0;
  const reader = createMemoryStore({
    vaultDir: vault,
    profile: example,
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
    profile: example,
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
    profile: profile('example'),
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
    profile: profile('example'),
    resourceLimits: { maxBytesPerRequest: 128 },
  });
  await assert.rejects(
    () => byteStore.recordEvents([event('bytes.1')]),
    assertGenericResourceError,
  );
  await assert.rejects(() => fs.stat(path.join(byteVault, '.safire')), { code: 'ENOENT' });
});

test('store scans count unexpected entries and exact reads remain direct', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-store-directory-cap-');
  const exampleProfile = profile('example');
  const writer = createMemoryStore({ vaultDir: vault, profile: exampleProfile });
  const created = await writer.recordEvents([event('directory.direct')]);
  const eventId = created.results[0].event.event_id;
  const eventDirectory = path.join(vault, '.safire', 'memory', 'v1', 'records', 'events');
  await fs.writeFile(path.join(eventDirectory, 'foreign-a.txt'), 'synthetic', 'utf8');
  await fs.writeFile(path.join(eventDirectory, 'foreign-b.tmp'), 'synthetic', 'utf8');

  const reader = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    resourceLimits: { maxDirectoryEntriesPerOperation: 2 },
  });
  await assert.rejects(() => reader.status(), assertGenericResourceError);
  assert.equal((await reader.get(eventId)).event.event_id, eventId);
  assert.deepEqual(
    (await fs.readdir(eventDirectory)).sort(),
    [opaqueJsonFilename(eventId), 'foreign-a.txt', 'foreign-b.tmp'].sort(),
  );
});

test('directory-entry budget is shared across every collection in one request', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-shared-directory-cap-');
  const exampleProfile = profile('example');
  const writer = createMemoryStore({ vaultDir: vault, profile: exampleProfile });
  const created = await writer.recordEvents([event('directory.shared')]);
  const eventId = created.results[0].event.event_id;
  await writer.recordFeedback([{
    schema_version: 1,
    target: { type: 'event', id: eventId },
    signal: 'useful',
    actor_id: 'agent:example',
    source: { stream: 'feedback.directory', event_id: 'shared' },
  }]);
  const reader = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    resourceLimits: { maxDirectoryEntriesPerOperation: 1 },
  });
  await assert.rejects(() => reader.status(), assertGenericResourceError);
  assert.equal((await reader.get(eventId)).event.event_id, eventId);
});

test('search candidate and result ceilings fail generically while bounded top-k remains correct', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-search-cap-');
  const exampleProfile = profile('example');
  const writer = createMemoryStore({ vaultDir: vault, profile: exampleProfile });
  await writer.recordEvents([
    event('candidate.1', { content: 'Bounded candidate alpha.' }),
    event('candidate.2', { content: 'Bounded candidate beta.' }),
    event('candidate.3', { content: 'Bounded candidate gamma.' }),
  ]);

  const candidateLimited = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    resourceLimits: { maxSearchCandidates: 2 },
  });
  await assert.rejects(
    () => candidateLimited.search({ query: 'bounded candidate', limit: 2 }),
    assertGenericResourceError,
  );

  const resultLimited = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    resourceLimits: { maxSearchResults: 2 },
  });
  await assert.rejects(
    () => resultLimited.search({ query: 'bounded candidate', limit: 3 }),
    assertGenericResourceError,
  );
  assert.equal((await resultLimited.search({ query: 'bounded candidate', limit: 2 })).count, 2);
});

test('namespace and stable-profile quotas reject only new unique writes without eviction', async (t) => {
  const vault = await temporaryVault(t);
  const exampleProfile = profile('example');
  const limited = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
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
  assert.equal((await createMemoryStore({ vaultDir: vault, profile: exampleProfile }).status()).counts.events, 2);

  const eventDirectory = path.join(vault, '.safire', 'memory', 'v1', 'records', 'events');
  const [eventName] = await fs.readdir(eventDirectory);
  const firstEventBytes = (await fs.stat(path.join(eventDirectory, eventName))).size;
  const byteLimited = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    resourceLimits: {
      maxBytesPerNamespace: firstEventBytes * 2,
      maxBytesPerProfile: firstEventBytes * 2,
    },
  });
  await assert.rejects(() => byteLimited.recordEvents([event('quota.bytes')]), assertGenericResourceError);

  const existingOverQuota = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
    resourceLimits: { maxRecordsPerProfile: 1, maxRecordsPerNamespace: 1 },
  });
  assert.equal((await existingOverQuota.get(first.results[0].event.event_id)).event.event_id,
    first.results[0].event.event_id);
  assert.equal((await existingOverQuota.status()).counts.events, 2);
});

test('concurrent batches serialize quota checks and never overcommit', async (t) => {
  const vault = await temporaryVault(t, 'safire-memory-concurrent-quota-');
  const exampleProfile = profile('example');
  const limits = { maxRecordsPerProfile: 3, maxRecordsPerNamespace: 3 };
  const first = createMemoryStore({ vaultDir: vault, profile: exampleProfile, resourceLimits: limits });
  const second = createMemoryStore({ vaultDir: vault, profile: exampleProfile, resourceLimits: limits });
  await first.recordEvents([event('concurrent.base')]);
  const outcomes = await Promise.allSettled([
    first.recordEvents([event('concurrent.a1'), event('concurrent.a2')]),
    second.recordEvents([event('concurrent.b1'), event('concurrent.b2')]),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const [rejected] = outcomes.filter(({ status }) => status === 'rejected');
  assertGenericResourceError(rejected.reason);
  assert.equal((await first.status()).counts.events, 3);
});

test('profile quota ownership is isolated in a shared namespace and metrics retain stable actors', async (t) => {
  const vault = await temporaryVault(t);
  const exampleProfile = profile('example');
  const syntheticProfile = profile('synthetic');
  const quota = { maxRecordsPerProfile: 1, maxRecordsPerNamespace: 10 };
  const exampleLimited = createMemoryStore({ vaultDir: vault, profile: exampleProfile, resourceLimits: quota });
  const syntheticLimited = createMemoryStore({ vaultDir: vault, profile: syntheticProfile, resourceLimits: quota });
  const exampleRecord = await exampleLimited.recordEvents([event('shared.example', {
    namespace: 'shared/demo',
    content: 'Shared stable actor metric target.',
  })]);
  await syntheticLimited.recordEvents([event('shared.synthetic', {
    actorName: 'synthetic',
    namespace: 'shared/demo',
    content: 'A second profile can use its own quota in the shared namespace.',
  })]);
  await assert.rejects(
    () => exampleLimited.recordEvents([event('shared.example.2', { namespace: 'shared/demo' })]),
    assertGenericResourceError,
  );
  await assert.rejects(
    () => syntheticLimited.recordEvents([event('shared.synthetic.2', {
      actorName: 'synthetic', namespace: 'shared/demo',
    })]),
    assertGenericResourceError,
  );

  const eventId = exampleRecord.results[0].event.event_id;
  const example = createMemoryStore({ vaultDir: vault, profile: exampleProfile });
  const synthetic = createMemoryStore({ vaultDir: vault, profile: syntheticProfile });
  await example.recordFeedback([
    {
      schema_version: 1,
      target: { type: 'event', id: eventId },
      signal: 'useful',
      actor_id: 'agent:example',
      source: { stream: 'feedback.example', event_id: 'agent' },
    },
    {
      schema_version: 1,
      target: { type: 'event', id: eventId },
      signal: 'not_useful',
      actor_id: 'agent_instance:example:desktop',
      source: { stream: 'feedback.example', event_id: 'instance' },
    },
  ]);
  await synthetic.recordFeedback([{
    schema_version: 1,
    target: { type: 'event', id: eventId },
    signal: 'useful',
    actor_id: 'agent:synthetic',
    source: { stream: 'feedback.synthetic', event_id: 'agent' },
  }]);
  const result = (await example.search({ query: 'stable actor metric target' })).results[0];
  assert.equal(result.activity_by_stable_actor['agent:example'].events, 1);
  assert.equal(result.activity_by_stable_actor['agent:example'].feedback, 1);
  assert.equal(result.activity_by_stable_actor['agent:example'].signals.useful, 1);
  assert.equal(result.activity_by_stable_actor['agent_instance:example:desktop'].feedback, 1);
  assert.equal(result.activity_by_stable_actor['agent_instance:example:desktop'].signals.not_useful, 1);
  assert.equal(result.activity_by_stable_actor['agent:synthetic'].feedback, 1);
});

test('feedback and relation expansion limits are shared across an exact request', async (t) => {
  const vault = await temporaryVault(t);
  const exampleProfile = profile('example');
  const writer = createMemoryStore({ vaultDir: vault, profile: exampleProfile });
  const target = await writer.recordEvents([event('expansion.target')]);
  const targetId = target.results[0].event.event_id;
  await writer.recordFeedback(Array.from({ length: 3 }, (_, index) => ({
    schema_version: 1,
    target: { type: 'event', id: targetId },
    signal: 'useful',
    actor_id: 'agent:example',
    source: { stream: 'feedback.expansion', event_id: `feedback.${index}` },
  })));
  await writer.recordEvents(Array.from({ length: 3 }, (_, index) => event(`relation.${index}`, {
    relations: [{ type: 'supports', target_event_id: targetId }],
  })));
  const reader = createMemoryStore({
    vaultDir: vault,
    profile: exampleProfile,
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
  const oldProfile = profile('example', {
    principal: { id: 'agent:example', type: 'agent', displayName: 'Old display label' },
    allowedActors: [{
      id: 'automation:runner',
      type: 'automation',
      delegatedBy: 'agent:example',
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
  assert.equal(marker.batch?.protocol, 'guard-receipt/v1');
  const { batch: _batch, ...preProtocolMarker } = marker;
  const legacyMarker = reseal({
    ...preProtocolMarker,
    request_digest: legacyDigest,
    record_digest: legacyEvent.integrity.digest,
  });
  await fs.writeFile(markerPath, `${JSON.stringify(legacyMarker, null, 2)}\n`, 'utf8');
  const receiptPath = path.join(
    root,
    'records',
    'idempotency',
    opaqueJsonFilename(`batch-receipt:${marker.batch.batch_id}`),
  );
  await fs.unlink(receiptPath);

  const renamedProfile = profile('example', {
    principal: { id: 'agent:example', type: 'agent', displayName: 'New display label' },
    allowedActors: [{
      id: 'automation:runner',
      type: 'automation',
      delegatedBy: 'agent:example',
    }],
  });
  const reopened = createMemoryStore({ vaultDir: vault, profile: renamedProfile });
  const duplicate = await reopened.recordEvents([input]);
  assert.equal(duplicate.duplicate_count, 1);
  assert.equal(duplicate.results[0].event.event_id, stored.event_id);
  const changedActor = event('legacy.display', {
    actor_type: 'automation',
    actor_id: 'automation:runner',
    delegated_by: 'agent:example',
    kind: 'automation_decision',
  });
  delete changedActor.agent_instance_id;
  await assert.rejects(
    () => reopened.recordEvents([changedActor]),
    MemoryIdempotencyConflictError,
  );
});
