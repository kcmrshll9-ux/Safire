import fs from 'node:fs/promises';
import path from 'node:path';
import { createNoteMutator, assertContainedPath, readContainedFile } from './note-mutations.mjs';
import { noteRevision } from './note-revision.mjs';

// Private checkpoints are kept outside Markdown discovery, and survive changing
// desktop loopback ports. Note backups remain a separate, immutable history.
export async function createDraftStore(vault) {
  const root = path.join(vault, '.safire', 'drafts');
  await assertContainedPath(vault, root, { allowMissing: true });
  await fs.mkdir(root, { recursive: true });
  await assertContainedPath(vault, root);
  const mutator = createNoteMutator({ vaultDir: root, backupWrites: false });
  const file = note => path.join(root, `${noteRevision(process.platform === 'win32' ? note.toLowerCase() : note)}.json`);
  async function get(note) {
    try {
      const stat = await fs.lstat(file(note));
      if (stat.size > 2_200_000) throw new Error('Draft exceeds the supported size');
      const bytes = await readContainedFile(root, file(note), 'utf8', { maxBytes: 2_200_000 });
      if (Buffer.byteLength(bytes) > 2_200_000) throw new Error('Draft exceeds the supported size');
      const draft = JSON.parse(bytes);
      if (draft.cleared) return null;
      if (typeof draft.content !== 'string' || !/^[a-f0-9]{64}$/.test(draft.baseRevision || '')) throw new Error('This draft is damaged. The saved Markdown note is unchanged.');
      return draft;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    get,
    async put(note, input) {
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1_000_000
        || !/^[a-f0-9]{64}$/.test(input.baseRevision || '')) throw new Error('Invalid draft');
      const draft = { path: note, content: input.content, baseRevision: input.baseRevision, updatedAt: Date.now() };
      await mutator.put(file(note), JSON.stringify(draft));
      return { path: note, updatedAt: draft.updatedAt, revision: noteRevision(draft.content) };
    },
    async clear(note, contentRevision) {
      if (!/^[a-f0-9]{64}$/.test(contentRevision || '')) throw new Error('Draft revision required');
      try {
        // A tombstone is published under the same cross-process lock as writes.
        await mutator.mutate(file(note), bytes => {
          const current = JSON.parse(String(bytes));
          return noteRevision(current.content || '') === contentRevision
            ? JSON.stringify({ path: note, cleared: true, updatedAt: Date.now() }) : bytes;
        });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    async list() {
      const drafts = [];
      const dir = await fs.opendir(root);
      let observed = 0;
      let complete = true;
      for await (const entry of dir) {
        if (++observed > 2000) { complete = false; break; }
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const absolute = path.join(root, entry.name);
        try {
          const draft = JSON.parse(await readContainedFile(root, absolute, 'utf8', { maxBytes: 2_200_000 }));
          if (!draft.cleared && typeof draft.path === 'string' && typeof draft.content === 'string') drafts.push({ path: draft.path, updatedAt: draft.updatedAt });
        } catch { complete = false; }
      }
      return { drafts: drafts.sort((a,b) => b.updatedAt - a.updatedAt), complete };
    },
  };
}
