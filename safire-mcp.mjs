import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createNotesMcpService, publicNotesMcpError } from './lib/notes-mcp-service.mjs';
import vaultConfig from './vault-config.cjs';

const { resolveVaultPath } = vaultConfig;

function argumentValue(name) {
  const prefixed = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const vaultDir = resolveVaultPath({ vaultDir: argumentValue('--vault') });
const notes = await createNotesMcpService({ vaultDir });

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolError(error) {
  return { content: [{ type: 'text', text: publicNotesMcpError(error, vaultDir) }], isError: true };
}

function registerTool(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (input) => {
    try {
      return jsonResult(await handler(input));
    } catch (error) {
      return toolError(error);
    }
  });
}

const server = new McpServer({ name: 'safire', version: '1.4.1' });

registerTool(
  server,
  'list_notes',
  'List Markdown notes in the Safire vault. Supplying a query searches note paths and contents.',
  { query: z.string().trim().max(300).optional().describe('Optional text to search for.') },
  async ({ query }) => notes.listNotes(query),
);

registerTool(
  server,
  'read_note',
  'Read one Markdown note from the Safire vault.',
  { path: z.string().trim().min(1).max(500).describe('Vault-relative note path, such as Projects/Plan.md.') },
  async ({ path: notePath }) => notes.readNote(notePath),
);

registerTool(
  server,
  'create_note',
  'Create a new Markdown note. This refuses to overwrite an existing note.',
  {
    path: z.string().trim().min(1).max(500).describe('Vault-relative path for the new note.'),
    content: z.string().max(1_000_000).optional().describe('Markdown body. Safire creates a title heading when omitted.'),
  },
  async ({ path: notePath, content }) => notes.createNote(notePath, content),
);

registerTool(
  server,
  'update_note',
  'Create or replace a Markdown note. Replacing an existing note creates a dated Safire backup first.',
  {
    path: z.string().trim().min(1).max(500).describe('Vault-relative path for the note.'),
    content: z.string().max(1_000_000).describe('Complete replacement Markdown body.'),
  },
  async ({ path: notePath, content }) => notes.updateNote(notePath, content),
);

registerTool(
  server,
  'quick_capture',
  'Save a short thought to a new Safire Inbox note.',
  {
    text: z.string().trim().min(1).max(10_000).describe('Text to capture.'),
    tag: z.string().trim().max(80).optional().describe('Optional simple tag, without the # prefix.'),
  },
  async ({ text, tag }) => notes.quickCapture(text, tag),
);

registerTool(
  server,
  'list_tasks',
  'List Markdown checklist tasks across the Safire vault.',
  { state: z.enum(['open', 'completed', 'all']).optional().describe('Which tasks to return. Defaults to open.') },
  async ({ state }) => notes.listTasks(state),
);

registerTool(
  server,
  'toggle_task',
  'Toggle a Markdown checklist task at a known note path and line number. Safire makes a backup first.',
  {
    path: z.string().trim().min(1).max(500).describe('Vault-relative note path containing the task.'),
    line: z.number().int().positive().describe('One-based line number of the task.'),
  },
  async ({ path: notePath, line }) => notes.toggleTask(notePath, line),
);

registerTool(
  server,
  'vault_health',
  'Get Safire vault health counts, missing wiki links, orphan notes, and backup count.',
  {},
  async () => notes.vaultHealth(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
