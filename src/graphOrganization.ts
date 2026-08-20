export type GraphLayoutPoint = { x: number; y: number };

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
