const PUBLIC_EVIDENCE_FIELDS = new Set([
  'id',
  'claim',
  'label',
  'source_type',
  'source',
  'source_url',
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

const PRIVATE_EVIDENCE_FIELDS = new Set(['private_notes', 'notes']);
const EVIDENCE_FIELDS = new Set([...PUBLIC_EVIDENCE_FIELDS, ...PRIVATE_EVIDENCE_FIELDS]);
const EVIDENCE_SOURCE_TYPES = new Set(['url', 'local_file', 'manual_observation', 'tool_result']);
const EVIDENCE_STATUSES = new Set(['verified', 'inferred', 'stale', 'conflicting', 'unavailable']);
const MAPPING_FIELD = /^([ \t]*)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;
const BLOCK_SCALAR = /^([|>])([1-9+-]*)(?:[ \t]+#.*)?[ \t]*$/;
const TASK = /^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.*)$/;
const MAX_EVIDENCE_BLOCK_BYTES = 256 * 1024;
const MAX_FLOW_DEPTH = 32;

function indentationWidth(value = '') {
  return String(value).replace(/\t/g, '    ').length;
}

function lineRecords(content = '') {
  const value = String(content);
  const records = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\r' && value[index] !== '\n') continue;
    const ending = value[index] === '\r' && value[index + 1] === '\n' ? '\r\n' : value[index];
    records.push({ text: value.slice(start, index), ending });
    if (ending.length === 2) index += 1;
    start = index + 1;
  }
  records.push({ text: value.slice(start), ending: '' });
  return records;
}

function consumeIndent(line, cursor, width) {
  let columns = 0;
  while (cursor < line.length && columns < width && (line[cursor] === ' ' || line[cursor] === '\t')) {
    columns += line[cursor] === '\t' ? 4 : 1;
    cursor += 1;
  }
  return columns >= width ? cursor : -1;
}

function stripContainerPrefix(line = '', containers = []) {
  if (!line.trim()) return '';
  let cursor = 0;
  for (const container of containers) {
    if (container.type === 'quote') {
      const marker = line.slice(cursor).match(/^[ \t]{0,3}>[ \t]?/);
      if (!marker) return null;
      cursor += marker[0].length;
      continue;
    }
    cursor = consumeIndent(line, cursor, container.continuationWidth);
    if (cursor < 0) return null;
  }
  return line.slice(cursor);
}

function continuationPrefix(containers = []) {
  return containers.map(container => (
    container.type === 'quote'
      ? `${container.leading}>${container.after}`
      : ' '.repeat(container.continuationWidth)
  )).join('');
}

function evidenceInfoKind(info = '') {
  const normalized = String(info).trim().toLowerCase();
  if (normalized === 'safire-evidence') return 'exact';
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  return compact.includes('safire') && compact.includes('evidence') ? 'sensitive' : 'ordinary';
}

function openingFence(line = '') {
  let cursor = 0;
  const containers = [];
  while (cursor < line.length) {
    const remainder = line.slice(cursor);
    const leading = remainder.match(/^[ \t]{0,3}/)?.[0] || '';
    const afterLeading = remainder.slice(leading.length);
    const quote = afterLeading.match(/^>([ \t]?)/);
    if (quote) {
      containers.push({ type: 'quote', leading, after: quote[1] });
      cursor += leading.length + quote[0].length;
      continue;
    }
    const list = afterLeading.match(/^([-+*]|\d{1,9}[.)])([ \t]+)/);
    if (!list) break;
    const literal = `${leading}${list[1]}${list[2]}`;
    containers.push({ type: 'list', continuationWidth: indentationWidth(literal) });
    cursor += literal.length;
  }

  const opening = line.slice(cursor).match(/^([ \t]*)(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/);
  if (!opening) return null;
  const prefix = `${line.slice(0, cursor)}${opening[1]}`;
  return {
    containers,
    prefix,
    closingPrefix: `${continuationPrefix(containers)}${opening[1]}`,
    fenceIndent: opening[1],
    fence: opening[2],
    fenceCharacter: opening[2][0],
    fenceLength: opening[2].length,
    info: opening[3].trim(),
    infoKind: evidenceInfoKind(opening[3]),
  };
}

function closesFence(line = '', opening) {
  const remainder = stripContainerPrefix(line, opening.containers);
  if (remainder === null) return false;
  const closing = remainder.match(/^[ \t]*(`+|~+)[ \t]*$/);
  return Boolean(
    closing
    && closing[1][0] === opening.fenceCharacter
    && closing[1].length >= opening.fenceLength
  );
}

function scanFences(records) {
  const blocks = [];
  const publicLineMask = Array(records.length).fill(true);
  for (let index = 0; index < records.length;) {
    const opening = openingFence(records[index].text);
    if (!opening) {
      index += 1;
      continue;
    }
    let closingIndex = index + 1;
    while (closingIndex < records.length && !closesFence(records[closingIndex].text, opening)) closingIndex += 1;
    const closed = closingIndex < records.length;
    const end = closed ? closingIndex : records.length - 1;
    for (let cursor = index; cursor <= end; cursor += 1) publicLineMask[cursor] = false;
    blocks.push({ openingIndex: index, closingIndex: end, closed, opening });
    index = end + 1;
  }
  return { blocks, publicLineMask };
}

function blockScalarDescriptor(raw = '') {
  const trimmed = String(raw).trim();
  const match = trimmed.match(BLOCK_SCALAR);
  if (!match) return null;
  const modifiers = match[2];
  const digits = [...modifiers].filter(character => /[1-9]/.test(character));
  const chomps = [...modifiers].filter(character => /[+-]/.test(character));
  if (modifiers.length > 2 || digits.length > 1 || chomps.length > 1) return null;
  return {
    style: match[1],
    indentation: digits.length ? Number(digits[0]) : 0,
    chomp: chomps[0] || '',
  };
}

function stripLeadingColumns(line, width) {
  let cursor = 0;
  let columns = 0;
  while (cursor < line.length && columns < width && line[cursor] === ' ') {
    cursor += 1;
    columns += 1;
  }
  return columns === width ? line.slice(cursor) : null;
}

function foldedBlock(lines) {
  if (!lines.length) return '';
  let value = '';
  let index = 0;
  while (index < lines.length && !lines[index]) {
    value += '\n';
    index += 1;
  }
  while (index < lines.length) {
    const line = lines[index];
    value += line;
    let blankLines = 0;
    while (index + 1 < lines.length && !lines[index + 1]) {
      blankLines += 1;
      index += 1;
    }
    if (blankLines) value += '\n'.repeat(blankLines);
    else if (index + 1 < lines.length) value += /^\s/.test(line) || /^\s/.test(lines[index + 1]) ? '\n' : ' ';
    index += 1;
  }
  return `${value}\n`;
}

function chompBlock(value, chomp, hasContentLines) {
  if (chomp === '+') return value;
  const stripped = value.replace(/\n+$/g, '');
  if (chomp === '-') return stripped;
  return hasContentLines ? `${stripped}\n` : '';
}

function parseBlockScalar(lines, startIndex, rootIndent, descriptor) {
  let nextIndex = startIndex + 1;
  while (nextIndex < lines.length) {
    const line = lines[nextIndex];
    const indentText = line.match(/^[ \t]*/)?.[0] || '';
    if (indentText.includes('\t')) return { valid: false };
    if (line.trim() && indentationWidth(indentText) <= rootIndent) break;
    nextIndex += 1;
  }

  const sourceLines = lines.slice(startIndex + 1, nextIndex);
  const firstContent = sourceLines.find(line => line.trim());
  const firstIndentText = firstContent?.match(/^[ \t]*/)?.[0] || '';
  const contentIndent = descriptor.indentation
    ? rootIndent + descriptor.indentation
    : indentationWidth(firstIndentText);
  if (firstContent && contentIndent <= rootIndent) return { valid: false };

  const contentLines = [];
  for (const line of sourceLines) {
    if (!line.trim()) {
      contentLines.push('');
      continue;
    }
    const indentText = line.match(/^[ \t]*/)?.[0] || '';
    if (indentText.includes('\t') || indentationWidth(indentText) < contentIndent) return { valid: false };
    const stripped = stripLeadingColumns(line, contentIndent);
    if (stripped === null) return { valid: false };
    contentLines.push(stripped);
  }

  const value = descriptor.style === '|'
    ? `${contentLines.join('\n')}${contentLines.length ? '\n' : ''}`
    : foldedBlock(contentLines);
  return {
    valid: true,
    nextIndex,
    value: chompBlock(value, descriptor.chomp, contentLines.length > 0),
  };
}

function scanQuotedScalar(lines, startIndex, raw, quote) {
  let value = '';
  let escaped = false;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const text = lineIndex === startIndex ? raw.trimStart().slice(1) : lines[lineIndex];
    for (let cursor = 0; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (quote === '"' && escaped) {
        const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (character in escapes) value += escapes[character];
        else if (['x', 'u', 'U'].includes(character)) {
          const length = character === 'x' ? 2 : character === 'u' ? 4 : 8;
          const digits = text.slice(cursor + 1, cursor + 1 + length);
          const codePoint = Number.parseInt(digits, 16);
          if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits) || codePoint > 0x10ffff) return { valid: false };
          value += String.fromCodePoint(codePoint);
          cursor += length;
        } else return { valid: false };
        escaped = false;
        continue;
      }
      if (quote === '"' && character === '\\') {
        escaped = true;
        continue;
      }
      if (character !== quote) {
        value += character;
        continue;
      }
      if (quote === "'" && text[cursor + 1] === "'") {
        value += "'";
        cursor += 1;
        continue;
      }
      if (!/^[ \t]*(?:#.*)?$/.test(text.slice(cursor + 1))) return { valid: false };
      return { valid: true, nextIndex: lineIndex + 1, value: value.replace(/[ \t]*\n[ \t]*/g, ' ') };
    }
    if (escaped) return { valid: false };
    value += '\n';
  }
  return { valid: false };
}

function flowClosingIndex(lines, startIndex, raw) {
  const first = raw.trimStart();
  const stack = [];
  let quote = '';
  let escaped = false;
  let expression = '';
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const text = lineIndex === startIndex ? first : lines[lineIndex];
    for (let cursor = 0; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      expression += character;
      if (quote) {
        if (quote === '"' && escaped) {
          escaped = false;
          continue;
        }
        if (quote === '"' && character === '\\') {
          escaped = true;
          continue;
        }
        if (character !== quote) continue;
        if (quote === "'" && text[cursor + 1] === "'") {
          expression += text[cursor + 1];
          cursor += 1;
          continue;
        }
        quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '[' || character === '{') {
        stack.push(character);
        if (stack.length > MAX_FLOW_DEPTH) return { valid: false };
        continue;
      }
      if (character !== ']' && character !== '}') continue;
      const expected = character === ']' ? '[' : '{';
      if (stack.pop() !== expected) return { valid: false };
      if (stack.length) continue;
      if (!/^[ \t]*(?:#.*)?$/.test(text.slice(cursor + 1))) return { valid: false };
      return { valid: true, nextIndex: lineIndex + 1, expression };
    }
    expression += '\n';
  }
  return { valid: false };
}

function validateFlowExpression(expression = '') {
  const source = String(expression);
  let cursor = 0;
  let depth = 0;

  function skipWhitespace() {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor])) {
        cursor += 1;
        continue;
      }
      if (source[cursor] === '#') {
        while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
        continue;
      }
      break;
    }
  }

  function quoted() {
    const quote = source[cursor];
    cursor += 1;
    while (cursor < source.length) {
      if (quote === '"' && source[cursor] === '\\') {
        const escape = source[cursor + 1];
        if ('"\\/bfnrt'.includes(escape)) cursor += 2;
        else if (['x', 'u', 'U'].includes(escape)) {
          const length = escape === 'x' ? 2 : escape === 'u' ? 4 : 8;
          const digits = source.slice(cursor + 2, cursor + 2 + length);
          const codePoint = Number.parseInt(digits, 16);
          if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits) || codePoint > 0x10ffff) return false;
          cursor += length + 2;
        } else return false;
        continue;
      }
      if (source[cursor] !== quote) {
        cursor += 1;
        continue;
      }
      if (quote === "'" && source[cursor + 1] === "'") {
        cursor += 2;
        continue;
      }
      cursor += 1;
      return true;
    }
    return false;
  }

  function plain(stopCharacters) {
    const start = cursor;
    while (cursor < source.length && !stopCharacters.includes(source[cursor]) && source[cursor] !== '\n') cursor += 1;
    return Boolean(source.slice(start, cursor).trim());
  }

  function value() {
    skipWhitespace();
    if (source[cursor] === '[') return sequence();
    if (source[cursor] === '{') return mapping();
    if (source[cursor] === '"' || source[cursor] === "'") return quoted();
    return plain(',]}');
  }

  function sequence() {
    depth += 1;
    if (depth > MAX_FLOW_DEPTH) return false;
    cursor += 1;
    skipWhitespace();
    if (source[cursor] === ']') {
      cursor += 1;
      depth -= 1;
      return true;
    }
    while (cursor < source.length) {
      if (!value()) return false;
      skipWhitespace();
      if (source[cursor] === ']') {
        cursor += 1;
        depth -= 1;
        return true;
      }
      if (source[cursor] !== ',') return false;
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === ']') {
        cursor += 1;
        depth -= 1;
        return true;
      }
    }
    return false;
  }

  function mappingKey() {
    skipWhitespace();
    if (source[cursor] === '"' || source[cursor] === "'") return quoted();
    return plain(':,{}[]');
  }

  function mapping() {
    depth += 1;
    if (depth > MAX_FLOW_DEPTH) return false;
    cursor += 1;
    skipWhitespace();
    if (source[cursor] === '}') {
      cursor += 1;
      depth -= 1;
      return true;
    }
    while (cursor < source.length) {
      if (!mappingKey()) return false;
      skipWhitespace();
      if (source[cursor] !== ':') return false;
      cursor += 1;
      if (!value()) return false;
      skipWhitespace();
      if (source[cursor] === '}') {
        cursor += 1;
        depth -= 1;
        return true;
      }
      if (source[cursor] !== ',') return false;
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === '}') {
        cursor += 1;
        depth -= 1;
        return true;
      }
    }
    return false;
  }

  if (!value()) return false;
  skipWhitespace();
  return cursor === source.length && depth === 0;
}

function parseFlowScalar(lines, startIndex, raw) {
  const scanned = flowClosingIndex(lines, startIndex, raw);
  if (!scanned.valid || !validateFlowExpression(scanned.expression)) return { valid: false };
  return { valid: true, nextIndex: scanned.nextIndex, value: scanned.expression.trim() };
}

function parseScalar(lines, startIndex, rootIndent, raw = '') {
  const value = String(raw).trimStart();
  const block = blockScalarDescriptor(value);
  if (block) return parseBlockScalar(lines, startIndex, rootIndent, block);
  if (value.startsWith('|') || value.startsWith('>')) return { valid: false };
  if (value.startsWith('"') || value.startsWith("'")) return scanQuotedScalar(lines, startIndex, raw, value[0]);
  if (value.startsWith('[') || value.startsWith('{')) return parseFlowScalar(lines, startIndex, raw);
  if (value.startsWith(']') || value.startsWith('}')) return { valid: false };
  if (/^[!&*@`%]/.test(value)) return { valid: false };
  return { valid: true, nextIndex: startIndex + 1, value: value.trim() };
}

function parseEvidenceBody(lines = []) {
  if (lines.join('\n').length > MAX_EVIDENCE_BLOCK_BYTES) return { valid: false, fields: new Map(), publicLineIndexes: [] };
  const firstIndex = lines.findIndex(line => line.trim() && !/^[ \t]*#/.test(line));
  if (firstIndex < 0) return { valid: false, fields: new Map(), publicLineIndexes: [] };
  const firstMatch = lines[firstIndex].match(MAPPING_FIELD);
  if (!firstMatch || firstMatch[1].includes('\t')) return { valid: false, fields: new Map(), publicLineIndexes: [] };
  const rootIndent = indentationWidth(firstMatch[1]);
  const fields = new Map();
  const publicLineIndexes = [];
  const fencedPublicFields = new Set();

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim() || /^[ \t]*#/.test(line)) {
      index += 1;
      continue;
    }
    const match = line.match(MAPPING_FIELD);
    if (!match || match[1].includes('\t') || indentationWidth(match[1]) !== rootIndent) {
      return { valid: false, fields: new Map(), publicLineIndexes: [] };
    }
    const key = match[2].toLowerCase();
    if (!EVIDENCE_FIELDS.has(key) || (fields.has(key) && !PRIVATE_EVIDENCE_FIELDS.has(key))) {
      return { valid: false, fields: new Map(), publicLineIndexes: [] };
    }
    const scalar = parseScalar(lines, index, rootIndent, match[3]);
    if (!scalar.valid) return { valid: false, fields: new Map(), publicLineIndexes: [] };
    if (!fields.has(key)) fields.set(key, scalar.value);
    if (PUBLIC_EVIDENCE_FIELDS.has(key)) {
      for (let visibleIndex = index; visibleIndex < scalar.nextIndex; visibleIndex += 1) publicLineIndexes.push(visibleIndex);
      const source = lines.slice(index, scalar.nextIndex).join('\n');
      if (scanFences(lineRecords(source)).blocks.length) fencedPublicFields.add(key);
    }
    index = scalar.nextIndex;
  }

  return { valid: true, fields, publicLineIndexes, fencedPublicFields };
}

function parsedEvidenceBlock(records, block) {
  if (block.opening.infoKind !== 'exact' || !block.closed) return { valid: false, fields: new Map(), publicLineIndexes: [] };
  const bodyRecords = records.slice(block.openingIndex + 1, block.closingIndex);
  const bodyLines = [];
  for (const record of bodyRecords) {
    const remainder = stripContainerPrefix(record.text, block.opening.containers);
    if (remainder === null) return { valid: false, fields: new Map(), publicLineIndexes: [] };
    bodyLines.push(remainder);
  }
  return parseEvidenceBody(bodyLines);
}

export function publicEvidenceContent(content = '') {
  const records = lineRecords(content);
  const { blocks } = scanFences(records);
  const byOpening = new Map(blocks.map(block => [block.openingIndex, block]));
  const output = [];
  for (let index = 0; index < records.length;) {
    const block = byOpening.get(index);
    if (!block) {
      output.push(`${records[index].text}${records[index].ending}`);
      index += 1;
      continue;
    }
    if (block.opening.infoKind === 'ordinary') {
      for (let cursor = block.openingIndex; cursor <= block.closingIndex; cursor += 1) {
        output.push(`${records[cursor].text}${records[cursor].ending}`);
      }
      index = block.closingIndex + 1;
      continue;
    }

    const normalizedOpening = `${block.opening.prefix}${block.opening.fence}safire-evidence`;
    output.push(`${normalizedOpening}${records[index].ending || '\n'}`);
    const parsed = parsedEvidenceBlock(records, block);
    if (parsed.valid) {
      for (const bodyIndex of parsed.publicLineIndexes) {
        const record = records[block.openingIndex + 1 + bodyIndex];
        output.push(`${record.text}${record.ending}`);
      }
    }
    if (block.closed) {
      const closing = records[block.closingIndex];
      output.push(`${closing.text}${closing.ending}`);
    } else {
      output.push(`${block.opening.closingPrefix}${block.opening.fence}`);
    }
    index = block.closingIndex + 1;
  }
  return output.join('');
}

function withoutFencedContent(content = '') {
  const records = lineRecords(content);
  const { blocks } = scanFences(records);
  const byOpening = new Map(blocks.map(block => [block.openingIndex, block]));
  const output = [];
  for (let index = 0; index < records.length;) {
    const block = byOpening.get(index);
    if (block) {
      index = block.closingIndex + 1;
      continue;
    }
    output.push(`${records[index].text}${records[index].ending}`);
    index += 1;
  }
  return output.join('');
}

// Generic indexes intentionally see less than an explicit note read. Ordinary
// fenced code is never semantic content, while a structurally valid
// safire-evidence block contributes only its allowlisted public field lines.
// Any malformed, ambiguous, or unclosed evidence block contributes nothing.
export function genericIndexContent(content = '') {
  const records = lineRecords(content);
  const { blocks } = scanFences(records);
  const byOpening = new Map(blocks.map(block => [block.openingIndex, block]));
  const output = [];
  for (let index = 0; index < records.length;) {
    const block = byOpening.get(index);
    if (!block) {
      output.push(`${records[index].text}${records[index].ending}`);
      index += 1;
      continue;
    }

    if (block.opening.infoKind === 'exact') {
      const parsed = parsedEvidenceBlock(records, block);
      if (parsed.valid) {
        for (const bodyIndex of parsed.publicLineIndexes) {
          const record = records[block.openingIndex + 1 + bodyIndex];
          output.push(`${record.text}${record.ending}`);
        }
      }
    }
    index = block.closingIndex + 1;
  }
  // Public block scalars can themselves contain Markdown fences. Strip those
  // in a non-promoting pass so nested evidence-like text is never reinterpreted.
  return withoutFencedContent(output.join(''));
}

export function publicMarkdownLineMask(content = '') {
  const records = lineRecords(content);
  return scanFences(records).publicLineMask;
}

export function parsePublicTasks(content = '', notePath = '', options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit >= 0
    ? options.limit
    : Number.POSITIVE_INFINITY;
  if (limit === 0) return [];
  const records = lineRecords(content);
  const mask = scanFences(records).publicLineMask;
  const tasks = [];
  for (let index = 0; index < records.length; index += 1) {
    if (!mask[index]) continue;
    const match = records[index].text.match(TASK);
    if (!match) continue;
    tasks.push({
      id: `${notePath}:${index + 1}`,
      path: notePath,
      line: index + 1,
      text: match[4].trim(),
      completed: match[2].toLowerCase() === 'x',
    });
    if (tasks.length >= limit) break;
  }
  return tasks;
}

export function isPublicTaskLine(content = '', lineNumber) {
  const line = Number(lineNumber);
  if (!Number.isInteger(line) || line < 1) return false;
  const records = lineRecords(content);
  const mask = scanFences(records).publicLineMask;
  return Boolean(mask[line - 1] && TASK.test(records[line - 1]?.text || ''));
}

function receiptFromFields(fields, notePath, index, includePrivate, now) {
  const freshness = fields.get('freshness') || fields.get('expires_at') || '';
  const timestamp = Date.parse(freshness);
  const sourceTypeValue = fields.get('source_type') || '';
  const statusValue = fields.get('status') || '';
  const receipt = {
    id: fields.get('id') || `${notePath || 'note'}:evidence:${index + 1}`,
    claim: fields.get('claim') || fields.get('label') || '',
    sourceType: EVIDENCE_SOURCE_TYPES.has(sourceTypeValue) ? sourceTypeValue : 'manual_observation',
    source: fields.get('source') || fields.get('source_url_or_path') || fields.get('source_url') || '',
    observedAt: fields.get('observed_at') || '',
    action: fields.get('action') || fields.get('action_performed') || '',
    verification: fields.get('verification') || fields.get('predicate') || fields.get('test') || '',
    status: EVIDENCE_STATUSES.has(statusValue) ? statusValue : 'unavailable',
    freshness,
    excerpt: fields.get('excerpt') || fields.get('evidence_excerpt') || '',
    hash: fields.get('hash') || fields.get('sha256') || '',
    expired: Number.isFinite(timestamp) && timestamp <= now,
  };
  if (includePrivate) receipt.privateNotes = fields.get('private_notes') || fields.get('notes') || '';
  return receipt;
}

export function parseEvidenceReceipts(content = '', notePath = '', options = {}) {
  const includePrivate = options.includePrivate !== false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const limit = Number.isInteger(options.limit) && options.limit >= 0
    ? options.limit
    : Number.POSITIVE_INFINITY;
  if (limit === 0) return [];
  const records = lineRecords(content);
  const { blocks } = scanFences(records);
  const receipts = [];
  let receiptIndex = 0;
  for (const block of blocks) {
    if (block.opening.infoKind !== 'exact') continue;
    const parsed = parsedEvidenceBlock(records, block);
    if (!parsed.valid) {
      receiptIndex += 1;
      continue;
    }
    const receiptFields = includePrivate
      ? parsed.fields
      : new Map([...parsed.fields].filter(([key]) => !parsed.fencedPublicFields?.has(key)));
    const receipt = receiptFromFields(receiptFields, notePath, receiptIndex, includePrivate, now);
    if (receipt.claim || receiptFields.get('id')) receipts.push(receipt);
    if (receipts.length >= limit) break;
    receiptIndex += 1;
  }
  return receipts;
}

export function parsePublicEvidenceReceipts(content = '', notePath = '', options = {}) {
  return parseEvidenceReceipts(publicEvidenceContent(content), notePath, { ...options, includePrivate: false }).map(receipt => ({
    id: withoutFencedContent(receipt.id),
    claim: withoutFencedContent(receipt.claim),
    sourceType: receipt.sourceType,
    observedAt: withoutFencedContent(receipt.observedAt),
    status: receipt.status,
    freshness: withoutFencedContent(receipt.freshness),
    expired: receipt.expired,
  }));
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

export function semanticMarkdownContent(content = '') {
  const projected = genericIndexContent(content);
  const records = lineRecords(projected);
  const mask = scanFences(records).publicLineMask;
  return records
    .filter((_record, index) => mask[index])
    .map(record => record.text.replace(/`[^`\r\n]*`/g, ''))
    .join('\n');
}

export function excerpt(content = '') {
  return semanticMarkdownContent(content).replace(/[#>*_`\[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function publicNoteMetadata(content = '') {
  const publicContent = genericIndexContent(content);
  return {
    tags: parseTags(publicContent),
    links: parseLinks(publicContent),
    excerpt: excerpt(publicContent),
  };
}
