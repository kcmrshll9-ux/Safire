import React from 'react';
import { GRAPH_RENDER_LIMITS, graphSourceLinkCountLabel, limitGraphForRendering } from './frontendSecurity';
import {
  buildProjectGraphProjection,
  deduplicateDirectedLinks,
  graphGroupAnchors,
  graphLayoutBounds,
  graphProjectMapLayout,
  projectFolderGroup,
  type GraphLayoutPoint,
  type ProjectGraphDisplayMode,
  type ProjectMapNodeRole,
} from './graphOrganization';
import {
  DEFAULT_GRAPH_ORBIT,
  graphCameraDistance,
  graphCameraPlaneDelta,
  projectGraphPoint,
  stableGraphDepth,
  updateGraphOrbit,
  type GraphOrbit,
  type GraphProjectedPoint,
} from './graphProjection';
import { OverflowMenu } from './OverflowMenu';

export type GraphNodeData = {
  id: string;
  label: string;
  tags: string[];
  folder: string;
  size: number;
  mtime: number;
  inDegree: number;
  outDegree: number;
  degree: number;
  orphan: boolean;
};

export type GraphLinkData = {
  id: string;
  source: string;
  target: string;
  label: string;
  resolved: boolean;
  resolution: 'exact-path' | 'unique-title' | 'ambiguous' | 'missing';
};

export type GraphData = {
  nodes: GraphNodeData[];
  links: GraphLinkData[];
  meta?: {
    sourceNotes: number;
    sourceNotesComplete?: boolean;
    sourceLinks: number;
    sourceLinksComplete?: boolean;
    returnedNotes: number;
    returnedLinks: number;
    truncated: boolean;
    omittedNoteContent?: number;
    omittedLinkFields?: number;
    responseBytes?: number;
  };
};

type GraphViewProps = {
  graph: GraphData;
  activePath: string;
  onPreview: (path: string) => void;
  onEdit: (path: string) => void;
  onCreateMissing: (title: string) => void;
  overlay?: React.ReactNode;
  eyebrow?: string;
  title?: string;
  description?: string;
  scopeLabel?: string;
  projectPath?: string;
};

type RenderNode = GraphNodeData & { missing: boolean; resolution?: GraphLinkData['resolution'] };
type RenderLink = GraphLinkData & { targetId: string };
type LayoutPoint = { x: number; y: number; z: number; depthExtent: number; vx: number; vy: number; fx?: number; fy?: number; fz?: number };
type ViewTransform = { x: number; y: number; k: number };
type GraphScope = 'project' | 'local';
type GroupMode = 'folder' | 'tag' | 'none';

type GraphPreferences = {
  showMissing: boolean;
  showOrphans: boolean;
  showLabels: boolean;
  arrows: boolean;
  groupBy: GroupMode;
  nodeSize: number;
  linkWidth: number;
  centerForce: number;
  repelForce: number;
  linkStrength: number;
  linkDistance: number;
};

const DEFAULT_PREFERENCES: GraphPreferences = {
  showMissing: true,
  showOrphans: true,
  showLabels: true,
  arrows: false,
  groupBy: 'folder',
  nodeSize: 1,
  linkWidth: 1.35,
  centerForce: .42,
  repelForce: 92,
  linkStrength: .58,
  linkDistance: 112,
};

const GRAPH_PREFERENCES_KEY = 'safire.graph.preferences.v1';

function graphHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function titleFromGraphPath(notePath: string) {
  return notePath.split('/').pop()?.replace(/\.md$/i, '') || notePath;
}

function missingNodeId(link: GraphLinkData) {
  return `missing:${link.resolution}:${link.target.toLocaleLowerCase()}`;
}

function readGraphPreferences(): GraphPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(GRAPH_PREFERENCES_KEY) || '{}') as Partial<GraphPreferences>;
    const finiteNumber = <Key extends keyof GraphPreferences>(key: Key, minimum: number, maximum: number) => {
      const value = stored[key];
      return typeof value === 'number' && Number.isFinite(value) ? clamp(value, minimum, maximum) : DEFAULT_PREFERENCES[key];
    };
    return {
      showMissing: typeof stored.showMissing === 'boolean' ? stored.showMissing : DEFAULT_PREFERENCES.showMissing,
      showOrphans: typeof stored.showOrphans === 'boolean' ? stored.showOrphans : DEFAULT_PREFERENCES.showOrphans,
      showLabels: typeof stored.showLabels === 'boolean' ? stored.showLabels : DEFAULT_PREFERENCES.showLabels,
      arrows: typeof stored.arrows === 'boolean' ? stored.arrows : DEFAULT_PREFERENCES.arrows,
      groupBy: stored.groupBy === 'folder' || stored.groupBy === 'tag' || stored.groupBy === 'none' ? stored.groupBy : DEFAULT_PREFERENCES.groupBy,
      nodeSize: finiteNumber('nodeSize', .7, 1.6) as number,
      linkWidth: finiteNumber('linkWidth', .6, 3) as number,
      centerForce: finiteNumber('centerForce', 0, 1) as number,
      repelForce: finiteNumber('repelForce', 20, 220) as number,
      linkStrength: finiteNumber('linkStrength', .05, 1) as number,
      linkDistance: finiteNumber('linkDistance', 45, 220) as number,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function expandGraph(graph: GraphData) {
  const actualIds = new Set(graph.nodes.map(node => node.id));
  const placeholders = new Map<string, RenderNode>();
  const candidateLinks: RenderLink[] = [];
  for (const link of graph.links) {
    // A resolved internal relationship without its endpoint was removed by a
    // rendering safety budget; it is not an unresolved note and must never be
    // redrawn as a misleading placeholder.
    if (link.resolved && !actualIds.has(link.target)) continue;
    const targetId = link.resolved ? link.target : missingNodeId(link);
    if (!actualIds.has(targetId) && !placeholders.has(targetId)) {
      placeholders.set(targetId, {
        id: targetId,
        label: link.label || titleFromGraphPath(link.target),
        tags: [],
        folder: '',
        size: 0,
        mtime: 0,
        inDegree: 0,
        outDegree: 0,
        degree: 0,
        orphan: false,
        missing: true,
        resolution: link.resolution,
      });
    }
    candidateLinks.push({ ...link, targetId });
  }
  const links = deduplicateDirectedLinks(candidateLinks);
  const degree = new Map<string, number>();
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) || 0) + 1);
    degree.set(link.targetId, (degree.get(link.targetId) || 0) + 1);
  }
  const nodes: RenderNode[] = [
    ...graph.nodes.map(node => ({ ...node, missing: false, degree: degree.get(node.id) ?? node.degree })),
    ...placeholders.values(),
  ].map(node => ({ ...node, degree: degree.get(node.id) ?? node.degree }));
  return { nodes, links };
}

function localGraphIds(nodes: RenderNode[], links: RenderLink[], root: string, depth: number) {
  const known = new Set(nodes.map(node => node.id));
  if (!known.has(root)) return new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const link of links) {
    adjacency.get(link.source)?.add(link.targetId);
    adjacency.get(link.targetId)?.add(link.source);
  }
  const distance = new Map<string, number>([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    const currentDepth = distance.get(current) || 0;
    if (currentDepth >= depth) continue;
    for (const neighbor of adjacency.get(current) || []) {
      if (distance.has(neighbor)) continue;
      distance.set(neighbor, currentDepth + 1);
      queue.push(neighbor);
    }
  }
  return new Set(distance.keys());
}

function nodeMatches(node: RenderNode, query: string) {
  if (!query) return true;
  const haystack = `${node.label} ${node.id} ${node.folder} ${node.tags.join(' ')}`.toLocaleLowerCase();
  return query.split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
}

function groupForNode(node: RenderNode, mode: GroupMode, projectPath: string) {
  if (node.missing) return 'Unresolved links';
  if (mode === 'tag') return node.tags[0] ? `#${node.tags[0]}` : 'Untagged';
  if (mode === 'folder') return projectFolderGroup(node.folder, projectPath);
  return 'Notes';
}

function nodeRadius(node: RenderNode, scale: number) {
  return clamp((7 + Math.sqrt(Math.max(0, node.degree)) * 2.2) * scale, 6, 24);
}

function displayedNodeRadius(node: RenderNode, scale: number, role: ProjectMapNodeRole | undefined) {
  const radius = nodeRadius(node, scale);
  if (role === 'home') return Math.max(radius, 20 * scale);
  if (role === 'hub') return Math.max(radius, 15 * scale);
  return radius;
}

function edgePath(source: GraphLayoutPoint, target: GraphLayoutPoint, link: RenderLink, sourceRadius: number, targetRadius: number) {
  const rawDx = target.x - source.x;
  const rawDy = target.y - source.y;
  const distance = Math.hypot(rawDx, rawDy);
  if (distance < 1) {
    const radius = Math.max(22, sourceRadius * 2.1);
    return `M ${source.x} ${source.y - sourceRadius} C ${source.x + radius} ${source.y - radius * 1.8}, ${source.x + radius} ${source.y + radius * 1.8}, ${source.x} ${source.y + sourceRadius}`;
  }
  const ux = rawDx / distance;
  const uy = rawDy / distance;
  const sx = source.x + ux * (sourceRadius + 2);
  const sy = source.y + uy * (sourceRadius + 2);
  const tx = target.x - ux * (targetRadius + 7);
  const ty = target.y - uy * (targetRadius + 7);
  const direction = graphHash(link.id) % 2 ? 1 : -1;
  const bend = direction * Math.min(18, Math.max(4, distance * .035));
  const midpointX = (sx + tx) / 2 - uy * bend;
  const midpointY = (sy + ty) / 2 + ux * bend;
  return `M ${sx} ${sy} Q ${midpointX} ${midpointY} ${tx} ${ty}`;
}

function formatGraphDate(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unknown';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function reportedGraphCount(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= fallback ? value : fallback;
}

export function GraphView({ graph, activePath, onPreview, onEdit, onCreateMissing, overlay, eyebrow = 'Project graph', title = 'Project connections', description = 'Links shape this project map. Dense hubs reveal recurring ideas; bridges reveal notes connecting different parts of the project.', scopeLabel = 'Project', projectPath = '' }: GraphViewProps) {
  const graphInstructionsId = React.useId();
  const workspaceRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const menuReturnFocusRef = React.useRef<SVGElement | null>(null);
  const fullscreenTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const nativeFullscreenActiveRef = React.useRef(false);
  const positionsRef = React.useRef(new Map<string, LayoutPoint>());
  const animationRef = React.useRef<number | null>(null);
  const orbitFrameRef = React.useRef<number | null>(null);
  const pendingOrbitRef = React.useRef<{ origin: GraphOrbit; deltaX: number; deltaY: number } | null>(null);
  const initialFitCompleteRef = React.useRef(false);
  const viewTouchedRef = React.useRef(false);
  const fitViewRef = React.useRef<() => void>(() => {});
  const pendingMapFocusRef = React.useRef<string | null>(null);
  const dragRef = React.useRef<null
    | { kind: 'pan'; pointerId: number; startX: number; startY: number; origin: ViewTransform }
    | { kind: 'orbit'; pointerId: number; startX: number; startY: number; origin: GraphOrbit; moved: boolean }
    | { kind: 'node'; pointerId: number; id: string; startX: number; startY: number; origin: { x: number; y: number; z: number }; perspectiveScale: number; moved: boolean }>(null);
  const suppressClickRef = React.useRef<string | null>(null);
  const [dimensions, setDimensions] = React.useState({ width: 900, height: 560 });
  const [view, setView] = React.useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const [orbit, setOrbit] = React.useState<GraphOrbit>(DEFAULT_GRAPH_ORBIT);
  const [orbiting, setOrbiting] = React.useState(false);
  const [displayMode, setDisplayMode] = React.useState<ProjectGraphDisplayMode>('project-map');
  const [scope, setScope] = React.useState<GraphScope>('project');
  const [localRoot, setLocalRoot] = React.useState(activePath);
  const [depth, setDepth] = React.useState(1);
  const [query, setQuery] = React.useState('');
  const [preferences, setPreferences] = React.useState<GraphPreferences>(readGraphPreferences);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(() => new Set());
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [navigatorOpen, setNavigatorOpen] = React.useState(false);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [fullscreenFallback, setFullscreenFallback] = React.useState(false);
  const [layoutVersion, setLayoutVersion] = React.useState(0);
  const [simulationVersion, setSimulationVersion] = React.useState(0);
  const [timelineEnabled, setTimelineEnabled] = React.useState(false);
  const [timelineCutoff, setTimelineCutoff] = React.useState(Number.POSITIVE_INFINITY);
  const [timelinePlaying, setTimelinePlaying] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState('');
  // activePath is a load-time retention hint. Once a graph is rendered, every
  // node the user can open is already retained; rebudgeting the same graph on
  // selection could swap nodes at a safety ceiling and reset its layout.
  const renderBudget = React.useMemo(() => limitGraphForRendering(graph, activePath), [graph]);
  const expanded = React.useMemo(() => expandGraph(renderBudget.graph), [renderBudget]);
  const sourceNoteCount = reportedGraphCount(graph.meta?.sourceNotes, graph.nodes.length);
  const sourceNoteLabel = graph.meta?.sourceNotesComplete === false ? `at least ${sourceNoteCount}` : `${sourceNoteCount}`;
  const sourceLinkCount = reportedGraphCount(graph.meta?.sourceLinks, graph.links.length);
  const sourceLinkLabel = graphSourceLinkCountLabel(sourceLinkCount, graph.meta?.sourceLinksComplete !== false);
  const omittedNoteContent = reportedGraphCount(graph.meta?.omittedNoteContent, 0);
  const omittedLinkFields = reportedGraphCount(graph.meta?.omittedLinkFields, 0);
  const graphWasTruncated = Boolean(
    graph.meta?.truncated
    || renderBudget.truncated
    || sourceNoteCount > renderBudget.renderedNotes
    || sourceLinkCount > renderBudget.renderedLinks,
  );
  const modifiedRange = React.useMemo(() => {
    const values = expanded.nodes.filter(node => !node.missing && node.mtime > 0).map(node => node.mtime);
    return { minimum: values.length ? Math.min(...values) : 0, maximum: values.length ? Math.max(...values) : 0 };
  }, [expanded]);

  React.useEffect(() => {
    try { localStorage.setItem(GRAPH_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Private browsing may disable storage. */ }
  }, [preferences]);

  React.useEffect(() => () => {
    if (orbitFrameRef.current !== null) cancelAnimationFrame(orbitFrameRef.current);
  }, []);

  React.useEffect(() => {
    setDisplayMode('project-map');
    setScope('project');
    setLocalRoot(activePath);
    setSelectedId(null);
    setExpandedGroups(new Set());
    positionsRef.current.clear();
    initialFitCompleteRef.current = false;
    viewTouchedRef.current = false;
    setView({ x: 0, y: 0, k: 1 });
    setOrbit(DEFAULT_GRAPH_ORBIT);
    setOrbiting(false);
  }, [projectPath]);

  React.useEffect(() => {
    setTimelineCutoff(modifiedRange.maximum || Number.POSITIVE_INFINITY);
  }, [modifiedRange.maximum]);

  React.useEffect(() => {
    const retainedIds = new Set(expanded.nodes.map(node => node.id));
    for (const nodeId of positionsRef.current.keys()) {
      if (!retainedIds.has(nodeId)) positionsRef.current.delete(nodeId);
    }
  }, [expanded]);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const width = Math.max(320, rect.width);
      const height = Math.max(280, rect.height);
      setDimensions(current => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const sync = () => {
      const active = document.fullscreenElement === workspaceRef.current;
      setIsFullscreen(active);
      if (active) setFullscreenFallback(false);
      if (nativeFullscreenActiveRef.current && !active) requestAnimationFrame(() => fullscreenTriggerRef.current?.focus());
      nativeFullscreenActiveRef.current = active;
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  React.useEffect(() => {
    if (!fullscreenFallback) return;
    const closeFallback = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setFullscreenFallback(false);
      setAnnouncement('Exited the expanded graph view.');
      requestAnimationFrame(() => fullscreenTriggerRef.current?.focus());
    };
    document.addEventListener('keydown', closeFallback, true);
    return () => document.removeEventListener('keydown', closeFallback, true);
  }, [fullscreenFallback]);

  React.useEffect(() => {
    if (!timelinePlaying || !timelineEnabled || modifiedRange.maximum <= modifiedRange.minimum) return;
    const startedAt = performance.now();
    const duration = 4200;
    setTimelineCutoff(modifiedRange.minimum);
    let frame = 0;
    const advance = (now: number) => {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      setTimelineCutoff(modifiedRange.minimum + (modifiedRange.maximum - modifiedRange.minimum) * progress);
      if (progress < 1) frame = requestAnimationFrame(advance);
      else setTimelinePlaying(false);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [timelinePlaying, timelineEnabled, modifiedRange]);

  const allowedLocalIds = React.useMemo(
    () => scope === 'local' ? localGraphIds(expanded.nodes, expanded.links, localRoot, depth) : new Set(expanded.nodes.map(node => node.id)),
    [expanded, scope, localRoot, depth],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredNodes = React.useMemo(() => expanded.nodes.filter(node => {
    if (!allowedLocalIds.has(node.id)) return false;
    if (node.missing && !preferences.showMissing) return false;
    if (!node.missing && node.orphan && !preferences.showOrphans) return false;
    if (!node.missing && timelineEnabled && node.mtime > timelineCutoff) return false;
    return nodeMatches(node, normalizedQuery);
  }), [expanded, allowedLocalIds, preferences.showMissing, preferences.showOrphans, timelineEnabled, timelineCutoff, normalizedQuery]);
  const filteredIds = React.useMemo(() => new Set(filteredNodes.map(node => node.id)), [filteredNodes]);
  const filteredLinks = React.useMemo(() => expanded.links.filter(link => filteredIds.has(link.source) && filteredIds.has(link.targetId)), [expanded, filteredIds]);
  const mapProjection = React.useMemo(() => buildProjectGraphProjection(displayMode, filteredNodes, filteredLinks, {
    projectPath,
    activePath,
    selectedId,
    expandedGroups,
    collapse: scope === 'project' && !normalizedQuery && !timelineEnabled,
  }), [displayMode, filteredNodes, filteredLinks, projectPath, activePath, selectedId, expandedGroups, scope, normalizedQuery, timelineEnabled]);
  const visibleNodes = React.useMemo(
    () => filteredNodes.filter(node => mapProjection.visibleNodeIds.has(node.id)),
    [filteredNodes, mapProjection],
  );
  const visibleIds = React.useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);
  const visibleLinks = React.useMemo(
    () => filteredLinks.filter(link => mapProjection.visibleLinkIds.has(link.id)),
    [filteredLinks, mapProjection],
  );
  const filteredNodeById = React.useMemo(() => new Map(filteredNodes.map(node => [node.id, node])), [filteredNodes]);
  const nodeById = React.useMemo(() => new Map(visibleNodes.map(node => [node.id, node])), [visibleNodes]);
  const selected = selectedId ? filteredNodeById.get(selectedId) || null : null;
  const focusId = hoveredId || (displayMode === 'project-map' ? selectedId : null);
  const neighbors = React.useMemo(() => {
    if (!hoveredId && displayMode === 'project-map' && selectedId) {
      return new Set([...mapProjection.selectedNeighborIds].filter(id => visibleIds.has(id)));
    }
    const values = new Set<string>();
    if (!focusId) return values;
    for (const link of visibleLinks) {
      if (link.source === focusId) values.add(link.targetId);
      if (link.targetId === focusId) values.add(link.source);
    }
    return values;
  }, [hoveredId, displayMode, selectedId, mapProjection, visibleIds, focusId, visibleLinks]);
  const effectiveGroupMode: GroupMode = displayMode === 'project-map' ? 'folder' : preferences.groupBy;
  const groups = React.useMemo(
    () => displayMode === 'project-map'
      ? mapProjection.groups.map(group => group.name)
      : [...new Set(visibleNodes.map(node => groupForNode(node, effectiveGroupMode, projectPath)))].sort((a, b) => a.localeCompare(b)),
    [displayMode, mapProjection, visibleNodes, effectiveGroupMode, projectPath],
  );
  const groupIndexes = React.useMemo(() => new Map(groups.map((group, index) => [group, index])), [groups]);
  const mapLayout = React.useMemo(
    () => graphProjectMapLayout(mapProjection.groups, filteredNodes, mapProjection.roleById, dimensions.width, dimensions.height),
    [mapProjection, filteredNodes, dimensions.width, dimensions.height],
  );
  const fullGraphDepthExtent = Math.max(110, Math.min(dimensions.width, dimensions.height) * .34);
  const cameraDistance = React.useMemo(() => {
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    let distance = graphCameraDistance(dimensions.width, dimensions.height, fullGraphDepthExtent);
    for (const node of visibleNodes) {
      const point = positionsRef.current.get(node.id);
      if (!point) continue;
      distance = Math.max(distance, Math.hypot(point.x - centerX, point.y - centerY, point.z) * 1.8);
    }
    return distance;
  }, [visibleNodes, dimensions.width, dimensions.height, fullGraphDepthExtent, layoutVersion]);
  const fullGraphProjection = React.useMemo(() => {
    const projected = new Map<string, GraphProjectedPoint>();
    if (displayMode !== 'full-graph') return projected;
    const center = { x: dimensions.width / 2, y: dimensions.height / 2 };
    for (const node of visibleNodes) {
      const point = positionsRef.current.get(node.id);
      if (point) projected.set(node.id, projectGraphPoint(point, center, orbit, cameraDistance));
    }
    return projected;
  }, [displayMode, visibleNodes, dimensions.width, dimensions.height, orbit, cameraDistance, layoutVersion]);
  const layoutPointFor = React.useCallback(
    (nodeId: string): GraphLayoutPoint | undefined => displayMode === 'project-map' ? mapLayout.positions.get(nodeId) : fullGraphProjection.get(nodeId),
    [displayMode, mapLayout, fullGraphProjection],
  );
  const perspectiveFor = React.useCallback(
    (nodeId: string) => displayMode === 'full-graph' ? fullGraphProjection.get(nodeId)?.scale || 1 : 1,
    [displayMode, fullGraphProjection],
  );
  const renderedNodes = React.useMemo(() => displayMode === 'full-graph'
    ? visibleNodes.slice().sort((left, right) => (fullGraphProjection.get(left.id)?.depth || 0) - (fullGraphProjection.get(right.id)?.depth || 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    : visibleNodes,
  [displayMode, visibleNodes, fullGraphProjection]);
  const renderedLinks = React.useMemo(() => displayMode === 'full-graph'
    ? visibleLinks.slice().sort((left, right) => {
      const leftDepth = ((fullGraphProjection.get(left.source)?.depth || 0) + (fullGraphProjection.get(left.targetId)?.depth || 0)) / 2;
      const rightDepth = ((fullGraphProjection.get(right.source)?.depth || 0) + (fullGraphProjection.get(right.targetId)?.depth || 0)) / 2;
      return leftDepth - rightDepth || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    })
    : visibleLinks,
  [displayMode, visibleLinks, fullGraphProjection]);
  const layoutSignature = `${displayMode}|${visibleNodes.map(node => `${node.id}:${node.degree}:${groupForNode(node, effectiveGroupMode, projectPath)}`).join('|')}`;
  const linkSignature = visibleLinks.map(link => `${link.source}:${link.targetId}`).join('|');

  const updatePreference = <Key extends keyof GraphPreferences>(key: Key, value: GraphPreferences[Key]) => {
    setPreferences(current => ({ ...current, [key]: value }));
  };

  React.useEffect(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    if (displayMode !== 'full-graph') {
      animationRef.current = null;
      return;
    }
    const positions = positionsRef.current;
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    const depthExtent = fullGraphDepthExtent;
    const anchors = graphGroupAnchors(groups, dimensions.width, dimensions.height);
    const bounds = graphLayoutBounds(dimensions.width, dimensions.height);
    const groupedNodes = new Map<string, RenderNode[]>();
    for (const node of visibleNodes) {
      const group = groupForNode(node, effectiveGroupMode, projectPath);
      const members = groupedNodes.get(group) || [];
      members.push(node);
      groupedNodes.set(group, members);
    }
    for (const members of groupedNodes.values()) {
      members.sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    }
    for (const node of visibleNodes) {
      const retainedPoint = positions.get(node.id);
      if (retainedPoint) {
        if (!Number.isFinite(retainedPoint.z)) {
          retainedPoint.z = stableGraphDepth(node.id, depthExtent);
        } else if (Number.isFinite(retainedPoint.depthExtent) && retainedPoint.depthExtent > 0 && retainedPoint.depthExtent !== depthExtent) {
          retainedPoint.z = clamp(retainedPoint.z * depthExtent / retainedPoint.depthExtent, -depthExtent, depthExtent);
        }
        retainedPoint.depthExtent = depthExtent;
        continue;
      }
      const group = groupForNode(node, effectiveGroupMode, projectPath);
      const anchor = anchors.get(group) || { x: centerX, y: centerY };
      const members = groupedNodes.get(group) || [node];
      const memberIndex = Math.max(0, members.findIndex(member => member.id === node.id));
      const ringIndex = Math.max(0, memberIndex - 1);
      const ring = memberIndex === 0 ? 0 : 32 + Math.floor(ringIndex / 6) * 24;
      const angle = (graphHash(group) % 360) * Math.PI / 180 + ringIndex % 6 * Math.PI / 3;
      positions.set(node.id, {
        x: clamp(anchor.x + Math.cos(angle) * ring, bounds.minimumX, bounds.maximumX),
        y: clamp(anchor.y + Math.sin(angle) * ring, bounds.minimumY, bounds.maximumY),
        z: stableGraphDepth(node.id, depthExtent),
        depthExtent,
        vx: 0,
        vy: 0,
      });
    }
    const layoutNodes = visibleNodes.map(node => ({ node, point: positions.get(node.id)! }));
    const nodeLookup = new Map(layoutNodes.map(entry => [entry.node.id, entry]));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let iteration = 0;
    let cancelled = false;
    const simulate = () => {
      const pairForce = (leftIndex: number, rightIndex: number, multiplier = 1) => {
        const left = layoutNodes[leftIndex];
        const right = layoutNodes[rightIndex];
        let dx = right.point.x - left.point.x;
        let dy = right.point.y - left.point.y;
        if (Math.abs(dx) + Math.abs(dy) < .01) {
          const jitter = ((graphHash(`${left.node.id}:${right.node.id}`) % 100) / 100 - .5) * .8;
          dx = jitter || .2;
          dy = .3 - jitter;
        }
        const distanceSquared = Math.max(36, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        const ux = dx / distance;
        const uy = dy / distance;
        const repulsion = preferences.repelForce * 13 * multiplier / distanceSquared;
        left.point.vx -= ux * repulsion;
        left.point.vy -= uy * repulsion;
        right.point.vx += ux * repulsion;
        right.point.vy += uy * repulsion;
        const minimumDistance = nodeRadius(left.node, preferences.nodeSize) + nodeRadius(right.node, preferences.nodeSize) + 15;
        if (distance < minimumDistance) {
          const collision = (minimumDistance - distance) * .018 * multiplier;
          left.point.vx -= ux * collision;
          left.point.vy -= uy * collision;
          right.point.vx += ux * collision;
          right.point.vy += uy * collision;
        }
      };
      if (layoutNodes.length <= 220) {
        for (let left = 0; left < layoutNodes.length; left += 1) {
          for (let right = left + 1; right < layoutNodes.length; right += 1) pairForce(left, right);
        }
      } else {
        for (let left = 0; left < layoutNodes.length; left += 1) {
          const start = graphHash(layoutNodes[left].node.id) % layoutNodes.length;
          for (let sample = 1; sample <= 48; sample += 1) {
            const right = (start + sample * 37) % layoutNodes.length;
            if (right > left) pairForce(left, right, .75);
          }
        }
      }
      for (const link of visibleLinks) {
        const source = nodeLookup.get(link.source)?.point;
        const target = nodeLookup.get(link.targetId)?.point;
        if (!source || !target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const pull = (distance - preferences.linkDistance) * preferences.linkStrength * .0055;
        const forceX = dx / distance * pull;
        const forceY = dy / distance * pull;
        source.vx += forceX;
        source.vy += forceY;
        target.vx -= forceX;
        target.vy -= forceY;
      }
      for (const { node, point } of layoutNodes) {
        if (point.fx !== undefined && point.fy !== undefined) {
          point.x = point.fx;
          point.y = point.fy;
          point.vx = 0;
          point.vy = 0;
          continue;
        }
        const group = groupForNode(node, effectiveGroupMode, projectPath);
        const anchor = anchors.get(group) || { x: centerX, y: centerY };
        const clusterStrength = effectiveGroupMode === 'none' ? .0014 : .0045;
        point.vx += (anchor.x - point.x) * preferences.centerForce * clusterStrength;
        point.vy += (anchor.y - point.y) * preferences.centerForce * clusterStrength;
        point.vx = clamp(point.vx * .84, -12, 12);
        point.vy = clamp(point.vy * .84, -12, 12);
        point.x = clamp(point.x + point.vx, bounds.minimumX, bounds.maximumX);
        point.y = clamp(point.y + point.vy, bounds.minimumY, bounds.maximumY);
        if (point.x === bounds.minimumX || point.x === bounds.maximumX) point.vx *= -.2;
        if (point.y === bounds.minimumY || point.y === bounds.maximumY) point.vy *= -.2;
      }
      iteration += 1;
    };
    const draw = () => {
      if (cancelled) return;
      const steps = reducedMotion ? 210 : iteration < 160 ? 8 : 4;
      for (let step = 0; step < steps; step += 1) simulate();
      setLayoutVersion(version => version + 1);
      if (iteration < 210) animationRef.current = requestAnimationFrame(draw);
      else {
        animationRef.current = null;
        if (!initialFitCompleteRef.current && !viewTouchedRef.current) {
          initialFitCompleteRef.current = true;
          requestAnimationFrame(() => fitViewRef.current());
        }
      }
    };
    animationRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
  }, [displayMode, layoutSignature, linkSignature, dimensions.width, dimensions.height, fullGraphDepthExtent, preferences.centerForce, preferences.repelForce, preferences.linkStrength, preferences.linkDistance, preferences.nodeSize, effectiveGroupMode, projectPath, simulationVersion]);

  const fitView = React.useCallback(() => {
    const points: GraphLayoutPoint[] = visibleNodes.map(node => layoutPointFor(node.id)).filter((point): point is GraphLayoutPoint => Boolean(point));
    if (displayMode === 'project-map') {
      for (const region of mapLayout.regions.values()) {
        points.push({ x: region.x, y: region.y }, { x: region.x + region.width, y: region.y + region.height });
      }
    }
    if (!points.length) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const minimumX = Math.min(...points.map(point => point.x));
    const maximumX = Math.max(...points.map(point => point.x));
    const minimumY = Math.min(...points.map(point => point.y));
    const maximumY = Math.max(...points.map(point => point.y));
    const fitPadding = displayMode === 'project-map' ? 24 : 120;
    const spanX = Math.max(120, maximumX - minimumX + fitPadding);
    const spanY = Math.max(120, maximumY - minimumY + fitPadding);
    const scale = clamp(Math.min(dimensions.width / spanX, dimensions.height / spanY), .25, 2.1);
    setView({
      x: dimensions.width / 2 - (minimumX + maximumX) / 2 * scale,
      y: dimensions.height / 2 - (minimumY + maximumY) / 2 * scale,
      k: scale,
    });
  }, [visibleNodes, dimensions, layoutPointFor, displayMode, mapLayout]);
  React.useLayoutEffect(() => {
    fitViewRef.current = fitView;
  }, [fitView]);

  React.useEffect(() => {
    if (displayMode !== 'project-map' || viewTouchedRef.current) return;
    const frame = requestAnimationFrame(() => {
      initialFitCompleteRef.current = true;
      fitViewRef.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [displayMode, projectPath, dimensions.width, dimensions.height]);

  React.useEffect(() => {
    const nodeId = pendingMapFocusRef.current;
    if (!nodeId || !mapLayout.positions.has(nodeId)) return;
    pendingMapFocusRef.current = null;
    const frame = requestAnimationFrame(() => {
      const point = mapLayout.positions.get(nodeId);
      if (!point) return;
      const scale = clamp(1.35, .25, 4);
      setView({ x: dimensions.width / 2 - point.x * scale, y: dimensions.height / 2 - point.y * scale, k: scale });
      requestAnimationFrame(() => {
        const graphNode = [...stageRef.current?.querySelectorAll<SVGGElement>('[data-graph-node-id]') || []]
          .find(element => element.dataset.graphNodeId === nodeId);
        (graphNode || stageRef.current)?.focus();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [mapLayout, dimensions]);

  React.useEffect(() => {
    if (selectedId && !visibleIds.has(selectedId)) setSelectedId(null);
  }, [selectedId, visibleIds]);

  React.useEffect(() => {
    if (!menu) return;
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [menu]);

  const pointFromClient = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) * dimensions.width / Math.max(1, rect.width), y: (clientY - rect.top) * dimensions.height / Math.max(1, rect.height) };
  };

  const openMenuAt = (node: RenderNode, x: number, y: number, returnFocus?: SVGElement) => {
    const stage = stageRef.current;
    if (!stage) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    menuReturnFocusRef.current = returnFocus || null;
    setSelectedId(node.id);
    setMenu({ nodeId: node.id, x: clamp(x, 8, Math.max(8, width - 230)), y: clamp(y, 8, Math.max(8, height - 246)) });
  };

  const focusNode = (nodeId: string, zoom = 1.45) => {
    const point = layoutPointFor(nodeId);
    if (!point) return;
    viewTouchedRef.current = true;
    initialFitCompleteRef.current = true;
    const scale = clamp(zoom, .25, 4);
    setView({ x: dimensions.width / 2 - point.x * scale, y: dimensions.height / 2 - point.y * scale, k: scale });
    setSelectedId(nodeId);
  };

  const restoreGraphNodeFocus = (nodeId: string) => {
    requestAnimationFrame(() => {
      const graphNode = [...stageRef.current?.querySelectorAll<SVGGElement>('[data-graph-node-id]') || []]
        .find(element => element.dataset.graphNodeId === nodeId);
      (graphNode || stageRef.current)?.focus();
    });
  };

  const showConnections = (node: RenderNode) => {
    if (node.missing) return;
    setLocalRoot(node.id);
    setScope('local');
    setDepth(1);
    setMenu(null);
    setAnnouncement(`Showing direct connections for ${node.label}`);
  };

  const resetFullGraphOrbit = () => {
    setOrbit(DEFAULT_GRAPH_ORBIT);
    setAnnouncement('Full graph rotation reset.');
  };

  const changeDisplayMode = (nextMode: ProjectGraphDisplayMode) => {
    if (nextMode === displayMode) return;
    if (nextMode === 'project-map') {
      if (document.fullscreenElement === workspaceRef.current) void document.exitFullscreen();
      setFullscreenFallback(false);
    }
    if (orbitFrameRef.current !== null) cancelAnimationFrame(orbitFrameRef.current);
    orbitFrameRef.current = null;
    pendingOrbitRef.current = null;
    setOrbiting(false);
    setDisplayMode(nextMode);
    if (nextMode === 'full-graph') setScope('project');
    setHoveredId(null);
    setMenu(null);
    initialFitCompleteRef.current = false;
    viewTouchedRef.current = false;
    setView({ x: 0, y: 0, k: 1 });
    if (nextMode === 'full-graph') setOrbit(DEFAULT_GRAPH_ORBIT);
    setAnnouncement(nextMode === 'project-map'
      ? 'Project map selected. Notes are organized into stable project folders.'
      : 'Full graph selected. Every visible note and relationship is shown in a mouse-rotatable 3D view.');
  };

  const toggleMapGroup = (groupName: string) => {
    const group = mapProjection.groups.find(entry => entry.name === groupName);
    if (!group?.collapsibleNodeIds.length) return;
    const expanding = !expandedGroups.has(groupName);
    setExpandedGroups(current => {
      const next = new Set(current);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
    setAnnouncement(`${expanding ? 'Expanded' : 'Collapsed'} ${groupName}. ${group.collapsibleNodeIds.length} ${group.collapsibleNodeIds.length === 1 ? 'note' : 'notes'} ${expanding ? 'revealed' : 'grouped'}.`);
  };

  const revealNavigatorNode = (node: RenderNode) => {
    setSelectedId(node.id);
    setNavigatorOpen(false);
    if (displayMode === 'project-map') {
      pendingMapFocusRef.current = node.id;
      setAnnouncement(`Revealed ${node.label} in ${groupForNode(node, 'folder', projectPath)}.`);
      return;
    }
    focusNode(node.id);
    restoreGraphNodeFocus(node.id);
  };

  const copyLink = async (node: RenderNode) => {
    const target = node.missing ? node.label : node.id.replace(/\.md$/i, '');
    try {
      await navigator.clipboard.writeText(`[[${target}]]`);
      setAnnouncement(`Copied link to ${node.label}`);
    } catch {
      setAnnouncement(`Could not copy the link to ${node.label}`);
    }
    setMenu(null);
  };

  const beginNodeDrag = (event: React.PointerEvent<SVGGElement>, node: RenderNode) => {
    if (event.button !== 0) return;
    viewTouchedRef.current = true;
    initialFitCompleteRef.current = true;
    event.stopPropagation();
    const point = positionsRef.current.get(node.id);
    if (!point) return;
    point.fx = point.x;
    point.fy = point.y;
    point.fz = point.z;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: 'node',
      pointerId: event.pointerId,
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: point.x, y: point.y, z: point.z },
      perspectiveScale: perspectiveFor(node.id),
      moved: false,
    };
  };

  const beginPan = (event: React.PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return;
    viewTouchedRef.current = true;
    initialFitCompleteRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rotate = displayMode === 'full-graph' && !event.shiftKey;
    dragRef.current = rotate
      ? { kind: 'orbit', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: orbit, moved: false }
      : { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: view };
    setOrbiting(rotate);
    setMenu(null);
    setSelectedId(null);
    setHoveredId(null);
  };

  const movePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === 'pan') {
      const rect = svgRef.current?.getBoundingClientRect();
      const scaleX = dimensions.width / Math.max(1, rect?.width || dimensions.width);
      const scaleY = dimensions.height / Math.max(1, rect?.height || dimensions.height);
      setView({ ...drag.origin, x: drag.origin.x + (event.clientX - drag.startX) * scaleX, y: drag.origin.y + (event.clientY - drag.startY) * scaleY });
      return;
    }
    if (drag.kind === 'orbit') {
      drag.moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
      pendingOrbitRef.current = {
        origin: drag.origin,
        deltaX: event.clientX - drag.startX,
        deltaY: event.clientY - drag.startY,
      };
      if (orbitFrameRef.current === null) {
        orbitFrameRef.current = requestAnimationFrame(() => {
          orbitFrameRef.current = null;
          const pending = pendingOrbitRef.current;
          pendingOrbitRef.current = null;
          if (pending) setOrbit(updateGraphOrbit(pending.origin, pending.deltaX, pending.deltaY));
        });
      }
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    const scaleX = dimensions.width / Math.max(1, rect?.width || dimensions.width);
    const scaleY = dimensions.height / Math.max(1, rect?.height || dimensions.height);
    const cameraDelta = graphCameraPlaneDelta(
      (event.clientX - drag.startX) * scaleX / Math.max(.2, view.k),
      (event.clientY - drag.startY) * scaleY / Math.max(.2, view.k),
      orbit,
      drag.perspectiveScale,
    );
    const point = positionsRef.current.get(drag.id);
    if (point) {
      point.fx = drag.origin.x + cameraDelta.x;
      point.fy = drag.origin.y + cameraDelta.y;
      point.fz = drag.origin.z + cameraDelta.z;
      point.x = point.fx;
      point.y = point.fy;
      point.z = point.fz;
    }
    drag.moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5;
    setLayoutVersion(version => version + 1);
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === 'node') {
      const point = positionsRef.current.get(drag.id);
      if (point) { delete point.fx; delete point.fy; delete point.fz; }
      suppressClickRef.current = drag.moved ? drag.id : null;
      setSimulationVersion(version => version + 1);
    } else if (drag.kind === 'orbit' && drag.moved) {
      setOrbiting(false);
      setAnnouncement('Full graph rotated. Shift-drag pans; wheel zooms.');
    }
    if (drag.kind === 'orbit' && !drag.moved) setOrbiting(false);
    dragRef.current = null;
  };

  const endNodePointer = (event: React.PointerEvent<SVGGElement>, node: RenderNode) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'node' || drag.pointerId !== event.pointerId || drag.id !== node.id) return;
    const point = positionsRef.current.get(drag.id);
    if (point) { delete point.fx; delete point.fy; delete point.fz; }
    suppressClickRef.current = node.id;
    dragRef.current = null;
    setSelectedId(node.id);
    setMenu(null);
    setSimulationVersion(version => version + 1);
    if (!drag.moved && !node.missing) onPreview(node.id);
  };

  const zoomAt = (factor: number, anchor = { x: dimensions.width / 2, y: dimensions.height / 2 }) => {
    viewTouchedRef.current = true;
    initialFitCompleteRef.current = true;
    setView(current => {
      const nextScale = clamp(current.k * factor, .2, 4);
      const ratio = nextScale / current.k;
      return { x: anchor.x - (anchor.x - current.x) * ratio, y: anchor.y - (anchor.y - current.y) * ratio, k: nextScale };
    });
  };

  const toggleFullscreen = async () => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    setHoveredId(null);
    try {
      if (document.fullscreenElement === workspace) {
        await document.exitFullscreen();
      } else if (fullscreenFallback) {
        setFullscreenFallback(false);
        requestAnimationFrame(() => fullscreenTriggerRef.current?.focus());
      } else {
        await workspace.requestFullscreen();
        setAnnouncement('Full screen graph opened. Press Escape to exit.');
      }
    } catch {
      setFullscreenFallback(current => !current);
      setAnnouncement('Using an expanded graph view in this window.');
    }
  };

  const onGraphKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey || event.altKey) && event.key.toLocaleLowerCase() === 'f') return;
    if (event.key === 'Escape') {
      setMenu(null);
      setSettingsOpen(false);
      setNavigatorOpen(false);
      if (fullscreenFallback) {
        setFullscreenFallback(false);
        requestAnimationFrame(() => fullscreenTriggerRef.current?.focus());
      }
      return;
    }
    const target = event.target as HTMLElement;
    if (target.matches('input, textarea, select') || target.isContentEditable) return;
    if (displayMode === 'full-graph' && event.key.toLocaleLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (displayMode === 'full-graph' && event.key.toLocaleLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      resetFullGraphOrbit();
      return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1.18); return; }
    if (event.key === '-') { event.preventDefault(); zoomAt(1 / 1.18); return; }
    if (event.key === '0') { event.preventDefault(); fitView(); return; }
    if (displayMode === 'full-graph' && event.altKey) {
      const orbitDelta = { ArrowLeft: [-26, 0], ArrowRight: [26, 0], ArrowUp: [0, -22], ArrowDown: [0, 22] }[event.key];
      if (orbitDelta) {
        event.preventDefault();
        setOrbit(current => updateGraphOrbit(current, orbitDelta[0], orbitDelta[1]));
        setAnnouncement('Full graph rotated with the keyboard.');
        return;
      }
    }
    const pan = { ArrowLeft: [36, 0], ArrowRight: [-36, 0], ArrowUp: [0, 36], ArrowDown: [0, -36] }[event.key];
    if (pan) {
      event.preventDefault();
      const speed = event.shiftKey ? 3 : 1;
      setView(current => ({ ...current, x: current.x + pan[0] * speed, y: current.y + pan[1] * speed }));
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])];
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenu(null);
      menuReturnFocusRef.current?.focus();
      return;
    }
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next].focus();
  };

  const visibleNoteCount = visibleNodes.filter(node => !node.missing).length;
  const visibleResolvedLinkCount = visibleLinks.filter(link => link.resolved).length;
  const visibleMissingLinkCount = visibleLinks.length - visibleResolvedLinkCount;
  const filteredResolvedLinkCount = filteredLinks.filter(link => link.resolved).length;
  const filteredMissingLinkCount = filteredLinks.length - filteredResolvedLinkCount;
  const navigatorNodes = displayMode === 'project-map' ? filteredNodes : visibleNodes;
  const currentMenuNode = menu ? nodeById.get(menu.nodeId) || null : null;
  const nodeCountLabel = visibleNoteCount === sourceNoteCount && graph.meta?.sourceNotesComplete !== false
    ? `${visibleNoteCount}`
    : `${visibleNoteCount} of ${sourceNoteLabel}`;
  void layoutVersion;

  const fullscreenActive = isFullscreen || fullscreenFallback;
  React.useEffect(() => {
    if (displayMode !== 'full-graph') return;
    initialFitCompleteRef.current = false;
    viewTouchedRef.current = false;
    let cancelled = false;
    let quietFrames = 0;
    let frame = 0;
    const fitAfterLayout = () => {
      if (cancelled || viewTouchedRef.current) return;
      if (animationRef.current !== null || quietFrames < 1) {
        quietFrames = animationRef.current === null ? quietFrames + 1 : 0;
        frame = requestAnimationFrame(fitAfterLayout);
        return;
      }
      initialFitCompleteRef.current = true;
      fitViewRef.current();
    };
    frame = requestAnimationFrame(fitAfterLayout);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [displayMode, fullscreenActive, dimensions.width, dimensions.height]);
  const unfilteredProjectMap = displayMode === 'project-map' && scope === 'project' && !normalizedQuery && !timelineEnabled;
  const relationshipCountLabel = unfilteredProjectMap ? sourceLinkLabel : `${visibleResolvedLinkCount}`;
  const unresolvedCountLabel = unfilteredProjectMap ? filteredMissingLinkCount : visibleMissingLinkCount;

  return <div className={`graph-workspace graph-relationship-workspace ${displayMode}${fullscreenFallback ? ' graph-fullscreen-fallback' : ''}`} ref={workspaceRef}>
    <header className="graph-panel-head graph-relationship-head">
      <div><span className="graph-eyebrow">{eyebrow}</span><h2>{scope === 'local' ? `${titleFromGraphPath(localRoot)} connections` : displayMode === 'full-graph' ? `${title} — full graph` : title}</h2><p>{description}</p></div>
      <div className="graph-stats" aria-label="Graph summary"><span><b>{nodeCountLabel}</b> notes shown</span><span><b>{relationshipCountLabel}</b> links</span><span><b>{unresolvedCountLabel}</b> unresolved</span></div>
    </header>

    <div className="graph-toolbar graph-relationship-toolbar" aria-label="Graph controls">
      <div className="graph-layout-control" role="group" aria-label="Graph view">
        <button className={displayMode === 'project-map' ? 'on' : ''} aria-pressed={displayMode === 'project-map'} onClick={() => changeDisplayMode('project-map')}>Project map</button>
        <button className={displayMode === 'full-graph' ? 'on' : ''} aria-pressed={displayMode === 'full-graph'} onClick={() => changeDisplayMode('full-graph')}>Full graph</button>
      </div>
      <div className="graph-scope-control" role="group" aria-label="Graph scope">
        <button className={scope === 'project' ? 'on' : ''} aria-pressed={scope === 'project'} onClick={() => setScope('project')}>{scopeLabel}</button>
        <button className={scope === 'local' ? 'on' : ''} aria-pressed={scope === 'local'} onClick={() => {
          setLocalRoot(activePath || selectedId || mapProjection.homeNodeId || filteredNodes[0]?.id || '');
          setScope('local');
        }}>Local</button>
      </div>
      {scope === 'local' && <label className="graph-depth-control"><span>Depth</span><select value={depth} onChange={event => setDepth(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      <label className="graph-search-control"><span className="sr-only">Filter graph notes</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter notes, paths, or tags…" /></label>
      <div className="graph-view-actions">
        <button onClick={() => { viewTouchedRef.current = true; initialFitCompleteRef.current = true; fitView(); }}>Fit</button>
        <button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.18)}>−</button>
        <button aria-label="Zoom in" onClick={() => zoomAt(1.18)}>+</button>
        {displayMode === 'full-graph' && <button className="graph-orbit-reset" title="Reset 3D rotation (R)" onClick={resetFullGraphOrbit}>Reset 3D</button>}
        {displayMode === 'full-graph' && <button ref={fullscreenTriggerRef} className="graph-fullscreen-button" aria-pressed={fullscreenActive} title="Full screen (F)" onClick={() => void toggleFullscreen()}>{fullscreenFallback ? 'Exit expanded view' : isFullscreen ? 'Exit full screen' : 'Full screen'}</button>}
        <OverflowMenu label="More graph actions" className="graph-toolbar-overflow" items={[
          { label: navigatorOpen ? 'Hide nodes' : 'Nodes', hint: navigatorOpen ? 'Close the node navigator' : displayMode === 'project-map' ? 'Browse every project note, including grouped notes' : 'Browse visible notes', onSelect: () => { setNavigatorOpen(value => !value); setSettingsOpen(false); } },
          { label: settingsOpen ? 'Hide settings' : 'Settings', hint: settingsOpen ? 'Close graph settings' : 'Tune filters and display', onSelect: () => { setSettingsOpen(value => !value); setNavigatorOpen(false); } },
        ]} />
      </div>
    </div>

    {displayMode === 'project-map' && <p className="graph-map-summary" role="status">
      <b>{visibleNoteCount}</b> notes shown in {mapProjection.groups.length} folder {mapProjection.groups.length === 1 ? 'region' : 'regions'}.
      {mapProjection.collapsedCount > 0 ? <> <b>{mapProjection.collapsedCount}</b> lower-priority {mapProjection.collapsedCount === 1 ? 'note is' : 'notes are'} grouped behind explicit folder controls.</> : <> Every matching note is shown.</>}
      {' '}Select a note to reveal its direct relationships, or open Full graph for every link at once.
    </p>}

    {graphWasTruncated && <p className="graph-limit-notice" role="status">
      Large graph limited for responsiveness: rendering {renderBudget.renderedNotes} of {sourceNoteLabel} notes and {renderBudget.renderedLinks} of {sourceLinkLabel} links. Unresolved placeholders are limited to {GRAPH_RENDER_LIMITS.missing}.
      {omittedNoteContent > 0 && <> Content indexing was skipped for {omittedNoteContent} oversized note{omittedNoteContent === 1 ? '' : 's'}.</>}
      {omittedLinkFields > 0 && <> {omittedLinkFields} oversized or malformed link field{omittedLinkFields === 1 ? ' was' : 's were'} omitted.</>}
    </p>}

    <div className={`graph-3d-stage graph-2d-stage ${displayMode}${displayMode === 'full-graph' ? ' graph-full-graph-3d' : ''}${orbiting ? ' orbiting' : ''}`} ref={stageRef} tabIndex={0} aria-label={displayMode === 'full-graph' ? 'Interactive 3D Full graph viewport' : 'Interactive Project map viewport'} aria-describedby={graphInstructionsId} onKeyDown={onGraphKeyDown}>
      <svg ref={svgRef} className="graph-svg-canvas" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} aria-label={`Interactive ${displayMode === 'project-map' ? 'project map' : 'full graph'} for ${scope === 'local' ? 'local connections' : scopeLabel.toLowerCase()}, with ${visibleNodes.length} visible notes and ${visibleLinks.length} drawn links`} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={event => {
        event.preventDefault();
        zoomAt(Math.exp(-event.deltaY * .0011), pointFromClient(event.clientX, event.clientY));
      }}>
        <title>{displayMode === 'project-map' ? 'Safire project map' : 'Safire 3D full graph'}</title><desc>{displayMode === 'project-map' ? 'Notes are arranged inside deterministic project-relative folder regions. Some lower-priority notes may be grouped behind explicit expansion controls.' : 'Every matching note and wiki-link relationship is shown in a perspective 3D graph. Drag empty space to rotate, Shift-drag to pan, and use the wheel to zoom.'}</desc>
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
          <filter id="graph-node-glow" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <rect className="graph-pan-surface" width={dimensions.width} height={dimensions.height} onPointerDown={beginPan} />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {displayMode === 'project-map' && <g className="graph-cluster-layer">
            {mapProjection.groups.map(group => {
              const region = mapLayout.regions.get(group.name);
              if (!region) return null;
              const groupIndex = groupIndexes.get(group.name) || 0;
              const toggleWidth = Math.min(118, Math.max(92, region.width * .48));
              const expanded = expandedGroups.has(group.name);
              const toggleLabel = expanded
                ? `Collapse ${group.collapsibleNodeIds.length} ${group.collapsibleNodeIds.length === 1 ? 'note' : 'notes'}`
                : `Show ${group.collapsedNodeIds.length} more ${group.collapsedNodeIds.length === 1 ? 'note' : 'notes'}`;
              const visibleToggleLabel = expanded
                ? `Collapse ${group.collapsibleNodeIds.length}`
                : `Show ${group.collapsedNodeIds.length} notes`;
              return <g key={group.name} className={`graph-cluster-region graph-group-${groupIndex % 6}`}>
                <title>{group.name}: {group.visibleNodeIds.length} of {group.nodeIds.length} notes shown</title>
                <rect className="graph-cluster-surface" x={region.x} y={region.y} width={region.width} height={region.height} rx={20} />
                <text className="graph-cluster-heading" x={region.x + 18} y={region.y + 28}>{group.name}</text>
                <text className="graph-cluster-count" x={region.x + 18} y={region.y + 45}>{group.visibleNodeIds.length} / {group.nodeIds.length}</text>
                {group.collapsibleNodeIds.length > 0 && <g className="graph-cluster-toggle" transform={`translate(${region.x + region.width - toggleWidth - 8} ${region.y + 5})`} role="button" tabIndex={0} aria-expanded={expanded} aria-label={`${toggleLabel} in ${group.name}`} onClick={event => { event.stopPropagation(); toggleMapGroup(group.name); }} onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleMapGroup(group.name);
                  }
                }}>
                  <rect className="graph-cluster-toggle-hit" width={toggleWidth} height={44} rx={12} />
                  <rect className="graph-cluster-toggle-surface" y={5} width={toggleWidth} height={34} rx={10} />
                  <text x={toggleWidth / 2} y={27} textAnchor="middle">{visibleToggleLabel}</text>
                </g>}
              </g>;
            })}
          </g>}
          <g className="graph-link-layer">
            {renderedLinks.map(link => {
              const sourceNode = nodeById.get(link.source);
              const targetNode = nodeById.get(link.targetId);
              const source = layoutPointFor(link.source);
              const target = layoutPointFor(link.targetId);
              if (!source || !target || !sourceNode || !targetNode) return null;
              const active = Boolean(focusId && (link.source === focusId || link.targetId === focusId));
              const direct = Boolean(displayMode === 'project-map' && selectedId && (link.source === selectedId || link.targetId === selectedId));
              const dimmed = Boolean(focusId && !active);
              const sourcePerspective = perspectiveFor(sourceNode.id);
              const targetPerspective = perspectiveFor(targetNode.id);
              const perspective = (sourcePerspective + targetPerspective) / 2;
              return <path key={link.id} className={`graph-link${displayMode === 'project-map' ? ' overview' : ' depth-link'}${direct ? ' direct' : ''}${link.resolved ? '' : ' unresolved'}${active ? ' active' : ''}${dimmed ? ' dimmed' : ''}`} d={edgePath(source, target, link, displayedNodeRadius(sourceNode, preferences.nodeSize, mapProjection.roleById.get(sourceNode.id)) * sourcePerspective, displayedNodeRadius(targetNode, preferences.nodeSize, mapProjection.roleById.get(targetNode.id)) * targetPerspective)} style={{ strokeWidth: preferences.linkWidth * perspective / view.k }} markerEnd={preferences.arrows ? 'url(#graph-arrow)' : undefined} />;
            })}
          </g>
          <g className="graph-node-layer">
            {renderedNodes.map(node => {
              const point = layoutPointFor(node.id);
              if (!point) return null;
              const nodeRole = mapProjection.roleById.get(node.id);
              const radius = displayedNodeRadius(node, preferences.nodeSize, nodeRole);
              const perspective = perspectiveFor(node.id);
              const groupIndex = groupIndexes.get(groupForNode(node, effectiveGroupMode, projectPath)) || 0;
              const isSelected = node.id === selectedId;
              const isHovered = node.id === hoveredId;
              const isActive = node.id === activePath;
              const isDirectNeighbor = displayMode === 'project-map' && Boolean(selectedId && mapProjection.selectedNeighborIds.has(node.id));
              const dimmed = Boolean(focusId && node.id !== focusId && !neighbors.has(node.id));
              const compactMapLabels = displayMode === 'project-map' && dimensions.width < 720 && visibleNodes.length > 12;
              const showLabel = preferences.showLabels && (displayMode === 'project-map'
                ? !compactMapLabels || nodeRole === 'home' || nodeRole === 'hub' || isSelected || isHovered || isActive
                : view.k >= .8 || node.degree >= 3 || isSelected || isHovered || isActive);
              const roleLabel = nodeRole === 'home' ? 'project home, ' : nodeRole === 'hub' ? 'project hub, ' : '';
              return <g key={node.id} data-graph-node-id={node.id} className={`graph-node graph-group-${groupIndex % 6}${nodeRole ? ` ${nodeRole}` : ''}${node.missing ? ' missing' : ''}${node.resolution === 'ambiguous' ? ' ambiguous' : ''}${isSelected ? ' selected' : ''}${isActive ? ' active-note' : ''}${isDirectNeighbor ? ' direct-neighbor' : ''}${dimmed ? ' dimmed' : ''}`} transform={`translate(${point.x} ${point.y})${displayMode === 'full-graph' ? ` scale(${perspective})` : ''}`} role="button" tabIndex={0} aria-label={`${node.label}, ${roleLabel}${node.resolution === 'ambiguous' ? 'ambiguous linked note' : node.missing ? 'unresolved linked note' : `${node.degree} connections`}`} onPointerDown={displayMode === 'full-graph' ? event => beginNodeDrag(event, node) : undefined} onPointerUp={displayMode === 'full-graph' ? event => endNodePointer(event, node) : undefined} onClick={event => {
                event.stopPropagation();
                if (suppressClickRef.current === node.id) { suppressClickRef.current = null; return; }
                setSelectedId(node.id);
                if (displayMode === 'project-map') {
                  setAnnouncement(`Selected ${node.label}. Direct relationships are highlighted; Preview and Edit remain available.`);
                } else if (!node.missing) onPreview(node.id);
              }} onPointerEnter={() => setHoveredId(node.id)} onPointerLeave={() => setHoveredId(current => current === node.id ? null : current)} onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                const rect = stageRef.current?.getBoundingClientRect();
                if (rect) openMenuAt(node, event.clientX - rect.left, event.clientY - rect.top, event.currentTarget);
              }} onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (displayMode === 'project-map' || node.missing) {
                    setSelectedId(node.id);
                    setAnnouncement(`Selected ${node.label}. Direct relationships are highlighted.`);
                  } else onPreview(node.id);
                }
                if (event.key === ' ') { event.preventDefault(); setSelectedId(node.id); }
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  openMenuAt(node, point.x * view.k + view.x, point.y * view.k + view.y, event.currentTarget);
                }
              }}>
                <title>{node.label} — {nodeRole === 'home' ? 'project home · ' : nodeRole === 'hub' ? 'high-value hub · ' : ''}{node.resolution === 'ambiguous' ? 'matches multiple notes' : node.missing ? 'unresolved link' : `${node.degree} connections · ${node.id}`}</title>
                <circle className="graph-node-halo" r={radius + 7} />
                {node.missing ? <path className="graph-node-core" d={`M 0 ${-radius} L ${radius} 0 L 0 ${radius} L ${-radius} 0 Z`} /> : <circle className="graph-node-core" r={radius} />}
                {nodeRole === 'home' && <circle className="graph-home-ring" r={radius + 6} />}
                {nodeRole === 'hub' && <circle className="graph-hub-ring" r={radius + 5} />}
                {isActive && <circle className="graph-active-ring" r={radius + 4} />}
                {node.missing && <text className="graph-missing-mark" y={4 / view.k} style={{ fontSize: `${11 / view.k}px` }}>?</text>}
                {showLabel && <text className="graph-node-label" y={radius + 15 / view.k} style={{ fontSize: `${12 / view.k}px`, strokeWidth: 4 / view.k }}>{node.label}</text>}
              </g>;
            })}
          </g>
        </g>
      </svg>

      {!visibleNodes.length && <div className="graph-empty-state"><b>No notes match this view</b><span>Clear the filter or include more note types in Settings.</span><button onClick={() => { setQuery(''); setPreferences(current => ({ ...current, showMissing: true, showOrphans: true })); }}>Clear filters</button></div>}

      {selected && <aside className="graph-selection-card" aria-live="polite">
        <span>{selected.resolution === 'ambiguous' ? 'Ambiguous link' : selected.missing ? 'Unresolved link' : mapProjection.homeNodeId === selected.id ? 'Project home' : mapProjection.hubNodeIds.has(selected.id) ? 'Project hub' : selected.id === activePath ? 'Active note' : 'Selected note'}</span>
        <b>{selected.label}</b>
        <small>{selected.resolution === 'ambiguous' ? 'More than one note has this title. Qualify the wiki link with its folder to connect it.' : selected.missing ? 'No existing note matches this link yet.' : `${selected.degree} connection${selected.degree === 1 ? '' : 's'} · ${selected.inDegree} in · ${selected.outDegree} out${selected.tags.length ? ` · ${selected.tags.slice(0, 3).map(tag => `#${tag}`).join(' ')}` : ''}`}</small>
        {displayMode === 'project-map' && mapProjection.hiddenSelectedNeighborsByGroup.length > 0 && <small className="graph-selection-hidden-summary">Some direct neighbors remain grouped to keep this map readable. Expand their folders below or use Show all connections.</small>}
        <div className="graph-selection-actions">{selected.missing ? selected.resolution !== 'ambiguous' && <button onClick={() => onCreateMissing(selected.label)}>Create note</button> : <><button onClick={() => onPreview(selected.id)}>Preview</button><button onClick={() => onEdit(selected.id)}>Edit</button><button onClick={() => showConnections(selected)}>Show all connections</button></>}</div>
        {displayMode === 'project-map' && mapProjection.hiddenSelectedNeighborsByGroup.length > 0 && <div className="graph-selection-groups" aria-label="Grouped direct neighbors">{mapProjection.hiddenSelectedNeighborsByGroup.map(group => <button key={group.group} onClick={() => {
          if (!expandedGroups.has(group.group)) toggleMapGroup(group.group);
        }}>Show {group.nodeIds.length} in {group.group}</button>)}</div>}
      </aside>}

      {currentMenuNode && menu && <div ref={menuRef} className="graph-node-menu" role="menu" aria-label={`Actions for ${currentMenuNode.label}`} style={{ left: menu.x, top: menu.y }} onPointerDown={event => event.stopPropagation()} onKeyDown={onMenuKeyDown}>
        <div className="graph-node-menu-title">{currentMenuNode.label}</div>
        {currentMenuNode.missing ? <>{currentMenuNode.resolution !== 'ambiguous' && <button role="menuitem" onClick={() => onCreateMissing(currentMenuNode.label)}>Create missing note</button>}<button role="menuitem" onClick={() => { focusNode(currentMenuNode.id); setMenu(null); }}>Focus placeholder</button></> : <><button role="menuitem" onClick={() => { setMenu(null); onPreview(currentMenuNode.id); }}>Preview note</button><button role="menuitem" onClick={() => { setMenu(null); onEdit(currentMenuNode.id); }}>Edit note</button><button role="menuitem" onClick={() => { focusNode(currentMenuNode.id); setMenu(null); }}>Focus note</button><button role="menuitem" onClick={() => showConnections(currentMenuNode)}>Show connections</button><button role="menuitem" onClick={() => void copyLink(currentMenuNode)}>Copy wiki link</button></>}
      </div>}

      {settingsOpen && <aside className="graph-settings-panel" aria-label="Graph settings">
        <header><div><span>Graph settings</span><b>Tune what the map reveals</b></div><button aria-label="Close graph settings" onClick={() => setSettingsOpen(false)}>×</button></header>
        <details open><summary>Filters</summary><label><span>Search files</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="path, title, or #tag" /></label><label className="graph-check"><input type="checkbox" checked={preferences.showMissing} onChange={event => updatePreference('showMissing', event.target.checked)} /><span>Unresolved links</span></label><label className="graph-check"><input type="checkbox" checked={preferences.showOrphans} onChange={event => updatePreference('showOrphans', event.target.checked)} /><span>Orphan notes</span></label></details>
        {displayMode === 'full-graph' ? <details open><summary>Groups</summary><label><span>Organize and color by</span><select value={preferences.groupBy} onChange={event => updatePreference('groupBy', event.target.value as GroupMode)}><option value="folder">Project folder</option><option value="tag">First tag</option><option value="none">Connections only</option></select></label></details> : <p className="graph-map-settings-note">Project map always uses stable project-relative folder regions. Switch to Full graph to tune grouping and forces.</p>}
        <details><summary>Display</summary><label className="graph-check"><input type="checkbox" checked={preferences.arrows} onChange={event => updatePreference('arrows', event.target.checked)} /><span>Link direction arrows</span></label><label className="graph-check"><input type="checkbox" checked={preferences.showLabels} onChange={event => updatePreference('showLabels', event.target.checked)} /><span>Note labels</span></label><label><span>Node size <b>{preferences.nodeSize.toFixed(1)}×</b></span><input type="range" min="0.7" max="1.6" step="0.1" value={preferences.nodeSize} onChange={event => updatePreference('nodeSize', Number(event.target.value))} /></label><label><span>Link thickness <b>{preferences.linkWidth.toFixed(1)}</b></span><input type="range" min="0.6" max="3" step="0.1" value={preferences.linkWidth} onChange={event => updatePreference('linkWidth', Number(event.target.value))} /></label>{modifiedRange.maximum > modifiedRange.minimum && <div className="graph-timeline-control"><label className="graph-check"><input type="checkbox" checked={timelineEnabled} onChange={event => { setTimelineEnabled(event.target.checked); setTimelinePlaying(false); setTimelineCutoff(modifiedRange.maximum); }} /><span>Modified timeline</span></label>{timelineEnabled && <><label><span>Through <b>{formatGraphDate(timelineCutoff)}</b></span><input type="range" min={modifiedRange.minimum} max={modifiedRange.maximum} step={Math.max(1, (modifiedRange.maximum - modifiedRange.minimum) / 120)} value={timelineCutoff} onChange={event => { setTimelinePlaying(false); setTimelineCutoff(Number(event.target.value)); }} /></label><button onClick={() => setTimelinePlaying(value => !value)}>{timelinePlaying ? 'Pause time-lapse' : 'Play time-lapse'}</button></>}</div>}</details>
        {displayMode === 'full-graph' && <details><summary>Forces</summary><label><span>Center force <b>{preferences.centerForce.toFixed(2)}</b></span><input type="range" min="0" max="1" step="0.02" value={preferences.centerForce} onChange={event => updatePreference('centerForce', Number(event.target.value))} /></label><label><span>Repel force <b>{preferences.repelForce}</b></span><input type="range" min="20" max="220" step="2" value={preferences.repelForce} onChange={event => updatePreference('repelForce', Number(event.target.value))} /></label><label><span>Link force <b>{preferences.linkStrength.toFixed(2)}</b></span><input type="range" min="0.05" max="1" step="0.05" value={preferences.linkStrength} onChange={event => updatePreference('linkStrength', Number(event.target.value))} /></label><label><span>Link distance <b>{preferences.linkDistance}px</b></span><input type="range" min="45" max="220" step="5" value={preferences.linkDistance} onChange={event => updatePreference('linkDistance', Number(event.target.value))} /></label></details>}
        <button className="graph-reset-settings" onClick={() => { positionsRef.current.clear(); initialFitCompleteRef.current = false; viewTouchedRef.current = false; setPreferences(DEFAULT_PREFERENCES); setQuery(''); setTimelineEnabled(false); setExpandedGroups(new Set()); setDisplayMode('project-map'); setSimulationVersion(version => version + 1); }}>Restore defaults</button>
      </aside>}

      {navigatorOpen && <aside className="graph-node-navigator" aria-label="Graph node navigator"><header><div><span>Node navigator</span><b>{navigatorNodes.length} {displayMode === 'project-map' ? 'matching project' : 'visible'} notes</b></div><button aria-label="Close node navigator" onClick={() => setNavigatorOpen(false)}>×</button></header><div>{navigatorNodes.slice().sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label)).slice(0, 300).map(node => <button key={node.id} className={`${node.id === selectedId ? 'selected' : ''}${!visibleIds.has(node.id) ? ' grouped' : ''}`} onClick={() => revealNavigatorNode(node)}><b>{node.label}</b><span>{node.missing ? 'Unresolved link' : `${node.degree} connections · ${groupForNode(node, 'folder', projectPath)}${!visibleIds.has(node.id) ? ' · grouped' : ''}`}</span></button>)}</div>{navigatorNodes.length > 300 && <p>Showing the 300 most connected matching notes. Use the graph filter to narrow the list.</p>}</aside>}

      {displayMode === 'full-graph' && <div className="graph-axis graph-3d-axis" aria-hidden="true"><i style={{ transform: `rotate(${orbit.yaw}rad)` }} /><span>3D</span></div>}
      <div id={graphInstructionsId} className="sr-only">{displayMode === 'full-graph' ? 'Drag empty space to rotate. Shift-drag or use arrow keys to pan. Use Alt plus arrow keys to rotate from the keyboard. Use the wheel or plus and minus keys to zoom. R resets 3D rotation. F toggles full screen. Right-click a note for actions.' : 'Drag or use arrow keys to pan. Use the wheel or plus and minus keys to zoom. Select a note to reveal links. Right-click a note for actions.'}</div>
      <div className="graph-canvas-help" aria-hidden="true">{displayMode === 'full-graph' ? 'Drag empty space to rotate · Shift-drag to pan · Wheel to zoom · Drag a note to reshape · R resets 3D · F toggles full screen' : 'Drag to pan · Wheel to zoom · Select a note to reveal links · Right-click for actions'}</div>
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </div>

    {effectiveGroupMode !== 'none' && groups.length > 1 && <div className="graph-group-legend" aria-label={`Node colors by ${effectiveGroupMode}`}><span className="graph-legend-title">{effectiveGroupMode === 'folder' ? 'Folders' : 'Tags'}</span>{groups.slice(0, 6).map((group, index) => <span key={group}><i className={`graph-group-${index % 6}`} />{group}</span>)}{groups.length > 6 && <span>+{groups.length - 6} more</span>}</div>}
    {overlay}
  </div>;
}
