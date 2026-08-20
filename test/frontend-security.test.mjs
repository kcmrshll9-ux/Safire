import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { marked } from 'marked';

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
const {
  GRAPH_RENDER_LIMITS,
  filterMarkdownClassName,
  getYouTubeVideoId,
  graphSourceLinkCountLabel,
  limitGraphForRendering,
  renderYouTubeLinkCard,
} = securityModule;

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
  const [{ tokens: [link] }] = marked.lexer('[**Synthetic video**](https://www.youtube.com/watch?v=synthetic123&list=synthetic "Open synthetic video")');
  const card = renderYouTubeLinkCard(candidate, link.tokens, 'Open synthetic video');
  assert.match(card, /class="youtube-link-card"/);
  assert.match(card, /href="https:\/\/www\.youtube\.com\/watch\?v=synthetic123&amp;list=synthetic"/);
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.match(card, /youtube-local-placeholder/);
  assert.doesNotMatch(card, /<(?:audio|embed|iframe|img|link|object|source|video)\b/i);
  assert.doesNotMatch(card, /\s(?:poster|src|srcset)\s*=/i);

  const mainSource = await fs.readFile(path.join(root, 'src', 'main.tsx'), 'utf8');
  assert.doesNotMatch(mainSource, /img\.youtube\.com/i);
});

test('YouTube link cards reduce resource-bearing labels to bounded safe inline markup', () => {
  const cases = [
    '[![Synthetic image](https://remote.invalid/tracker.png)](https://youtu.be/synthetic)',
    '[<IMG SRC="//remote.invalid/tracker.png">Synthetic](https://youtube.com/watch?v=synthetic)',
    '[<video poster="https%3A%2F%2Fremote.invalid%2Fposter.png"><source src="//remote.invalid/a.mp4"></video>](https://youtube.com/watch?v=synthetic#fragment)',
    '[<svg><image href="https://remote.invalid/pixel"></image></svg>](https://YouTube.com/watch?v=synthetic)',
    '[<style>@import url(//remote.invalid/style.css)</style>Safe](https://youtube.com/watch?v=synthetic)',
  ];

  for (const markdown of cases) {
    const [{ tokens: [link] }] = marked.lexer(markdown);
    const card = renderYouTubeLinkCard(link.href, link.tokens, link.title);
    assert.doesNotMatch(card, /<(?:audio|embed|iframe|img|link|object|picture|source|style|svg|video)\b/i, markdown);
    assert.doesNotMatch(card, /\s(?:poster|src|srcset)\s*=/i, markdown);
    assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  }

  const [{ tokens: [safeLink] }] = marked.lexer('[**Bold** and *emphasis* with `code`](https://youtu.be/synthetic)');
  const safeCard = renderYouTubeLinkCard(safeLink.href, safeLink.tokens, safeLink.title);
  assert.match(safeCard, /<strong>Bold<\/strong> and <em>emphasis<\/em> with <code>code<\/code>/);
});

test('YouTube recognition accepts intended URL variants and rejects malformed or ordinary links', () => {
  assert.equal(getYouTubeVideoId('https://YouTube.com/watch?v=synthetic#fragment'), 'synthetic');
  assert.equal(getYouTubeVideoId('//youtu.be/synthetic?feature=share', 'https://safire.invalid/'), 'synthetic');
  assert.equal(getYouTubeVideoId('https://www.youtube-nocookie.com/embed/synthetic'), 'synthetic');
  for (const href of [
    'not a URL',
    'javascript:alert(1)',
    'https://youtube.com.evil.invalid/watch?v=synthetic',
    'https://remote.invalid/watch?v=synthetic',
    'https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dsynthetic',
  ]) assert.equal(getYouTubeVideoId(href), null, href);
});

test('Markdown rendering strips application and arbitrary classes while retaining only preview-safe renderer classes', async () => {
  assert.equal(filterMarkdownClassName('modal-backdrop palette primary-action'), '');
  assert.equal(filterMarkdownClassName('safire-preview-image modal-backdrop'), 'safire-preview-image');
  assert.equal(filterMarkdownClassName('youtube-link-card youtube-title'), 'youtube-link-card youtube-title');
  assert.equal(filterMarkdownClassName('evidence-status verified'), 'evidence-status verified');
  assert.equal(filterMarkdownClassName('evidence-status owner-controlled'), 'evidence-status');

  const mainSource = await fs.readFile(path.join(root, 'src', 'main.tsx'), 'utf8');
  assert.match(mainSource, /renderer\.html\s*=\s*\(token\)\s*=>\s*DOMPurify\.sanitize/);
  assert.match(mainSource, /FORBID_ATTR:\s*\['class', 'id', 'style'\]/);
  assert.match(mainSource, /filterMarkdownClassName\(data\.attrValue\)/);
  assert.match(mainSource, /data\.keepAttr\s*=\s*false/);
  assert.match(mainSource, /if \(!videoId\) return defaultLinkRenderer\(token\)/);
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
  assert.equal(limited.graph.nodes.at(-1).id, activePath);
  assert.equal(limited.graph.links.length, GRAPH_RENDER_LIMITS.links);
  assert.equal(limited.truncated, true);
  assert.equal(limited.sourceNotes, nodes.length);
  assert.equal(limited.sourceLinks, links.length);
  const retainedIds = new Set(limited.graph.nodes.map(candidate => candidate.id));
  assert.ok(limited.graph.links.every(link => retainedIds.has(link.source) && retainedIds.has(link.target)));
});

test('changing the active note within a rendered project does not reorder graph layout input', () => {
  const nodes = Array.from({ length: GRAPH_RENDER_LIMITS.notes + 20 }, (_, index) => node(`Note-${index}.md`));
  const graph = { nodes, links: [] };
  const first = limitGraphForRendering(graph, 'Note-10.md');
  const second = limitGraphForRendering(graph, 'Note-500.md');

  assert.deepEqual(second.graph.nodes.map(candidate => candidate.id), first.graph.nodes.map(candidate => candidate.id));
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

test('graph rendering drops oversized fields before lowercase keys, placeholder expansion, or layout', () => {
  const oversized = 'X'.repeat(GRAPH_RENDER_LIMITS.fieldCharacters + 1);
  const limited = limitGraphForRendering({
    nodes: [
      { id: 'Safe.md', label: 'Safe', folder: '', tags: [] },
      { id: 'Oversized.md', label: oversized, folder: '', tags: [] },
    ],
    links: [
      missingLink('oversized-target', 'Safe.md', oversized),
      { ...missingLink('oversized-label', 'Safe.md', 'Missing'), label: oversized },
      missingLink('safe', 'Safe.md', 'Missing'),
    ],
  });

  assert.deepEqual(limited.graph.nodes.map(candidate => candidate.id), ['Safe.md']);
  assert.deepEqual(limited.graph.links.map(link => link.id), ['safe']);
  assert.equal(limited.truncated, true);
});

test('graph rendering enforces an aggregate string budget before expansion', () => {
  const target = 'M'.repeat(Math.floor(GRAPH_RENDER_LIMITS.fieldCharacters / 2));
  const links = Array.from({ length: GRAPH_RENDER_LIMITS.links }, (_, index) => missingLink(`link-${index}`, 'Root.md', `${index}-${target}`));
  const limited = limitGraphForRendering({ nodes: [{ id: 'Root.md', label: 'Root', folder: '', tags: [] }], links });

  assert.ok(limited.graph.links.length > 0);
  assert.ok(limited.graph.links.length < links.length);
  assert.ok(limited.renderedStringCharacters <= GRAPH_RENDER_LIMITS.aggregateStringCharacters);
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
  assert.match(source, /rendering \{renderBudget\.renderedNotes\} of \{sourceNoteLabel\} notes/);
  assert.match(source, /graph\.meta\?\.sourceNotesComplete === false \? `at least \$\{sourceNoteCount\}`/);
  assert.match(source, /graphSourceLinkCountLabel\(sourceLinkCount, graph\.meta\?\.sourceLinksComplete !== false\)/);
  assert.match(source, /Content indexing was skipped for \{omittedNoteContent\} oversized note/);
  assert.match(source, /\{omittedLinkFields\} oversized or malformed link field/);
  assert.match(source, /useMemo\(\(\) => limitGraphForRendering\(graph, activePath\), \[graph\]\)/);
  assert.doesNotMatch(source, /React\.useEffect\(\(\) => \{\s*if \(activePath\) setLocalRoot\(activePath\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => fitViewRef\.current\(\), 180\)/);
  assert.match(source, /!initialFitCompleteRef\.current && !viewTouchedRef\.current/);
  assert.match(source, /graphLayoutBounds\(dimensions\.width, dimensions\.height\)/);
  assert.match(source, /Organize and color by/);
});

test('frontend requests graphs only through an explicit project scope', async () => {
  const source = await fs.readFile(path.join(root, 'src', 'main.tsx'), 'utf8');
  assert.match(source, /\/api\/graph\?project=\$\{encodeURIComponent\(projectPath\)\}&active=\$\{encodeURIComponent\(projectActivePath\)\}/);
  assert.doesNotMatch(source, /\/api\/graph\?active=/);
  assert.doesNotMatch(source, /setMode\('graph'\)/);
});

test('incomplete server link totals are visibly labeled as lower bounds', () => {
  assert.equal(graphSourceLinkCountLabel(2_001, false), 'at least 2001');
  assert.equal(graphSourceLinkCountLabel(42, true), '42');
});
