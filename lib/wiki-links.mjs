import path from 'node:path';

const withoutExtension = value => value.replace(/\.md$/i, '');
export function createWikiResolver(paths) {
  const exact = new Set(paths);
  const byKey = new Map();
  const byName = new Map();
  for (const file of paths) {
    for (const [map, key] of [[byKey, withoutExtension(file).toLowerCase()], [byName, withoutExtension(path.posix.basename(file)).toLowerCase()]]) {
      map.set(key, map.has(key) ? null : file);
    }
  }
  return (from, target) => {
  const clean = target.split('#')[0].trim().replace(/\\/g,'/');
  if (!clean) return from;
  const folder = path.posix.dirname(from);
  const project = from.includes('/') ? from.split('/')[0] : '';
  const candidates = clean.startsWith('/') ? [clean.slice(1)] : [path.posix.normalize(path.posix.join(folder,clean)), ...(project ? [path.posix.join(project,clean)] : []), clean];
  for (const candidate of candidates) {
    const precise = /\.md$/i.test(candidate) ? candidate : candidate + '.md';
    if (exact.has(precise)) return precise;
    const resolved = byKey.get(withoutExtension(candidate).toLowerCase());
    if (resolved) return resolved;
    if (byKey.has(withoutExtension(candidate).toLowerCase())) return null;
  }
  return clean.startsWith('/') ? null : byName.get(withoutExtension(clean).toLowerCase()) || null;
  };
}

export function resolveWikiPath(from, target, paths) {
  return createWikiResolver(paths)(from, target);
}

export function rewriteWikiReferences(content, contextPath, from, to, paths, resolver = createWikiResolver(paths)) {
  let fence = null;
  let count = 0;
  const updated = content.split(/(\r?\n)/).map(line => {
    const marker = line.match(/^\s*(?:>\s*)*(?:[-*+]\s+)?(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) return line;
    return line.split(/(`+[^`]*`+)/g).map(part => {
      if (part.startsWith('`')) return part;
      return part.replace(/(?<!\\)\[\[([^\]\n]+)\]\]/g, (original, inside) => {
        const pipe = inside.indexOf('|');
        const target = pipe < 0 ? inside : inside.slice(0,pipe);
        const resolved = resolver(contextPath,target);
        if (!resolved) return original;
        const destination = resolved === from ? to : resolved;
        const movingContext = contextPath === from && path.posix.dirname(from) !== path.posix.dirname(to);
        if (resolved !== from && (!movingContext || target.trim().startsWith('/'))) return original;
        const anchor = target.includes('#') ? target.slice(target.indexOf('#')) : '';
        const alias = pipe < 0 ? '' : inside.slice(pipe);
        count++;
        return `[[/${withoutExtension(destination)}${anchor}${alias}]]`;
      });
    }).join('');
  }).join('');
  return { content: updated, count };
}
