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

function boundedResponseValue(value, seen = new Set()) {
  if (typeof value === 'string') {
    return value.length <= GRAPH_STORAGE_LIMITS.linkFieldCharacters
      && Buffer.byteLength(value, 'utf8') <= GRAPH_STORAGE_LIMITS.linkFieldBytes;
  }
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const valid = values.every(item => boundedResponseValue(item, seen));
  seen.delete(value);
  return valid;
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
      if (!Array.isArray(collection) || !boundedResponseValue(value)) {
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
