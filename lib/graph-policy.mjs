import path from 'node:path';

const KIBIBYTE = 1_024;

export const GRAPH_STORAGE_LIMITS = Object.freeze({
  notes: 1_000,
  links: 2_000,
  observedLinks: 4_000,
  tagsPerNote: 32,
  noteBytes: 1_024 * KIBIBYTE,
  indexBytesPerOperation: 16 * 1_024 * KIBIBYTE,
  linkFieldCharacters: 1_024,
  linkFieldBytes: 2 * KIBIBYTE,
  responseBytes: 2 * 1_024 * KIBIBYTE,
  responseReserveBytes: 16 * KIBIBYTE,
});

export const GENERIC_INDEX_LIMITS = Object.freeze({
  notes: GRAPH_STORAGE_LIMITS.notes,
  directories: 2_000,
  directoryDepth: 64,
  directoryEntries: 10_000,
  searchResults: 1_000,
  backups: 1_000,
  backupMetadataBytes: 256 * KIBIBYTE,
  tasks: 2_000,
  tagsPerNote: GRAPH_STORAGE_LIMITS.tagsPerNote,
  tagsPerOperation: 4_000,
  linksPerNote: 128,
  linkObservationsPerOperation: GRAPH_STORAGE_LIMITS.observedLinks,
  evidenceReceiptsPerNote: 64,
  evidenceReceiptsPerOperation: 1_000,
  missingLinks: 2_000,
  noteBytes: GRAPH_STORAGE_LIMITS.noteBytes,
  indexBytesPerOperation: GRAPH_STORAGE_LIMITS.indexBytesPerOperation,
  fieldCharacters: GRAPH_STORAGE_LIMITS.linkFieldCharacters,
  fieldBytes: GRAPH_STORAGE_LIMITS.linkFieldBytes,
  responseBytes: GRAPH_STORAGE_LIMITS.responseBytes,
  responseReserveBytes: 64 * KIBIBYTE,
});

export function indexNoteReadPolicy(size) {
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { readContent: false, contentOmitted: true, reason: 'invalid-size' };
  if (bytes > GRAPH_STORAGE_LIMITS.noteBytes) return { readContent: false, contentOmitted: true, reason: 'note-byte-limit' };
  return { readContent: true, contentOmitted: false, reason: '' };
}

function sameFileSnapshot(left, right) {
  return Boolean(
    left
    && right
    && left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  );
}

/**
 * Reads an indexable note through an opened handle with a hard allocation cap.
 * Growth, truncation, replacement, and oversized files are represented as an
 * omitted body; explicit note-read APIs deliberately do not use this helper.
 */
export async function readBoundedIndexNote(fsApi, absolutePath, requestedByteLimit = GRAPH_STORAGE_LIMITS.noteBytes) {
  const handle = await fsApi.open(absolutePath, 'r');
  try {
    const before = await handle.stat();
    const policy = indexNoteReadPolicy(before.size);
    const byteLimit = Number.isSafeInteger(requestedByteLimit) && requestedByteLimit >= 0
      ? Math.min(requestedByteLimit, GRAPH_STORAGE_LIMITS.noteBytes)
      : GRAPH_STORAGE_LIMITS.noteBytes;
    if (!before.isFile() || !policy.readContent || before.size > byteLimit) {
      const reason = !before.isFile()
        ? 'not-a-file'
        : !policy.readContent
          ? policy.reason
          : 'operation-byte-limit';
      return { stat: before, content: '', contentOmitted: true, reason, bytesConsumed: 0 };
    }

    const expectedBytes = Number(before.size);
    const buffer = Buffer.alloc(expectedBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const current = await fsApi.lstat(absolutePath);
    if (bytesRead !== expectedBytes || !sameFileSnapshot(before, after) || !sameFileSnapshot(after, current)) {
      return { stat: after, content: '', contentOmitted: true, reason: 'changed-during-read', bytesConsumed: expectedBytes };
    }
    return {
      stat: after,
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      contentOmitted: false,
      reason: '',
      bytesConsumed: expectedBytes,
    };
  } finally {
    await handle.close();
  }
}

export function selectGraphNotePaths(notePaths, activePath = '') {
  const ordered = Array.isArray(notePaths) ? notePaths : [];
  const selected = ordered.slice(0, GRAPH_STORAGE_LIMITS.notes);
  if (!activePath || selected.includes(activePath) || !ordered.includes(activePath)) return selected;
  selected[selected.length - 1] = activePath;
  return selected.sort((left, right) => left.localeCompare(right));
}

/**
 * Streams a bounded generic-index view of a vault. The +1 observation is a
 * truncation sentinel, not a path retained for later processing. An explicitly
 * requested active note may be seeded by callers after their normal path and
 * file checks so it remains available even when the ordinary page is full.
 */
export async function collectBoundedMarkdownPaths(fsApi, rootPath, options = {}) {
  const maximumNotes = Number.isInteger(options.limit) && options.limit >= 0
    ? Math.min(options.limit, GENERIC_INDEX_LIMITS.notes)
    : GENERIC_INDEX_LIMITS.notes;
  const maximumDirectories = Number.isInteger(options.directoryLimit) && options.directoryLimit >= 0
    ? Math.min(options.directoryLimit, GENERIC_INDEX_LIMITS.directories)
    : GENERIC_INDEX_LIMITS.directories;
  const maximumEntries = Number.isInteger(options.entryLimit) && options.entryLimit >= 0
    ? Math.min(options.entryLimit, GENERIC_INDEX_LIMITS.directoryEntries)
    : GENERIC_INDEX_LIMITS.directoryEntries;
  const maximumDepth = Number.isInteger(options.depthLimit) && options.depthLimit >= 0
    ? Math.min(options.depthLimit, GENERIC_INDEX_LIMITS.directoryDepth)
    : GENERIC_INDEX_LIMITS.directoryDepth;
  const root = path.resolve(rootPath);
  const paths = [];
  const directoryPaths = [];
  const retained = new Map();
  let retainedPathBytes = 0;
  let retainedDirectoryPathBytes = 0;
  let observedNotes = 0;
  let observedDirectories = maximumDirectories > 0 ? 1 : 0;
  let observedEntries = 0;
  let omittedPaths = 0;
  let complete = maximumNotes > 0 && maximumDirectories > 0 && maximumEntries > 0;
  let stopped = maximumNotes === 0 || maximumDirectories === 0 || maximumEntries === 0;

  const normalizeRelativePath = (value) => String(value).replace(/\\/g, '/').replace(/^\/+/, '');
  const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  let preferredKey = '';
  let canonicalPreferredPath = '';
  const retain = (relativePath, canonical = false) => {
    const key = pathKey(relativePath);
    if (retained.has(key)) {
      if (canonical) {
        const index = retained.get(key);
        const previous = paths[index];
        const nextBytes = Buffer.byteLength(relativePath, 'utf8');
        const previousBytes = Buffer.byteLength(previous, 'utf8');
        if (isBoundedIndexValue(relativePath)
          && retainedPathBytes - previousBytes + nextBytes <= GENERIC_INDEX_LIMITS.responseBytes) {
          paths[index] = relativePath;
          retainedPathBytes += nextBytes - previousBytes;
          if (key === preferredKey) canonicalPreferredPath = relativePath;
        }
      }
      return;
    }
    const pathBytes = Buffer.byteLength(relativePath, 'utf8');
    if (!isBoundedIndexValue(relativePath)
      || retainedPathBytes + pathBytes > GENERIC_INDEX_LIMITS.responseBytes) {
      omittedPaths += 1;
      complete = false;
      return;
    }
    if (paths.length >= maximumNotes) {
      complete = false;
      return;
    }
    retained.set(key, paths.length);
    paths.push(relativePath);
    retainedPathBytes += pathBytes;
  };

  const preferredPath = normalizeRelativePath(options.preferredPath || '');
  preferredKey = pathKey(preferredPath);
  if (preferredPath && maximumNotes > 0) {
    const preferredAbsolute = path.resolve(root, preferredPath);
    const relative = path.relative(root, preferredAbsolute);
    if (preferredAbsolute !== root
      && !relative.startsWith('..')
      && !path.isAbsolute(relative)
      && preferredPath.toLowerCase().endsWith('.md')) {
      // The caller must have already applied its normal containment, reparse-
      // point, existence, and file checks. Repeating raw path traversal here
      // would bypass that policy and introduce another check/use boundary.
      observedNotes = 1;
      retain(preferredPath);
      canonicalPreferredPath = preferredPath;
    }
  }

  const pendingDirectories = [{ directory: root, depth: 0 }];
  while (pendingDirectories.length > 0 && !stopped) {
    const { directory, depth } = pendingDirectories.pop();
    const handle = await fsApi.opendir(directory);
    for await (const entry of handle) {
      if (stopped) break;
      observedEntries += 1;
      if (observedEntries > maximumEntries) {
        complete = false;
        stopped = true;
        break;
      }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        observedDirectories += 1;
        if (observedDirectories > maximumDirectories) {
          complete = false;
          stopped = true;
          break;
        }
        const relativeDirectory = normalizeRelativePath(path.relative(root, absolutePath));
        if (depth >= maximumDepth || !isBoundedIndexValue(relativeDirectory)) {
          complete = false;
          continue;
        }
        const directoryBytes = Buffer.byteLength(relativeDirectory, 'utf8');
        if (retainedDirectoryPathBytes + directoryBytes <= GENERIC_INDEX_LIMITS.responseBytes) {
          directoryPaths.push(relativeDirectory);
          retainedDirectoryPathBytes += directoryBytes;
        } else {
          complete = false;
        }
        pendingDirectories.push({ directory: absolutePath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      const key = pathKey(relativePath);
      if (retained.has(key)) {
        retain(relativePath, true);
        continue;
      }
      observedNotes += 1;
      if (observedNotes > maximumNotes) {
        complete = false;
        stopped = true;
        break;
      }
      retain(relativePath);
    }
  }
  paths.sort((left, right) => left.localeCompare(right));
  directoryPaths.sort((left, right) => left.localeCompare(right));
  return {
    paths,
    directoryPaths,
    preferredPath: canonicalPreferredPath,
    observedNotes,
    observedDirectories: Math.min(observedDirectories, maximumDirectories + 1),
    observedEntries: Math.min(observedEntries, maximumEntries + 1),
    omittedPaths,
    complete,
  };
}

function boundedSegment(content, start, end) {
  while (start < end && /\s/.test(content[start])) start += 1;
  while (end > start && /\s/.test(content[end - 1])) end -= 1;
  const characters = end - start;
  if (characters <= 0 || characters > GRAPH_STORAGE_LIMITS.linkFieldCharacters) return null;
  const value = content.slice(start, end);
  return Buffer.byteLength(value, 'utf8') <= GRAPH_STORAGE_LIMITS.linkFieldBytes ? value : null;
}

/**
 * Scans graph wiki links without first capturing an attacker-controlled target
 * or alias. Oversized/malformed links count as observations but are omitted.
 */
export function scanBoundedGraphWikiLinks(rawContent = '', requestedObservationLimit = GRAPH_STORAGE_LIMITS.observedLinks) {
  const content = String(rawContent);
  const observationLimit = Number.isSafeInteger(requestedObservationLimit) && requestedObservationLimit >= 0
    ? Math.min(requestedObservationLimit, GRAPH_STORAGE_LIMITS.observedLinks)
    : GRAPH_STORAGE_LIMITS.observedLinks;
  if (Buffer.byteLength(content, 'utf8') > GRAPH_STORAGE_LIMITS.noteBytes) {
    return { targets: [], observed: 0, omitted: 1, complete: false, observationsComplete: false };
  }
  const targets = [];
  let observed = 0;
  let omitted = 0;
  let observationsComplete = true;
  let offset = 0;
  while (offset < content.length) {
    const opening = content.indexOf('[[', offset);
    if (opening < 0) break;
    observed += 1;
    if (observed > observationLimit) {
      observationsComplete = false;
      break;
    }

    const maximumSyntaxCharacters = GRAPH_STORAGE_LIMITS.linkFieldCharacters * 2 + 256;
    let closing = -1;
    const scanEnd = Math.min(content.length - 1, opening + 2 + maximumSyntaxCharacters);
    for (let index = opening + 2; index < scanEnd; index += 1) {
      if (content[index] === ']' && content[index + 1] === ']') {
        closing = index;
        break;
      }
    }
    if (closing < 0) {
      omitted += 1;
      const eventualClose = content.indexOf(']]', scanEnd);
      offset = eventualClose < 0 ? content.length : eventualClose + 2;
      continue;
    }

    let targetEnd = closing;
    let labelStart = -1;
    for (let index = opening + 2; index < closing; index += 1) {
      if (content[index] === '|' && labelStart < 0) {
        targetEnd = Math.min(targetEnd, index);
        labelStart = index + 1;
      } else if (content[index] === '#' && labelStart < 0) {
        targetEnd = Math.min(targetEnd, index);
      }
    }
    const target = boundedSegment(content, opening + 2, targetEnd);
    const label = labelStart < 0 ? '' : boundedSegment(content, labelStart, closing);
    if (!target || (labelStart >= 0 && !label)) omitted += 1;
    else targets.push(target);
    offset = closing + 2;
  }
  return {
    targets,
    observed: Math.min(observed, observationLimit),
    omitted,
    complete: omitted === 0 && observationsComplete,
    observationsComplete,
  };
}

export function scanBoundedIndexWikiLinks(
  rawContent = '',
  requestedLinkLimit = GENERIC_INDEX_LIMITS.linksPerNote,
  requestedObservationLimit = GENERIC_INDEX_LIMITS.linkObservationsPerOperation,
) {
  const linkLimit = Number.isInteger(requestedLinkLimit) && requestedLinkLimit >= 0
    ? Math.min(requestedLinkLimit, GENERIC_INDEX_LIMITS.linksPerNote)
    : GENERIC_INDEX_LIMITS.linksPerNote;
  const observationLimit = Number.isInteger(requestedObservationLimit) && requestedObservationLimit >= 0
    ? Math.min(requestedObservationLimit, GENERIC_INDEX_LIMITS.linkObservationsPerOperation)
    : GENERIC_INDEX_LIMITS.linkObservationsPerOperation;
  const scanned = scanBoundedGraphWikiLinks(rawContent, observationLimit);
  const links = [];
  const unique = new Set();
  let omitted = scanned.omitted;
  for (const target of scanned.targets) {
    if (unique.has(target)) continue;
    unique.add(target);
    if (links.length >= linkLimit) {
      omitted += 1;
      continue;
    }
    links.push(target);
  }
  return {
    links,
    observed: scanned.observed,
    omitted,
    complete: scanned.complete && omitted === 0,
    observationsComplete: scanned.observationsComplete,
  };
}

export function isBoundedIndexValue(value, seen = new Set()) {
  if (typeof value === 'string') {
    return value.length <= GENERIC_INDEX_LIMITS.fieldCharacters
      && Buffer.byteLength(value, 'utf8') <= GENERIC_INDEX_LIMITS.fieldBytes;
  }
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const valid = values.every(item => isBoundedIndexValue(item, seen));
  seen.delete(value);
  return valid;
}

function responseItemBytes(value, pretty) {
  const serialized = JSON.stringify(value, null, pretty ? 2 : undefined);
  if (typeof serialized !== 'string') return Number.POSITIVE_INFINITY;
  let bytes = Buffer.byteLength(serialized, 'utf8') + 2;
  if (pretty) {
    const lines = serialized.split('\n').length;
    // The item will be nested in a top-level response array. Eight bytes per
    // line safely cover the added indentation plus comma/newline delimiters.
    bytes += lines * 8;
  }
  return bytes;
}

export function createIndexResponseBudget(options = {}) {
  const pretty = options.pretty === true;
  const requestedLimit = Number(options.limit);
  const maximum = Number.isSafeInteger(requestedLimit) && requestedLimit > GENERIC_INDEX_LIMITS.responseReserveBytes
    ? Math.min(requestedLimit, GENERIC_INDEX_LIMITS.responseBytes)
    : GENERIC_INDEX_LIMITS.responseBytes;
  let bytes = GENERIC_INDEX_LIMITS.responseReserveBytes;
  let truncated = false;
  const tryConsume = (value) => {
    if (!isBoundedIndexValue(value)) {
      truncated = true;
      return false;
    }
    const itemBytes = responseItemBytes(value, pretty);
    if (!Number.isSafeInteger(itemBytes) || bytes + itemBytes > maximum) {
      truncated = true;
      return false;
    }
    bytes += itemBytes;
    return true;
  };
  return {
    get bytes() { return bytes; },
    get truncated() { return truncated; },
    markTruncated() { truncated = true; },
    tryConsume,
    tryAppend(collection, value) {
      if (!Array.isArray(collection)) {
        truncated = true;
        return false;
      }
      if (!tryConsume(value)) return false;
      collection.push(value);
      return true;
    },
  };
}

export function finalizeIndexResponse(payload, options = {}) {
  const pretty = options.pretty === true;
  const maximum = Number.isSafeInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, GENERIC_INDEX_LIMITS.responseBytes)
    : GENERIC_INDEX_LIMITS.responseBytes;
  if (!payload || typeof payload !== 'object' || !payload.meta || typeof payload.meta !== 'object') {
    throw new Error('Generic index response metadata is required');
  }
  payload.meta.responseBytes = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const measured = Buffer.byteLength(JSON.stringify(payload, null, pretty ? 2 : undefined), 'utf8');
    if (payload.meta.responseBytes === measured) break;
    payload.meta.responseBytes = measured;
  }
  const measured = Buffer.byteLength(JSON.stringify(payload, null, pretty ? 2 : undefined), 'utf8');
  if (payload.meta.responseBytes !== measured) payload.meta.responseBytes = measured;
  if (measured > maximum) throw new Error('Generic index response exceeded the safe byte limit');
  return payload;
}

export function createGraphResponseBudget(limit = GRAPH_STORAGE_LIMITS.responseBytes) {
  const maximum = Number.isSafeInteger(limit) && limit > GRAPH_STORAGE_LIMITS.responseReserveBytes
    ? Math.min(limit, GRAPH_STORAGE_LIMITS.responseBytes)
    : GRAPH_STORAGE_LIMITS.responseBytes;
  let bytes = GRAPH_STORAGE_LIMITS.responseReserveBytes;
  let truncated = false;
  return {
    get bytes() { return bytes; },
    get truncated() { return truncated; },
    tryAppend(collection, value) {
      if (!Array.isArray(collection) || !isBoundedIndexValue(value)) {
        truncated = true;
        return false;
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
      if (bytes + itemBytes > maximum) {
        truncated = true;
        return false;
      }
      collection.push(value);
      bytes += itemBytes;
      return true;
    },
  };
}
