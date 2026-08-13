import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vaultConfig from '../vault-config.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpEntry = path.join(projectRoot, 'safire-mcp.mjs');

function createClient({ vaultDir, configPath, useVaultArgument = true }) {
  const args = [mcpEntry];
  if (useVaultArgument && vaultDir) args.push('--vault', vaultDir);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, ...(configPath ? { SAFIRE_VAULT_CONFIG_PATH: configPath } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr}`));
    }, 5000).unref();
  });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const close = async () => {
    child.stdin.end();
    if (!child.killed) child.kill();
  };
  return { request, notify, close };
}

test('Safire MCP exposes a scoped note workflow over stdio', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-test-'));
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  const initialized = await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-test', version: '1.0.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'safire');
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list');
  assert.ok(tools.result.tools.some((tool) => tool.name === 'create_note'));
  assert.ok(tools.result.tools.some((tool) => tool.name === 'vault_health'));
  assert.ok(!tools.result.tools.some((tool) => tool.name.includes('delete')));

  const created = await client.request('tools/call', {
    name: 'create_note',
    arguments: { path: 'Projects/MCP.md', content: '# MCP\n\n- [ ] Verify integration\n' },
  });
  assert.match(created.result.content[0].text, /Projects\/MCP\.md/);

  const search = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'integration' },
  });
  assert.match(search.result.content[0].text, /Projects\/MCP\.md/);

  const toggled = await client.request('tools/call', {
    name: 'toggle_task',
    arguments: { path: 'Projects/MCP.md', line: 3 },
  });
  assert.match(toggled.result.content[0].text, /Verify integration/);
});

test('Safire MCP follows the vault selected by the desktop app', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-selected-vault-'));
  const vault = path.join(root, 'Chosen Vault');
  const configPath = path.join(root, 'state', 'vault.json');
  vaultConfig.saveVaultPath(vault, { configPath });
  const client = createClient({ configPath, useVaultArgument: false });
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-selected-vault-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');
  const created = await client.request('tools/call', {
    name: 'create_note',
    arguments: { path: 'Projects/Shared Vault.md', content: '# Shared vault\n' },
  });
  assert.match(created.result.content[0].text, /Projects\/Shared Vault\.md/);
  assert.equal(await fs.readFile(path.join(vault, 'Projects', 'Shared Vault.md'), 'utf8'), '# Shared vault\n');
});
