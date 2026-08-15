function stripComment(raw) {
  let quote = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === "'") {
      if (character === "'" && raw[index + 1] === "'") index += 1;
      else if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = '';
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '#' && (index === 0 || /\s/.test(raw[index - 1]))) return raw.slice(0, index).trimEnd();
  }
  if (quote) throw new Error('Unclosed YAML quote');
  return raw.trimEnd();
}

function mappingDelimiter(value) {
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") quote = '';
    } else if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = '';
    } else if (character === "'" || character === '"') quote = character;
    else if (character === ':' && (index + 1 === value.length || /\s/.test(value[index + 1]))) return index;
  }
  return -1;
}

function scalar(value) {
  const trimmed = value.trim();
  if (/^[&*!]|^<<\s*:/.test(trimmed) || /^[\[{]/.test(trimmed)) throw new Error(`Unsupported YAML structure: ${trimmed}`);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new Error('Unclosed YAML string');
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function entry(value) {
  const delimiter = mappingDelimiter(value);
  if (delimiter < 1) throw new Error(`Expected YAML mapping entry: ${value}`);
  const key = scalar(value.slice(0, delimiter));
  if (typeof key !== 'string' || !key) throw new Error('YAML mapping keys must be non-empty strings');
  return { key, rest: value.slice(delimiter + 1).trim() };
}

export function parseWorkflowYaml(source) {
  const lines = String(source).split(/\r?\n/).map((raw, lineIndex) => {
    if (/^\s*\t/.test(raw)) throw new Error(`Tabs are not supported at YAML line ${lineIndex + 1}`);
    const indentation = raw.match(/^ */)[0].length;
    const content = stripComment(raw.slice(indentation));
    return { indentation, content, raw: raw.slice(indentation), line: lineIndex + 1 };
  }).filter(line => line.content.trim());

  const parseBlock = (start, indentation) => {
    if (lines[start]?.content.startsWith('-') && /^(?:-|-[ \t])/.test(lines[start].content)) return parseSequence(start, indentation);
    return parseMapping(start, indentation);
  };

  const parseNestedValue = (lineIndex, indentation, rest) => {
    if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const body = [];
      let next = lineIndex + 1;
      while (next < lines.length && lines[next].indentation > indentation) {
        body.push(lines[next].raw);
        next += 1;
      }
      return { value: body.join('\n'), next };
    }
    if (rest) return { value: scalar(rest), next: lineIndex + 1 };
    const nextLine = lines[lineIndex + 1];
    if (!nextLine || nextLine.indentation <= indentation) return { value: null, next: lineIndex + 1 };
    const parsed = parseBlock(lineIndex + 1, nextLine.indentation);
    return { value: parsed.value, next: parsed.next };
  };

  const assign = (object, pair, lineIndex, indentation) => {
    if (Object.hasOwn(object, pair.key)) throw new Error(`Duplicate YAML key ${pair.key} at line ${lines[lineIndex].line}`);
    const parsed = parseNestedValue(lineIndex, indentation, pair.rest);
    object[pair.key] = parsed.value;
    return parsed.next;
  };

  function parseMapping(start, indentation, initialText = '') {
    const object = {};
    let index = start;
    if (initialText) index = assign(object, entry(initialText), start, indentation);
    while (index < lines.length && lines[index].indentation === indentation && !/^(?:-|-[ \t])/.test(lines[index].content)) {
      index = assign(object, entry(lines[index].content), index, indentation);
    }
    return { value: object, next: index };
  }

  function parseSequence(start, indentation) {
    const values = [];
    let index = start;
    while (index < lines.length && lines[index].indentation === indentation && /^(?:-|-[ \t])/.test(lines[index].content)) {
      const rest = lines[index].content.slice(1).trim();
      if (!rest) {
        const nextLine = lines[index + 1];
        if (!nextLine || nextLine.indentation <= indentation) {
          values.push(null);
          index += 1;
        } else {
          const parsed = parseBlock(index + 1, nextLine.indentation);
          values.push(parsed.value);
          index = parsed.next;
        }
      } else if (mappingDelimiter(rest) >= 1) {
        const parsed = parseMapping(index, indentation + 2, rest);
        values.push(parsed.value);
        index = parsed.next;
      } else {
        values.push(scalar(rest));
        index += 1;
      }
    }
    return { value: values, next: index };
  }

  if (!lines.length) return {};
  const parsed = parseBlock(0, lines[0].indentation);
  if (parsed.next !== lines.length) throw new Error(`Unsupported YAML structure at line ${lines[parsed.next].line}`);
  return parsed.value;
}

export function recursivelyCollectKey(value, key) {
  return recursivelyCollectMappingsWithKey(value, key).map(mapping => mapping[key]);
}

export function recursivelyCollectMappingsWithKey(value, key) {
  const found = [];
  const visit = candidate => {
    if (!candidate || typeof candidate !== 'object') return;
    if (!Array.isArray(candidate) && Object.hasOwn(candidate, key)) found.push(candidate);
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) visit(child);
  };
  visit(value);
  return found;
}
