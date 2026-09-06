import fs from 'node:fs/promises';
import path from 'node:path';
import { assertContainedPath } from './note-mutations.mjs';
import { readBoundedIndexNote } from './graph-policy.mjs';
import { noteRevision } from './note-revision.mjs';
import { rewriteWikiReferences, createWikiResolver } from './wiki-links.mjs';

export async function planLinkedRename(vault, from, to, catalog) {
  const discovery = await catalog.paths();
  if (!discovery.complete) throw new Error('Finish indexing the vault before updating links during a rename.');
  const rewrites = [];
  const skipped = [];
  const resolve = createWikiResolver(discovery.paths);
  let bytes = 0;
  for (const relative of discovery.paths) {
    const absolute = path.join(vault, relative);
    await assertContainedPath(vault, absolute);
    const indexed = await readBoundedIndexNote(fs, absolute);
    bytes += indexed.bytesConsumed;
    if (bytes > 64 * 1024 * 1024) throw new Error('This rename needs more than the 64 MiB review budget. Move a smaller project first.');
    if (indexed.contentOmitted) { skipped.push(relative); continue; }
    const rewrite = rewriteWikiReferences(indexed.content, relative, from, to, discovery.paths, resolve);
    if (rewrite.count || relative === from) rewrites.push({ path: relative, content: rewrite.content, count: rewrite.count, revision: noteRevision(indexed.content) });
  }
  if (!rewrites.some(change => change.path === from)) throw new Error('The source note cannot be safely read for this rename');
  return { from, to, rewrites, skipped };
}
