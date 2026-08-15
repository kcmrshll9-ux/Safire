import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startSafireServer } from '../server.mjs';
import { GRAPH_STORAGE_LIMITS } from '../lib/graph-policy.mjs';

function sameTestPath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight;
}

async function waitForTestBarrier(promise, label, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withServer(t, run) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-12-test-'));
  const started = await startSafireServer({ vaultDir: vault, port: 0 });
  t.after(async () => {
    await new Promise(resolve => started.server.close(resolve));
    await fs.rm(vault, { recursive: true, force: true });
  });
  const health = await fetch(`${started.url}/api/health`).then(res => res.json());
  const [actualVault, expectedVault] = await Promise.all([
    fs.realpath(started.vault),
    fs.realpath(vault),
  ]);
  const normalizeIdentity = value => process.platform === 'win32'
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
  assert.equal(
    normalizeIdentity(actualVault),
    normalizeIdentity(expectedVault),
    'test server must use only its temporary vault internally',
  );
  assert.equal(health.vault, path.basename(vault), 'public health response must expose only the vault label');
  return run({ vault, ...started });
}

test('Safire server can be scoped to a temporary vault', async (t) => {
  await withServer(t, async ({ url }) => {
    const response = await fetch(`${url}/api/workspace`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      pinnedNotes: [],
      recentNotes: [],
      savedSearches: [],
    });
  });
});

test('HTTP note mutations serialize accepted writes and publish complete unique backups', async (t) => {
  await withServer(t, async ({ url }) => {
    const initialVersions = Array.from({ length: 32 }, (_value, index) => `creator-${index}\n`);
    const creates = await Promise.all(initialVersions.map((content) => fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Concurrent.md', content }),
    })));
    assert.equal(creates.filter((response) => response.status === 201).length, 1);
    assert.equal(creates.filter((response) => response.status === 409).length, 31);

    const acceptedInitial = (await fetch(`${url}/api/note?path=Concurrent.md`).then((response) => response.json())).content;
    assert.equal(initialVersions.includes(acceptedInitial), true);
    const updates = Array.from({ length: 32 }, (_value, index) => `update-${index}\n`);
    const updated = await Promise.all(updates.map((content) => fetch(`${url}/api/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Concurrent.md', content }),
    })));
    assert.equal(updated.every((response) => response.status === 200), true);

    const final = (await fetch(`${url}/api/note?path=Concurrent.md`).then((response) => response.json())).content;
    const listed = await fetch(`${url}/api/backups?path=Concurrent.md`).then((response) => response.json());
    assert.equal(listed.backups.length, updates.length);
    assert.equal(listed.backups.every((backup) => backup.size > 0), true);
    assert.equal(new Set(listed.backups.map((backup) => backup.id)).size, listed.backups.length);
    const backupContents = await Promise.all(listed.backups.map((backup) => fetch(`${url}/api/backup?id=${encodeURIComponent(backup.id)}`).then((response) => response.json()).then((body) => body.content)));
    assert.deepEqual(new Set([final, ...backupContents]), new Set([acceptedInitial, ...updates]));

    const missingUpdate = await fetch(`${url}/api/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Missing.md', content: 'must not be created' }),
    });
    assert.equal(missingUpdate.status, 400);
    assert.equal((await missingUpdate.json()).error, 'The requested item was not found');
  });
});

test('HTTP create and note rename cannot both succeed for the same destination', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-http-rename-race-'));
  let gate;
  const gatedFs = {
    ...fs,
    async open(target, flags, mode) {
      if (gate && !gate.consumed && flags === 'wx' && sameTestPath(target, gate.target)) {
        gate.consumed = true;
        gate.started();
        await gate.wait;
      }
      return fs.open(target, flags, mode);
    },
  };
  const started = await startSafireServer({
    vaultDir: vault,
    port: 0,
    log: () => {},
    noteMutationOptions: { fsApi: gatedFs },
  });
  t.after(async () => {
    await new Promise((resolve) => started.server.close(resolve));
    await fs.rm(vault, { recursive: true, force: true });
  });

  async function scenario(createFirst) {
    const suffix = createFirst ? 'create-first' : 'rename-first';
    const sourceRel = `Source-${suffix}.md`;
    const destinationRel = `Destination-${suffix}.md`;
    await fs.writeFile(path.join(vault, sourceRel), `source-${suffix}`, 'utf8');
    let markStarted;
    const destinationOpenStarted = new Promise((resolve) => { markStarted = resolve; });
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    gate = {
      consumed: false,
      started: markStarted,
      target: path.resolve(started.vault, destinationRel),
      wait,
    };
    const create = () => fetch(`${started.url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: destinationRel, content: `created-${suffix}` }),
    });
    const rename = () => fetch(`${started.url}/api/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sourceRel, to: destinationRel }),
    });
    const first = createFirst ? create() : rename();
    try {
      await waitForTestBarrier(destinationOpenStarted, 'the destination publication barrier');
      const second = createFirst ? rename() : create();
      release();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      assert.equal(firstResponse.status, createFirst ? 201 : 200);
      assert.equal(secondResponse.status, 409);
      if (createFirst) {
        assert.equal(await fs.readFile(path.join(vault, destinationRel), 'utf8'), `created-${suffix}`);
        assert.equal(await fs.readFile(path.join(vault, sourceRel), 'utf8'), `source-${suffix}`);
      } else {
        assert.equal(await fs.readFile(path.join(vault, destinationRel), 'utf8'), `source-${suffix}`);
        await assert.rejects(() => fs.access(path.join(vault, sourceRel)), { code: 'ENOENT' });
      }
    } finally {
      release();
    }
  }

  await scenario(true);
  await scenario(false);
});

test('HTTP folder rename preserves descendant notes under coordinated mutation', async (t) => {
  await withServer(t, async ({ url }) => {
    const folder = await fetch(`${url}/api/folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Original/Subfolder' }),
    });
    assert.equal(folder.status, 201);
    const note = await fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Original/Subfolder/Note.md', content: 'preserved descendant' }),
    });
    assert.equal(note.status, 201);
    const renamed = await fetch(`${url}/api/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Original', to: 'Renamed' }),
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { ok: true, from: 'Original', to: 'Renamed' });
    const moved = await fetch(`${url}/api/note?path=${encodeURIComponent('Renamed/Subfolder/Note.md')}`);
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).content, 'preserved descendant');
  });
});

test('Safire graph resolves paths deterministically and reports note topology metadata', async (t) => {
  await withServer(t, async ({ url }) => {
    const createNote = async (notePath, content) => {
      const response = await fetch(`${url}/api/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: notePath, content }),
      });
      assert.equal(response.status, 201);
    };
    const planContent = '# Plan\n\n#project\n';
    await createNote('Projects/Plan.md', planContent);
    await createNote('Alpha/Twin.md', '# Alpha twin\n');
    await createNote('Beta/Twin.md', '# Beta twin\n');
    await createNote('Lonely.md', '# Lonely\n');
    await createNote('Links.md', '# Links\n\n[[Projects/Plan]]\n[[Projects/Plan.md]]\n[[Plan.md]]\n[[Twin]]\n[[Never Created]]\n');

    const graph = await fetch(`${url}/api/graph`).then(res => res.json());
    assert.deepEqual(graph.meta, {
      sourceNotes: 7,
      sourceLinks: 7,
      sourceLinksComplete: true,
      returnedNotes: 7,
      returnedLinks: 7,
      omittedNoteContent: 0,
      omittedLinkFields: 0,
      responseBytes: Buffer.byteLength(JSON.stringify(graph), 'utf8'),
      truncated: false,
    });
    assert.ok(graph.meta.responseBytes <= GRAPH_STORAGE_LIMITS.responseBytes);
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const links = graph.links.filter(link => link.source === 'Links.md');
    const linksByLabel = new Map(links.map(link => [link.label, link]));

    assert.deepEqual(
      ['Projects/Plan', 'Projects/Plan.md', 'Plan.md'].map(label => ({
        target: linksByLabel.get(label).target,
        resolved: linksByLabel.get(label).resolved,
        resolution: linksByLabel.get(label).resolution,
      })),
      [
        { target: 'Projects/Plan.md', resolved: true, resolution: 'exact-path' },
        { target: 'Projects/Plan.md', resolved: true, resolution: 'exact-path' },
        { target: 'Projects/Plan.md', resolved: true, resolution: 'unique-title' },
      ],
    );
    assert.deepEqual(
      { target: linksByLabel.get('Twin').target, resolved: linksByLabel.get('Twin').resolved, resolution: linksByLabel.get('Twin').resolution },
      { target: 'Twin.md', resolved: false, resolution: 'ambiguous' },
    );
    assert.deepEqual(
      { target: linksByLabel.get('Never Created').target, resolved: linksByLabel.get('Never Created').resolved, resolution: linksByLabel.get('Never Created').resolution },
      { target: 'Never Created.md', resolved: false, resolution: 'missing' },
    );
    assert.equal(new Set(links.map(link => link.id)).size, links.length);

    const plan = nodes.get('Projects/Plan.md');
    assert.equal(plan.label, 'Plan');
    assert.deepEqual(plan.tags, ['project']);
    assert.equal(plan.folder, 'Projects');
    assert.equal(plan.size, Buffer.byteLength(planContent));
    assert.equal(Number.isFinite(plan.mtime), true);
    assert.deepEqual(
      { inDegree: plan.inDegree, outDegree: plan.outDegree, degree: plan.degree, orphan: plan.orphan },
      { inDegree: 3, outDegree: 0, degree: 3, orphan: false },
    );
    assert.deepEqual(
      { inDegree: nodes.get('Lonely.md').inDegree, outDegree: nodes.get('Lonely.md').outDegree, degree: nodes.get('Lonely.md').degree, orphan: nodes.get('Lonely.md').orphan },
      { inDegree: 0, outDegree: 0, degree: 0, orphan: true },
    );
    assert.equal(nodes.get('Alpha/Twin.md').orphan, true);
    assert.equal(nodes.get('Beta/Twin.md').orphan, true);

    const backlinks = await fetch(`${url}/api/backlinks?path=${encodeURIComponent('Projects/Plan.md')}`).then(res => res.json());
    assert.deepEqual(backlinks.backlinks.map(note => note.path), ['Links.md']);
    const health = await fetch(`${url}/api/vault-health`).then(res => res.json());
    assert.deepEqual(health.missingLinks.map(link => link.target).sort(), ['Never Created', 'Twin']);
    assert.equal(health.orphanNotes.includes('Lonely.md'), true);
    assert.equal(health.orphanNotes.includes('Projects/Plan.md'), false);
  });
});

test('Safire graph response applies deterministic note and link budgets', async (t) => {
  await withServer(t, async ({ vault, url }) => {
    const graphFolder = path.join(vault, 'Graph Budget');
    await fs.mkdir(graphFolder, { recursive: true });
    const unresolved = Array.from({ length: 2001 }, (_value, index) => `[[Missing ${String(index).padStart(4, '0')}]]`);
    const tags = Array.from({ length: 40 }, (_value, index) => `#tag-${String(index).padStart(2, '0')}`).join(' ');
    const source = ['# Budget source', tags, '[[Graph Budget/0001]]', '[[Graph Budget/1001]]', ...unresolved].join('\n');
    const writes = [fs.writeFile(path.join(graphFolder, '0000.md'), source, 'utf8')];
    for (let index = 1; index <= 1001; index += 1) {
      writes.push(fs.writeFile(path.join(graphFolder, `${String(index).padStart(4, '0')}.md`), `# ${index}\n`, 'utf8'));
    }
    await Promise.all(writes);

    const first = await fetch(`${url}/api/graph`).then(response => response.json());
    const second = await fetch(`${url}/api/graph`).then(response => response.json());
    assert.deepEqual(first, second, 'budgeted graph selection must be deterministic');
    assert.deepEqual(first.meta, {
      sourceNotes: 1004,
      sourceLinks: 2003,
      sourceLinksComplete: false,
      returnedNotes: 1000,
      returnedLinks: 2000,
      omittedNoteContent: 0,
      omittedLinkFields: 0,
      responseBytes: Buffer.byteLength(JSON.stringify(first), 'utf8'),
      truncated: true,
    });
    assert.equal(first.nodes.length, 1000);
    assert.equal(first.links.length, 2000);
    assert.deepEqual(first.nodes.find(node => node.id === 'Graph Budget/0000.md').tags, Array.from({ length: 32 }, (_value, index) => `tag-${String(index).padStart(2, '0')}`));
    assert.equal(first.links.some(link => link.resolved && link.target === 'Graph Budget/1001.md'), false);
    assert.equal(first.links.every(link => !link.resolved || first.nodes.some(node => node.id === link.target)), true);
    assert.ok(first.meta.responseBytes <= GRAPH_STORAGE_LIMITS.responseBytes);

    const active = await fetch(`${url}/api/graph?active=${encodeURIComponent('Graph Budget/1001.md')}`).then(response => response.json());
    assert.equal(active.nodes.length, GRAPH_STORAGE_LIMITS.notes);
    assert.equal(active.nodes.some(node => node.id === 'Graph Budget/1001.md'), true);
    assert.equal(active.nodes.some(node => node.id === 'Graph Budget/0999.md'), false);
    assert.ok(active.meta.responseBytes <= GRAPH_STORAGE_LIMITS.responseBytes);

    const invalidActive = await fetch(`${url}/api/graph?active=${encodeURIComponent('../outside.md')}`).then(response => response.json());
    const missingActive = await fetch(`${url}/api/graph?active=${encodeURIComponent('Graph Budget/Missing.md')}`).then(response => response.json());
    assert.deepEqual(invalidActive, first, 'outside active paths must not alter or disclose the graph page');
    assert.deepEqual(missingActive, first, 'missing active paths must be indistinguishable from the default graph page');
  });
});

test('Safire index and graph omit oversized imported note bodies while explicit reads remain available', async (t) => {
  await withServer(t, async ({ vault, url }) => {
    const privateMarker = 'OVERSIZED-IMPORTED-NOTE-MARKER';
    const oversizedTarget = 'Z'.repeat(GRAPH_STORAGE_LIMITS.noteBytes + 1);
    const oversizedContent = `# Oversized\n\n${privateMarker}\n[[${oversizedTarget}]]\n`;
    await fs.writeFile(path.join(vault, 'Oversized.md'), oversizedContent, 'utf8');

    const listed = await fetch(`${url}/api/notes`).then(response => response.json());
    const metadata = listed.notes.find(note => note.path === 'Oversized.md');
    assert.equal(metadata.contentOmitted, true);
    assert.deepEqual({ tags: metadata.tags, links: metadata.links, excerpt: metadata.excerpt }, { tags: [], links: [], excerpt: '' });
    assert.equal(listed.meta.contentOmitted, 1);

    const searched = await fetch(`${url}/api/search?q=${encodeURIComponent(privateMarker)}`).then(response => response.json());
    assert.deepEqual(searched.results, []);

    const graph = await fetch(`${url}/api/graph?active=${encodeURIComponent('Oversized.md')}`).then(response => response.json());
    assert.equal(graph.nodes.some(node => node.id === 'Oversized.md'), true);
    assert.equal(graph.links.some(link => String(link.label).includes(privateMarker)), false);
    assert.ok(graph.meta.omittedNoteContent >= 1);
    assert.equal(graph.meta.truncated, true);
    assert.equal(graph.meta.responseBytes, Buffer.byteLength(JSON.stringify(graph), 'utf8'));
    assert.ok(graph.meta.responseBytes <= GRAPH_STORAGE_LIMITS.responseBytes);

    const explicit = await fetch(`${url}/api/note?path=${encodeURIComponent('Oversized.md')}`).then(response => response.json());
    assert.equal(explicit.content, oversizedContent);
  });
});

test('Safire graph marks source-link totals incomplete when the observation ceiling is reached', async (t) => {
  await withServer(t, async ({ vault, url }) => {
    await fs.writeFile(
      path.join(vault, 'Duplicate Links.md'),
      `# Duplicate links\n${'[[Repeated Target]]\n'.repeat(GRAPH_STORAGE_LIMITS.observedLinks + 1)}`,
      'utf8',
    );

    const graph = await fetch(`${url}/api/graph`).then(response => response.json());
    assert.equal(graph.meta.sourceLinks, GRAPH_STORAGE_LIMITS.observedLinks);
    assert.equal(graph.meta.sourceLinksComplete, false);
    assert.equal(graph.meta.truncated, true);
    assert.equal(graph.links.filter(link => link.source === 'Duplicate Links.md').length, 1);
    assert.ok(graph.meta.responseBytes <= GRAPH_STORAGE_LIMITS.responseBytes);
  });
});

test('Safire graph retains the requested active note when response bytes truncate other nodes', async (t) => {
  await withServer(t, async ({ vault, url }) => {
    const largeTags = Array.from({ length: GRAPH_STORAGE_LIMITS.tagsPerNote }, (_value, index) => (
      `#tag${String(index).padStart(2, '0')}${'x'.repeat(980)}`
    )).join(' ');
    const writes = Array.from({ length: 66 }, (_value, index) => fs.writeFile(
      path.join(vault, `A Heavy ${String(index).padStart(2, '0')}.md`),
      `# Heavy ${index}\n${largeTags}\n`,
      'utf8',
    ));
    writes.push(fs.writeFile(path.join(vault, 'Z Active.md'), '# Active\n', 'utf8'));
    await Promise.all(writes);

    const graph = await fetch(`${url}/api/graph?active=${encodeURIComponent('Z Active.md')}`).then(response => response.json());
    assert.equal(graph.nodes.some(node => node.id === 'Z Active.md'), true);
    assert.equal(graph.meta.truncated, true);
    assert.equal(
      graph.nodes.some(node => node.id.startsWith('A Heavy ') && node.tags.length === 0)
        || graph.meta.returnedNotes < graph.meta.sourceNotes,
      true,
      'the response budget must omit lower-priority node fields or nodes before the active note',
    );
    assert.equal(graph.meta.responseBytes, Buffer.byteLength(JSON.stringify(graph), 'utf8'));
    assert.ok(graph.meta.responseBytes <= GRAPH_STORAGE_LIMITS.responseBytes);
  });
});

test('Safire graph ignores tags and wikilinks inside fenced code and private evidence', async (t) => {
  await withServer(t, async ({ url }) => {
    const content = [
      '# Visible graph note',
      '',
      '#public-tag [[Public Target]]',
      '',
      '```md',
      '#hidden-code [[Hidden Code Target]]',
      '```',
      '',
      '~~~text',
      '#hidden-tilde [[Hidden Tilde Target]]',
      '~~~',
      '',
      '`#hidden-inline [[Hidden Inline Target]]`',
      '',
      '> ```md',
      '> #hidden-quote [[Hidden Quote Target]]',
      '> ```',
      '',
      '```safire-evidence',
      'id: "private-graph"',
      'claim: "Graph privacy"',
      'private_notes: "secret #private-tag [[Private Target]]"',
      '```',
      '',
    ].join('\n');
    for (const [notePath, noteContent] of [['Private Graph.md', content], ['Public Target.md', '# Public target\n']]) {
      const response = await fetch(`${url}/api/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: notePath, content: noteContent }),
      });
      assert.equal(response.status, 201);
    }

    const graph = await fetch(`${url}/api/graph`).then(res => res.json());
    const node = graph.nodes.find(candidate => candidate.id === 'Private Graph.md');
    const links = graph.links.filter(link => link.source === 'Private Graph.md');
    assert.deepEqual(node.tags, ['public-tag']);
    assert.deepEqual(links.map(link => link.label), ['Public Target']);
    assert.equal(links[0].target, 'Public Target.md');
    assert.equal(links[0].resolved, true);
    assert.doesNotMatch(JSON.stringify({ node, links }), /hidden-code|hidden-tilde|hidden-inline|hidden-quote|private-tag|Hidden Code Target|Hidden Tilde Target|Hidden Inline Target|Hidden Quote Target|Private Target|secret/);
  });
});

test('Safire aggregates and toggles Markdown tasks without reading fenced code', async (t) => {
  await withServer(t, async ({ url }) => {
    await fetch(`${url}/api/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Projects/Tasks.md', content: '# Tasks\n\n- [ ] First task\n- [x] Finished task\n```md\n- [ ] Not a task\n```\n' }) });
    const tasks = await fetch(`${url}/api/tasks?state=open`).then(res => res.json());
    assert.deepEqual(tasks.tasks.map(task => task.text), ['First task']);
    const toggle = await fetch(`${url}/api/task/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Projects/Tasks.md', line: 3 }) });
    assert.equal(toggle.status, 200);
    const completed = await fetch(`${url}/api/tasks?state=completed`).then(res => res.json());
    assert.deepEqual(completed.tasks.map(task => task.text).sort(), ['Finished task', 'First task']);

    const privateContent = [
      '# Private task fixture',
      '',
      '> ```safire-evidence',
      '> private_notes: |',
      '- [ ] SYNTHETIC-PRIVATE-TASK #private-task [[Private Task Link]]',
      '> ```',
      '',
      '- [ ] Public task',
      '',
    ].join('\n');
    const created = await fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Private Tasks.md', content: privateContent }),
    });
    assert.equal(created.status, 201);
    const allTasks = await fetch(`${url}/api/tasks?state=all`).then(res => res.json());
    assert.equal(allTasks.tasks.some(task => /SYNTHETIC-PRIVATE-TASK|private-task|Private Task Link/.test(task.text)), false);
    assert.equal(allTasks.tasks.some(task => task.path === 'Private Tasks.md' && task.text === 'Public task' && task.line === 8), true);

    const rejectedToggle = await fetch(`${url}/api/task/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Private Tasks.md', line: 5 }),
    });
    assert.equal(rejectedToggle.status, 400);
    assert.equal(await fetch(`${url}/api/note?path=${encodeURIComponent('Private Tasks.md')}`).then(res => res.json()).then(body => body.content), privateContent);
    assert.deepEqual(await fetch(`${url}/api/backups?path=${encodeURIComponent('Private Tasks.md')}`).then(res => res.json()).then(body => body.backups), []);
  });
});

test('HTTP metadata, search, and task toggles fail closed for list-contained evidence', async (t) => {
  await withServer(t, async ({ url }) => {
    const noteContent = [
      '# HTTP list evidence',
      '1. ~~~safire-evidence',
      '   id: http-list-public',
      '   claim: HTTP public list claim #http-list-public [[HTTP List Public]]',
      '   private_notes: |-',
      '     - [ ] HTTP-LIST-PRIVATE-TASK #http-list-private [[HTTP List Private]]',
      '   ~~~',
      '- [ ] HTTP public outside task',
      '> - ~~~safire-evidence extra',
      '>   claim: HTTP-MALFORMED-LIST-PUBLIC',
      '>   private_notes: HTTP-MALFORMED-LIST-PRIVATE #http-malformed-private [[HTTP Malformed Private]]',
      '>   - [ ] HTTP-MALFORMED-LIST-PRIVATE-TASK',
      '>   ~~~',
    ].join('\r\n');
    const created = await fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'HTTP List Evidence.md', content: noteContent }),
    });
    assert.equal(created.status, 201);

    const listed = await fetch(`${url}/api/notes`).then(response => response.json());
    const metadata = listed.notes.find(note => note.path === 'HTTP List Evidence.md');
    assert.deepEqual(metadata.tags, ['http-list-public']);
    assert.deepEqual(metadata.links, ['HTTP List Public']);
    assert.doesNotMatch(JSON.stringify(metadata), /HTTP-LIST-PRIVATE|http-list-private|HTTP-MALFORMED-LIST|http-malformed-private|HTTP (?:List|Malformed) Private/);

    for (const query of ['HTTP-LIST-PRIVATE-TASK', 'HTTP-MALFORMED-LIST-PUBLIC', 'HTTP-MALFORMED-LIST-PRIVATE']) {
      const searched = await fetch(`${url}/api/search?q=${encodeURIComponent(query)}`).then(response => response.json());
      assert.deepEqual(searched.results, []);
    }
    const publicSearch = await fetch(`${url}/api/search?q=${encodeURIComponent('HTTP public list claim')}`).then(response => response.json());
    assert.equal(publicSearch.results.length, 1);
    assert.equal(publicSearch.results[0].evidence.receipts[0].claim, 'HTTP public list claim #http-list-public [[HTTP List Public]]');
    assert.doesNotMatch(JSON.stringify(publicSearch), /HTTP-LIST-PRIVATE|HTTP-MALFORMED-LIST|HTTP (?:List|Malformed) Private/);

    const tasks = await fetch(`${url}/api/tasks?state=all`).then(response => response.json());
    assert.deepEqual(tasks.tasks.filter(task => task.path === 'HTTP List Evidence.md').map(task => ({ line: task.line, text: task.text })), [
      { line: 8, text: 'HTTP public outside task' },
    ]);

    for (const privateLine of [6, 12]) {
      const rejected = await fetch(`${url}/api/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'HTTP List Evidence.md', line: privateLine }),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error, 'No supported public task exists on that line');
      const stored = await fetch(`${url}/api/note?path=${encodeURIComponent('HTTP List Evidence.md')}`).then(response => response.json());
      assert.equal(stored.content, noteContent);
      const backups = await fetch(`${url}/api/backups?path=${encodeURIComponent('HTTP List Evidence.md')}`).then(response => response.json());
      assert.deepEqual(backups.backups, []);
    }
  });
});

test('Safire captures ideas and instantiates portable Markdown templates', async (t) => {
  await withServer(t, async ({ url }) => {
    const capture = await fetch(`${url}/api/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Call trail group', tag: 'ultra' }) });
    assert.equal(capture.status, 201);
    const captured = await capture.json();
    const capturedNote = await fetch(`${url}/api/note?path=${encodeURIComponent(captured.path)}`).then(res => res.json());
    assert.match(capturedNote.content, /Call trail group/);
    assert.match(capturedNote.content, /#ultra/);

    await fetch(`${url}/api/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Templates/Meeting.md', content: '# {{title}}\n{{date}} {{time}}\n\n- [ ] Follow up\n' }) });
    const templates = await fetch(`${url}/api/templates`).then(res => res.json());
    assert.equal(templates.templates[0].path, 'Templates/Meeting.md');
    const made = await fetch(`${url}/api/template/instantiate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templatePath: 'Templates/Meeting.md', destination: 'Meetings/July.md', title: 'July Meeting' }) });
    assert.equal(made.status, 201);
    const note = await fetch(`${url}/api/note?path=Meetings/July.md`).then(res => res.json());
    assert.match(note.content, /# July Meeting/);
    assert.doesNotMatch(note.content, /{{(title|date|time)}}/);
  });
});

test('Safire indexes portable evidence receipts and filters global search locally', async (t) => {
  await withServer(t, async ({ url }) => {
    const receipt = `\n\`\`\`safire-evidence\nid: "receipt-1"\nclaim: "Daily account balance reviewed"\nsource_type: "url"\nsource: "https://bank.example/checking"\nobserved_at: "2026-07-20T08:30:00.000Z"\naction: "Reviewed the displayed balance"\nverification: "The account page showed the expected balance"\nstatus: "verified"\nfreshness: "2026-08-20T08:30:00.000Z"\nexcerpt: "Balance displayed: $123.45"\nhash: "abc123"\nprivate_notes: "Do not share account details"\n\`\`\`\n\n\`\`\`safire-evidence\nid: "receipt-2"\nclaim: "Old tool result"\nsource_type: "tool_result"\nsource: "local diagnostic"\nobserved_at: "2025-01-01T00:00:00.000Z"\naction: "Ran local diagnostic"\nverification: "Exit code is zero"\nstatus: "stale"\nfreshness: "2025-01-02T00:00:00.000Z"\nexcerpt: "ok"\nhash: ""\nprivate_notes: ""\n\`\`\``;
    const created = await fetch(`${url}/api/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Research/Evidence.md', content: `# Evidence\n${receipt}` }) });
    assert.equal(created.status, 201);

    const indexed = await fetch(`${url}/api/evidence?path=Research/Evidence.md`);
    assert.equal(indexed.status, 200);
    const data = await indexed.json();
    assert.equal(data.receipts.length, 2);
    assert.deepEqual(data.receipts[0], {
      id: 'receipt-1', claim: 'Daily account balance reviewed', sourceType: 'url', source: 'https://bank.example/checking', observedAt: '2026-07-20T08:30:00.000Z', action: 'Reviewed the displayed balance', verification: 'The account page showed the expected balance', status: 'verified', freshness: '2026-08-20T08:30:00.000Z', excerpt: 'Balance displayed: $123.45', hash: 'abc123', privateNotes: 'Do not share account details', expired: false,
    });

    const verified = await fetch(`${url}/api/search?status=verified&source=url&from=2026-07-01&to=2026-07-31`).then(res => res.json());
    assert.deepEqual(verified.results.map(note => note.path), ['Research/Evidence.md']);
    assert.equal(verified.results[0].evidence.receipts.length, 1);
    assert.equal(verified.results[0].evidence.receipts[0].privateNotes, undefined);
    assert.equal(verified.results[0].evidence.receipts[0].source, undefined);
    assert.doesNotMatch(JSON.stringify(verified), /Do not share account details/);
    const stale = await fetch(`${url}/api/search?state=stale`).then(res => res.json());
    assert.equal(stale.results[0].evidence.stale, 1);
    const expired = await fetch(`${url}/api/search?expired=true`).then(res => res.json());
    assert.equal(expired.results[0].evidence.expired, 1);
  });
});

test('Safire keeps evidence private notes out of generic search metadata', async (t) => {
  await withServer(t, async ({ url }) => {
    const content = `# Public claim\n\n\`\`\`safire-evidence\nid: "private-search"\nclaim: "Visible claim"\nsource_type: "manual_observation"\nstatus: "verified"\nprivate_notes: "TOP-SECRET-PRIVATE-NOTE #leakedtag [[Leaked Link]]"\n\`\`\``;
    await fetch(`${url}/api/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Private.md', content }) });
    const privateQuery = await fetch(`${url}/api/search?q=TOP-SECRET-PRIVATE-NOTE`).then(res => res.json());
    assert.deepEqual(privateQuery.results, []);
    const publicQuery = await fetch(`${url}/api/search?q=Visible`).then(res => res.json());
    assert.deepEqual(publicQuery.results[0].tags, []);
    assert.deepEqual(publicQuery.results[0].links, []);
    assert.doesNotMatch(JSON.stringify(publicQuery), /TOP-SECRET-PRIVATE-NOTE|leakedtag|Leaked Link/);
  });
});

test('Safire excludes structural private evidence from note metadata and search', async (t) => {
  await withServer(t, async ({ url }) => {
    const privateTerms = [
      'LITERAL-PRIVATE',
      'FOLDED-PRIVATE',
      'INDENTED-PRIVATE',
      'QUOTED-PRIVATE',
      'MALFORMED-PRIVATE',
      'LEGACY-PRIVATE',
      'RESERVED-PRIVATE-CLAIM',
    ];
    const content = [
      '# Public note',
      '',
      '#outside [[Outside Link]]',
      '',
      '```safire-evidence',
      'id: "first"',
      'claim: >-',
      '  Visible multiline claim #receipt-tag [[Receipt Link]]',
      'private_notes: |',
      '  LITERAL-PRIVATE #literal-private [[Literal Private Link]]',
      '  claim: RESERVED-PRIVATE-CLAIM',
      '  source_type: url',
      '  status: conflicting',
      'notes: >+',
      '  FOLDED-PRIVATE #folded-private [[Folded Private Link]]',
      'private_notes: |2-',
      '  INDENTED-PRIVATE #indented-private [[Indented Private Link]]',
      '```',
      '',
      '```safire-evidence',
      'id: "second"',
      'claim: "Visible quoted claim"',
      'private_notes: "QUOTED-PRIVATE',
      '  #quoted-private [[Quoted Private Link]]"',
      'notes: "MALFORMED-PRIVATE',
      '  #malformed-private [[Malformed Private Link]]',
      'label: "Visible fallback label"',
      '"private_notes": "LEGACY-PRIVATE #legacy-private [[Legacy Private Link]]"',
      '```',
    ].join('\r\n');
    const created = await fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Structural Privacy.md', content }),
    });
    assert.equal(created.status, 201);

    const listed = await fetch(`${url}/api/notes`).then(response => response.json());
    const listMetadata = listed.notes.find(note => note.path === 'Structural Privacy.md');
    assert.deepEqual(listMetadata.tags, ['outside', 'receipt-tag']);
    assert.deepEqual(listMetadata.links, ['Outside Link', 'Receipt Link']);

    const opened = await fetch(`${url}/api/note?path=${encodeURIComponent('Structural Privacy.md')}`).then(response => response.json());
    assert.deepEqual(opened.tags, ['outside', 'receipt-tag']);
    assert.deepEqual(opened.links, ['Outside Link', 'Receipt Link']);

    for (const privateTerm of privateTerms) {
      const result = await fetch(`${url}/api/search?q=${encodeURIComponent(privateTerm)}`).then(response => response.json());
      assert.deepEqual(result.results, [], `${privateTerm} must not be searchable`);
    }
    const publicSearch = await fetch(`${url}/api/search?q=Visible`).then(response => response.json());
    const publicResult = publicSearch.results.find(note => note.path === 'Structural Privacy.md');
    assert.deepEqual(publicResult.tags, ['outside', 'receipt-tag']);
    assert.deepEqual(publicResult.links, ['Outside Link', 'Receipt Link']);

    const genericOutput = JSON.stringify({ listMetadata, opened: { tags: opened.tags, links: opened.links }, publicSearch });
    assert.doesNotMatch(genericOutput, /LITERAL-PRIVATE|FOLDED-PRIVATE|INDENTED-PRIVATE|QUOTED-PRIVATE|MALFORMED-PRIVATE|LEGACY-PRIVATE|RESERVED-PRIVATE-CLAIM/);
    assert.doesNotMatch(genericOutput, /literal-private|folded-private|indented-private|quoted-private|malformed-private|legacy-private|Private Link/);
  });
});

test('Safire search fails closed for malformed private quoted evidence', async (t) => {
  await withServer(t, async ({ url }) => {
    const content = [
      '# Outside public text #outside [[Outside Link]]',
      '',
      '```safire-evidence',
      'id: "malformed-quote"',
      'private_notes: "PRIVATE-PREFIX',
      'claim: PRIVATE-CONTINUATION #private-tag [[Private Link]]',
      'status: "verified"',
      '```',
    ].join('\n');
    const created = await fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Malformed Evidence.md', content }),
    });
    assert.equal(created.status, 201);

    for (const term of ['PRIVATE-PREFIX', 'PRIVATE-CONTINUATION', 'private-tag', 'Private Link']) {
      const result = await fetch(`${url}/api/search?q=${encodeURIComponent(term)}`).then(response => response.json());
      assert.deepEqual(result.results, [], `${term} must not be searchable`);
    }
    const listed = await fetch(`${url}/api/notes`).then(response => response.json());
    const metadata = listed.notes.find(note => note.path === 'Malformed Evidence.md');
    assert.deepEqual(metadata.tags, ['outside']);
    assert.deepEqual(metadata.links, ['Outside Link']);
    assert.doesNotMatch(metadata.excerpt, /PRIVATE|private-tag|Private Link/);
  });
});

test('Safire generic indexes fail closed for an unclosed evidence fence', async (t) => {
  await withServer(t, async ({ url }) => {
    const content = [
      '# Outside public text #outside [[Outside Link]]',
      '',
      '```safire-evidence',
      'claim: "Visible but interrupted"',
      'private_notes: |',
      '  UNCLOSED-PRIVATE #unclosed-private [[Unclosed Private Link]]',
    ].join('\r\n');
    const created = await fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Unclosed Evidence.md', content }),
    });
    assert.equal(created.status, 201);

    for (const term of ['UNCLOSED-PRIVATE', 'unclosed-private', 'Unclosed Private Link', 'Visible but interrupted']) {
      const result = await fetch(`${url}/api/search?q=${encodeURIComponent(term)}`).then(response => response.json());
      assert.deepEqual(result.results, [], `${term} must not be searchable`);
    }
    const listed = await fetch(`${url}/api/notes`).then(response => response.json());
    const metadata = listed.notes.find(note => note.path === 'Unclosed Evidence.md');
    assert.deepEqual(metadata.tags, ['outside']);
    assert.deepEqual(metadata.links, ['Outside Link']);
    assert.doesNotMatch(metadata.excerpt, /UNCLOSED|unclosed-private|Unclosed Private Link|Visible but interrupted/);
  });
});

test('Safire generic indexes project nested blockquoted evidence safely', async (t) => {
  await withServer(t, async ({ url }) => {
    const content = [
      '# Outside blockquote text #outside [[Outside Link]]',
      '',
      '> > ```safire-evidence',
      '> > id: "blockquote-valid"',
      '> > claim: >-',
      '> >   Blockquote public claim #quoted-public [[Quoted Public Link]]',
      '> > private_notes: |+',
      '> >   BLOCKQUOTE-PRIVATE #quoted-private [[Quoted Private Link]]',
      '> > ```',
      '',
      '> ```safire-evidence',
      '> id: "blockquote-malformed"',
      '> private_notes: "MALFORMED-BLOCKQUOTE-PRIVATE',
      '> claim: PRIVATE-PROMOTION #promoted-private [[Promoted Private Link]]',
      '> ```',
    ].join('\r\n');
    const created = await fetch(`${url}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Blockquoted Evidence.md', content }),
    });
    assert.equal(created.status, 201);

    for (const term of ['BLOCKQUOTE-PRIVATE', 'MALFORMED-BLOCKQUOTE-PRIVATE', 'PRIVATE-PROMOTION', 'quoted-private', 'Promoted Private Link']) {
      const result = await fetch(`${url}/api/search?q=${encodeURIComponent(term)}`).then(response => response.json());
      assert.deepEqual(result.results, [], `${term} must not be searchable`);
    }
    const publicSearch = await fetch(`${url}/api/search?q=${encodeURIComponent('Blockquote public claim')}`).then(response => response.json());
    const publicResult = publicSearch.results.find(note => note.path === 'Blockquoted Evidence.md');
    assert.deepEqual(publicResult.tags, ['outside', 'quoted-public']);
    assert.deepEqual(publicResult.links, ['Outside Link', 'Quoted Public Link']);

    const listed = await fetch(`${url}/api/notes`).then(response => response.json());
    const metadata = listed.notes.find(note => note.path === 'Blockquoted Evidence.md');
    assert.deepEqual(metadata.tags, ['outside', 'quoted-public']);
    assert.deepEqual(metadata.links, ['Outside Link', 'Quoted Public Link']);
    assert.doesNotMatch(JSON.stringify({ publicResult, metadata }), /BLOCKQUOTE-PRIVATE|MALFORMED-BLOCKQUOTE-PRIVATE|PRIVATE-PROMOTION|quoted-private|promoted-private|Private Link/);
  });
});

test('Safire web clipper saves article and recipe pages as durable Markdown', async (t) => {
  await withServer(t, async ({ url }) => {
    const article = await fetch(`${url}/api/web-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'article',
        url: 'https://example.com/field-notes',
        html: `<!doctype html><html><head><title>Field Notes</title><meta name="author" content="Ada Lovelace"><meta name="description" content="A short field report."></head><body><article><p>First paragraph with <a href="https://source.example/paper">a citation</a>.</p><h2>Findings</h2><p>Second paragraph.</p><section class="footnotes"><ol><li id="fn1">Original field observation.</li></ol></section></article></body></html>`,
      }),
    });
    assert.equal(article.status, 201);
    const articleResult = await article.json();
    assert.match(articleResult.path, /^Web Clips\/Articles\/Field Notes\.md$/);
    const articleNote = await fetch(`${url}/api/note?path=${encodeURIComponent(articleResult.path)}`).then(res => res.json());
    assert.match(articleNote.content, /source: "https:\/\/example\.com\/field-notes"/);
    assert.match(articleNote.content, /author: "Ada Lovelace"/);
    assert.match(articleNote.content, /## Citations/);
    assert.match(articleNote.content, /https:\/\/source\.example\/paper/);
    assert.match(articleNote.content, /## Footnotes/);
    assert.match(articleNote.content, /Original field observation/);

    const recipe = await fetch(`${url}/api/web-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'recipe',
        url: 'https://example.com/overnight-oats',
        html: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Recipe","name":"Overnight Oats","recipeIngredient":["1 cup oats","1 cup milk"],"recipeInstructions":["Mix ingredients","Refrigerate overnight"],"recipeYield":"2 servings","nutrition":{"@type":"NutritionInformation","calories":"320 calories"}}</script>`,
      }),
    });
    assert.equal(recipe.status, 201);
    const recipeResult = await recipe.json();
    const recipeNote = await fetch(`${url}/api/note?path=${encodeURIComponent(recipeResult.path)}`).then(res => res.json());
    assert.match(recipeNote.content, /## Ingredients/);
    assert.match(recipeNote.content, /1 cup oats/);
    assert.match(recipeNote.content, /## Instructions/);
    assert.match(recipeNote.content, /Refrigerate overnight/);
    assert.match(recipeNote.content, /Calories \| 320 calories/);
  });
});
