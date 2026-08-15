const PUBLIC_EVIDENCE_FIELDS = new Set([
  'id',
  'claim',
  'label',
  'source_type',
  'source',
  'source_url_or_path',
  'observed_at',
  'action',
  'action_performed',
  'verification',
  'predicate',
  'test',
  'status',
  'freshness',
  'expires_at',
  'excerpt',
  'evidence_excerpt',
  'hash',
  'sha256',
]);

const MAPPING_FIELD = /^([ \t]*)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;
const BLOCK_SCALAR = /^[ \t]*[|>](?:(?:[1-9][+-]?)|(?:[+-][1-9]?)|[+-])?[ \t]*(?:#.*)?$/;

function indentationWidth(value = '') {
  return String(value).replace(/\t/g, '    ').length;
}

function validInlineScalar(raw = '') {
  const value = String(raw).trim();
  if (!value || !['"', "'"].includes(value[0])) return true;
  const quote = value[0];
  for (let index = 1; index < value.length; index += 1) {
    if (quote === '"' && value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] !== quote) continue;
    if (quote === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    return /^[ \t]*(?:#.*)?$/.test(value.slice(index + 1));
  }
  return false;
}

function quotedLinePrefix(line = '') {
  let cursor = 0;
  let quotePrefix = '';
  let quoteDepth = 0;
  while (cursor < line.length) {
    const marker = line.slice(cursor).match(/^[ \t]{0,3}>[ \t]?/);
    if (!marker) break;
    quotePrefix += marker[0];
    cursor += marker[0].length;
    quoteDepth += 1;
  }
  return { quotePrefix, quoteDepth, remainder: line.slice(cursor) };
}

function stripQuoteDepth(line = '', quoteDepth = 0) {
  let cursor = 0;
  for (let depth = 0; depth < quoteDepth; depth += 1) {
    const marker = line.slice(cursor).match(/^[ \t]{0,3}>[ \t]?/);
    if (!marker) return null;
    cursor += marker[0].length;
  }
  return line.slice(cursor);
}

function openingFence(line = '') {
  const container = quotedLinePrefix(line);
  const opening = container.remainder.match(/^([ \t]*)(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/);
  if (!opening) return null;
  return {
    ...container,
    fenceIndent: opening[1],
    fence: opening[2],
    fenceCharacter: opening[2][0],
    fenceLength: opening[2].length,
    info: opening[3].trim(),
  };
}

function closesFence(line = '', opening) {
  const remainder = stripQuoteDepth(line, opening.quoteDepth);
  if (remainder === null) return false;
  const closing = remainder.match(/^[ \t]*(`+|~+)[ \t]*$/);
  return Boolean(
    closing
    && closing[1][0] === opening.fenceCharacter
    && closing[1].length >= opening.fenceLength
  );
}

function publicEvidenceBody(body = '', newline = '\n') {
  const lines = String(body).split(/\r?\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  const firstField = lines.find(line => line.trim() && !/^[ \t]*#/.test(line));
  const firstMatch = firstField?.match(MAPPING_FIELD);
  if (!firstMatch) return '';
  const rootIndent = indentationWidth(firstMatch[1]);
  const visible = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim() || /^[ \t]*#/.test(line)) {
      index += 1;
      continue;
    }
    const match = line.match(MAPPING_FIELD);
    if (!match || indentationWidth(match[1]) !== rootIndent || !validInlineScalar(match[3])) return '';
    const key = match[2].toLowerCase();
    const isPublic = PUBLIC_EVIDENCE_FIELDS.has(key);
    if (isPublic) visible.push(line);
    index += 1;

    if (!BLOCK_SCALAR.test(match[3])) continue;
    while (index < lines.length) {
      const continuation = lines[index];
      const continuationIndent = indentationWidth(continuation.match(/^[ \t]*/)?.[0]);
      if (continuation.trim() && continuationIndent <= rootIndent) break;
      if (isPublic) visible.push(continuation);
      index += 1;
    }
  }

  while (visible.length && visible.at(-1) === '') visible.pop();
  return visible.join(newline);
}

export function publicEvidenceContent(content = '') {
  const records = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let lineMatch;
  while ((lineMatch = linePattern.exec(String(content))) && (lineMatch[1] || lineMatch[2])) {
    records.push({ text: lineMatch[1], ending: lineMatch[2] });
    if (!lineMatch[2]) break;
  }

  const output = [];
  for (let index = 0; index < records.length;) {
    const record = records[index];
    const opening = openingFence(record.text);
    if (!opening) {
      output.push(`${record.text}${record.ending}`);
      index += 1;
      continue;
    }

    let closingIndex = index + 1;
    while (closingIndex < records.length) {
      if (closesFence(records[closingIndex].text, opening)) break;
      closingIndex += 1;
    }

    const isEvidence = opening.fenceCharacter === '`' && opening.info.toLowerCase() === 'safire-evidence';
    if (!isEvidence) {
      const end = closingIndex < records.length ? closingIndex + 1 : records.length;
      for (let cursor = index; cursor < end; cursor += 1) output.push(`${records[cursor].text}${records[cursor].ending}`);
      index = end;
      continue;
    }

    const newline = record.ending || '\n';
    output.push(`${record.text}${newline}`);
    if (closingIndex < records.length) {
      let containerValid = true;
      const body = records.slice(index + 1, closingIndex).map(line => {
        const remainder = stripQuoteDepth(line.text, opening.quoteDepth);
        if (remainder === null) containerValid = false;
        return `${remainder ?? ''}${line.ending}`;
      }).join('');
      const visible = containerValid ? publicEvidenceBody(body, newline) : '';
      if (visible) {
        const quotedVisible = visible.split(/\r?\n/).map(line => `${opening.quotePrefix}${line}`).join(newline);
        output.push(`${quotedVisible}${newline}`);
      }
      output.push(`${records[closingIndex].text}${records[closingIndex].ending}`);
      index = closingIndex + 1;
      continue;
    }

    // A recognized evidence block interrupted before its closing fence is
    // ownership-uncertain input. Omit the rest of the block and close the
    // projected fence rather than exposing raw private or malformed fields.
    output.push(`${opening.quotePrefix}${opening.fenceIndent}${opening.fence}`);
    index = records.length;
  }
  return output.join('');
}

export function* wikiLinkTargets(content = '') {
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = re.exec(String(content)))) {
    const target = match[1].trim();
    if (target) yield target;
  }
}

export function parseLinks(content = '') {
  return [...new Set(wikiLinkTargets(content))];
}

export function parseTags(content = '', limit = Number.POSITIVE_INFINITY) {
  const maximum = Number.isInteger(limit) && limit >= 0 ? limit : Number.POSITIVE_INFINITY;
  const tags = new Set();
  const re = /(^|\s)#([A-Za-z0-9_/-]+)/g;
  let match;
  while (tags.size < maximum && (match = re.exec(String(content)))) tags.add(match[2]);
  return [...tags].sort();
}

export function excerpt(content = '') {
  return String(content).replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`\[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function publicNoteMetadata(content = '') {
  const publicContent = publicEvidenceContent(content);
  return {
    tags: parseTags(publicContent),
    links: parseLinks(publicContent),
    excerpt: excerpt(publicContent),
  };
}

export function semanticMarkdownContent(content = '') {
  const lines = publicEvidenceContent(content).split(/\r?\n/);
  const visible = [];
  let fenceCharacter = '';
  let fenceLength = 0;
  for (const line of lines) {
    if (!fenceCharacter) {
      const opening = line.match(/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})/);
      if (opening) {
        fenceCharacter = opening[1][0];
        fenceLength = opening[1].length;
        continue;
      }
      visible.push(line.replace(/`[^`\r\n]*`/g, ''));
      continue;
    }
    const closing = line.match(/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`+|~+)[ \t]*$/);
    if (closing && closing[1][0] === fenceCharacter && closing[1].length >= fenceLength) {
      fenceCharacter = '';
      fenceLength = 0;
    }
  }
  return visible.join('\n');
}
