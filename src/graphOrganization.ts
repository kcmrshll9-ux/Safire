export type GraphLayoutPoint = { x: number; y: number };

export type ProjectMapNodeInput = {
  id: string;
  label: string;
  folder: string;
  degree: number;
  missing?: boolean;
};

export type ProjectMapLinkInput = {
  id: string;
  source: string;
  targetId: string;
  resolved?: boolean;
};

export type ProjectMapNodeRole = 'home' | 'hub' | 'bridge' | 'note' | 'missing';
export type ProjectGraphDisplayMode = 'project-map' | 'full-graph';

export type ProjectMapGroup = {
  name: string;
  nodeIds: string[];
  visibleNodeIds: string[];
  collapsedNodeIds: string[];
  collapsibleNodeIds: string[];
};

export type ProjectMapProjection = {
  mode: ProjectGraphDisplayMode;
  groups: ProjectMapGroup[];
  visibleNodeIds: Set<string>;
  visibleLinkIds: Set<string>;
  homeNodeId: string | null;
  hubNodeIds: Set<string>;
  bridgeNodeIds: Set<string>;
  roleById: Map<string, ProjectMapNodeRole>;
  selectedNeighborIds: Set<string>;
  hiddenSelectedNeighborsByGroup: Array<{ group: string; nodeIds: string[] }>;
  collapsedCount: number;
};

export type GraphClusterRegion = {
  group: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ProjectMapLayout = {
  regions: Map<string, GraphClusterRegion>;
  positions: Map<string, GraphLayoutPoint>;
};

const PROJECT_MAP_COLLAPSE_THRESHOLD = 10;
const PROJECT_MAP_VISIBLE_PER_GROUP = 8;
const PROJECT_MAP_MIN_REGION_WIDTH = 72;
const PROJECT_MAP_MIN_REGION_HEIGHT = 88;
const PROJECT_MAP_MAX_NODE_SCALE = 1.6;
const PROJECT_MAP_NODE_LABEL_OFFSET = 15;

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function compareStableStrings(left: string, right: string) {
  const byLabel = left.localeCompare(right, undefined, { sensitivity: 'base' });
  if (byLabel) return byLabel;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIds(left: { id: string }, right: { id: string }) {
  return compareStableStrings(normalizePath(left.id), normalizePath(right.id));
}

function projectGroupOrder(left: string, right: string) {
  if (left === 'Project root') return right === 'Project root' ? 0 : -1;
  if (right === 'Project root') return 1;
  if (left === 'Unresolved links') return right === 'Unresolved links' ? 0 : 1;
  if (right === 'Unresolved links') return -1;
  return compareStableStrings(left, right);
}

export function projectFolderGroup(folder: string, projectPath: string) {
  const normalizedFolder = normalizePath(folder);
  const normalizedProject = normalizePath(projectPath);
  if (!normalizedFolder || normalizedFolder === normalizedProject) return 'Project root';
  const projectPrefix = normalizedProject ? `${normalizedProject}/` : '';
  const relativeFolder = projectPrefix && normalizedFolder.startsWith(projectPrefix)
    ? normalizedFolder.slice(projectPrefix.length)
    : normalizedFolder;
  return relativeFolder.split('/').filter(Boolean)[0] || 'Project root';
}

export function graphGroupAnchors(groups: string[], width: number, height: number) {
  const center = { x: width / 2, y: height / 2 };
  const anchors = new Map<string, GraphLayoutPoint>();
  const ringGroups = groups.filter(group => group !== 'Project root');
  if (groups.includes('Project root')) anchors.set('Project root', center);
  if (!ringGroups.length) return anchors;
  if (ringGroups.length === 1 && !anchors.size) {
    anchors.set(ringGroups[0], center);
    return anchors;
  }
  const radius = Math.max(72, Math.min(Math.min(width, height) * .3, Math.min(width, height) / 2 - 64));
  ringGroups.forEach((group, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / ringGroups.length;
    anchors.set(group, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  });
  return anchors;
}

export function graphLayoutBounds(width: number, height: number) {
  const padding = Math.min(96, Math.max(48, Math.min(width, height) * .12));
  return {
    minimumX: Math.min(padding, width / 2),
    maximumX: Math.max(width - padding, width / 2),
    minimumY: Math.min(padding, height / 2),
    maximumY: Math.max(height - padding, height / 2),
  };
}

function groupForMapNode(node: ProjectMapNodeInput, projectPath: string) {
  return node.missing ? 'Unresolved links' : projectFolderGroup(node.folder, projectPath);
}

/**
 * Keeps one relationship for each directed source/target pair. The first link
 * retains its label and resolution metadata, while a reciprocal edge remains
 * a separate relationship.
 */
export function deduplicateDirectedLinks<Link extends ProjectMapLinkInput>(links: Link[]) {
  const seen = new Set<string>();
  const deduplicated: Link[] = [];
  for (const link of links) {
    // The server has already resolved aliases to canonical node ids. Keep the
    // comparison case-sensitive so distinct files remain distinct on vaults
    // hosted by case-sensitive filesystems.
    const key = `${normalizePath(link.source)}\u0000${normalizePath(link.targetId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(link);
  }
  return deduplicated;
}

export function findProjectHomeId(nodes: ProjectMapNodeInput[], projectPath: string) {
  const projectName = normalizePath(projectPath).split('/').pop()?.toLocaleLowerCase() || '';
  const roots = nodes
    .filter(node => !node.missing && projectFolderGroup(node.folder, projectPath) === 'Project root')
    .slice()
    .sort(compareIds);
  if (!roots.length) return null;
  const score = (node: ProjectMapNodeInput) => {
    const basename = normalizePath(node.id).split('/').pop()?.replace(/\.md$/i, '').toLocaleLowerCase() || '';
    const label = node.label.trim().toLocaleLowerCase();
    let value = Math.max(0, node.degree);
    if (projectName && (basename === projectName || label === projectName)) value += 1_000;
    if (projectName && (basename === `${projectName} project` || label === `${projectName} project`)) value += 950;
    if (projectName && (basename.startsWith(projectName) || label.startsWith(projectName))) value += 700;
    if (/\b(project|home|overview|index)\b/i.test(`${basename} ${label}`)) value += 350;
    return value;
  };
  return roots.sort((left, right) => score(right) - score(left) || compareIds(left, right))[0].id;
}

function buildAdjacency(nodes: ProjectMapNodeInput[], links: ProjectMapLinkInput[]) {
  const known = new Set(nodes.map(node => node.id));
  const adjacency = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const link of deduplicateDirectedLinks(links)) {
    if (!known.has(link.source) || !known.has(link.targetId)) continue;
    adjacency.get(link.source)?.add(link.targetId);
    adjacency.get(link.targetId)?.add(link.source);
  }
  return adjacency;
}

function rolePriority(role: ProjectMapNodeRole) {
  return { home: 0, hub: 1, bridge: 2, note: 3, missing: 4 }[role];
}

function classifyProjectMapNodes(nodes: ProjectMapNodeInput[], links: ProjectMapLinkInput[], projectPath: string) {
  const sortedNodes = nodes.slice().sort(compareIds);
  const nodeById = new Map(sortedNodes.map(node => [node.id, node]));
  const groupById = new Map(sortedNodes.map(node => [node.id, groupForMapNode(node, projectPath)]));
  const adjacency = buildAdjacency(sortedNodes, links);
  const homeNodeId = findProjectHomeId(sortedNodes, projectPath);
  const ordinary = sortedNodes.filter(node => !node.missing && node.id !== homeNodeId);
  const averageDegree = ordinary.length
    ? ordinary.reduce((total, node) => total + (adjacency.get(node.id)?.size || node.degree || 0), 0) / ordinary.length
    : 0;
  const hubThreshold = Math.max(4, Math.ceil(averageDegree * 1.35));
  const hubLimit = Math.max(2, Math.ceil(sortedNodes.length / 10));
  const hubNodeIds = new Set(ordinary
    .slice()
    .sort((left, right) => (adjacency.get(right.id)?.size || right.degree) - (adjacency.get(left.id)?.size || left.degree) || compareIds(left, right))
    .filter(node => (adjacency.get(node.id)?.size || node.degree) >= hubThreshold)
    .slice(0, hubLimit)
    .map(node => node.id));

  const bridgeLimit = Math.max(3, Math.ceil(sortedNodes.length / 10));
  const bridgeNodeIds = new Set(ordinary.map(node => {
    const neighborGroups = new Set([...adjacency.get(node.id) || []].map(id => groupById.get(id)).filter(Boolean));
    return { node, neighborGroups: neighborGroups.size };
  }).filter(entry => entry.neighborGroups >= 2)
    .sort((left, right) => right.neighborGroups - left.neighborGroups
      || (adjacency.get(right.node.id)?.size || right.node.degree) - (adjacency.get(left.node.id)?.size || left.node.degree)
      || compareIds(left.node, right.node))
    .slice(0, bridgeLimit)
    .map(entry => entry.node.id));

  const roleById = new Map<string, ProjectMapNodeRole>();
  for (const node of sortedNodes) {
    const role = node.missing
      ? 'missing'
      : node.id === homeNodeId
        ? 'home'
        : hubNodeIds.has(node.id)
          ? 'hub'
          : bridgeNodeIds.has(node.id)
            ? 'bridge'
            : 'note';
    roleById.set(node.id, role);
  }
  return { sortedNodes, nodeById, groupById, adjacency, homeNodeId, hubNodeIds, bridgeNodeIds, roleById };
}

function rankedNodeIds(
  nodeIds: string[],
  nodeById: Map<string, ProjectMapNodeInput>,
  adjacency: Map<string, Set<string>>,
  roleById: Map<string, ProjectMapNodeRole>,
) {
  return nodeIds.slice().sort((leftId, rightId) => {
    const left = nodeById.get(leftId)!;
    const right = nodeById.get(rightId)!;
    return rolePriority(roleById.get(leftId) || 'note') - rolePriority(roleById.get(rightId) || 'note')
      || (adjacency.get(rightId)?.size || right.degree) - (adjacency.get(leftId)?.size || left.degree)
      || compareIds(left, right);
  });
}

function selectOverviewLinks(
  links: ProjectMapLinkInput[],
  visibleNodeIds: Set<string>,
  groupById: Map<string, string>,
  roleById: Map<string, ProjectMapNodeRole>,
  nodeById: Map<string, ProjectMapNodeInput>,
  selectedId: string | null,
) {
  const candidates = deduplicateDirectedLinks(links).filter(link => visibleNodeIds.has(link.source) && visibleNodeIds.has(link.targetId));
  if (visibleNodeIds.size <= 12) return new Set(candidates.map(link => link.id));
  const selected = new Set<string>();
  const score = (link: ProjectMapLinkInput) => {
    const sourceRole = roleById.get(link.source) || 'note';
    const targetRole = roleById.get(link.targetId) || 'note';
    const roleScore = (4 - rolePriority(sourceRole)) * 100 + (4 - rolePriority(targetRole)) * 100;
    return roleScore + (nodeById.get(link.source)?.degree || 0) + (nodeById.get(link.targetId)?.degree || 0);
  };
  const ordered = candidates.slice().sort((left, right) => score(right) - score(left)
    || left.source.localeCompare(right.source)
    || left.targetId.localeCompare(right.targetId)
    || left.id.localeCompare(right.id));

  if (selectedId) {
    for (const link of ordered) {
      if (link.source === selectedId || link.targetId === selectedId) selected.add(link.id);
    }
  }

  const groupPairLinks = new Map<string, ProjectMapLinkInput>();
  for (const link of ordered) {
    const sourceGroup = groupById.get(link.source);
    const targetGroup = groupById.get(link.targetId);
    if (!sourceGroup || !targetGroup || sourceGroup === targetGroup) continue;
    const pair = [sourceGroup, targetGroup].sort(projectGroupOrder).join('\u0000');
    if (!groupPairLinks.has(pair)) groupPairLinks.set(pair, link);
  }
  for (const link of groupPairLinks.values()) selected.add(link.id);

  const perGroup = new Map<string, number>();
  const perHub = new Map<string, number>();
  for (const link of ordered) {
    const sourceGroup = groupById.get(link.source);
    const targetGroup = groupById.get(link.targetId);
    const sourceRole = roleById.get(link.source) || 'note';
    const targetRole = roleById.get(link.targetId) || 'note';
    if (sourceGroup && sourceGroup === targetGroup && (sourceRole !== 'note' || targetRole !== 'note')) {
      const count = perGroup.get(sourceGroup) || 0;
      if (count < 2) {
        selected.add(link.id);
        perGroup.set(sourceGroup, count + 1);
      }
    }
    for (const [nodeId, role] of [[link.source, sourceRole], [link.targetId, targetRole]] as const) {
      if (role !== 'home' && role !== 'hub') continue;
      const count = perHub.get(nodeId) || 0;
      if (count >= 2) continue;
      selected.add(link.id);
      perHub.set(nodeId, count + 1);
    }
  }
  return selected;
}

export function buildProjectGraphProjection(
  mode: ProjectGraphDisplayMode,
  nodes: ProjectMapNodeInput[],
  links: ProjectMapLinkInput[],
  options: {
    projectPath: string;
    activePath?: string;
    selectedId?: string | null;
    expandedGroups?: Iterable<string>;
    collapse?: boolean;
  },
): ProjectMapProjection {
  const classified = classifyProjectMapNodes(nodes, links, options.projectPath);
  const { sortedNodes, nodeById, groupById, adjacency, homeNodeId, hubNodeIds, bridgeNodeIds, roleById } = classified;
  const deduplicatedLinks = deduplicateDirectedLinks(links);
  const selectedId = options.selectedId && nodeById.has(options.selectedId) ? options.selectedId : null;
  const expandedGroups = new Set(options.expandedGroups || []);
  const selectedNeighborIds = new Set(selectedId ? [...adjacency.get(selectedId) || []] : []);
  const rankedSelectedNeighbors = rankedNodeIds([...selectedNeighborIds], nodeById, adjacency, roleById);
  // A deliberate selection is the one time the compact map reveals every
  // immediate neighbor. Render budgets have already bounded this collection.
  const promotedSelectedNeighbors = new Set(rankedSelectedNeighbors);

  const grouped = new Map<string, string[]>();
  for (const node of sortedNodes) {
    const group = groupById.get(node.id)!;
    const members = grouped.get(group) || [];
    members.push(node.id);
    grouped.set(group, members);
  }

  const visibleNodeIds = new Set<string>();
  const groups: ProjectMapGroup[] = [];
  for (const groupName of [...grouped.keys()].sort(projectGroupOrder)) {
    const ranked = rankedNodeIds(grouped.get(groupName) || [], nodeById, adjacency, roleById);
    const mustShow = new Set(ranked.filter(id => id === homeNodeId
      || hubNodeIds.has(id)
      || bridgeNodeIds.has(id)
      || id === options.activePath
      || id === selectedId
      || promotedSelectedNeighbors.has(id)));
    const canCollapse = mode === 'project-map'
      && options.collapse !== false
      && ranked.length > PROJECT_MAP_COLLAPSE_THRESHOLD;
    const compactVisible = canCollapse
      ? ranked.filter((id, index) => mustShow.has(id) || index < PROJECT_MAP_VISIBLE_PER_GROUP)
      : ranked;
    const compactVisibleSet = new Set(compactVisible);
    const collapsible = ranked.filter(id => !compactVisibleSet.has(id));
    const visible = canCollapse && !expandedGroups.has(groupName) ? compactVisible : ranked;
    const visibleSet = new Set(visible);
    const collapsed = ranked.filter(id => !visibleSet.has(id));
    visible.forEach(id => visibleNodeIds.add(id));
    groups.push({ name: groupName, nodeIds: ranked, visibleNodeIds: visible, collapsedNodeIds: collapsed, collapsibleNodeIds: collapsible });
  }

  const hiddenSelectedNeighborsByGroup = groups.map(group => ({
    group: group.name,
    nodeIds: group.collapsedNodeIds.filter(id => selectedNeighborIds.has(id)),
  })).filter(group => group.nodeIds.length > 0);

  const visibleLinkIds = mode === 'full-graph'
    ? new Set(deduplicatedLinks.map(link => link.id))
    : selectOverviewLinks(deduplicatedLinks, visibleNodeIds, groupById, roleById, nodeById, selectedId);
  return {
    mode,
    groups,
    visibleNodeIds,
    visibleLinkIds,
    homeNodeId,
    hubNodeIds,
    bridgeNodeIds,
    roleById,
    selectedNeighborIds,
    hiddenSelectedNeighborsByGroup,
    collapsedCount: groups.reduce((total, group) => total + group.collapsedNodeIds.length, 0),
  };
}

export function graphClusterRegions(groups: string[], width: number, height: number) {
  const ordered = [...new Set(groups)].sort(projectGroupOrder);
  const regions = new Map<string, GraphClusterRegion>();
  if (!ordered.length) return regions;
  const outer = Math.max(18, Math.min(34, Math.min(width, height) * .045));
  const gap = Math.max(14, Math.min(24, Math.min(width, height) * .035));
  const usableWidth = Math.max(180, width - outer * 2);
  const usableHeight = Math.max(180, height - outer * 2);
  const narrow = usableWidth < 640;
  const preferredColumns = narrow
    ? 1
    : Math.min(3, Math.max(1, Math.ceil(Math.sqrt(ordered.length * usableWidth / Math.max(1, usableHeight)))));
  const maximumColumns = Math.max(1, Math.min(ordered.length, Math.floor((usableWidth + gap) / (150 + gap))));
  const maximumRows = Math.max(1, Math.floor((usableHeight + gap) / (150 + gap)));
  const minimumColumns = Math.ceil(ordered.length / maximumRows);
  let columns = Math.min(maximumColumns, Math.max(preferredColumns, minimumColumns));
  let rows = Math.ceil(ordered.length / columns);
  let columnGap = gap;
  let rowGap = gap;
  // Fit the stage exactly even when it is too small to honor the preferred
  // 150px region size; overflowing the SVG would make folders unreachable.
  let regionWidth = (usableWidth - columnGap * (columns - 1)) / columns;
  let regionHeight = (usableHeight - rowGap * (rows - 1)) / rows;
  if (regionWidth < PROJECT_MAP_MIN_REGION_WIDTH || regionHeight < PROJECT_MAP_MIN_REGION_HEIGHT) {
    // A compact stage can make the preferred 150px row/column constraints
    // mutually exclusive (for example, four groups at 320x280). Choose the
    // best-fitting deterministic grid instead, and tighten only its gutters.
    const compactGap = Math.min(gap, 8);
    let best: {
      columns: number;
      rows: number;
      columnGap: number;
      rowGap: number;
      regionWidth: number;
      regionHeight: number;
      score: number;
    } | null = null;
    for (let candidateColumns = 1; candidateColumns <= ordered.length; candidateColumns += 1) {
      const candidateRows = Math.ceil(ordered.length / candidateColumns);
      const candidateColumnGap = candidateColumns > 1
        ? Math.max(0, Math.min(compactGap, (usableWidth - candidateColumns) / (candidateColumns - 1)))
        : 0;
      const candidateRowGap = candidateRows > 1
        ? Math.max(0, Math.min(compactGap, (usableHeight - candidateRows) / (candidateRows - 1)))
        : 0;
      const candidateWidth = (usableWidth - candidateColumnGap * (candidateColumns - 1)) / candidateColumns;
      const candidateHeight = (usableHeight - candidateRowGap * (candidateRows - 1)) / candidateRows;
      const score = Math.min(
        candidateWidth / PROJECT_MAP_MIN_REGION_WIDTH,
        candidateHeight / PROJECT_MAP_MIN_REGION_HEIGHT,
      );
      if (!best || score > best.score) {
        best = {
          columns: candidateColumns,
          rows: candidateRows,
          columnGap: candidateColumnGap,
          rowGap: candidateRowGap,
          regionWidth: candidateWidth,
          regionHeight: candidateHeight,
          score,
        };
      }
    }
    if (best) {
      ({ columns, rows, columnGap, rowGap, regionWidth, regionHeight } = best);
    }
  }
  ordered.forEach((group, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    regions.set(group, {
      group,
      x: outer + column * (regionWidth + columnGap),
      y: outer + row * (regionHeight + rowGap),
      width: regionWidth,
      height: regionHeight,
    });
  });
  return regions;
}

export function graphProjectMapLayout(
  groups: ProjectMapGroup[],
  nodes: ProjectMapNodeInput[],
  roleById: Map<string, ProjectMapNodeRole>,
  width: number,
  height: number,
): ProjectMapLayout {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const regions = graphClusterRegions(groups.map(group => group.name), width, height);
  const positions = new Map<string, GraphLayoutPoint>();
  for (const group of groups) {
    const region = regions.get(group.name);
    if (!region) continue;
    const orderedIds = group.visibleNodeIds.slice().sort((leftId, rightId) => {
      const left = nodeById.get(leftId)!;
      const right = nodeById.get(rightId)!;
      return rolePriority(roleById.get(leftId) || 'note') - rolePriority(roleById.get(rightId) || 'note')
        || right.degree - left.degree
        || compareIds(left, right);
    });
    if (!orderedIds.length) continue;
    const preferredHorizontalPadding = Math.min(50, Math.max(28, region.width * .12));
    const horizontalPadding = Math.max(0, Math.min(preferredHorizontalPadding, region.width * .25));
    const topPadding = Math.min(56, region.height);
    const bottomPadding = Math.min(18, Math.max(0, region.height - topPadding));
    const innerWidth = Math.max(0, region.width - horizontalPadding * 2);
    const innerHeight = Math.max(0, region.height - topPadding - bottomPadding);
    const columns = Math.max(1, Math.min(orderedIds.length, Math.ceil(Math.sqrt(orderedIds.length * Math.max(1, innerWidth) / Math.max(1, innerHeight)))));
    const rows = Math.ceil(orderedIds.length / columns);
    orderedIds.forEach((nodeId, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      let x = region.x + horizontalPadding + (column + .5) * innerWidth / columns;
      let y = region.y + topPadding + (row + .5) * innerHeight / rows;
      if (region.width < 150 || region.height < 150) {
        const node = nodeById.get(nodeId)!;
        const role = roleById.get(nodeId) || 'note';
        const scaledRadius = Math.max(6, Math.min(24, (7 + Math.sqrt(Math.max(0, node.degree)) * 2.2) * PROJECT_MAP_MAX_NODE_SCALE));
        const radius = role === 'home'
          ? Math.max(scaledRadius, 20 * PROJECT_MAP_MAX_NODE_SCALE)
          : role === 'hub'
            ? Math.max(scaledRadius, 15 * PROJECT_MAP_MAX_NODE_SCALE)
            : scaledRadius;
        const horizontalClearance = Math.min(radius, region.width / 2);
        const topClearance = Math.min(radius, region.height / 2);
        const bottomClearance = Math.min(radius + PROJECT_MAP_NODE_LABEL_OFFSET, region.height - topClearance);
        x = Math.max(region.x + horizontalClearance, Math.min(region.x + region.width - horizontalClearance, x));
        y = Math.max(region.y + topClearance, Math.min(region.y + region.height - bottomClearance, y));
      }
      positions.set(nodeId, {
        x,
        y,
      });
    });
  }
  return { regions, positions };
}
