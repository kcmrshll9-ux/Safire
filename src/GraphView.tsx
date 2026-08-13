import React from 'react';

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

export type GraphData = { nodes: GraphNodeData[]; links: GraphLinkData[] };

type GraphViewProps = {
  graph: GraphData;
  activePath: string;
  onPreview: (path: string) => void;
  onEdit: (path: string) => void;
  onCreateMissing: (title: string) => void;
  overlay?: React.ReactNode;
};

type RenderNode = GraphNodeData & { missing: boolean; resolution?: GraphLinkData['resolution'] };
type RenderLink = GraphLinkData & { targetId: string };
type LayoutPoint = { x: number; y: number; vx: number; vy: number; fx?: number; fy?: number };
type ViewTransform = { x: number; y: number; k: number };
type GraphScope = 'global' | 'local';
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
  const links: RenderLink[] = graph.links.map(link => {
    const targetId = link.resolved && actualIds.has(link.target) ? link.target : missingNodeId(link);
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
    return { ...link, targetId };
  });
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

function groupForNode(node: RenderNode, mode: GroupMode) {
  if (node.missing) return 'Unresolved links';
  if (mode === 'tag') return node.tags[0] ? `#${node.tags[0]}` : 'Untagged';
  if (mode === 'folder') return node.folder.split('/')[0] || 'Vault root';
  return 'Notes';
}

function nodeRadius(node: RenderNode, scale: number) {
  return clamp((7 + Math.sqrt(Math.max(0, node.degree)) * 2.2) * scale, 6, 24);
}

function edgePath(source: LayoutPoint, target: LayoutPoint, link: RenderLink, sourceRadius: number, targetRadius: number) {
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

export function GraphView({ graph, activePath, onPreview, onEdit, onCreateMissing, overlay }: GraphViewProps) {
  const workspaceRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const menuReturnFocusRef = React.useRef<SVGElement | null>(null);
  const positionsRef = React.useRef(new Map<string, LayoutPoint>());
  const animationRef = React.useRef<number | null>(null);
  const dragRef = React.useRef<null | { kind: 'pan'; pointerId: number; startX: number; startY: number; origin: ViewTransform } | { kind: 'node'; pointerId: number; id: string; startX: number; startY: number; moved: boolean }>(null);
  const suppressClickRef = React.useRef<string | null>(null);
  const [dimensions, setDimensions] = React.useState({ width: 900, height: 560 });
  const [view, setView] = React.useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const [scope, setScope] = React.useState<GraphScope>('global');
  const [localRoot, setLocalRoot] = React.useState(activePath);
  const [depth, setDepth] = React.useState(1);
  const [query, setQuery] = React.useState('');
  const [preferences, setPreferences] = React.useState<GraphPreferences>(readGraphPreferences);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
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
  const expanded = React.useMemo(() => expandGraph(graph), [graph]);
  const modifiedRange = React.useMemo(() => {
    const values = expanded.nodes.filter(node => !node.missing && node.mtime > 0).map(node => node.mtime);
    return { minimum: values.length ? Math.min(...values) : 0, maximum: values.length ? Math.max(...values) : 0 };
  }, [expanded]);

  React.useEffect(() => {
    try { localStorage.setItem(GRAPH_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Private browsing may disable storage. */ }
  }, [preferences]);

  React.useEffect(() => {
    if (activePath) setLocalRoot(activePath);
  }, [activePath]);

  React.useEffect(() => {
    setTimelineCutoff(modifiedRange.maximum || Number.POSITIVE_INFINITY);
  }, [modifiedRange.maximum]);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      setDimensions({ width: Math.max(320, rect.width), height: Math.max(280, rect.height) });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const sync = () => {
      setIsFullscreen(document.fullscreenElement === workspaceRef.current);
      if (document.fullscreenElement === workspaceRef.current) setFullscreenFallback(false);
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

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
  const visibleNodes = React.useMemo(() => expanded.nodes.filter(node => {
    if (!allowedLocalIds.has(node.id)) return false;
    if (node.missing && !preferences.showMissing) return false;
    if (!node.missing && node.orphan && !preferences.showOrphans) return false;
    if (!node.missing && timelineEnabled && node.mtime > timelineCutoff) return false;
    return nodeMatches(node, normalizedQuery);
  }), [expanded, allowedLocalIds, preferences.showMissing, preferences.showOrphans, timelineEnabled, timelineCutoff, normalizedQuery]);
  const visibleIds = React.useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);
  const visibleLinks = React.useMemo(() => expanded.links.filter(link => visibleIds.has(link.source) && visibleIds.has(link.targetId)), [expanded, visibleIds]);
  const nodeById = React.useMemo(() => new Map(visibleNodes.map(node => [node.id, node])), [visibleNodes]);
  const selected = selectedId ? nodeById.get(selectedId) || null : null;
  const focusId = hoveredId;
  const neighbors = React.useMemo(() => {
    const values = new Set<string>();
    if (!focusId) return values;
    for (const link of visibleLinks) {
      if (link.source === focusId) values.add(link.targetId);
      if (link.targetId === focusId) values.add(link.source);
    }
    return values;
  }, [visibleLinks, focusId]);
  const groups = React.useMemo(() => [...new Set(visibleNodes.map(node => groupForNode(node, preferences.groupBy)))].sort((a, b) => a.localeCompare(b)), [visibleNodes, preferences.groupBy]);
  const groupIndexes = React.useMemo(() => new Map(groups.map((group, index) => [group, index])), [groups]);
  const layoutSignature = visibleNodes.map(node => `${node.id}:${node.degree}`).join('|');
  const linkSignature = visibleLinks.map(link => `${link.id}:${link.targetId}`).join('|');

  const updatePreference = <Key extends keyof GraphPreferences>(key: Key, value: GraphPreferences[Key]) => {
    setPreferences(current => ({ ...current, [key]: value }));
  };

  React.useEffect(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    const positions = positionsRef.current;
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    const maxInitialRadius = Math.max(80, Math.min(dimensions.width, dimensions.height) * .34);
    for (const node of visibleNodes) {
      if (positions.has(node.id)) continue;
      const hash = graphHash(node.id);
      const angle = (hash % 10000) / 10000 * Math.PI * 2;
      const radius = (.18 + ((hash >>> 12) % 1000) / 1250) * maxInitialRadius;
      positions.set(node.id, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius, vx: 0, vy: 0 });
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
      for (const { point } of layoutNodes) {
        if (point.fx !== undefined && point.fy !== undefined) {
          point.x = point.fx;
          point.y = point.fy;
          point.vx = 0;
          point.vy = 0;
          continue;
        }
        point.vx += (centerX - point.x) * preferences.centerForce * .0014;
        point.vy += (centerY - point.y) * preferences.centerForce * .0014;
        point.vx = clamp(point.vx * .84, -12, 12);
        point.vy = clamp(point.vy * .84, -12, 12);
        point.x += point.vx;
        point.y += point.vy;
      }
      iteration += 1;
    };
    const draw = () => {
      if (cancelled) return;
      const steps = reducedMotion ? 140 : iteration < 45 ? 3 : 1;
      for (let step = 0; step < steps; step += 1) simulate();
      setLayoutVersion(version => version + 1);
      if (iteration < 210) animationRef.current = requestAnimationFrame(draw);
      else animationRef.current = null;
    };
    animationRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
  }, [layoutSignature, linkSignature, dimensions.width, dimensions.height, preferences.centerForce, preferences.repelForce, preferences.linkStrength, preferences.linkDistance, preferences.nodeSize, simulationVersion]);

  const fitView = React.useCallback(() => {
    const points = visibleNodes.map(node => positionsRef.current.get(node.id)).filter((point): point is LayoutPoint => Boolean(point));
    if (!points.length) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const minimumX = Math.min(...points.map(point => point.x));
    const maximumX = Math.max(...points.map(point => point.x));
    const minimumY = Math.min(...points.map(point => point.y));
    const maximumY = Math.max(...points.map(point => point.y));
    const spanX = Math.max(120, maximumX - minimumX + 120);
    const spanY = Math.max(120, maximumY - minimumY + 120);
    const scale = clamp(Math.min(dimensions.width / spanX, dimensions.height / spanY), .25, 2.1);
    setView({
      x: dimensions.width / 2 - (minimumX + maximumX) / 2 * scale,
      y: dimensions.height / 2 - (minimumY + maximumY) / 2 * scale,
      k: scale,
    });
  }, [visibleNodes, dimensions]);

  React.useEffect(() => {
    const timer = window.setTimeout(fitView, 180);
    return () => window.clearTimeout(timer);
  }, [layoutSignature, dimensions.width, dimensions.height, fitView]);

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

  const worldFromClient = (clientX: number, clientY: number) => {
    const point = pointFromClient(clientX, clientY);
    return { x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k };
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
    const point = positionsRef.current.get(nodeId);
    if (!point) return;
    const scale = clamp(zoom, .25, 4);
    setView({ x: dimensions.width / 2 - point.x * scale, y: dimensions.height / 2 - point.y * scale, k: scale });
    setSelectedId(nodeId);
  };

  const showConnections = (node: RenderNode) => {
    if (node.missing) return;
    setLocalRoot(node.id);
    setScope('local');
    setDepth(1);
    setMenu(null);
    setAnnouncement(`Showing direct connections for ${node.label}`);
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
    event.stopPropagation();
    const world = worldFromClient(event.clientX, event.clientY);
    const point = positionsRef.current.get(node.id);
    if (point) {
      point.fx = world.x;
      point.fy = world.y;
      point.x = world.x;
      point.y = world.y;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: 'node', pointerId: event.pointerId, id: node.id, startX: event.clientX, startY: event.clientY, moved: false };
  };

  const beginPan = (event: React.PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: view };
    setMenu(null);
    setSelectedId(null);
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
    const world = worldFromClient(event.clientX, event.clientY);
    const point = positionsRef.current.get(drag.id);
    if (point) {
      point.fx = world.x;
      point.fy = world.y;
      point.x = world.x;
      point.y = world.y;
    }
    drag.moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5;
    setLayoutVersion(version => version + 1);
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === 'node') {
      const point = positionsRef.current.get(drag.id);
      if (point) { delete point.fx; delete point.fy; }
      suppressClickRef.current = drag.moved ? drag.id : null;
      setSimulationVersion(version => version + 1);
    }
    dragRef.current = null;
  };

  const endNodePointer = (event: React.PointerEvent<SVGGElement>, node: RenderNode) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'node' || drag.pointerId !== event.pointerId || drag.id !== node.id) return;
    const point = positionsRef.current.get(drag.id);
    if (point) { delete point.fx; delete point.fy; }
    suppressClickRef.current = node.id;
    dragRef.current = null;
    setSelectedId(node.id);
    setMenu(null);
    setSimulationVersion(version => version + 1);
    if (!drag.moved && !node.missing) onPreview(node.id);
  };

  const zoomAt = (factor: number, anchor = { x: dimensions.width / 2, y: dimensions.height / 2 }) => {
    setView(current => {
      const nextScale = clamp(current.k * factor, .2, 4);
      const ratio = nextScale / current.k;
      return { x: anchor.x - (anchor.x - current.x) * ratio, y: anchor.y - (anchor.y - current.y) * ratio, k: nextScale };
    });
  };

  const toggleFullscreen = async () => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    try {
      if (document.fullscreenElement === workspace) await document.exitFullscreen();
      else if (fullscreenFallback) setFullscreenFallback(false);
      else await workspace.requestFullscreen();
    } catch {
      setFullscreenFallback(current => !current);
      setAnnouncement('Using an expanded graph view in this window.');
    }
  };

  const onGraphKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey || event.altKey) && event.key.toLocaleLowerCase() === 'f') return;
    if (event.key === 'Escape') { setMenu(null); setSettingsOpen(false); setNavigatorOpen(false); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1.18); return; }
    if (event.key === '-') { event.preventDefault(); zoomAt(1 / 1.18); return; }
    if (event.key === '0') { event.preventDefault(); fitView(); return; }
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
  const currentMenuNode = menu ? nodeById.get(menu.nodeId) || null : null;
  const nodeCountLabel = visibleNoteCount === graph.nodes.length ? `${visibleNoteCount}` : `${visibleNoteCount} of ${graph.nodes.length}`;
  void layoutVersion;

  const fullscreenActive = isFullscreen || fullscreenFallback;

  return <div className={`graph-workspace graph-relationship-workspace${fullscreenFallback ? ' graph-fullscreen-fallback' : ''}`} ref={workspaceRef}>
    <header className="graph-panel-head graph-relationship-head">
      <div><span className="graph-eyebrow">Knowledge graph</span><h2>{scope === 'local' ? `${titleFromGraphPath(localRoot)} connections` : 'Your connected notes'}</h2><p>Links shape the map. Dense hubs reveal recurring ideas; bridges reveal notes connecting different parts of your thinking.</p></div>
      <div className="graph-stats" aria-label="Graph summary"><span><b>{nodeCountLabel}</b> notes</span><span><b>{visibleResolvedLinkCount}</b> links</span><span><b>{visibleMissingLinkCount}</b> unresolved</span></div>
    </header>

    <div className="graph-toolbar graph-relationship-toolbar" aria-label="Graph controls">
      <div className="graph-scope-control" role="group" aria-label="Graph scope">
        <button className={scope === 'global' ? 'on' : ''} aria-pressed={scope === 'global'} onClick={() => setScope('global')}>Global</button>
        <button className={scope === 'local' ? 'on' : ''} aria-pressed={scope === 'local'} onClick={() => { setLocalRoot(activePath); setScope('local'); }}>Local</button>
      </div>
      {scope === 'local' && <label className="graph-depth-control"><span>Depth</span><select value={depth} onChange={event => setDepth(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      <label className="graph-search-control"><span className="sr-only">Filter graph notes</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter notes, paths, or tags…" /></label>
      <div className="graph-view-actions">
        <button onClick={fitView}>Fit</button>
        <button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.18)}>−</button>
        <button aria-label="Zoom in" onClick={() => zoomAt(1.18)}>+</button>
        <button aria-expanded={navigatorOpen} onClick={() => { setNavigatorOpen(value => !value); setSettingsOpen(false); }}>Nodes</button>
        <button aria-expanded={settingsOpen} onClick={() => { setSettingsOpen(value => !value); setNavigatorOpen(false); }}>Settings</button>
        <button className="graph-fullscreen-button" onClick={() => void toggleFullscreen()} aria-pressed={fullscreenActive}>{fullscreenActive ? 'Exit full screen' : 'Full screen'}</button>
      </div>
    </div>

    <div className="graph-3d-stage graph-2d-stage" ref={stageRef} tabIndex={0} onKeyDown={onGraphKeyDown}>
      <svg ref={svgRef} className="graph-svg-canvas" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} aria-label={`Interactive ${scope} knowledge graph with ${visibleNodes.length} visible notes and ${visibleLinks.length} visible links`} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={event => {
        event.preventDefault();
        zoomAt(Math.exp(-event.deltaY * .0011), pointFromClient(event.clientX, event.clientY));
      }}>
        <title>Safire knowledge graph</title><desc>Notes are circles and wiki links are connecting lines. Larger circles have more connections.</desc>
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
          <filter id="graph-node-glow" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <rect className="graph-pan-surface" width={dimensions.width} height={dimensions.height} onPointerDown={beginPan} />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <g className="graph-link-layer">
            {visibleLinks.map(link => {
              const sourceNode = nodeById.get(link.source);
              const targetNode = nodeById.get(link.targetId);
              const source = positionsRef.current.get(link.source);
              const target = positionsRef.current.get(link.targetId);
              if (!source || !target || !sourceNode || !targetNode) return null;
              const active = Boolean(focusId && (link.source === focusId || link.targetId === focusId));
              const dimmed = Boolean(focusId && !active);
              return <path key={link.id} className={`graph-link${link.resolved ? '' : ' unresolved'}${active ? ' active' : ''}${dimmed ? ' dimmed' : ''}`} d={edgePath(source, target, link, nodeRadius(sourceNode, preferences.nodeSize), nodeRadius(targetNode, preferences.nodeSize))} style={{ strokeWidth: preferences.linkWidth / view.k }} markerEnd={preferences.arrows ? 'url(#graph-arrow)' : undefined} />;
            })}
          </g>
          <g className="graph-node-layer">
            {visibleNodes.map(node => {
              const point = positionsRef.current.get(node.id);
              if (!point) return null;
              const radius = nodeRadius(node, preferences.nodeSize);
              const groupIndex = groupIndexes.get(groupForNode(node, preferences.groupBy)) || 0;
              const isSelected = node.id === selectedId;
              const isHovered = node.id === hoveredId;
              const isActive = node.id === activePath;
              const dimmed = Boolean(focusId && node.id !== focusId && !neighbors.has(node.id));
              const showLabel = preferences.showLabels && (view.k >= .8 || node.degree >= 3 || isSelected || isHovered || isActive);
              return <g key={node.id} className={`graph-node graph-group-${groupIndex % 6}${node.missing ? ' missing' : ''}${node.resolution === 'ambiguous' ? ' ambiguous' : ''}${isSelected ? ' selected' : ''}${isActive ? ' active-note' : ''}${dimmed ? ' dimmed' : ''}`} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={`${node.label}, ${node.resolution === 'ambiguous' ? 'ambiguous linked note' : node.missing ? 'unresolved linked note' : `${node.degree} connections`}`} onPointerDown={event => beginNodeDrag(event, node)} onPointerUp={event => endNodePointer(event, node)} onClick={event => {
                event.stopPropagation();
                if (suppressClickRef.current === node.id) { suppressClickRef.current = null; return; }
                setSelectedId(node.id);
                if (!node.missing) onPreview(node.id);
              }} onPointerEnter={() => setHoveredId(node.id)} onPointerLeave={() => setHoveredId(current => current === node.id ? null : current)} onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                const rect = stageRef.current?.getBoundingClientRect();
                if (rect) openMenuAt(node, event.clientX - rect.left, event.clientY - rect.top, event.currentTarget);
              }} onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); node.missing ? setSelectedId(node.id) : onPreview(node.id); }
                if (event.key === ' ') { event.preventDefault(); setSelectedId(node.id); }
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  openMenuAt(node, point.x * view.k + view.x, point.y * view.k + view.y, event.currentTarget);
                }
              }}>
                <title>{node.label} — {node.resolution === 'ambiguous' ? 'matches multiple notes' : node.missing ? 'unresolved link' : `${node.degree} connections · ${node.id}`}</title>
                <circle className="graph-node-halo" r={radius + 7} />
                {node.missing ? <path className="graph-node-core" d={`M 0 ${-radius} L ${radius} 0 L 0 ${radius} L ${-radius} 0 Z`} /> : <circle className="graph-node-core" r={radius} />}
                {isActive && <circle className="graph-active-ring" r={radius + 4} />}
                {node.missing && <text className="graph-missing-mark" y={4 / view.k} style={{ fontSize: `${11 / view.k}px` }}>?</text>}
                {showLabel && <text className="graph-node-label" y={radius + 15 / view.k} style={{ fontSize: `${12 / view.k}px`, strokeWidth: 4 / view.k }}>{node.label}</text>}
              </g>;
            })}
          </g>
        </g>
      </svg>

      {!visibleNodes.length && <div className="graph-empty-state"><b>No notes match this view</b><span>Clear the filter or include more note types in Settings.</span><button onClick={() => { setQuery(''); setPreferences(current => ({ ...current, showMissing: true, showOrphans: true })); }}>Clear filters</button></div>}

      {selected && <aside className="graph-selection-card" aria-live="polite"><span>{selected.resolution === 'ambiguous' ? 'Ambiguous link' : selected.missing ? 'Unresolved link' : selected.id === activePath ? 'Active note' : 'Selected note'}</span><b>{selected.label}</b><small>{selected.resolution === 'ambiguous' ? 'More than one note has this title. Qualify the wiki link with its folder to connect it.' : selected.missing ? 'No existing note matches this link yet.' : `${selected.degree} connection${selected.degree === 1 ? '' : 's'} · ${selected.inDegree} in · ${selected.outDegree} out${selected.tags.length ? ` · ${selected.tags.slice(0, 3).map(tag => `#${tag}`).join(' ')}` : ''}`}</small><div>{selected.missing ? selected.resolution !== 'ambiguous' && <button onClick={() => onCreateMissing(selected.label)}>Create note</button> : <><button onClick={() => onPreview(selected.id)}>Preview</button><button onClick={() => onEdit(selected.id)}>Edit</button><button onClick={() => showConnections(selected)}>Connections</button></>}</div></aside>}

      {currentMenuNode && menu && <div ref={menuRef} className="graph-node-menu" role="menu" aria-label={`Actions for ${currentMenuNode.label}`} style={{ left: menu.x, top: menu.y }} onPointerDown={event => event.stopPropagation()} onKeyDown={onMenuKeyDown}>
        <div className="graph-node-menu-title">{currentMenuNode.label}</div>
        {currentMenuNode.missing ? <>{currentMenuNode.resolution !== 'ambiguous' && <button role="menuitem" onClick={() => onCreateMissing(currentMenuNode.label)}>Create missing note</button>}<button role="menuitem" onClick={() => { focusNode(currentMenuNode.id); setMenu(null); }}>Focus placeholder</button></> : <><button role="menuitem" onClick={() => { setMenu(null); onPreview(currentMenuNode.id); }}>Preview note</button><button role="menuitem" onClick={() => { setMenu(null); onEdit(currentMenuNode.id); }}>Edit note</button><button role="menuitem" onClick={() => { focusNode(currentMenuNode.id); setMenu(null); }}>Focus note</button><button role="menuitem" onClick={() => showConnections(currentMenuNode)}>Show connections</button><button role="menuitem" onClick={() => void copyLink(currentMenuNode)}>Copy wiki link</button></>}
      </div>}

      {settingsOpen && <aside className="graph-settings-panel" aria-label="Graph settings">
        <header><div><span>Graph settings</span><b>Tune what the map reveals</b></div><button aria-label="Close graph settings" onClick={() => setSettingsOpen(false)}>×</button></header>
        <details open><summary>Filters</summary><label><span>Search files</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="path, title, or #tag" /></label><label className="graph-check"><input type="checkbox" checked={preferences.showMissing} onChange={event => updatePreference('showMissing', event.target.checked)} /><span>Unresolved links</span></label><label className="graph-check"><input type="checkbox" checked={preferences.showOrphans} onChange={event => updatePreference('showOrphans', event.target.checked)} /><span>Orphan notes</span></label></details>
        <details open><summary>Groups</summary><label><span>Color nodes by</span><select value={preferences.groupBy} onChange={event => updatePreference('groupBy', event.target.value as GroupMode)}><option value="folder">Top-level folder</option><option value="tag">First tag</option><option value="none">No groups</option></select></label></details>
        <details><summary>Display</summary><label className="graph-check"><input type="checkbox" checked={preferences.arrows} onChange={event => updatePreference('arrows', event.target.checked)} /><span>Link direction arrows</span></label><label className="graph-check"><input type="checkbox" checked={preferences.showLabels} onChange={event => updatePreference('showLabels', event.target.checked)} /><span>Note labels</span></label><label><span>Node size <b>{preferences.nodeSize.toFixed(1)}×</b></span><input type="range" min="0.7" max="1.6" step="0.1" value={preferences.nodeSize} onChange={event => updatePreference('nodeSize', Number(event.target.value))} /></label><label><span>Link thickness <b>{preferences.linkWidth.toFixed(1)}</b></span><input type="range" min="0.6" max="3" step="0.1" value={preferences.linkWidth} onChange={event => updatePreference('linkWidth', Number(event.target.value))} /></label>{modifiedRange.maximum > modifiedRange.minimum && <div className="graph-timeline-control"><label className="graph-check"><input type="checkbox" checked={timelineEnabled} onChange={event => { setTimelineEnabled(event.target.checked); setTimelinePlaying(false); setTimelineCutoff(modifiedRange.maximum); }} /><span>Modified timeline</span></label>{timelineEnabled && <><label><span>Through <b>{formatGraphDate(timelineCutoff)}</b></span><input type="range" min={modifiedRange.minimum} max={modifiedRange.maximum} step={Math.max(1, (modifiedRange.maximum - modifiedRange.minimum) / 120)} value={timelineCutoff} onChange={event => { setTimelinePlaying(false); setTimelineCutoff(Number(event.target.value)); }} /></label><button onClick={() => setTimelinePlaying(value => !value)}>{timelinePlaying ? 'Pause time-lapse' : 'Play time-lapse'}</button></>}</div>}</details>
        <details><summary>Forces</summary><label><span>Center force <b>{preferences.centerForce.toFixed(2)}</b></span><input type="range" min="0" max="1" step="0.02" value={preferences.centerForce} onChange={event => updatePreference('centerForce', Number(event.target.value))} /></label><label><span>Repel force <b>{preferences.repelForce}</b></span><input type="range" min="20" max="220" step="2" value={preferences.repelForce} onChange={event => updatePreference('repelForce', Number(event.target.value))} /></label><label><span>Link force <b>{preferences.linkStrength.toFixed(2)}</b></span><input type="range" min="0.05" max="1" step="0.05" value={preferences.linkStrength} onChange={event => updatePreference('linkStrength', Number(event.target.value))} /></label><label><span>Link distance <b>{preferences.linkDistance}px</b></span><input type="range" min="45" max="220" step="5" value={preferences.linkDistance} onChange={event => updatePreference('linkDistance', Number(event.target.value))} /></label></details>
        <button className="graph-reset-settings" onClick={() => { setPreferences(DEFAULT_PREFERENCES); setQuery(''); setTimelineEnabled(false); setSimulationVersion(version => version + 1); }}>Restore defaults</button>
      </aside>}

      {navigatorOpen && <aside className="graph-node-navigator" aria-label="Graph node navigator"><header><div><span>Node navigator</span><b>{visibleNodes.length} visible notes</b></div><button aria-label="Close node navigator" onClick={() => setNavigatorOpen(false)}>×</button></header><div>{visibleNodes.slice().sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label)).slice(0, 300).map(node => <button key={node.id} className={node.id === selectedId ? 'selected' : ''} onClick={() => { focusNode(node.id); setNavigatorOpen(false); }}><b>{node.label}</b><span>{node.missing ? 'Unresolved link' : `${node.degree} connections · ${node.folder || 'Vault root'}`}</span></button>)}</div>{visibleNodes.length > 300 && <p>Showing the 300 most connected visible notes. Use the graph filter to narrow the list.</p>}</aside>}

      <div className="graph-canvas-help" aria-hidden="true">Drag to pan · Wheel to zoom · Drag a note to reshape · Right-click for actions</div>
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </div>

    {preferences.groupBy !== 'none' && groups.length > 1 && <div className="graph-group-legend" aria-label={`Node colors by ${preferences.groupBy}`}><span className="graph-legend-title">{preferences.groupBy === 'folder' ? 'Folders' : 'Tags'}</span>{groups.slice(0, 6).map((group, index) => <span key={group}><i className={`graph-group-${index % 6}`} />{group}</span>)}{groups.length > 6 && <span>+{groups.length - 6} more</span>}</div>}
    {overlay}
  </div>;
}
