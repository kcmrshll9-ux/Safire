import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {
  createNoteMutator,
  listContainedFiles,
} from './note-mutations.mjs';
import { GRAPH_STORAGE_LIMITS, readBoundedIndexNote } from './graph-policy.mjs';
import {
  excerpt,
  isPublicTaskLine,
  parseLinks,
  parsePublicEvidenceReceipts,
  parsePublicTasks,
  parseTags,
  publicEvidenceContent,
  publicNoteMetadata,
  semanticMarkdownContent,
} from './note-projection.mjs';

export function publicNotesMcpError(error, vaultDir = '') {
  const fileSystemMessages = {
    EACCES: 'Safire could not access the requested item',
    EBUSY: 'Safire is busy with note changes; try again',
    EEXIST: 'The requested item already exists',
    EISDIR: 'The requested item is not a file',
    ENOENT: 'The requested item was not found',
    ENOTDIR: 'The requested folder was not found',
    EPERM: 'Safire could not access the requested item',
  };
  if (fileSystemMessages[error?.code]) return fileSystemMessages[error.code];
  if (typeof error?.code === 'string' && /^(?:E[A-Z0-9_]+|ERR_FS_[A-Z0-9_]+)$/.test(error.code)) {
    return 'Safire could not complete the requested file operation';
  }
  let message = String(error?.message || 'Request failed').replace(/[\r\n]+/g, ' ').slice(0, 300);
  if (vaultDir) {
    const escapedVault = path.resolve(vaultDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    message = message.replace(new RegExp(escapedVault, 'gi'), '[vault]');
  }
  message = message
    .replace(/[A-Za-z]:[\\/][^\s"'`),}\]]+/g, '[local path]')
    .replace(/\\\\[^\\\s]+\\[^\s"'`),}\]]+/g, '[local path]');
  return message || 'Request failed';
}

function slash(value) {
  return String(value).replace(/\\/g, '/');
}

function titleFromPath(relativePath) {
  return path.basename(relativePath, '.md');
}

function safeFilename(raw) {
  return String(raw).replace(/[<>:"|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

function normalizeFolderPath(raw = '') {
  const relativePath = slash(raw).replace(/^\/+|\/+$/g, '').trim();
  if (!relativePath) return '';
  if (relativePath.includes('\0') || relativePath.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Unsafe folder path');
  }
  return relativePath;
}

function normalizeNotePath(raw = '') {
  let relativePath = slash(raw).replace(/^\/+/, '').trim();
  if (!relativePath) throw new Error('Missing note path');
  if (!relativePath.toLowerCase().endsWith('.md')) relativePath += '.md';
  if (relativePath.includes('\0') || relativePath.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Unsafe note path');
  }
  return relativePath;
}

function assertNoReparsePoints(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes vault');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fssync.lstatSync(current).isSymbolicLink()) {
        throw new Error('Vault paths cannot use symlinks or junctions');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function createPathResolver(vaultDir) {
  function resolveVaultPath(raw = '') {
    const relativePath = normalizeFolderPath(raw);
    const absolutePath = path.resolve(vaultDir, relativePath);
    if (absolutePath !== vaultDir && !absolutePath.startsWith(`${vaultDir}${path.sep}`)) throw new Error('Path escapes vault');
    assertNoReparsePoints(vaultDir, absolutePath);
    return { rel: relativePath, abs: absolutePath };
  }

  function resolveNotePath(raw) {
    const relativePath = normalizeNotePath(raw);
    const absolutePath = path.resolve(vaultDir, relativePath);
    if (absolutePath !== vaultDir && !absolutePath.startsWith(`${vaultDir}${path.sep}`)) throw new Error('Path escapes vault');
    assertNoReparsePoints(vaultDir, absolutePath);
    return { rel: relativePath, abs: absolutePath };
  }

  return { resolveVaultPath, resolveNotePath };
}

async function ensureVault(vaultDir) {
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'Daily Notes'), { recursive: true });
  const welcome = path.join(vaultDir, 'Welcome.md');
  try {
    await fs.writeFile(welcome, '# Welcome to Safire\n\nSafire is your privacy-focused, local-first Markdown workspace: warm, fast, portable, and yours.\n\n- Link notes with [[Ideas]]\n- Tag notes with #home or #projects\n- Use the graph view to see connections\n- Press Ctrl+K for the command palette\n- Press Ctrl+O for quick switcher\n- Press Ctrl+S to save\n\nCore note workflows stay on this computer. See PRIVACY.md for the network boundaries of optional features.\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const ideas = path.join(vaultDir, 'Ideas.md');
  try {
    await fs.writeFile(ideas, '# Ideas\n\nThis note links back to [[Welcome]].\n\n#ideas\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function walkMarkdown(root, directory = root) {
  const notes = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) notes.push(...await walkMarkdown(root, absolutePath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) notes.push(slash(path.relative(root, absolutePath)));
  }
  return notes.sort((left, right) => left.localeCompare(right));
}

function wikiLinkPath(rawTarget = '') {
  let target = slash(rawTarget).trim().replace(/^\/+/, '').replace(/^(?:\.\/)+/, '');
  if (!target || target.includes('\0')) return '';
  const parts = target.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  if (!/\.md$/i.test(target)) target += '.md';
  return target;
}

function addIndexValue(index, key, value) {
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}

function createWikiLinkResolver(notes) {
  const paths = new Map();
  const titles = new Map();
  for (const note of notes) {
    addIndexValue(paths, note.rel.toLowerCase(), note.rel);
    addIndexValue(titles, path.posix.basename(note.rel).replace(/\.md$/i, '').toLowerCase(), note.rel);
  }
  return (rawTarget) => {
    const normalizedPath = wikiLinkPath(rawTarget);
    const fallbackTarget = normalizedPath || wikiLinkPath(String(rawTarget).replace(/\.\./g, '')) || `${String(rawTarget).trim() || 'Untitled'}.md`;
    if (!normalizedPath) return { target: fallbackTarget, resolved: false };
    const exactMatches = paths.get(normalizedPath.toLowerCase()) || [];
    if (exactMatches.length === 1) return { target: exactMatches[0], resolved: true };
    if (!normalizedPath.includes('/')) {
      const titleMatches = titles.get(path.posix.basename(normalizedPath).replace(/\.md$/i, '').toLowerCase()) || [];
      if (titleMatches.length === 1) return { target: titleMatches[0], resolved: true };
    }
    return { target: normalizedPath, resolved: false };
  };
}

function evidenceSummary(receipts) {
  return {
    count: receipts.length,
    verified: receipts.filter((receipt) => receipt.status === 'verified').length,
    stale: receipts.filter((receipt) => receipt.status === 'stale').length,
    conflicting: receipts.filter((receipt) => receipt.status === 'conflicting').length,
    expired: receipts.filter((receipt) => receipt.expired).length,
  };
}

function safeCaptureTag(raw = '') {
  const tag = String(raw).trim().replace(/^#/, '');
  if (!tag) return '';
  if (!/^[A-Za-z0-9_/-]{1,80}$/.test(tag)) throw new Error('Capture tag contains unsupported characters');
  return tag;
}

export async function createNotesMcpService({ vaultDir: configuredVaultDir }) {
  const requestedVault = path.resolve(configuredVaultDir);
  await ensureVault(requestedVault);
  const vaultDir = await fs.realpath(requestedVault);
  const { resolveVaultPath, resolveNotePath } = createPathResolver(vaultDir);
  const noteMutator = createNoteMutator({ vaultDir });

  async function allNotesWithContent() {
    const notes = [];
    let remainingBytes = GRAPH_STORAGE_LIMITS.indexBytesPerOperation;
    for (const rel of await walkMarkdown(vaultDir)) {
      const { abs } = resolveNotePath(rel);
      const indexed = await readBoundedIndexNote(fs, abs, remainingBytes);
      remainingBytes = Math.max(0, remainingBytes - indexed.bytesConsumed);
      const semanticContent = indexed.contentOmitted ? '' : semanticMarkdownContent(indexed.content);
      notes.push({
        rel,
        content: indexed.content,
        contentOmitted: indexed.contentOmitted,
        title: titleFromPath(rel),
        folder: slash(path.dirname(rel)) === '.' ? '' : slash(path.dirname(rel)),
        size: indexed.stat.size,
        mtime: indexed.stat.mtimeMs,
        tags: parseTags(semanticContent),
        links: parseLinks(semanticContent),
      });
    }
    return notes;
  }

  async function noteMeta(rel, byteLimit = GRAPH_STORAGE_LIMITS.noteBytes) {
    const { abs } = resolveNotePath(rel);
    const indexed = await readBoundedIndexNote(fs, abs, byteLimit);
    const metadata = indexed.contentOmitted ? { tags: [], links: [], excerpt: '' } : publicNoteMetadata(indexed.content);
    return {
      note: {
        path: rel,
        title: titleFromPath(rel),
        folder: slash(path.dirname(rel)) === '.' ? '' : slash(path.dirname(rel)),
        size: indexed.stat.size,
        mtime: indexed.stat.mtimeMs,
        contentOmitted: indexed.contentOmitted,
        ...metadata,
      },
      bytesConsumed: indexed.bytesConsumed,
    };
  }

  return Object.freeze({
    async listNotes(query = '') {
      const normalizedQuery = String(query).toLowerCase().trim();
      if (!normalizedQuery) {
        const notes = [];
        let remainingBytes = GRAPH_STORAGE_LIMITS.indexBytesPerOperation;
        for (const rel of await walkMarkdown(vaultDir)) {
          const indexedMetadata = await noteMeta(rel, remainingBytes);
          const note = indexedMetadata.note;
          remainingBytes = Math.max(0, remainingBytes - indexedMetadata.bytesConsumed);
          notes.push(note);
        }
        return { vault: path.basename(vaultDir) || 'Safire Vault', notes };
      }
      const notes = await allNotesWithContent();
      const results = notes.map((note) => {
        const searchable = publicEvidenceContent(note.content);
        if (!note.rel.toLowerCase().includes(normalizedQuery) && !searchable.toLowerCase().includes(normalizedQuery)) return null;
        const receipts = parsePublicEvidenceReceipts(searchable, note.rel);
        return {
          path: note.rel,
          title: note.title,
          folder: note.folder,
          tags: parseTags(searchable),
          links: parseLinks(searchable),
          excerpt: excerpt(searchable),
          evidence: { ...evidenceSummary(receipts), receipts },
        };
      }).filter(Boolean);
      return {
        query: normalizedQuery,
        filters: { status: '', source: '', state: '', expired: false, from: null, to: null },
        results,
      };
    },

    async readNote(notePath) {
      const { rel, abs } = resolveNotePath(notePath || 'Welcome.md');
      const content = await fs.readFile(abs, 'utf8');
      const metadata = publicNoteMetadata(content);
      return { path: rel, title: titleFromPath(rel), content, tags: metadata.tags, links: metadata.links };
    },

    async createNote(notePath, content) {
      const wanted = notePath || 'Untitled';
      const safe = slash(safeFilename(wanted)).replace(/^\/+/, '') || 'Untitled';
      const { rel, abs } = resolveNotePath(safe);
      const initial = content ?? `# ${titleFromPath(rel)}\n\n`;
      await noteMutator.create(abs, initial);
      return { path: rel, content: initial };
    },

    async updateNote(notePath, content) {
      const { rel, abs } = resolveNotePath(notePath);
      const { backup } = await noteMutator.replace(abs, String(content ?? ''));
      return { ok: true, path: rel, backup };
    },

    async quickCapture(textValue, tagValue) {
      const text = String(textValue || '').trim();
      if (!text) throw new Error('Capture text is required');
      if (text.length > 10_000) throw new Error('Capture text is too long');
      const tag = safeCaptureTag(tagValue);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rel = `Inbox/${stamp}-${Math.random().toString(36).slice(2, 6)}.md`;
      const { abs } = resolveNotePath(rel);
      const content = `# Quick capture\n\n${text}\n${tag ? `\n#${tag}\n` : ''}`;
      await noteMutator.create(abs, content);
      return { path: rel, content };
    },

    async listTasks(state = 'open') {
      const normalizedState = ['open', 'completed', 'all'].includes(state) ? state : 'open';
      const tasks = (await allNotesWithContent()).flatMap((note) => parsePublicTasks(note.content, note.rel));
      const filtered = normalizedState === 'completed'
        ? tasks.filter((task) => task.completed)
        : normalizedState === 'all'
          ? tasks
          : tasks.filter((task) => !task.completed);
      filtered.sort((left, right) => Number(left.completed) - Number(right.completed) || left.path.localeCompare(right.path) || left.line - right.line);
      return { state: normalizedState, tasks: filtered };
    },

    async toggleTask(notePath, rawLine) {
      const { rel, abs } = resolveNotePath(notePath);
      const lineNumber = Number(rawLine);
      if (!Number.isInteger(lineNumber) || lineNumber < 1) throw new Error('Task line must be a positive integer');
      const { backup, value: task } = await noteMutator.mutate(abs, (current) => {
        const content = current.toString('utf8');
        if (!isPublicTaskLine(content, lineNumber)) throw new Error('No supported public task exists on that line');
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.replaceAll('\r', '').split('\n');
        const index = lineNumber - 1;
        const match = lines[index]?.match(/^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.*)$/);
        if (!match) throw new Error('No supported task exists on that line');
        lines[index] = `${match[1]}${match[2].toLowerCase() === 'x' ? ' ' : 'x'}${match[3]}${match[4]}`;
        const nextContent = lines.join(newline);
        return {
          content: nextContent,
          value: parsePublicTasks(lines.join('\n'), rel).find((candidate) => candidate.line === lineNumber),
        };
      }, { requireExisting: true });
      return { ok: true, task, backup };
    },

    async vaultHealth() {
      const notes = await allNotesWithContent();
      const resolveWikiLink = createWikiLinkResolver(notes);
      const missingLinks = [];
      const linkedTargets = new Set();
      for (const note of notes) {
        for (const link of note.links) {
          const resolution = resolveWikiLink(link);
          if (resolution.resolved) linkedTargets.add(resolution.target.toLowerCase());
          else missingLinks.push({ from: note.rel, target: link });
        }
      }
      const orphanNotes = notes
        .filter((note) => !linkedTargets.has(note.rel.toLowerCase()) && note.links.length === 0)
        .map((note) => note.rel);
      const backupRoot = resolveVaultPath('.safire-backups').abs;
      const backups = (await listContainedFiles(vaultDir, backupRoot))
        .filter((item) => item.relativePath.toLowerCase().endsWith('.bak'));
      return {
        noteCount: notes.length,
        tagCount: new Set(notes.flatMap((note) => note.tags)).size,
        linkCount: notes.reduce((sum, note) => sum + note.links.length, 0),
        missingLinks,
        orphanNotes,
        backupCount: backups.length,
      };
    },
  });
}
