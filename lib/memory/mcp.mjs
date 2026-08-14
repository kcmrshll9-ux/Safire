import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
export const MEMORY_MCP_SERVER_VERSION = '1.4.0';

export const MEMORY_MCP_TOOL_NAMES = Object.freeze([
  'memory_record_events',
  'memory_search',
  'memory_get',
  'memory_record_feedback',
  'memory_recall',
  'memory_status',
]);

const MEMORY_MCP_TOOL_NAME_SET = new Set(MEMORY_MCP_TOOL_NAMES);
const PREFLIGHTED_MCP_SERVERS = new WeakSet();
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

function installSensitivePropertyNamePreflight(server) {
  if (PREFLIGHTED_MCP_SERVERS.has(server) || typeof server.validateToolInput !== 'function') return;
  const validateToolInput = server.validateToolInput;
  server.validateToolInput = async function validateMemoryToolInput(tool, input, toolName) {
    if (!MEMORY_MCP_TOOL_NAME_SET.has(toolName)) {
      return validateToolInput.call(this, tool, input, toolName);
    }
    try {
      assertNoSensitivePropertyNames(input);
      return await validateToolInput.call(this, tool, input, toolName);
    } catch {
      invalidMemoryInput();
    }
  };
  PREFLIGHTED_MCP_SERVERS.add(server);
}

function registerJsonTool(server, store, name, description, handler) {
  server.registerTool(name, {
    description,
    inputSchema: memoryMcpToolSchemas[name],
  }, async (input) => {
    try {
      assertPortableMemoryStore(store);
      return jsonResult(await handler(store, input));
    } catch (error) {
      return publicToolError(error);
    }
  });
}

export function registerMemoryMcpTools(server, store) {
  if (!server || typeof server.registerTool !== 'function') {
    throw new TypeError('A compatible MCP server is required');
  }
  if (!store || typeof store.status !== 'function') {
    throw new TypeError('A Safire memory store is required');
  }
  assertPortableMemoryStore(store);
  installSensitivePropertyNamePreflight(server);

  registerJsonTool(
    server,
    store,
    'memory_record_events',
    'Append strict, attributed events to Safire memory. Attribution identity and trust come only from the configured profile.',
    (memoryStore, { events }) => memoryStore.recordEvents(events),
  );
  registerJsonTool(
    server,
    store,
    'memory_search',
    'Search accessible Safire memories within the configured profile namespace grants.',
    (memoryStore, input) => memoryStore.search(input),
  );
  registerJsonTool(
    server,
    store,
    'memory_get',
    'Get one accessible Safire event-backed memory by exact event or memory ID.',
    (memoryStore, { id, include_feedback, include_relations }) => memoryStore.get(id, {
      includeFeedback: include_feedback,
      includeRelations: include_relations,
    }),
  );
  registerJsonTool(
    server,
    store,
    'memory_record_feedback',
    'Append actor-attributed feedback to accessible Safire memory records.',
    (memoryStore, { feedback }) => memoryStore.recordFeedback(feedback),
  );
  registerJsonTool(
    server,
    store,
    'memory_recall',
    'Recall multiple accessible Safire event-backed memories by exact ID.',
    (memoryStore, { ids, include_feedback, include_relations }) => memoryStore.recall(ids, {
      includeFeedback: include_feedback,
      includeRelations: include_relations,
    }),
  );
  registerJsonTool(
    server,
    store,
    'memory_status',
    'Report Safire memory availability, profile identity, schema version, and record counts without exposing memory contents.',
    memoryStore => memoryStore.status(),
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
