export type LibraryNote = { path: string; title: string; folder: string; size: number; mtime: number; tags: string[]; links: string[]; excerpt: string };
export type LibraryTree = { type: 'folder' | 'note'; name: string; path: string; title?: string; children?: LibraryTree[] };

export function libraryTree(notes: LibraryNote[]): LibraryTree[] {
  const roots: LibraryTree[] = [];
  const folders = new Map<string, LibraryTree>();
  for (const note of notes) {
    const parts = note.path.split('/');
    let children = roots;
    for (let index = 0; index < parts.length - 1; index++) {
      const folderPath = parts.slice(0,index+1).join('/');
      let folder = folders.get(folderPath);
      if (!folder) { folder = { type: 'folder', name: parts[index], path: folderPath, children: [] }; children.push(folder); folders.set(folderPath,folder); }
      children = folder.children!;
    }
    children.push({ type: 'note', name: parts[parts.length-1], path: note.path, title: note.title });
  }
  const sort = (items: LibraryTree[]) => { items.sort((a,b)=>a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1); for (const item of items) if (item.children) sort(item.children); };
  sort(roots);
  return roots;
}
