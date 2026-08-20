import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {
  assertUserMutationPath,
  createNoteMutator,
  listContainedFilesBounded,
} from './note-mutations.mjs';
import {
  GENERIC_INDEX_LIMITS,
  collectBoundedMarkdownPaths,
  createIndexResponseBudget,
  finalizeIndexResponse,
  isBoundedIndexValue,
  readBoundedIndexNote,
  scanBoundedIndexWikiLinks,
} from './graph-policy.mjs';
import {
  excerpt,
  genericIndexContent,
  isPublicTaskLine,
  parsePublicEvidenceReceipts,
  parsePublicTasks,
  parseTags,
  publicNoteMetadata,
} from './note-projection.mjs';
import vaultConfig from '../vault-config.cjs';

const { initializeVault } = vaultConfig;

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

function createIndexOperationState() {
  return {
    remainingTags: GENERIC_INDEX_LIMITS.tagsPerOperation,
    remainingLinkObservations: GENERIC_INDEX_LIMITS.linkObservationsPerOperation,
    contentOmitted: 0,
    metadataOmitted: 0,
  };
}

function boundedIndexMetadata(content, state) {
  const publicContent = genericIndexContent(content);
  let complete = true;

  const tagLimit = Math.min(GENERIC_INDEX_LIMITS.tagsPerNote, state.remainingTags);
  const tagCandidates = tagLimit > 0 ? parseTags(publicContent, tagLimit + 1) : [];
  const observedTags = Math.min(tagCandidates.length, tagLimit);
  state.remainingTags = Math.max(0, state.remainingTags - observedTags);
  let tags = tagCandidates.slice(0, tagLimit);
  if (tagCandidates.length > tagLimit || (tagLimit === 0 && publicContent.length > 0)) complete = false;
  const boundedTags = tags.filter(tag => isBoundedIndexValue(tag));
  if (boundedTags.length !== tags.length) complete = false;
  tags = boundedTags;

  const linkLimit = Math.min(GENERIC_INDEX_LIMITS.linksPerNote, state.remainingLinkObservations);
  const linkScan = linkLimit > 0
    ? scanBoundedIndexWikiLinks(publicContent, linkLimit, state.remainingLinkObservations)
    : { links: [], observed: 0, complete: publicContent.length === 0 };
  state.remainingLinkObservations = Math.max(0, state.remainingLinkObservations - linkScan.observed);
  if (!linkScan.complete) complete = false;
  if (!complete) state.metadataOmitted += 1;
  return { tags, links: linkScan.links, excerpt: excerpt(publicContent), complete };
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
  const vaultDir = initializeVault(requestedVault);
  const { resolveVaultPath, resolveNotePath } = createPathResolver(vaultDir);
  const noteMutator = createNoteMutator({ vaultDir });

  function resolveUserMutationNotePath(raw) {
    const resolved = resolveNotePath(raw);
    assertUserMutationPath(vaultDir, resolved.abs);
    return resolved;
  }

  const collectIndexPaths = () => collectBoundedMarkdownPaths(fs, vaultDir);

  async function allNotesWithContent() {
    const discovery = await collectIndexPaths();
    const notes = [];
    const state = createIndexOperationState();
    let remainingBytes = GENERIC_INDEX_LIMITS.indexBytesPerOperation;
    for (const rel of discovery.paths) {
      const { abs } = resolveNotePath(rel);
      const indexed = await readBoundedIndexNote(fs, abs, remainingBytes);
      remainingBytes = Math.max(0, remainingBytes - indexed.bytesConsumed);
      let metadata;
      if (indexed.contentOmitted) {
        state.contentOmitted += 1;
        state.metadataOmitted += 1;
        metadata = { tags: [], links: [], complete: false };
      } else {
        metadata = boundedIndexMetadata(indexed.content, state);
      }
      notes.push({
        rel,
        content: indexed.content,
        contentOmitted: indexed.contentOmitted,
        title: titleFromPath(rel),
        folder: slash(path.dirname(rel)) === '.' ? '' : slash(path.dirname(rel)),
        size: indexed.stat.size,
        mtime: indexed.stat.mtimeMs,
        metadataOmitted: !metadata.complete,
        tags: metadata.tags,
        links: metadata.links,
      });
    }
    return { notes, discovery, state };
  }

  async function noteMeta(rel, byteLimit = GENERIC_INDEX_LIMITS.noteBytes, state = createIndexOperationState()) {
    const { abs } = resolveNotePath(rel);
    const indexed = await readBoundedIndexNote(fs, abs, byteLimit);
    let metadata;
    if (indexed.contentOmitted) {
      state.contentOmitted += 1;
      state.metadataOmitted += 1;
      metadata = { tags: [], links: [], excerpt: '', complete: false };
    } else {
      metadata = boundedIndexMetadata(indexed.content, state);
    }
    return {
      note: {
        path: rel,
        title: titleFromPath(rel),
        folder: slash(path.dirname(rel)) === '.' ? '' : slash(path.dirname(rel)),
        size: indexed.stat.size,
        mtime: indexed.stat.mtimeMs,
        contentOmitted: indexed.contentOmitted,
        metadataOmitted: !metadata.complete,
        tags: metadata.tags,
        links: metadata.links,
        excerpt: metadata.excerpt,
      },
      bytesConsumed: indexed.bytesConsumed,
    };
  }

  return Object.freeze({
    async listNotes(query = '') {
      const normalizedQuery = String(query).toLowerCase().trim();
      if (!isBoundedIndexValue(normalizedQuery)) throw new Error('Search query is too long');
      if (!normalizedQuery) {
        const discovery = await collectIndexPaths();
        const state = createIndexOperationState();
        const responseBudget = createIndexResponseBudget({ pretty: true });
        const notes = [];
        let remainingBytes = GENERIC_INDEX_LIMITS.indexBytesPerOperation;
        let responseMetadataOmitted = 0;
        for (const rel of discovery.paths) {
          const indexedMetadata = await noteMeta(rel, remainingBytes, state);
          const note = indexedMetadata.note;
          remainingBytes = Math.max(0, remainingBytes - indexedMetadata.bytesConsumed);
          if (responseBudget.tryAppend(notes, note)) continue;
          const statOnly = { ...note, metadataOmitted: true, tags: [], links: [], excerpt: '' };
          if (responseBudget.tryAppend(notes, statOnly)) responseMetadataOmitted += 1;
        }
        const payload = {
          vault: path.basename(vaultDir) || 'Safire Vault',
          notes,
          meta: {
            observedNotes: discovery.observedNotes,
            indexComplete: discovery.complete && state.contentOmitted === 0 && state.metadataOmitted === 0,
            returnedNotes: notes.length,
            contentOmitted: state.contentOmitted,
            metadataOmitted: state.metadataOmitted + responseMetadataOmitted,
            responseBytes: 0,
            truncated: !discovery.complete
              || state.contentOmitted > 0
              || state.metadataOmitted > 0
              || responseBudget.truncated,
          },
        };
        return finalizeIndexResponse(payload, { pretty: true });
      }
      const indexed = await allNotesWithContent();
      const responseBudget = createIndexResponseBudget({ pretty: true });
      const results = [];
      let observedEvidence = 0;
      let evidenceComplete = true;
      for (const note of indexed.notes) {
        const searchable = genericIndexContent(note.content);
        if (!note.rel.toLowerCase().includes(normalizedQuery) && !searchable.toLowerCase().includes(normalizedQuery)) continue;
        const remainingEvidence = GENERIC_INDEX_LIMITS.evidenceReceiptsPerOperation - observedEvidence;
        const receiptLimit = Math.min(GENERIC_INDEX_LIMITS.evidenceReceiptsPerNote, remainingEvidence);
        const receiptCandidates = receiptLimit > 0
          ? parsePublicEvidenceReceipts(note.content, note.rel, { limit: receiptLimit + 1 })
          : [];
        if (receiptCandidates.length > receiptLimit || (receiptLimit === 0 && searchable.length > 0)) evidenceComplete = false;
        observedEvidence += Math.min(receiptCandidates.length, receiptLimit);
        const receipts = receiptCandidates.slice(0, receiptLimit).filter(receipt => {
          const bounded = isBoundedIndexValue(receipt);
          if (!bounded) evidenceComplete = false;
          return bounded;
        });
        const result = {
          path: note.rel,
          title: note.title,
          folder: note.folder,
          contentOmitted: note.contentOmitted,
          metadataOmitted: note.metadataOmitted,
          tags: note.tags,
          links: note.links,
          excerpt: excerpt(searchable),
          evidence: { ...evidenceSummary(receipts), receipts },
        };
        if (responseBudget.tryAppend(results, result)) continue;
        const minimal = { ...result, metadataOmitted: true, tags: [], links: [], evidence: { ...evidenceSummary([]), receipts: [] } };
        if (!responseBudget.tryAppend(results, minimal)) break;
      }
      const payload = {
        query: normalizedQuery,
        filters: { status: '', source: '', state: '', expired: false, from: null, to: null },
        results,
        meta: {
          observedNotes: indexed.discovery.observedNotes,
          indexComplete: indexed.discovery.complete
            && indexed.state.contentOmitted === 0
            && indexed.state.metadataOmitted === 0,
          returnedResults: results.length,
          contentOmitted: indexed.state.contentOmitted,
          metadataOmitted: indexed.state.metadataOmitted,
          observedEvidence,
          evidenceComplete,
          responseBytes: 0,
          truncated: !indexed.discovery.complete
            || indexed.state.contentOmitted > 0
            || indexed.state.metadataOmitted > 0
            || !evidenceComplete
            || responseBudget.truncated,
        },
      };
      return finalizeIndexResponse(payload, { pretty: true });
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
      const { rel, abs } = resolveUserMutationNotePath(safe);
      const initial = content ?? `# ${titleFromPath(rel)}\n\n`;
      await noteMutator.create(abs, initial);
      return { path: rel, content: initial };
    },

    async updateNote(notePath, content) {
      const { rel, abs } = resolveUserMutationNotePath(notePath);
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
      const { abs } = resolveUserMutationNotePath(rel);
      const content = `# Quick capture\n\n${text}\n${tag ? `\n#${tag}\n` : ''}`;
      await noteMutator.create(abs, content);
      return { path: rel, content };
    },

    async listTasks(state = 'open') {
      const normalizedState = ['open', 'completed', 'all'].includes(state) ? state : 'open';
      const indexed = await allNotesWithContent();
      const responseBudget = createIndexResponseBudget({ pretty: true });
      const tasks = [];
      let observedTasks = 0;
      let tasksComplete = true;
      for (const note of indexed.notes) {
        const remainingTasks = GENERIC_INDEX_LIMITS.tasks - observedTasks;
        if (remainingTasks <= 0) {
          tasksComplete = false;
          break;
        }
        const candidates = parsePublicTasks(note.content, note.rel, { limit: remainingTasks + 1 });
        if (candidates.length > remainingTasks) tasksComplete = false;
        for (const task of candidates.slice(0, remainingTasks)) {
          observedTasks += 1;
          const matchesState = normalizedState === 'completed'
            ? task.completed
            : normalizedState === 'all' || !task.completed;
          if (!matchesState) continue;
          if (!responseBudget.tryAppend(tasks, task)) tasksComplete = false;
        }
        if (!tasksComplete && (observedTasks >= GENERIC_INDEX_LIMITS.tasks || responseBudget.truncated)) break;
      }
      tasks.sort((left, right) => Number(left.completed) - Number(right.completed) || left.path.localeCompare(right.path) || left.line - right.line);
      const payload = {
        state: normalizedState,
        tasks,
        meta: {
          observedNotes: indexed.discovery.observedNotes,
          indexComplete: indexed.discovery.complete && indexed.state.contentOmitted === 0,
          observedTasks,
          tasksComplete: tasksComplete && indexed.discovery.complete && indexed.state.contentOmitted === 0,
          returnedTasks: tasks.length,
          contentOmitted: indexed.state.contentOmitted,
          responseBytes: 0,
          truncated: !tasksComplete
            || !indexed.discovery.complete
            || indexed.state.contentOmitted > 0
            || responseBudget.truncated,
        },
      };
      return finalizeIndexResponse(payload, { pretty: true });
    },

    async toggleTask(notePath, rawLine) {
      const { rel, abs } = resolveUserMutationNotePath(notePath);
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
      const indexed = await allNotesWithContent();
      const resolveWikiLink = createWikiLinkResolver(indexed.notes);
      const responseBudget = createIndexResponseBudget({ pretty: true });
      const missingLinks = [];
      const linkedTargets = new Set();
      for (const note of indexed.notes) {
        for (const link of note.links) {
          const resolution = resolveWikiLink(link);
          if (resolution.resolved) linkedTargets.add(resolution.target.toLowerCase());
          else if (missingLinks.length < GENERIC_INDEX_LIMITS.missingLinks) {
            responseBudget.tryAppend(missingLinks, { from: note.rel, target: link });
          } else {
            responseBudget.markTruncated();
          }
        }
      }
      const orphanNotes = [];
      for (const note of indexed.notes) {
        if (linkedTargets.has(note.rel.toLowerCase()) || note.links.length > 0) continue;
        responseBudget.tryAppend(orphanNotes, note.rel);
      }
      const backupRoot = resolveVaultPath('.safire-backups').abs;
      const backupDiscovery = await listContainedFilesBounded(vaultDir, backupRoot, {
        fileLimit: GENERIC_INDEX_LIMITS.backups,
        directoryLimit: GENERIC_INDEX_LIMITS.directories,
        entryLimit: GENERIC_INDEX_LIMITS.directoryEntries,
        depthLimit: GENERIC_INDEX_LIMITS.directoryDepth,
        fieldCharacters: GENERIC_INDEX_LIMITS.fieldCharacters,
        fieldBytes: GENERIC_INDEX_LIMITS.fieldBytes,
        includeFile: relativePath => relativePath.toLowerCase().endsWith('.bak'),
      });
      const payload = {
        noteCount: indexed.notes.length,
        tagCount: new Set(indexed.notes.flatMap((note) => note.tags)).size,
        linkCount: indexed.notes.reduce((sum, note) => sum + note.links.length, 0),
        missingLinks,
        orphanNotes,
        backupCount: backupDiscovery.observedFiles,
        meta: {
          observedNotes: indexed.discovery.observedNotes,
          indexComplete: indexed.discovery.complete
            && indexed.state.contentOmitted === 0
            && indexed.state.metadataOmitted === 0,
          contentOmitted: indexed.state.contentOmitted,
          metadataOmitted: indexed.state.metadataOmitted,
          backupsComplete: backupDiscovery.complete,
          responseBytes: 0,
          truncated: !indexed.discovery.complete
            || indexed.state.contentOmitted > 0
            || indexed.state.metadataOmitted > 0
            || !backupDiscovery.complete
            || responseBudget.truncated,
        },
      };
      return finalizeIndexResponse(payload, { pretty: true });
    },
  });
}
