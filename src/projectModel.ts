export type ProjectTreeNode = {
  type: 'folder' | 'note';
  name: string;
  path: string;
  title?: string;
  children?: ProjectTreeNode[];
};

export type ProjectNote = {
  path: string;
  title: string;
  mtime: number;
};

export type ProjectSummary = {
  path: string;
  name: string;
  entryCount: number;
  lastUpdated: number | null;
};

const MANAGED_ROOT_FOLDERS = new Set([
  '.safire',
  '.safire-backups',
  'attachments',
  'daily notes',
  'inbox',
  'templates',
  'web clips',
]);

function normalizedPath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function rootFolderName(value: string) {
  return normalizedPath(value).split('/')[0]?.trim().toLowerCase() || '';
}

export function managedProjectFolders(dailyNotesFolder = 'Daily Notes') {
  const managed = new Set(MANAGED_ROOT_FOLDERS);
  const dailyRoot = rootFolderName(dailyNotesFolder);
  if (dailyRoot) managed.add(dailyRoot);
  return managed;
}

export function projectEntries(notes: ProjectNote[], projectPath: string) {
  const prefix = `${normalizedPath(projectPath)}/`;
  return notes
    .filter(note => normalizedPath(note.path).startsWith(prefix))
    .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' }));
}

export function projectForNotePath(projects: ProjectSummary[], notePath: string) {
  const normalizedNotePath = normalizedPath(notePath);
  return projects.find(project => normalizedNotePath.startsWith(`${normalizedPath(project.path)}/`)) || null;
}

export function projectGraph<
  Node extends { id: string; inDegree?: number; outDegree?: number; degree?: number; orphan?: boolean },
  Link extends { source: string; target: string },
>(graph: { nodes: Node[]; links: Link[] }, projectPath: string): { nodes: Node[]; links: Link[] } {
  const prefix = `${normalizedPath(projectPath)}/`;
  const retained = graph.nodes.filter(node => normalizedPath(node.id).startsWith(prefix));
  const retainedIds = new Set(retained.map(node => normalizedPath(node.id)));
  const links = graph.links.filter(link => (
    retainedIds.has(normalizedPath(link.source))
    && retainedIds.has(normalizedPath(link.target))
  ));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const link of links) {
    const source = normalizedPath(link.source);
    const target = normalizedPath(link.target);
    outgoing.set(source, (outgoing.get(source) || 0) + 1);
    incoming.set(target, (incoming.get(target) || 0) + 1);
  }
  const nodes = retained.map(node => {
    const key = normalizedPath(node.id);
    const inDegree = incoming.get(key) || 0;
    const outDegree = outgoing.get(key) || 0;
    return { ...node, inDegree, outDegree, degree: inDegree + outDegree, orphan: inDegree + outDegree === 0 };
  });
  return { nodes, links };
}

export function projectSummaries(tree: ProjectTreeNode[], notes: ProjectNote[], dailyNotesFolder = 'Daily Notes'): ProjectSummary[] {
  const managed = managedProjectFolders(dailyNotesFolder);
  return tree
    .filter(node => node.type === 'folder' && !node.name.startsWith('.') && !managed.has(node.name.trim().toLowerCase()))
    .map(node => {
      const entries = projectEntries(notes, node.path);
      return {
        path: node.path,
        name: node.name,
        entryCount: entries.length,
        lastUpdated: entries[0]?.mtime ?? null,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export function portableEntryNameError(rawName: string) {
  const name = rawName.trim();
  if (!name) return 'Enter a name.';
  if (name === '.' || name === '..') return 'Use one portable name without slashes or reserved filename characters.';
  if (name.startsWith('.')) return 'Entry names cannot start with a dot because leading dots create hidden or internal files.';
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    return 'Use one portable name without slashes or reserved filename characters.';
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return 'That name is reserved by Windows. Choose another name.';
  }
  return null;
}

export function projectNameError(rawName: string, dailyNotesFolder = 'Daily Notes') {
  const name = rawName.trim();
  if (name.startsWith('.')) return 'That folder name is reserved for Safire-managed files. Choose another project name.';
  const portableError = portableEntryNameError(rawName);
  if (portableError) return portableError.replace('name', 'project name');
  if (managedProjectFolders(dailyNotesFolder).has(name.toLowerCase())) {
    return 'That folder name is reserved for Safire-managed files. Choose another project name.';
  }
  return null;
}
