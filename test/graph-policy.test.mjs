import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GRAPH_STORAGE_LIMITS,
  createGraphResponseBudget,
  indexNoteReadPolicy,
  readBoundedIndexNote,
  scanBoundedGraphWikiLinks,
  selectGraphNotePaths,
} from '../lib/graph-policy.mjs';

test('active graph note deterministically replaces the last ordinary page entry', () => {
  const paths = Array.from({ length: 1_500 }, (_, index) => `${String(index).padStart(4, '0')}.md`);
  const selected = selectGraphNotePaths(paths, '1499.md');

  assert.equal(selected.length, GRAPH_STORAGE_LIMITS.notes);
  assert.ok(selected.includes('1499.md'));
  assert.ok(!selected.includes('0999.md'));
  assert.deepEqual(selected, selected.slice().sort((left, right) => left.localeCompare(right)));
  assert.deepEqual(selectGraphNotePaths(paths, '1499.md'), selected);
  assert.deepEqual(selectGraphNotePaths(paths, 'outside.md'), paths.slice(0, GRAPH_STORAGE_LIMITS.notes));
});

test('bounded graph wiki-link scanning rejects oversized target and label fields without copying them', () => {
  const oversized = 'Z'.repeat(GRAPH_STORAGE_LIMITS.linkFieldCharacters + 1);
  const result = scanBoundedGraphWikiLinks([
    '[[Safe target]]',
    `[[${oversized}]]`,
    `[[Safe target|${oversized}]]`,
    '[[Other#anchor|Small label]]',
  ].join('\n'));

  assert.deepEqual(result.targets, ['Safe target', 'Other']);
  assert.equal(result.observed, 4);
  assert.equal(result.omitted, 2);
  assert.equal(result.complete, false);
  assert.equal(result.observationsComplete, true);
  assert.ok(result.targets.every(target => target.length <= GRAPH_STORAGE_LIMITS.linkFieldCharacters));

  const multibyte = scanBoundedGraphWikiLinks(`[[${'€'.repeat(GRAPH_STORAGE_LIMITS.linkFieldCharacters)}]]`);
  assert.deepEqual(multibyte.targets, []);
  assert.equal(multibyte.omitted, 1);

  const observationLimited = scanBoundedGraphWikiLinks('[[Same]]\n'.repeat(5), 4);
  assert.equal(observationLimited.observed, 4);
  assert.equal(observationLimited.omitted, 0);
  assert.equal(observationLimited.observationsComplete, false);
  assert.equal(observationLimited.complete, false);
});

test('graph response item budget rejects a single oversized item and caps aggregate bytes', () => {
  const budget = createGraphResponseBudget();
  const accepted = [];
  const ordinary = { id: 'link', source: 'Root.md', target: 'Target.md', label: 'Target' };
  while (budget.tryAppend(accepted, ordinary)) { /* fill the deterministic byte budget */ }

  assert.ok(accepted.length > 0);
  assert.ok(budget.bytes <= GRAPH_STORAGE_LIMITS.responseBytes);
  assert.equal(budget.truncated, true);
  assert.equal(budget.tryAppend(accepted, { label: '€'.repeat(GRAPH_STORAGE_LIMITS.linkFieldCharacters) }), false);
  assert.ok(Buffer.byteLength(JSON.stringify({ nodes: [], links: accepted, meta: {} })) <= GRAPH_STORAGE_LIMITS.responseBytes);
});

test('graph storage limits bound imported note reads and individual response fields', () => {
  assert.ok(GRAPH_STORAGE_LIMITS.noteBytes > 0);
  assert.ok(GRAPH_STORAGE_LIMITS.linkFieldBytes > 0);
  assert.ok(GRAPH_STORAGE_LIMITS.responseBytes > GRAPH_STORAGE_LIMITS.linkFieldBytes);
  assert.deepEqual(indexNoteReadPolicy(GRAPH_STORAGE_LIMITS.noteBytes), {
    readContent: true,
    contentOmitted: false,
    reason: '',
  });
  assert.deepEqual(indexNoteReadPolicy(GRAPH_STORAGE_LIMITS.noteBytes + 1), {
    readContent: false,
    contentOmitted: true,
    reason: 'note-byte-limit',
  });
  assert.equal(indexNoteReadPolicy(Number.NaN).readContent, false);
});

test('bounded index reads omit oversized and changing files without allocating their full contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-graph-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const ordinaryPath = path.join(directory, 'ordinary.md');
  await fs.writeFile(ordinaryPath, '# Ordinary\n', 'utf8');
  const ordinary = await readBoundedIndexNote(fs, ordinaryPath);
  assert.equal(ordinary.content, '# Ordinary\n');
  assert.equal(ordinary.contentOmitted, false);
  assert.equal(ordinary.bytesConsumed, Buffer.byteLength('# Ordinary\n'));

  const oversizedPath = path.join(directory, 'oversized.md');
  const oversizedHandle = await fs.open(oversizedPath, 'w');
  await oversizedHandle.truncate(GRAPH_STORAGE_LIMITS.noteBytes + 1);
  await oversizedHandle.close();
  const oversized = await readBoundedIndexNote(fs, oversizedPath);
  assert.equal(oversized.content, '');
  assert.equal(oversized.contentOmitted, true);
  assert.equal(oversized.reason, 'note-byte-limit');
  assert.equal(oversized.bytesConsumed, 0);

  const snapshot = await fs.stat(ordinaryPath);
  let statCalls = 0;
  const changingHandle = {
    async stat() {
      statCalls += 1;
      return statCalls === 1
        ? snapshot
        : { ...snapshot, size: snapshot.size + 1, isFile: () => true };
    },
    async read(buffer) {
      buffer.write('# Ordinary\n');
      return { bytesRead: snapshot.size };
    },
    async close() {},
  };
  const changingFs = {
    open: async () => changingHandle,
    lstat: async () => snapshot,
  };
  const changing = await readBoundedIndexNote(changingFs, ordinaryPath);
  assert.equal(changing.content, '');
  assert.equal(changing.contentOmitted, true);
  assert.equal(changing.reason, 'changed-during-read');
  assert.equal(changing.bytesConsumed, snapshot.size);
});
