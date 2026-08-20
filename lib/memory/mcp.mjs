import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestParamsSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MemoryHardLinkUnavailableError } from './filesystem.mjs';
import {
  MemoryDisabledError,
  MemoryIdempotencyConflictError,
  MemoryNotFoundError,
  MemoryStoreError,
  createMemoryStore,
} from './store.mjs';
import {
  MemorySchemaValidationError,
  actorTypeSchema,
  containsDisallowedSensitiveMaterial,
  eventInputSchema,
  eventKindSchema,
  feedbackInputSchema,
  namespaceSchema,
  opaqueIdSchema,
} from './schema.mjs';
import {
  PROFILE_TYPES,
  ProfileAuthorizationError,
  ProfileValidationError,
  validateProfile,
} from './profile.mjs';

export const MEMORY_MCP_SERVER_NAME = 'safire-memory';
export const MEMORY_MCP_SERVER_VERSION = '1.6.0';

export const MEMORY_MCP_TOOL_NAMES = Object.freeze([
  'memory_record_events',
  'memory_search',
  'memory_get',
  'memory_record_feedback',
  'memory_recall',
  'memory_status',
]);

const MEMORY_MCP_TOOL_NAME_SET = new Set(MEMORY_MCP_TOOL_NAMES);
const SENSITIVE_PROPERTY_SCAN_LIMITS = Object.freeze({
  depth: 32,
  containers: 50_000,
  properties: 1_000_000,
  propertyNameLength: 512,
  propertyNameCharacters: 8_000_000,
});

export class MemoryMcpConfigurationError extends Error {
  constructor() {
    super('Ordinary Safire memory MCP requires a portable_mcp profile');
    this.name = 'MemoryMcpConfigurationError';
    this.code = 'MEMORY_MCP_PROFILE_INVALID';
  }
}

const eventBatchSchema = z.array(eventInputSchema).min(1).max(100);
const feedbackBatchSchema = z.array(feedbackInputSchema).min(1).max(100);
const opaqueIdBatchSchema = z.array(opaqueIdSchema)
  .min(1)
  .max(100)
  .refine(ids => new Set(ids).size === ids.length, 'Recall IDs must be unique');

export const memoryMcpToolSchemas = Object.freeze({
  memory_record_events: z.object({
    events: eventBatchSchema.describe('One through 100 strict Safire memory event inputs.'),
  }).strict(),
  memory_search: z.object({
    query: z.string().max(2_000)
      .refine(
        value => value.length > 2_000 || !containsDisallowedSensitiveMaterial(value),
        'Sensitive search text is not accepted',
      )
      .optional()
      .describe('Optional visible text to search for.'),
    namespaces: z.array(namespaceSchema).max(64).optional()
      .describe('Optional explicitly granted logical namespaces.'),
    actor_types: z.array(actorTypeSchema).max(64).optional()
      .describe('Optional actor type filter.'),
    kinds: z.array(eventKindSchema).max(64).optional()
      .describe('Optional event kind filter.'),
    limit: z.number().int().min(1).max(100).optional()
      .describe('Maximum number of results, from 1 through 100.'),
  }).strict(),
  memory_get: z.object({
    id: opaqueIdSchema.describe('An exact Safire event or memory ID.'),
    include_feedback: z.boolean().optional()
      .describe('Opt in to bounded feedback expansion for the exact record.'),
    include_relations: z.boolean().optional()
      .describe('Opt in to bounded relation and derivation expansion for the exact record.'),
  }).strict(),
  memory_record_feedback: z.object({
    feedback: feedbackBatchSchema.describe('One through 100 strict Safire memory feedback inputs.'),
  }).strict(),
  memory_recall: z.object({
    ids: opaqueIdBatchSchema.describe('One through 100 unique event or memory IDs.'),
    include_feedback: z.boolean().optional()
      .describe('Opt in to bounded feedback expansion for recalled records.'),
    include_relations: z.boolean().optional()
      .describe('Opt in to bounded relation and derivation expansion for recalled records.'),
  }).strict(),
  memory_status: z.object({}).strict(),
});

const MEMORY_MCP_TOOL_DESCRIPTIONS = Object.freeze({
  memory_record_events: 'Append strict, attributed events to Safire memory. Attribution identity and trust come only from the configured profile.',
  memory_search: 'Search accessible Safire memories within the configured profile namespace grants.',
  memory_get: 'Get one accessible Safire event-backed memory by exact event or memory ID.',
  memory_record_feedback: 'Append actor-attributed feedback to accessible Safire memory records.',
  memory_recall: 'Recall multiple accessible Safire event-backed memories by exact ID.',
  memory_status: 'Report Safire memory availability, profile identity, schema version, and record counts without exposing memory contents.',
});

const MEMORY_MCP_TOOL_HANDLERS = Object.freeze({
  memory_record_events: (memoryStore, { events }) => memoryStore.recordEvents(events),
  memory_search: (memoryStore, input) => memoryStore.search(input),
  memory_get: (memoryStore, { id, include_feedback, include_relations }) => memoryStore.get(id, {
    includeFeedback: include_feedback,
    includeRelations: include_relations,
  }),
  memory_record_feedback: (memoryStore, { feedback }) => memoryStore.recordFeedback(feedback),
  memory_recall: (memoryStore, { ids, include_feedback, include_relations }) => memoryStore.recall(ids, {
    includeFeedback: include_feedback,
    includeRelations: include_relations,
  }),
  memory_status: memoryStore => memoryStore.status(),
});

function advertisedToolSchema(name) {
  const jsonSchema = JSON.parse(JSON.stringify(z.toJSONSchema(memoryMcpToolSchemas[name], {
    target: 'draft-07',
    io: 'input',
  })));
  if (jsonSchema?.type !== 'object' || jsonSchema.additionalProperties !== false) {
    throw new MemoryMcpConfigurationError();
  }
  return jsonSchema;
}

const MEMORY_MCP_TOOLS = Object.freeze(MEMORY_MCP_TOOL_NAMES.map(name => Object.freeze({
  name,
  description: MEMORY_MCP_TOOL_DESCRIPTIONS[name],
  inputSchema: advertisedToolSchema(name),
  execution: Object.freeze({ taskSupport: 'forbidden' }),
})));

const SAFE_ERROR_MESSAGES = Object.freeze({
  MEMORY_DISABLED: 'Safire memory is disabled for this integration',
  MEMORY_NOT_FOUND: 'Memory record was not found or is not accessible',
  MEMORY_IDEMPOTENCY_CONFLICT: 'The source event ID was already used with a different payload',
  MEMORY_SCHEMA_VALIDATION_FAILED: 'Invalid Safire memory input',
  MEMORY_PROFILE_DENIED: 'The configured memory profile does not authorize this request',
  INVALID_MEMORY_PROFILE: 'The configured memory profile is invalid',
  MEMORY_BATCH_INVALID: 'Invalid Safire memory batch',
  MEMORY_QUERY_INVALID: 'Invalid Safire memory query',
  MEMORY_RESOURCE_LIMIT: 'Safire memory resource limit exceeded',
  MEMORY_HARD_LINK_UNAVAILABLE: 'Safire memory requires same-directory hard-link support',
  MEMORY_MCP_PROFILE_INVALID: 'Ordinary Safire memory MCP requires a portable profile',
});

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function publicToolError(error) {
  if (error instanceof MemorySchemaValidationError) {
    return {
      content: [{ type: 'text', text: 'Invalid Safire memory input' }],
      isError: true,
    };
  }

  let code = 'MEMORY_REQUEST_FAILED';
  let message = 'Safire memory request failed';

  if (error instanceof MemoryDisabledError
      || error instanceof MemoryNotFoundError
      || error instanceof MemoryIdempotencyConflictError
      || error instanceof MemorySchemaValidationError
      || error instanceof ProfileAuthorizationError
      || error instanceof ProfileValidationError
      || error instanceof MemoryHardLinkUnavailableError
      || error instanceof MemoryMcpConfigurationError
      || error instanceof MemoryStoreError) {
    const candidate = typeof error.code === 'string' && /^MEMORY_[A-Z_]+$/.test(error.code)
      ? error.code
      : error.code === 'INVALID_MEMORY_PROFILE'
        ? error.code
        : null;
    if (candidate) {
      code = candidate;
      message = SAFE_ERROR_MESSAGES[candidate] || message;
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: { code, message } }, null, 2),
    }],
    isError: true,
  };
}

function assertPortableMemoryStore(store) {
  try {
    const enabled = store?.enabled !== false;
    const profile = store?.profile == null ? null : validateProfile(store.profile);
    if ((enabled && !profile) || (profile && profile.profile_type !== PROFILE_TYPES.PORTABLE_MCP)) {
      throw new MemoryMcpConfigurationError();
    }
    return profile;
  } catch (error) {
    if (error instanceof MemoryMcpConfigurationError) throw error;
    throw new MemoryMcpConfigurationError();
  }
}

function invalidMemoryInput() {
  throw new MemorySchemaValidationError('Safire memory input');
}

function isCanonicalArrayIndex(key) {
  if (key === '0') return true;
  if (key.length === 0 || key.length > 10) return false;
  const first = key.charCodeAt(0);
  if (first < 0x31 || first > 0x39) return false;
  let value = first - 0x30;
  for (let index = 1; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
    value = (value * 10) + code - 0x30;
  }
  return value <= 0xFFFFFFFE;
}

function assertNoSensitivePropertyNames(input) {
  const pending = [];
  const discovered = new WeakSet();
  let containerCount = 0;
  let propertyCount = 0;
  let propertyNameCharacters = 0;
  if (input !== null && typeof input === 'object') {
    pending.push({ value: input, depth: 0 });
    discovered.add(input);
    containerCount = 1;
  }

  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    const arrayValue = Array.isArray(value);

    try {
      if (arrayValue) {
        const arrayLength = value.length;
        if (!Number.isSafeInteger(arrayLength) || arrayLength < 0) invalidMemoryInput();
        propertyCount += arrayLength;
        if (propertyCount > SENSITIVE_PROPERTY_SCAN_LIMITS.properties) invalidMemoryInput();
      }

      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const arrayIndex = arrayValue && isCanonicalArrayIndex(key);
        if (!arrayIndex) {
          if (++propertyCount > SENSITIVE_PROPERTY_SCAN_LIMITS.properties) invalidMemoryInput();
          propertyNameCharacters += key.length;
          if (key.length > SENSITIVE_PROPERTY_SCAN_LIMITS.propertyNameLength
              || propertyNameCharacters > SENSITIVE_PROPERTY_SCAN_LIMITS.propertyNameCharacters
              || containsDisallowedSensitiveMaterial(key)) {
            invalidMemoryInput();
          }
        }
        const child = value[key];
        if (child !== null && typeof child === 'object' && !discovered.has(child)) {
          if (depth + 1 > SENSITIVE_PROPERTY_SCAN_LIMITS.depth
              || ++containerCount > SENSITIVE_PROPERTY_SCAN_LIMITS.containers) {
            invalidMemoryInput();
          }
          discovered.add(child);
          pending.push({ value: child, depth: depth + 1 });
        }
      }
    } catch {
      invalidMemoryInput();
    }
  }
}

function hasSameEnumerablePropertyShape(input, output) {
  const pending = [[input, output]];
  const discoveredPairs = new WeakMap();
  let containerCount = 0;
  let propertyCount = 0;

  try {
    while (pending.length > 0) {
      const [inputValue, outputValue] = pending.pop();
      if (inputValue === null || typeof inputValue !== 'object') continue;
      if (outputValue === null
          || typeof outputValue !== 'object'
          || Array.isArray(inputValue) !== Array.isArray(outputValue)) {
        return false;
      }

      let pairedOutputs = discoveredPairs.get(inputValue);
      if (pairedOutputs?.has(outputValue)) continue;
      if (!pairedOutputs) {
        pairedOutputs = new WeakSet();
        discoveredPairs.set(inputValue, pairedOutputs);
      }
      pairedOutputs.add(outputValue);
      if (++containerCount > SENSITIVE_PROPERTY_SCAN_LIMITS.containers) return false;

      const inputKeys = Object.keys(inputValue);
      const outputKeys = Object.keys(outputValue);
      propertyCount += inputKeys.length;
      if (propertyCount > SENSITIVE_PROPERTY_SCAN_LIMITS.properties
          || inputKeys.length !== outputKeys.length) {
        return false;
      }
      for (const key of inputKeys) {
        if (!Object.hasOwn(outputValue, key)) return false;
        const child = inputValue[key];
        if (child !== null && typeof child === 'object') {
          pending.push([child, outputValue[key]]);
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}

const INVALID_MEMORY_CALL_PARAMS = Object.freeze({
  name: 'safire_invalid_memory_tool',
  arguments: Object.freeze({}),
});
const STRICT_MEMORY_CALL_PARAMS_SCHEMA = CallToolRequestParamsSchema.strict();

// Server.setRequestHandler performs a second standard tools/call parse before
// invoking the registered callback. Normalize malformed protocol parameters to
// an invalid, non-sensitive sentinel first so that parse cannot expose raw Zod
// issues and Safire can return its one fixed validation result. This transport
// boundary does not define accepted tool input; the six canonical schemas above
// remain the advertised and runtime definitions.
const MEMORY_CALL_TOOL_REQUEST_SCHEMA = CallToolRequestSchema.extend({
  params: z.preprocess((rawParams) => {
    try {
      assertNoSensitivePropertyNames(rawParams);
      const parsed = STRICT_MEMORY_CALL_PARAMS_SCHEMA.safeParse(rawParams);
      if (parsed.success
          && parsed.data.task === undefined
          && hasSameEnumerablePropertyShape(rawParams, parsed.data)) {
        return parsed.data;
      }
      return INVALID_MEMORY_CALL_PARAMS;
    } catch {
      return INVALID_MEMORY_CALL_PARAMS;
    }
  }, STRICT_MEMORY_CALL_PARAMS_SCHEMA),
});

async function parseMemoryToolInput(name, rawInput) {
  if (!MEMORY_MCP_TOOL_NAME_SET.has(name)) invalidMemoryInput();
  const input = rawInput === undefined ? {} : rawInput;
  try {
    assertNoSensitivePropertyNames(input);
    const parsed = await memoryMcpToolSchemas[name].safeParseAsync(input);
    if (parsed.success && hasSameEnumerablePropertyShape(input, parsed.data)) return parsed.data;
  } catch {
    // Validation errors are deliberately collapsed below without retaining a
    // caller-controlled issue path, value, message, stack, or cause.
  }
  invalidMemoryInput();
}

async function dispatchMemoryTool(store, request) {
  try {
    const name = request.params.name;
    const input = await parseMemoryToolInput(name, request.params.arguments);
    assertPortableMemoryStore(store);
    return jsonResult(await MEMORY_MCP_TOOL_HANDLERS[name](store, input));
  } catch (error) {
    return publicToolError(error);
  }
}

/**
 * Registers the six Safire memory tools on a dedicated, unconnected public
 * McpServer whose tools/list and tools/call handler slots are both unused.
 * Mixed high-level tool registries and already-connected servers are rejected
 * rather than being composed without this validation boundary.
 */
export function registerMemoryMcpTools(server, store) {
  if (!(server instanceof McpServer)) {
    throw new TypeError('A supported MCP server is required');
  }
  if (!store || typeof store.status !== 'function') {
    throw new TypeError('A Safire memory store is required');
  }
  assertPortableMemoryStore(store);

  const protocol = server.server;
  if (!protocol
      || typeof protocol.assertCanSetRequestHandler !== 'function'
      || typeof protocol.registerCapabilities !== 'function'
      || typeof protocol.setRequestHandler !== 'function') {
    throw new TypeError('A supported MCP server is required');
  }

  protocol.assertCanSetRequestHandler('tools/list');
  protocol.assertCanSetRequestHandler('tools/call');
  protocol.registerCapabilities({ tools: { listChanged: true } });
  protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MEMORY_MCP_TOOLS.map(tool => structuredClone(tool)),
  }));
  protocol.setRequestHandler(
    MEMORY_CALL_TOOL_REQUEST_SCHEMA,
    request => dispatchMemoryTool(store, request),
  );

  return server;
}

export function createMemoryMcpServer({
  store,
  vaultDir,
  profile,
  enabled = true,
  resourceLimits,
  name = MEMORY_MCP_SERVER_NAME,
  version = MEMORY_MCP_SERVER_VERSION,
} = {}) {
  const memoryStore = store || createMemoryStore({ vaultDir, profile, enabled, resourceLimits });
  const server = new McpServer({ name, version });
  registerMemoryMcpTools(server, memoryStore);
  return { server, store: memoryStore };
}

export async function startMemoryMcpStdio(options = {}) {
  const { server, store } = createMemoryMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, store, transport };
}
