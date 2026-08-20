import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadGraphOrganization() {
  const source = await fs.readFile(path.join(projectRoot, 'src', 'graphOrganization.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function denseProjectFixture() {
  const project = 'Graph UX Demo';
  const homeId = `${project}/${project} Project.md`;
  const nodes = [{ id: homeId, label: `${project} Project`, folder: project, degree: 30 }];
  for (let index = 1; index <= 16; index += 1) {
    nodes.push({ id: `${project}/Reports/Report ${String(index).padStart(2, '0')}.md`, label: `Report ${index}`, folder: `${project}/Reports`, degree: 2 });
  }
  for (let index = 1; index <= 12; index += 1) {
    nodes.push({ id: `${project}/Insights/Insight ${String(index).padStart(2, '0')}.md`, label: `Insight ${index}`, folder: `${project}/Insights`, degree: 1 });
  }
  const reportIndex = `${project}/Reference/Report Index.md`;
  nodes.push(
    { id: reportIndex, label: 'Report Index', folder: `${project}/Reference`, degree: 16 },
    { id: `${project}/Reference/Feature Requests.md`, label: 'Feature Requests', folder: `${project}/Reference`, degree: 2 },
    { id: `${project}/Reference/Agent Guidance.md`, label: 'Agent Guidance', folder: `${project}/Reference`, degree: 2 },
  );
  const links = [];
  const addLink = (source, targetId) => links.push({ id: `link:${links.length}`, source, targetId, resolved: true });
  for (const node of nodes.filter(node => node.folder === `${project}/Reports`)) {
    addLink(homeId, node.id);
    addLink(reportIndex, node.id);
  }
  for (const node of nodes.filter(node => node.folder === `${project}/Insights`)) addLink(homeId, node.id);
  addLink(`${project}/Reports/Report 01.md`, `${project}/Insights/Insight 01.md`);
  addLink(`${project}/Reference/Feature Requests.md`, reportIndex);
  addLink(`${project}/Reference/Agent Guidance.md`, reportIndex);
  return { project, homeId, reportIndex, nodes, links };
}

function maximumProjectMapRadius(node, role) {
  const scaledRadius = Math.max(6, Math.min(24, (7 + Math.sqrt(Math.max(0, node.degree)) * 2.2) * 1.6));
  if (role === 'home') return Math.max(scaledRadius, 32);
  if (role === 'hub') return Math.max(scaledRadius, 24);
  return scaledRadius;
}

function assertCompactLayoutContained(layout, groups, nodes, roleById, width, height) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const epsilon = 1e-9;
  for (const region of layout.regions.values()) {
    assert.ok(Number.isFinite(region.x) && Number.isFinite(region.y));
    assert.ok(Number.isFinite(region.width) && Number.isFinite(region.height));
    assert.ok(region.width > 0 && region.height > 0, `${region.group} has non-positive geometry`);
    assert.ok(region.x >= -epsilon && region.y >= -epsilon);
    assert.ok(region.x + region.width <= width + epsilon);
    assert.ok(region.y + region.height <= height + epsilon);
  }
  for (const group of groups) {
    const region = layout.regions.get(group.name);
    assert.ok(region, `${group.name} is missing its region`);
    for (const nodeId of group.visibleNodeIds) {
      const point = layout.positions.get(nodeId);
      const node = nodeById.get(nodeId);
      assert.ok(point && node, `${nodeId} is missing its layout input or position`);
      const radius = maximumProjectMapRadius(node, roleById.get(nodeId));
      assert.ok(point.x - radius >= region.x - epsilon, `${nodeId} extends left of ${group.name}`);
      assert.ok(point.x + radius <= region.x + region.width + epsilon, `${nodeId} extends right of ${group.name}`);
      assert.ok(point.y - radius >= region.y - epsilon, `${nodeId} extends above ${group.name}`);
      assert.ok(point.y + radius + 15 <= region.y + region.height + epsilon, `${nodeId}'s label extends below ${group.name}`);
    }
  }
}

test('project folder groups are relative to the selected project', async () => {
  const { projectFolderGroup } = await loadGraphOrganization();
  assert.equal(projectFolderGroup('Atlas', 'Atlas'), 'Project root');
  assert.equal(projectFolderGroup('Atlas/Research', 'Atlas'), 'Research');
  assert.equal(projectFolderGroup('Atlas/Research/Interviews', 'Atlas'), 'Research');
  assert.equal(projectFolderGroup('Beta/Notes', 'Beta'), 'Notes');
  assert.equal(projectFolderGroup('', 'Atlas'), 'Project root');
});

test('project root stays central while project folders receive stable cluster anchors', async () => {
  const { graphGroupAnchors, graphLayoutBounds } = await loadGraphOrganization();
  const groups = ['Meetings', 'Plan', 'Project root', 'Research'];
  const anchors = graphGroupAnchors(groups, 800, 600);
  assert.deepEqual(anchors.get('Project root'), { x: 400, y: 300 });
  assert.deepEqual([...anchors], [...graphGroupAnchors(groups, 800, 600)]);
  assert.equal(new Set([...anchors.values()].map(point => `${point.x}:${point.y}`)).size, groups.length);

  const bounds = graphLayoutBounds(800, 600);
  for (const point of anchors.values()) {
    assert.ok(point.x >= bounds.minimumX && point.x <= bounds.maximumX);
    assert.ok(point.y >= bounds.minimumY && point.y <= bounds.maximumY);
  }
});

test('directed relationships deduplicate canonical endpoints while retaining reciprocal links', async () => {
  const { deduplicateDirectedLinks } = await loadGraphOrganization();
  const links = [
    { id: 'first', source: 'Project/Source.md', targetId: 'Project/Target.md' },
    { id: 'alias', source: 'Project/Source.md', targetId: 'Project/Target.md' },
    { id: 'case-variant', source: 'project/source.md', targetId: 'project/target.md' },
    { id: 'reciprocal', source: 'Project/Target.md', targetId: 'Project/Source.md' },
    { id: 'other-source', source: 'Project/Other.md', targetId: 'Project/Target.md' },
  ];

  assert.deepEqual(deduplicateDirectedLinks(links).map(link => link.id), [
    'first',
    'case-variant',
    'reciprocal',
    'other-source',
  ]);
});

test('project map identifies the project home and explicitly collapses and expands dense folders', async () => {
  const { buildProjectGraphProjection } = await loadGraphOrganization();
  const fixture = denseProjectFixture();
  const compact = buildProjectGraphProjection('project-map', fixture.nodes, fixture.links, {
    projectPath: fixture.project,
    activePath: fixture.homeId,
    collapse: true,
  });

  assert.equal(compact.homeNodeId, fixture.homeId);
  assert.equal(compact.roleById.get(fixture.homeId), 'home');
  assert.ok(compact.hubNodeIds.has(fixture.reportIndex));
  assert.ok(compact.visibleNodeIds.has(fixture.homeId));
  assert.ok(compact.collapsedCount > 0);
  assert.deepEqual(compact.groups.map(group => group.name), ['Project root', 'Insights', 'Reference', 'Reports']);
  const reports = compact.groups.find(group => group.name === 'Reports');
  assert.equal(reports.nodeIds.length, 16);
  assert.ok(reports.collapsedNodeIds.length > 0);
  assert.deepEqual(reports.collapsedNodeIds, reports.collapsibleNodeIds);

  const expanded = buildProjectGraphProjection('project-map', fixture.nodes, fixture.links, {
    projectPath: fixture.project,
    activePath: fixture.homeId,
    expandedGroups: ['Reports'],
    collapse: true,
  });
  const expandedReports = expanded.groups.find(group => group.name === 'Reports');
  assert.equal(expandedReports.visibleNodeIds.length, 16);
  assert.deepEqual(expandedReports.collapsedNodeIds, []);
  assert.deepEqual(expandedReports.collapsibleNodeIds, reports.collapsibleNodeIds);
});

test('selected notes reveal their direct unique relationships without expanding unrelated leaves', async () => {
  const { buildProjectGraphProjection } = await loadGraphOrganization();
  const fixture = denseProjectFixture();
  const selectedId = `${fixture.project}/Reports/Report 16.md`;
  const selected = buildProjectGraphProjection('project-map', fixture.nodes, fixture.links, {
    projectPath: fixture.project,
    selectedId,
    collapse: true,
  });

  assert.ok(selected.visibleNodeIds.has(selectedId));
  assert.deepEqual([...selected.selectedNeighborIds].sort(), [fixture.homeId, fixture.reportIndex].sort());
  const directLinks = fixture.links.filter(link => link.source === selectedId || link.targetId === selectedId);
  assert.deepEqual(
    directLinks.filter(link => selected.visibleLinkIds.has(link.id)).map(link => link.id).sort(),
    directLinks.map(link => link.id).sort(),
  );
  assert.deepEqual(selected.hiddenSelectedNeighborsByGroup, []);
});

test('selecting a high-degree hub reveals every immediate neighbor and direct relationship', async () => {
  const { buildProjectGraphProjection } = await loadGraphOrganization();
  const fixture = denseProjectFixture();
  const selected = buildProjectGraphProjection('project-map', fixture.nodes, fixture.links, {
    projectPath: fixture.project,
    selectedId: fixture.homeId,
    collapse: true,
  });
  const directLinks = fixture.links.filter(link => link.source === fixture.homeId || link.targetId === fixture.homeId);
  const directNeighborIds = new Set(directLinks.map(link => link.source === fixture.homeId ? link.targetId : link.source));

  assert.equal(selected.selectedNeighborIds.size, directNeighborIds.size);
  assert.ok([...directNeighborIds].every(id => selected.visibleNodeIds.has(id)));
  assert.ok(directLinks.every(link => selected.visibleLinkIds.has(link.id)));
  assert.deepEqual(selected.hiddenSelectedNeighborsByGroup, []);
});

test('full graph mode remains lossless while project map uses a sparse overview', async () => {
  const { buildProjectGraphProjection } = await loadGraphOrganization();
  const fixture = denseProjectFixture();
  const duplicate = { ...fixture.links[0], id: 'duplicate-alias' };
  const links = [...fixture.links, duplicate];
  const map = buildProjectGraphProjection('project-map', fixture.nodes, links, {
    projectPath: fixture.project,
    collapse: true,
  });
  const full = buildProjectGraphProjection('full-graph', fixture.nodes, links, {
    projectPath: fixture.project,
  });

  assert.ok(map.visibleNodeIds.size < fixture.nodes.length);
  assert.ok(map.visibleLinkIds.size < fixture.links.length);
  assert.equal(full.visibleNodeIds.size, fixture.nodes.length);
  assert.equal(full.visibleLinkIds.size, fixture.links.length, 'the duplicate alias is one relationship in every mode');
  assert.equal(full.collapsedCount, 0);
});

test('project map regions and node positions are deterministic, non-overlapping, and bounded', async () => {
  const { buildProjectGraphProjection, graphProjectMapLayout } = await loadGraphOrganization();
  const fixture = denseProjectFixture();
  const projection = buildProjectGraphProjection('project-map', fixture.nodes, fixture.links, {
    projectPath: fixture.project,
    collapse: true,
  });
  const reversedProjection = buildProjectGraphProjection('project-map', [...fixture.nodes].reverse(), [...fixture.links].reverse(), {
    projectPath: fixture.project,
    collapse: true,
  });
  const layout = graphProjectMapLayout(projection.groups, fixture.nodes, projection.roleById, 960, 640);
  const repeated = graphProjectMapLayout(reversedProjection.groups, [...fixture.nodes].reverse(), reversedProjection.roleById, 960, 640);
  const normalize = values => [...values].sort(([left], [right]) => left.localeCompare(right));

  assert.deepEqual(normalize(layout.positions), normalize(repeated.positions));
  assert.deepEqual(normalize(layout.regions), normalize(repeated.regions));
  const regions = [...layout.regions.values()];
  for (const region of regions) {
    assert.ok(region.x >= 0 && region.y >= 0);
    assert.ok(region.x + region.width <= 960);
    assert.ok(region.y + region.height <= 640);
  }
  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      const separated = regions[left].x + regions[left].width <= regions[right].x
        || regions[right].x + regions[right].width <= regions[left].x
        || regions[left].y + regions[left].height <= regions[right].y
        || regions[right].y + regions[right].height <= regions[left].y;
      assert.equal(separated, true, `${regions[left].group} overlaps ${regions[right].group}`);
    }
  }
  for (const point of layout.positions.values()) {
    assert.ok(point.x >= 0 && point.x <= 960);
    assert.ok(point.y >= 0 && point.y <= 640);
  }
});

test('project map regions stay in bounds on a compact landscape stage', async () => {
  const { graphClusterRegions } = await loadGraphOrganization();
  const width = 600;
  const height = 480;
  const regions = [...graphClusterRegions(['Project root', 'Reports', 'Insights', 'Reference'], width, height).values()];

  assert.equal(regions.length, 4);
  for (const region of regions) {
    assert.ok(region.x >= 0 && region.y >= 0);
    assert.ok(region.x + region.width <= width);
    assert.ok(region.y + region.height <= height);
  }
  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      const separated = regions[left].x + regions[left].width <= regions[right].x
        || regions[right].x + regions[right].width <= regions[left].x
        || regions[left].y + regions[left].height <= regions[right].y
        || regions[right].y + regions[right].height <= regions[left].y;
      assert.equal(separated, true, `${regions[left].group} overlaps ${regions[right].group}`);
    }
  }
});

test('project map nodes and label baselines stay inside four regions at the 320x280 minimum', async () => {
  const { buildProjectGraphProjection, graphProjectMapLayout } = await loadGraphOrganization();
  const fixture = denseProjectFixture();
  const projection = buildProjectGraphProjection('project-map', fixture.nodes, fixture.links, {
    projectPath: fixture.project,
    collapse: true,
  });
  const reversedProjection = buildProjectGraphProjection('project-map', [...fixture.nodes].reverse(), [...fixture.links].reverse(), {
    projectPath: fixture.project,
    collapse: true,
  });
  const width = 320;
  const height = 280;
  const layout = graphProjectMapLayout(projection.groups, fixture.nodes, projection.roleById, width, height);
  const repeated = graphProjectMapLayout(reversedProjection.groups, [...fixture.nodes].reverse(), reversedProjection.roleById, width, height);

  assert.deepEqual([...layout.regions], [...repeated.regions]);
  assert.deepEqual([...layout.positions].sort(), [...repeated.positions].sort());
  assert.equal(new Set([...layout.regions.values()].map(region => region.x)).size, 2);
  assert.equal(new Set([...layout.regions.values()].map(region => region.y)).size, 2);
  assertCompactLayoutContained(layout, projection.groups, fixture.nodes, projection.roleById, width, height);
});

test('compact project map safely fits eight deterministic folder regions without negative geometry', async () => {
  const { graphProjectMapLayout } = await loadGraphOrganization();
  const width = 320;
  const height = 280;
  const names = ['Project root', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
  const nodes = names.map((name, index) => ({
    id: `Compact/${name}/Note ${index}.md`,
    label: `N${index}`,
    folder: `Compact/${name}`,
    degree: index === 0 ? 12 : index % 3,
  }));
  const groups = names.map((name, index) => ({
    name,
    nodeIds: [nodes[index].id],
    visibleNodeIds: [nodes[index].id],
    collapsedNodeIds: [],
    collapsibleNodeIds: [],
  }));
  const roleById = new Map(nodes.map((node, index) => [node.id, index === 0 ? 'home' : 'note']));
  const layout = graphProjectMapLayout(groups, nodes, roleById, width, height);
  const repeated = graphProjectMapLayout([...groups].reverse(), [...nodes].reverse(), roleById, width, height);

  assert.equal(layout.regions.size, names.length);
  assert.deepEqual([...layout.regions], [...repeated.regions]);
  assert.deepEqual([...layout.positions].sort(), [...repeated.positions].sort());
  assertCompactLayoutContained(layout, groups, nodes, roleById, width, height);
});

test('case-distinct folder regions have a stable order across input permutations', async () => {
  const { graphClusterRegions } = await loadGraphOrganization();
  const normalize = values => [...values].map(([group, region]) => [group, region]);
  const forward = graphClusterRegions(['Reports', 'reports', 'Reference'], 900, 540);
  const reversed = graphClusterRegions(['Reference', 'reports', 'Reports'], 900, 540);

  assert.deepEqual(normalize(forward), normalize(reversed));
  assert.equal(forward.size, 3);
});

test('GraphView defaults to Project map and exposes Full graph as an explicit advanced option', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'src', 'GraphView.tsx'), 'utf8');
  assert.match(source, /useState<ProjectGraphDisplayMode>\('project-map'\)/);
  assert.match(source, />Project map<\/button>/);
  assert.match(source, />Full graph<\/button>/);
  assert.match(source, /nextMode === 'full-graph'\) setScope\('project'\)/);
  assert.match(source, /displayMode === 'full-graph'[^\n]+<details><summary>Forces/);
});

test('Full graph wires perspective orbit controls and a direct full-screen action without changing the map default', async () => {
  const [source, styles] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'src', 'GraphView.tsx'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src', 'styles.css'), 'utf8'),
  ]);

  assert.match(source, /if \(displayMode !== 'full-graph'\) return projected/);
  assert.match(source, /projectGraphPoint\(point, center, orbit, cameraDistance\)/);
  assert.match(source, /kind: 'orbit'/);
  assert.match(source, /displayMode === 'full-graph' && !event\.shiftKey/);
  assert.match(source, /displayMode === 'full-graph' && <button ref=\{fullscreenTriggerRef\} className="graph-fullscreen-button" aria-pressed=\{fullscreenActive\}/);
  assert.match(source, /fullscreenFallback \? 'Exit expanded view' : isFullscreen \? 'Exit full screen' : 'Full screen'/);
  assert.match(source, /orbitFrameRef\.current = requestAnimationFrame/);
  assert.match(source, /renderedNodes\.map\(node =>/);
  assert.match(source, /document\.addEventListener\('keydown', closeFallback, true\)/);
  assert.match(source, /aria-label=\{displayMode === 'full-graph' \? 'Interactive 3D Full graph viewport'/);
  assert.match(source, /Drag empty space to rotate · Shift-drag to pan/);
  assert.match(source, /setOrbit\(DEFAULT_GRAPH_ORBIT\)/);
  assert.match(styles, /\.graph-relationship-workspace\.graph-fullscreen-fallback\s*\{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/);
  assert.match(styles, /height: 100dvh;/);
  assert.match(styles, /\.graph-full-graph-3d \.graph-link-layer \{ pointer-events: none; \}/);
});
