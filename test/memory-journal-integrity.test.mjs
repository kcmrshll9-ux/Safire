import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createImmutableJson,
  digestJson,
  ensureMemoryLayout,
  journalDirectory,
  journalEntryPath,
  serializeJson,
} from '../lib/memory/filesystem.mjs';
import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import { digestRecord } from '../lib/memory/records.mjs';
import { createMemoryStore } from '../lib/memory/store.mjs';

const INGESTION_JOURNAL = 'ingestion';
const BATCH_GUARD_JOURNAL = 'ingestion-batch-guard';

function profile() {
  return createPortableMcpProfile({
    profileId: 'profile:journal-integrity',
    principal: { id: 'agent:journal', type: 'agent', displayName: 'Journal test agent' },
    agentInstance: { id: 'agent_instance:journal:test', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:safire-memory-mcp:journal-test' },
    sourceIdentity: 'mcp:journal-test',
    allowedActors: [],
    namespaceGrants: [
      { namespace: 'agents/journal', read: true, write: true, descendants: true },
    ],
  });
}

function event(eventId) {
  return {
    schema_version: 1,
    namespace: 'agents/journal',
    actor_type: 'agent',
    actor_id: 'agent:journal',
    agent_instance_id: 'agent_instance:journal:test',
    kind: 'visible_agent_response',
    speech_act: 'proposal',
    content: `Journal integrity event ${eventId}.`,
    occurred_at: '2026-08-14T17:00:00.000Z',
    context: { conversation_id: 'journal.integrity', turn_id: eventId },
    source: { stream: 'journal.integrity', event_id: eventId },
  };
}

function feedback(target, eventId) {
  return {
    schema_version: 1,
    target,
    signal: 'useful',
    actor_id: 'agent:journal',
    source: { stream: 'journal.integrity.feedback', event_id: eventId },
  };
}

async function temporaryVault(t, prefix = 'safire-memory-journal-integrity-') {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return vault;
}

async function soleFile(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].isFile(), true);
  return path.join(directory, entries[0].name);
}

async function pendingState(vault) {
  const layout = await ensureMemoryLayout(vault);
  const journalDir = journalDirectory(layout, INGESTION_JOURNAL);
  const guardDir = journalDirectory(layout, BATCH_GUARD_JOURNAL);
  const journalPath = await soleFile(journalDir);
  const guardPath = await soleFile(guardDir);
  return {
    layout,
    journalDir,
    guardDir,
    journalPath,
    guardPath,
    journal: JSON.parse(await fs.readFile(journalPath, 'utf8')),
    guard: JSON.parse(await fs.readFile(guardPath, 'utf8')),
  };
}

async function artifactSnapshot(root, directory = root) {
  const snapshot = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const relative = path.relative(root, entryPath);
    if (entry.isDirectory()) {
      snapshot.push({ type: 'directory', path: relative });
      snapshot.push(...await artifactSnapshot(root, entryPath));
    } else {
      snapshot.push({
        type: entry.isFile() ? 'file' : 'other',
        path: relative,
        bytes: entry.isFile() ? (await fs.readFile(entryPath)).toString('base64') : null,
      });
    }
  }
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

function journalArtifactSnapshot(layout) {
  return artifactSnapshot(layout.journalsDir);
}

function recordArtifactSnapshot(layout) {
  return artifactSnapshot(layout.recordsDir);
}

async function publishedChildSnapshot(layout) {
  return Object.fromEntries(await Promise.all(
    ['events', 'memories', 'feedback'].map(async collection => [
      collection,
      await artifactSnapshot(layout.collections[collection]),
    ]),
  ));
}

async function soleBatchReceipt(layout) {
  const matches = [];
  for (const name of await fs.readdir(layout.collections.idempotency)) {
    const receiptPath = path.join(layout.collections.idempotency, name);
    const value = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    if (value.schema === 'safire.memory.batch-receipt/v1') {
      matches.push({ path: receiptPath, value });
    }
  }
  assert.equal(matches.length, 1);
  return matches[0];
}

async function interruptEventBatch(t, prefix = 'event') {
  const vault = await temporaryVault(t, `safire-journal-${prefix}-`);
  let interrupted = false;
  const store = createMemoryStore({
    vaultDir: vault,
    profile: profile(),
    faultInjector(stage) {
      if (interrupted || stage !== 'after_idempotency_create') return;
      interrupted = true;
      throw new Error('interrupt after first event child');
    },
  });
  await assert.rejects(
    () => store.recordEvents([event(`${prefix}.one`), event(`${prefix}.two`)]),
    /interrupt after first event child/,
  );
  return { vault, ...(await pendingState(vault)) };
}

async function interruptFeedbackBatch(t, prefix = 'feedback') {
  const vault = await temporaryVault(t, `safire-journal-${prefix}-`);
  const base = createMemoryStore({ vaultDir: vault, profile: profile() });
  const created = await base.recordEvents([event(`${prefix}.target`)]);
  const target = { type: 'event', id: created.results[0].event.event_id };
  let interrupted = false;
  const store = createMemoryStore({
    vaultDir: vault,
    profile: profile(),
    faultInjector(stage) {
      if (interrupted || stage !== 'after_idempotency_create') return;
      interrupted = true;
      throw new Error('interrupt after first feedback child');
    },
  });
  await assert.rejects(
    () => store.recordFeedback([
      feedback(target, `${prefix}.one`),
      feedback(target, `${prefix}.two`),
    ]),
    /interrupt after first feedback child/,
  );
  return { vault, ...(await pendingState(vault)) };
}

function isSanitizedTransactionError(error) {
  assert.equal(error?.code, 'MEMORY_TRANSACTION_INVALID');
  assert.equal(error?.details?.path, undefined);
  assert.doesNotMatch(error?.message || '', /[\\/][^\\/]+|[a-f0-9]{64}\.json/i);
  return true;
}

async function expectStatusFailsClosed(vault) {
  const store = createMemoryStore({ vaultDir: vault, profile: profile() });
  await assert.rejects(() => store.status(), isSanitizedTransactionError);
}

async function expectFailsClosedWithoutJournalMutation(pending) {
  const before = await journalArtifactSnapshot(pending.layout);
  await expectStatusFailsClosed(pending.vault);
  assert.deepEqual(await journalArtifactSnapshot(pending.layout), before);
}

test('a missing transaction journal with an active guard fails closed without removing the prefix', async (t) => {
  const pending = await interruptEventBatch(t, 'missing-main');
  await fs.rm(pending.journalDir, { recursive: true });

  await expectStatusFailsClosed(pending.vault);
  const events = await fs.readdir(pending.layout.collections.events);
  const memories = await fs.readdir(pending.layout.collections.memories);
  assert.equal(events.length, 1);
  assert.equal(memories.length, 1);
  assert.equal((await fs.readdir(pending.guardDir)).length, 1);
});

test('batch-linked event and feedback prefixes remain detectable after both transient journals are missing', async (t) => {
  await t.test('event', async (t) => {
    const pending = await interruptEventBatch(t, 'both-missing-event');
    const partialEventId = pending.journal.transactions[0].event.event_id;
    await fs.rm(pending.journalDir, { recursive: true });
    await fs.rm(pending.guardDir, { recursive: true });

    const store = createMemoryStore({ vaultDir: pending.vault, profile: profile() });
    await assert.rejects(() => store.get(partialEventId), isSanitizedTransactionError);
    await assert.rejects(() => store.search({ query: 'Journal integrity' }), isSanitizedTransactionError);
    await assert.rejects(() => store.recall([partialEventId]), isSanitizedTransactionError);
    await assert.rejects(
      () => store.recordEvents([
        event('both-missing-event.one'),
        event('both-missing-event.two'),
      ]),
      isSanitizedTransactionError,
    );
    await assert.rejects(() => store.status(), isSanitizedTransactionError);
  });

  await t.test('feedback', async (t) => {
    const pending = await interruptFeedbackBatch(t, 'both-missing-feedback');
    await fs.rm(pending.journalDir, { recursive: true });
    await fs.rm(pending.guardDir, { recursive: true });

    await expectStatusFailsClosed(pending.vault);
  });
});

test('renamed transaction journal entries and directories fail closed', async (t) => {
  await t.test('noncanonical entry name', async (t) => {
    const pending = await interruptEventBatch(t, 'renamed-entry');
    await fs.rename(pending.journalPath, path.join(pending.journalDir, 'ignored-journal.bin'));
    await expectFailsClosedWithoutJournalMutation(pending);
  });

  await t.test('valid filename with the wrong sealed identity', async (t) => {
    const pending = await interruptEventBatch(t, 'wrong-entry-identity');
    await fs.rename(pending.journalPath, path.join(pending.journalDir, `${'b'.repeat(64)}.json`));
    await expectFailsClosedWithoutJournalMutation(pending);
  });

  await t.test('unexpected canonical directory', async (t) => {
    const pending = await interruptEventBatch(t, 'renamed-directory');
    const renamed = path.join(pending.layout.journalsDir, 'c'.repeat(64));
    await fs.rename(pending.journalDir, renamed);
    await expectFailsClosedWithoutJournalMutation(pending);
  });
});

test('renamed guard entries and directories fail closed', async (t) => {
  await t.test('guard entry', async (t) => {
    const pending = await interruptEventBatch(t, 'renamed-guard-entry');
    await fs.rename(pending.guardPath, path.join(pending.guardDir, 'ignored-guard.bin'));
    await expectFailsClosedWithoutJournalMutation(pending);
  });

  await t.test('guard directory', async (t) => {
    const pending = await interruptEventBatch(t, 'renamed-guard-directory');
    const renamed = path.join(pending.layout.journalsDir, 'd'.repeat(64));
    await fs.rename(pending.guardDir, renamed);
    await expectFailsClosedWithoutJournalMutation(pending);
  });
});

test('multiple protected main journals without a guard fail closed without changing artifacts', async (t) => {
  const vault = await temporaryVault(t, 'safire-journal-ambiguous-protected-');
  let interrupted = false;
  const store = createMemoryStore({
    vaultDir: vault,
    profile: profile(),
    faultInjector(stage) {
      if (interrupted || stage !== 'after_journal_create') return;
      interrupted = true;
      throw new Error('interrupt before protected children');
    },
  });
  await assert.rejects(
    () => store.recordEvents([event('ambiguous.one'), event('ambiguous.two')]),
    /interrupt before protected children/,
  );
  const pending = await pendingState(vault);
  await fs.rm(pending.guardDir, { recursive: true });

  const secondBatchId = `bat_${randomUUID()}`;
  const secondTransactionId = `event_batch:${secondBatchId}`;
  const secondLink = {
    protocol: 'guard-receipt/v1',
    operation: 'event_batch',
    batch_id: secondBatchId,
    batch_transaction_id: secondTransactionId,
    transaction_count: pending.journal.transactions.length,
  };
  const secondChildren = pending.journal.transactions.map((child) => {
    const { integrity: _integrity, ...unsigned } = child;
    const clone = { ...unsigned, batch: secondLink };
    clone.integrity = { algorithm: 'sha256', digest: digestRecord(clone) };
    return clone;
  });
  const { integrity: _integrity, ...unsignedBatch } = pending.journal;
  const secondBatch = {
    ...unsignedBatch,
    transaction_id: secondTransactionId,
    batch_id: secondBatchId,
    transactions: secondChildren,
  };
  secondBatch.integrity = { algorithm: 'sha256', digest: digestRecord(secondBatch) };
  await fs.writeFile(
    journalEntryPath(pending.layout, INGESTION_JOURNAL, secondTransactionId),
    serializeJson(secondBatch),
    { flag: 'wx' },
  );
  const beforeJournals = await journalArtifactSnapshot(pending.layout);
  const beforeRecords = await recordArtifactSnapshot(pending.layout);

  await expectStatusFailsClosed(vault);
  assert.deepEqual(await journalArtifactSnapshot(pending.layout), beforeJournals);
  assert.deepEqual(await recordArtifactSnapshot(pending.layout), beforeRecords);
});

test('noncanonical, malformed, and foreign journal bytes fail closed with a controlled error', async (t) => {
  await t.test('noncanonical JSON', async (t) => {
    const pending = await interruptEventBatch(t, 'noncanonical');
    await fs.writeFile(pending.journalPath, JSON.stringify(pending.journal), 'utf8');
    await expectFailsClosedWithoutJournalMutation(pending);
  });

  await t.test('malformed JSON', async (t) => {
    const pending = await interruptEventBatch(t, 'malformed');
    await fs.writeFile(pending.journalPath, '{', 'utf8');
    await expectFailsClosedWithoutJournalMutation(pending);
  });

  await t.test('foreign file', async (t) => {
    const pending = await interruptEventBatch(t, 'foreign');
    await fs.writeFile(path.join(pending.journalDir, 'foreign.bin'), Buffer.from([0xff, 0x00]));
    await expectFailsClosedWithoutJournalMutation(pending);
  });
});

test('a protected journal without its guard remains recoverable for the guard-creation crash window', async (t) => {
  const pending = await interruptEventBatch(t, 'missing-guard');
  await fs.rm(pending.guardDir, { recursive: true });

  const recovered = createMemoryStore({ vaultDir: pending.vault, profile: profile() });
  const status = await recovered.status();
  assert.equal(status.counts.events, 2);
  assert.equal(status.counts.memories, 2);
  assert.equal(status.pending_transactions, 0);
  const repeated = await createMemoryStore({ vaultDir: pending.vault, profile: profile() }).status();
  assert.equal(repeated.counts.events, 2);
  assert.equal(repeated.counts.memories, 2);
  const replay = await recovered.recordEvents([
    event('missing-guard.one'),
    event('missing-guard.two'),
  ]);
  assert.equal(replay.created_count, 0);
  assert.equal(replay.duplicate_count, 2);
});

test('a valid pre-protocol pending batch journal recovers without migrating legacy markers', async (t) => {
  const vault = await temporaryVault(t, 'safire-journal-pre-protocol-');
  let interrupted = false;
  const inputs = [event('pre-protocol.one'), event('pre-protocol.two')];
  const store = createMemoryStore({
    vaultDir: vault,
    profile: profile(),
    faultInjector(stage) {
      if (interrupted || stage !== 'after_journal_create') return;
      interrupted = true;
      throw new Error('interrupt before pre-protocol publication');
    },
  });
  await assert.rejects(
    () => store.recordEvents(inputs),
    /interrupt before pre-protocol publication/,
  );
  const pending = await pendingState(vault);
  delete pending.journal.protocol;
  pending.journal.transactions = pending.journal.transactions.map((child) => {
    const { batch: _batch, integrity: _integrity, ...unsigned } = child;
    const legacyChild = { ...unsigned };
    legacyChild.integrity = { algorithm: 'sha256', digest: digestRecord(legacyChild) };
    return legacyChild;
  });
  delete pending.journal.integrity;
  pending.journal.integrity = {
    algorithm: 'sha256',
    digest: digestRecord(pending.journal),
  };
  await fs.writeFile(pending.journalPath, serializeJson(pending.journal), 'utf8');
  await fs.rm(pending.guardDir, { recursive: true });

  const recovered = createMemoryStore({ vaultDir: vault, profile: profile() });
  const status = await recovered.status();
  assert.equal(status.counts.events, 2);
  assert.equal(status.counts.memories, 2);
  const idempotencyRecords = [];
  for (const name of await fs.readdir(pending.layout.collections.idempotency)) {
    idempotencyRecords.push(JSON.parse(await fs.readFile(
      path.join(pending.layout.collections.idempotency, name),
      'utf8',
    )));
  }
  assert.equal(idempotencyRecords.length, 2);
  assert.equal(idempotencyRecords.every(record => (
    record.schema === 'safire.memory.idempotency/v1' && record.batch === undefined
  )), true);
  const replay = await recovered.recordEvents(inputs);
  assert.equal(replay.created_count, 0);
  assert.equal(replay.duplicate_count, 2);
});

test('cleanup recovery is idempotent when the receipt exists and the guard was already removed', async (t) => {
  const vault = await temporaryVault(t, 'safire-journal-cleanup-window-');
  let interrupted = false;
  const store = createMemoryStore({
    vaultDir: vault,
    profile: profile(),
    faultInjector(stage) {
      if (interrupted || stage !== 'after_batch_receipt_create') return;
      interrupted = true;
      throw new Error('interrupt after receipt');
    },
  });
  await assert.rejects(
    () => store.recordEvents([event('cleanup.one'), event('cleanup.two')]),
    /interrupt after receipt/,
  );
  const pending = await pendingState(vault);
  await fs.rm(pending.guardDir, { recursive: true });

  const recovered = createMemoryStore({ vaultDir: vault, profile: profile() });
  const status = await recovered.status();
  assert.equal(status.counts.events, 2);
  assert.equal(status.counts.memories, 2);
  assert.equal(status.pending_transactions, 0);
  assert.equal((await fs.readdir(pending.layout.journalsDir)).length, 0);
});

test('occupied permanent receipt identities are rejected before event or feedback journals exist', async (t) => {
  for (const operation of ['event', 'feedback']) {
    await t.test(operation, async (t) => {
      const vault = await temporaryVault(t, `safire-journal-receipt-collision-${operation}-`);
      const base = createMemoryStore({ vaultDir: vault, profile: profile() });
      const target = await base.recordEvents([event(`receipt.collision.${operation}.target`)]);
      const targetId = target.results[0].event.event_id;
      const receipt = await soleBatchReceipt(base.layout);
      const beforeRecords = await recordArtifactSnapshot(base.layout);
      const beforeJournals = await journalArtifactSnapshot(base.layout);
      const collisionStore = createMemoryStore({
        vaultDir: vault,
        profile: profile(),
        idFactory(prefix) {
          return prefix === 'bat' ? receipt.value.batch_id : `${prefix}_${randomUUID()}`;
        },
      });
      const write = operation === 'event'
        ? () => collisionStore.recordEvents([event('receipt.collision.event.new')])
        : () => collisionStore.recordFeedback([
          feedback({ type: 'event', id: targetId }, 'receipt.collision.feedback.new'),
        ]);

      await assert.rejects(write, (error) => {
        assert.equal(error?.code, 'MEMORY_ID_CONFLICT');
        assert.doesNotMatch(error?.message || '', new RegExp(receipt.value.batch_id, 'u'));
        return true;
      });
      assert.deepEqual(await recordArtifactSnapshot(base.layout), beforeRecords);
      assert.deepEqual(await journalArtifactSnapshot(base.layout), beforeJournals);
    });
  }
});

test('a receipt appearing after journal publication blocks event and feedback children', async (t) => {
  for (const operation of ['event', 'feedback']) {
    await t.test(operation, async (t) => {
      const vault = await temporaryVault(t, `safire-journal-receipt-race-${operation}-`);
      const base = createMemoryStore({ vaultDir: vault, profile: profile() });
      const initialized = await base.initialize();
      let targetId = null;
      if (operation === 'feedback') {
        const target = await base.recordEvents([event('receipt.race.feedback.target')]);
        targetId = target.results[0].event.event_id;
      }
      const beforeChildren = await publishedChildSnapshot(initialized.layout);
      const beforeIdempotency = (await fs.readdir(initialized.layout.collections.idempotency)).length;
      let injected = false;
      const writer = createMemoryStore({
        vaultDir: vault,
        profile: profile(),
        async faultInjector(stage, metadata) {
          if (injected || stage !== 'after_journal_create') return;
          injected = true;
          const collision = {
            schema: 'safire.memory.batch-receipt/v1',
            schema_version: 1,
            vault_id: initialized.manifest.vault_id,
            protocol: 'guard-receipt/v1',
            operation: `${operation}_batch`,
            transaction_id: `${operation}_batch:${metadata.batch_id}`,
            batch_id: metadata.batch_id,
            transaction_count: 1,
            transaction_digest: '0'.repeat(64),
            committed_at: '2026-08-14T17:00:00.000Z',
            members: [],
          };
          collision.integrity = { algorithm: 'sha256', digest: digestRecord(collision) };
          await createImmutableJson(
            initialized.layout,
            'idempotency',
            `batch-receipt:${metadata.batch_id}`,
            collision,
          );
        },
      });
      const write = operation === 'event'
        ? () => writer.recordEvents([event('receipt.race.event.new')])
        : () => writer.recordFeedback([
          feedback({ type: 'event', id: targetId }, 'receipt.race.feedback.new'),
        ]);

      await assert.rejects(write, error => error?.code === 'MEMORY_ID_CONFLICT');
      assert.equal(injected, true);
      assert.deepEqual(await publishedChildSnapshot(initialized.layout), beforeChildren);
      assert.equal(
        (await fs.readdir(initialized.layout.collections.idempotency)).length,
        beforeIdempotency + 1,
      );
      const preservedJournals = await journalArtifactSnapshot(initialized.layout);
      const preservedRecords = await recordArtifactSnapshot(initialized.layout);
      assert.ok(preservedJournals.length > 0);
      await assert.rejects(
        () => createMemoryStore({ vaultDir: vault, profile: profile() }).status(),
        error => error?.code === 'MEMORY_ID_CONFLICT',
      );
      assert.deepEqual(await journalArtifactSnapshot(initialized.layout), preservedJournals);
      assert.deepEqual(await recordArtifactSnapshot(initialized.layout), preservedRecords);
    });
  }
});

test('a sealed event batch containing a feedback child fails closed as a malformed mixed journal', async (t) => {
  const eventPending = await interruptEventBatch(t, 'mixed-event');
  const feedbackPending = await interruptFeedbackBatch(t, 'mixed-feedback');
  eventPending.journal.transactions[1] = feedbackPending.journal.transactions[1];
  delete eventPending.journal.integrity;
  eventPending.journal.integrity = {
    algorithm: 'sha256',
    digest: digestRecord(eventPending.journal),
  };
  await fs.writeFile(eventPending.journalPath, serializeJson(eventPending.journal), 'utf8');
  assert.equal(digestJson(eventPending.journal), digestJson(JSON.parse(
    await fs.readFile(eventPending.journalPath, 'utf8'),
  )));
  await fs.rm(eventPending.guardDir, { recursive: true });

  await expectStatusFailsClosed(eventPending.vault);
});

test('a resealed receipt with duplicate malformed members fails closed with a controlled error', async (t) => {
  const vault = await temporaryVault(t, 'safire-journal-malformed-receipt-');
  const store = createMemoryStore({ vaultDir: vault, profile: profile() });
  const created = await store.recordEvents([event('receipt.one'), event('receipt.two')]);
  const layout = await ensureMemoryLayout(vault);
  const receiptDirectory = layout.collections.idempotency;
  let receiptPath = null;
  let receipt = null;
  for (const name of await fs.readdir(receiptDirectory)) {
    const candidatePath = path.join(receiptDirectory, name);
    const candidate = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
    if (candidate.schema !== 'safire.memory.batch-receipt/v1') continue;
    receiptPath = candidatePath;
    receipt = candidate;
    break;
  }
  assert.ok(receiptPath);
  receipt.members[1] = { ...receipt.members[0] };
  delete receipt.integrity;
  receipt.integrity = { algorithm: 'sha256', digest: digestRecord(receipt) };
  await fs.writeFile(receiptPath, serializeJson(receipt), 'utf8');

  const reopened = createMemoryStore({ vaultDir: vault, profile: profile() });
  await assert.rejects(
    () => reopened.get(created.results[0].event.event_id),
    isSanitizedTransactionError,
  );
});
