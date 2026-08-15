import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');

async function loadFrontendSecurityModule() {
  const source = await fs.readFile(path.join(root, 'src', 'frontendSecurity.ts'), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: 'frontendSecurity.ts',
    reportDiagnostics: true,
  });
  assert.deepEqual(transpiled.diagnostics, []);
  return import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);
}

const securityModule = await loadFrontendSecurityModule();
const { GRAPH_RENDER_LIMITS, graphSourceLinkCountLabel, limitGraphForRendering, renderYouTubeLinkCard } = securityModule;

function node(id) {
  return { id };
}

function resolvedLink(id, source, target) {
  return { id, source, target, label: target, resolved: true, resolution: 'exact-path' };
}

function missingLink(id, source, target) {
  return { id, source, target, label: target, resolved: false, resolution: 'missing' };
}

test('YouTube link cards use a local placeholder and create no automatic subresource request', async () => {
  const candidate = 'https://www.youtube.com/watch?v=synthetic123&list=synthetic';
  const card = renderYouTubeLinkCard(candidate, '<strong>Synthetic video</strong>', 'Open synthetic video');
  assert.match(card, /class="youtube-link-card"/);
  assert.match(card, /href="https:\/\/www\.youtube\.com\/watch\?v=synthetic123&amp;list=synthetic"/);
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.match(card, /youtube-local-placeholder/);
  assert.doesNotMatch(card, /<(?:audio|embed|iframe|img|link|object|source|video)\b/i);
  assert.doesNotMatch(card, /\s(?:poster|src|srcset)\s*=/i);

  const mainSource = await fs.readFile(path.join(root, 'src', 'main.tsx'), 'utf8');
  assert.doesNotMatch(mainSource, /img\.youtube\.com/i);
});

test('graph rendering retains the active note while enforcing fixed node and link ceilings', () => {
  const nodes = Array.from({ length: GRAPH_RENDER_LIMITS.notes + 500 }, (_, index) => node(`Note-${index}.md`));
  const selectedPrefixSize = GRAPH_RENDER_LIMITS.notes - 1;
  const links = Array.from({ length: GRAPH_RENDER_LIMITS.links + 700 }, (_, index) => resolvedLink(
    `link-${index}`,
    `Note-${index % selectedPrefixSize}.md`,
    `Note-${(index + 1) % selectedPrefixSize}.md`,
  ));
  const activePath = nodes.at(-1).id;
  const limited = limitGraphForRendering({ nodes, links }, activePath);

  assert.equal(limited.graph.nodes.length, GRAPH_RENDER_LIMITS.notes);
  assert.equal(limited.graph.nodes[0].id, activePath);
  assert.equal(limited.graph.links.length, GRAPH_RENDER_LIMITS.links);
  assert.equal(limited.truncated, true);
  assert.equal(limited.sourceNotes, nodes.length);
  assert.equal(limited.sourceLinks, links.length);
  const retainedIds = new Set(limited.graph.nodes.map(candidate => candidate.id));
  assert.ok(limited.graph.links.every(link => retainedIds.has(link.source) && retainedIds.has(link.target)));
});

test('graph rendering bounds unique unresolved placeholders before SVG expansion', () => {
  const uniqueMissing = Array.from({ length: GRAPH_RENDER_LIMITS.missing + 50 }, (_, index) => missingLink(`missing-${index}`, 'Root.md', `Missing ${index}`));
  const repeatedMissing = Array.from({ length: 100 }, (_, index) => missingLink(`repeat-${index}`, 'Root.md', 'Missing 0'));
  const limited = limitGraphForRendering({ nodes: [node('Root.md')], links: [...uniqueMissing, ...repeatedMissing] });

  assert.equal(limited.renderedMissing, GRAPH_RENDER_LIMITS.missing);
  assert.equal(limited.graph.links.length, GRAPH_RENDER_LIMITS.missing + repeatedMissing.length);
  assert.ok(limited.renderedNotes + limited.renderedMissing <= GRAPH_RENDER_LIMITS.notes + GRAPH_RENDER_LIMITS.missing);
  assert.equal(limited.truncated, true);
});

test('graph budget drops links whose endpoints are outside the retained note set', () => {
  const nodes = Array.from({ length: GRAPH_RENDER_LIMITS.notes + 1 }, (_, index) => node(`Note-${index}.md`));
  const links = [
    resolvedLink('inside', 'Note-0.md', 'Note-1.md'),
    resolvedLink('outside-target', 'Note-0.md', `Note-${GRAPH_RENDER_LIMITS.notes}.md`),
    resolvedLink('outside-source', `Note-${GRAPH_RENDER_LIMITS.notes}.md`, 'Note-0.md'),
  ];
  const limited = limitGraphForRendering({ nodes, links });

  assert.deepEqual(limited.graph.links.map(link => link.id), ['inside']);
  assert.equal(limited.truncated, true);
});

test('GraphView applies the defensive budget before expanding placeholders and exposes truncation', async () => {
  const source = await fs.readFile(path.join(root, 'src', 'GraphView.tsx'), 'utf8');
  const budgetCall = source.indexOf('limitGraphForRendering(graph, activePath)');
  const expansionCall = source.indexOf('expandGraph(renderBudget.graph)');
  assert.ok(budgetCall >= 0);
  assert.ok(expansionCall > budgetCall);
  assert.doesNotMatch(source, /expandGraph\(graph\)/);
  assert.match(source, /className="graph-limit-notice" role="status"/);
  assert.match(source, /rendering \{renderBudget\.renderedNotes\} of \{sourceNoteCount\} notes/);
  assert.match(source, /graphSourceLinkCountLabel\(sourceLinkCount, graph\.meta\?\.sourceLinksComplete !== false\)/);
});

test('incomplete server link totals are visibly labeled as lower bounds', () => {
  assert.equal(graphSourceLinkCountLabel(2_001, false), 'at least 2001');
  assert.equal(graphSourceLinkCountLabel(42, true), '42');
});
