import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadProjectModel() {
  const source = await fs.readFile(path.join(projectRoot, 'src', 'projectModel.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

async function loadProjectGraphState() {
  const source = await fs.readFile(path.join(projectRoot, 'src', 'projectGraphState.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

test('Home derives one project per top-level user folder and keeps entries scoped', async () => {
  const { projectEntries, projectForNotePath, projectSummaries } = await loadProjectModel();
  const tree = [
    { type: 'folder', name: '.safire', path: '.safire', children: [] },
    { type: 'folder', name: 'Attachments', path: 'Attachments', children: [] },
    { type: 'folder', name: 'Inbox', path: 'Inbox', children: [] },
    { type: 'folder', name: 'Journal', path: 'Journal', children: [] },
    { type: 'folder', name: 'Templates', path: 'Templates', children: [] },
    { type: 'folder', name: 'Web Clips', path: 'Web Clips', children: [] },
    { type: 'folder', name: 'Atlas', path: 'Atlas', children: [] },
    { type: 'folder', name: 'Beta 2', path: 'Beta 2', children: [] },
    { type: 'note', name: 'Welcome.md', path: 'Welcome.md', title: 'Welcome' },
  ];
  const notes = [
    { path: 'Atlas/Overview.md', title: 'Overview', mtime: 100 },
    { path: 'Atlas/Meetings/Kickoff.md', title: 'Kickoff', mtime: 300 },
    { path: 'atlas/Case-sensitive.md', title: 'Different project', mtime: 950 },
    { path: 'Atlas Extra/Not Atlas.md', title: 'Not Atlas', mtime: 900 },
    { path: 'Inbox/Capture.md', title: 'Capture', mtime: 800 },
    { path: 'Welcome.md', title: 'Welcome', mtime: 700 },
  ];

  assert.deepEqual(projectSummaries(tree, notes, 'Journal/Daily'), [
    { path: 'Atlas', name: 'Atlas', entryCount: 2, lastUpdated: 300 },
    { path: 'Beta 2', name: 'Beta 2', entryCount: 0, lastUpdated: null },
  ]);
  assert.deepEqual(projectEntries(notes, 'Atlas').map(note => note.path), [
    'Atlas/Meetings/Kickoff.md',
    'Atlas/Overview.md',
  ]);
  const projects = projectSummaries(tree, notes, 'Journal/Daily');
  assert.equal(projectForNotePath(projects, 'Atlas/Overview.md')?.path, 'Atlas');
  assert.equal(projectForNotePath(projects, 'Atlas Extra/Not Atlas.md'), null);
  assert.equal(projectForNotePath(projects, 'Welcome.md'), null);
});

test('project graph retains only descendant nodes and fully internal links', async () => {
  const { projectGraph } = await loadProjectModel();
  const graph = {
    nodes: [
      { id: 'Atlas/Overview.md', inDegree: 9, outDegree: 9, degree: 18, orphan: false },
      { id: 'Atlas/Notes/Decision.md', inDegree: 9, outDegree: 9, degree: 18, orphan: false },
      { id: 'Atlas Extra/Outside.md', inDegree: 9, outDegree: 9, degree: 18, orphan: false },
      { id: 'atlas/Case-sensitive.md', inDegree: 9, outDegree: 9, degree: 18, orphan: false },
      { id: 'Beta/Plan.md', inDegree: 9, outDegree: 9, degree: 18, orphan: false },
    ],
    links: [
      { id: 'internal', source: 'Atlas/Overview.md', target: 'Atlas/Notes/Decision.md' },
      { id: 'outbound', source: 'Atlas/Overview.md', target: 'Beta/Plan.md' },
      { id: 'prefix-lookalike', source: 'Atlas Extra/Outside.md', target: 'Atlas/Overview.md' },
    ],
  };

  const filtered = projectGraph(graph, 'Atlas');
  assert.deepEqual(filtered.links.map(link => link.id), ['internal']);
  assert.deepEqual(filtered.nodes, [
    { id: 'Atlas/Overview.md', inDegree: 0, outDegree: 1, degree: 1, orphan: false },
    { id: 'Atlas/Notes/Decision.md', inDegree: 1, outDegree: 0, degree: 1, orphan: false },
  ]);
});

test('a delayed project graph response cannot replace a newer project request', async () => {
  const { projectGraphLoadReducer } = await loadProjectGraphState();
  let state = { status: 'idle' };
  state = projectGraphLoadReducer(state, { type: 'load', projectPath: 'Atlas', requestId: 1 });
  state = projectGraphLoadReducer(state, { type: 'load', projectPath: 'Beta', requestId: 2 });
  const betaLoadingState = state;

  state = projectGraphLoadReducer(state, { type: 'ready', projectPath: 'Atlas', requestId: 1, graph: { nodes: [{ id: 'Atlas/A.md' }], links: [] } });
  assert.deepEqual(state, betaLoadingState);

  state = projectGraphLoadReducer(state, { type: 'ready', projectPath: 'Beta', requestId: 2, graph: { nodes: [{ id: 'Beta/B.md' }], links: [] } });
  assert.equal(state.status, 'ready');
  assert.equal(state.projectPath, 'Beta');
  assert.deepEqual(state.graph.nodes.map(node => node.id), ['Beta/B.md']);

  const readyGraph = state.graph;
  state = projectGraphLoadReducer(state, { type: 'load', projectPath: 'Beta', requestId: 3 });
  assert.equal(state.status, 'loading');
  assert.equal(state.graph, readyGraph, 'refresh keeps the rendered project graph mounted');
});

test('case-distinct sibling folders remain separate projects on case-sensitive vaults', async () => {
  const { projectEntries, projectGraph, projectSummaries } = await loadProjectModel();
  const tree = [
    { type: 'folder', name: 'Atlas', path: 'Atlas', children: [] },
    { type: 'folder', name: 'atlas', path: 'atlas', children: [] },
  ];
  const notes = [
    { path: 'Atlas/Upper.md', title: 'Upper', mtime: 200 },
    { path: 'atlas/Lower.md', title: 'Lower', mtime: 100 },
  ];
  const graph = {
    nodes: notes.map(note => ({ id: note.path })),
    links: [
      { id: 'case-crossing', source: 'Atlas/Upper.md', target: 'atlas/Lower.md' },
    ],
  };

  assert.deepEqual(projectSummaries(tree, notes).map(project => ({ path: project.path, entryCount: project.entryCount })), [
    { path: 'Atlas', entryCount: 1 },
    { path: 'atlas', entryCount: 1 },
  ]);
  assert.deepEqual(projectEntries(notes, 'Atlas').map(note => note.path), ['Atlas/Upper.md']);
  assert.deepEqual(projectGraph(graph, 'Atlas').nodes.map(node => node.id), ['Atlas/Upper.md']);
  assert.deepEqual(projectGraph(graph, 'Atlas').links, []);
});

test('project names are portable and cannot reuse Safire-managed roots', async () => {
  const { portableEntryNameError, projectNameError } = await loadProjectModel();
  assert.equal(projectNameError('Website redesign'), null);
  assert.match(projectNameError('Inbox'), /reserved for Safire-managed files/);
  assert.match(projectNameError('Journal', 'Journal/Daily'), /reserved for Safire-managed files/);
  assert.match(projectNameError('.private'), /reserved for Safire-managed files/);
  assert.match(projectNameError('Parent/Child'), /without slashes/);
  assert.match(projectNameError('CON'), /reserved by Windows/);
  assert.match(projectNameError('AUX.txt'), /reserved by Windows/);
  assert.match(projectNameError('C:escape'), /reserved filename characters/);
  assert.match(projectNameError('Templates'), /reserved for Safire-managed files/);
  assert.match(projectNameError('Daily', 'Daily/Journal'), /reserved for Safire-managed files/);
  assert.match(portableEntryNameError('..'), /without slashes/);
  assert.match(portableEntryNameError('Trailing.'), /without slashes/);
  assert.match(portableEntryNameError('.secret'), /hidden|leading dot|reserved/i);
  assert.match(portableEntryNameError('.md'), /hidden|leading dot|reserved/i);
  assert.equal(portableEntryNameError('Overview.md'), null);
});

test('project Home opens entries in the editor and offers backed-up per-file deletion', async () => {
  const [main, home, graphView, styles, server] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'src', 'main.tsx'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src', 'ProjectHome.tsx'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src', 'GraphView.tsx'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src', 'styles.css'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'server.mjs'), 'utf8'),
  ]);

  assert.match(main, /<ProjectHome hidden=\{workspaceView !== 'home'\} tree=\{tree\} notes=\{notes\} activePath=\{activePath\}/);
  assert.match(main, /\/api\/graph\?project=\$\{encodeURIComponent\(projectPath\)\}&active=\$\{encodeURIComponent\(projectActivePath\)\}/);
  assert.doesNotMatch(main, /\/api\/graph\?active=/);
  assert.doesNotMatch(main, /setMode\('graph'\)/);
  assert.match(main, /projectForNotePath\(projects, activePath\)/);
  assert.match(main, /name: 'Open project graph'/);
  assert.match(main, /aria-label="Project graph" title="Project graph" onClick=\{\(\) => openProjectGraph\(\)\}/);
  assert.match(main, /selectedProjectPath=\{selectedProjectPath\} projectView=\{projectView\}/);
  assert.match(main, /graphRefreshRevision=\{projectGraphRevision\} showGraphPrompt=\{projectGraphPrompt\}/);
  assert.match(main, /onSelectProject=\{selectProject\} onSetProjectView=\{setProjectView\}/);
  assert.match(main, /workspaceView !== 'home' \? activeNoteProject\?\.path : null/);
  assert.match(main, /Open a project, then choose Project graph/);
  assert.match(main, /openProjectGraph\(selectedProject\.path, false\).*← Back to \{selectedProject\.name\} graph/s);
  assert.doesNotMatch(main, /function HomeView\(/);
  assert.match(main, /projectNameError\(name, settings\?\.dailyNotesFolder\)/);
  assert.match(main, /body: JSON\.stringify\(\{ path: name \}\)/);
  assert.match(main, /portableEntryNameError\(name\)/);
  assert.match(main, /createNote\(`\$\{projectPath\}\/\$\{name\}`\)/);
  assert.match(main, /method: 'DELETE'.*path: notePath/s);
  assert.match(main, /A backup copy will be made first/);
  assert.match(server, /app\.post\('\/api\/folder'.*resolveUserMutationFolderPath\(req\.body\.path/s);
  assert.match(server, /app\.delete\('\/api\/note'.*resolveUserMutationNotePath\(req\.body\.path\)/s);
  assert.match(home, /className="project-grid" aria-label="Projects"/);
  assert.match(home, /role="group" aria-label=\{`\$\{activeProject\.name\} view`\}/);
  assert.match(home, /aria-pressed=\{projectView === 'entries'\}/);
  assert.match(home, /aria-pressed=\{projectView === 'graph'\}/);
  assert.match(home, /aria-labelledby="project-entries-heading"/);
  assert.match(home, /<time dateTime=/);
  assert.match(home, /onOpenEntry\(entry\.path, 'edit'\)/);
  assert.match(home, /label: 'Delete entry'/);
  assert.match(home, /danger: true/);
  assert.doesNotMatch(home, /Delete project/);
  assert.match(home, />Project graph<\/button>/);
  assert.match(home, /loadProjectGraph\(resolvedActiveProjectPath, activePath\)/);
  assert.match(home, /Cross-project links are excluded so every project keeps its own graph/);
  assert.doesNotMatch(home, /vault-wide graph/);
  assert.match(home, /Loading this project’s graph/);
  assert.match(home, /Could not load this project’s graph/);
  assert.match(home, /Each project has a separate graph; Safire never combines projects into one map/);
  assert.match(graphView, /data-graph-node-id=\{node\.id\}/);
  assert.match(home, /node\.dataset\.graphNodeId === pendingGraphFocus\.nodeId/);
  assert.match(home, /document\.activeElement/);
  assert.match(home, /graphState\.status === 'loading'.*Refreshing this project’s graph/s);
  assert.match(home, /projectPath=\{activeProject\.path\}/);
  assert.doesNotMatch(home, /\[activePath, graphRefreshRevision/);
  assert.match(graphView, /if \(rect\.width <= 0 \|\| rect\.height <= 0\) return/);
  assert.match(styles, /\.project-graph-content \{ position: relative; height: 100%; min-height: 0; \}/);
  assert.match(home, /hidden=\{hidden\} className="home-view project-home/);
  assert.match(home, /projectGraphData\?\.nodes\.some\(node => node\.id === activePath\)/);
  assert.match(home, /onPreview=\{path => openGraphEntry\(path, 'preview'\)\}/);
  assert.match(home, /onEdit=\{path => openGraphEntry\(path, 'edit'\)\}/);
  assert.match(home, /projectBackRef\.current\?\.focus\(\)/);
  assert.match(home, /projectCardRefs\.current\.get\(returnPath\)/);
  assert.match(home, /preferredEntry \|\| firstEntry \|\| createFirstEntryRef\.current \|\| projectHeadingRef\.current/);
  assert.match(main, /setProjectIndexComplete\(notesData\.meta\?\.truncated !== true && treeData\.meta\?\.truncated !== true\)/);
  assert.match(main, /setStatus\(`Project \$\{data\.path\} is ready`\)/);
  assert.match(main, /const openProjectEntry = React\.useCallback\(async/);
  assert.match(main, /if \(path === activePath\)/);
  assert.match(main, /await openNote\(path\);\s*setMode\(entryMode\);\s*setWorkspaceView\('note'\);\s*focusDestination\(\)/s);
  assert.match(main, /if \(entryMode === 'edit'\) editorRef\.current\?\.focus\(\);\s*else workspaceRef\.current\?\.focus\(\)/s);
  assert.match(main, /const createProjectEntry = async[\s\S]*?if \(dirty\)[\s\S]*?await askConfirm[\s\S]*?if \(!proceed\) return;[\s\S]*?await createNote\(`\$\{projectPath\}\/\$\{name\}`\);\s*setMode\('edit'\);\s*setWorkspaceView\('note'\);\s*window\.setTimeout\(\(\) => editorRef\.current\?\.focus\(\), 0\)/);
  assert.match(main, /Unsaved editor changes will be discarded and are not included in the backup/);
  assert.match(main, /className="palette safire-dialog" role="dialog" aria-modal="true" aria-labelledby=\{titleId\} aria-describedby=\{messageId\}/);
  assert.match(main, /if \(inputRef\.current\)[\s\S]*?else cancelRef\.current\?\.focus\(\)/);
  assert.match(main, /if \(openerRef\.current\?\.isConnected\) openerRef\.current\.focus\(\)/);
  assert.match(main, /if \(event\.key !== 'Tab'\) return;[\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/);
  assert.match(home, /Partial project index/);
  assert.match(home, /top-level user folder/);
  assert.match(home, /choose its parent folder/);
  assert.match(styles, /\.project-card\s*\{/);
  assert.match(styles, /\.project-entry-row\s*\{/);
  assert.match(styles, /\.project-graph-panel\s*\{/);
});
