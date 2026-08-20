type NotePath = { path: string };

export function selectAvailableNotePath(notes: readonly NotePath[], preferredPaths: readonly string[] = []) {
  const availablePaths = new Set(notes.map(note => note.path));
  return preferredPaths.find(candidate => candidate && availablePaths.has(candidate)) || notes[0]?.path || '';
}
