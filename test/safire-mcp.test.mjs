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
const denyNetworkListenFixture = path.join(projectRoot, 'test', 'fixtures', 'deny-network-listen.cjs');

function createClient({ vaultDir, configPath, useVaultArgument = true, extraEnv = {} }) {
  const args = [mcpEntry];
  if (useVaultArgument && vaultDir) args.push('--vault', vaultDir);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, ...(configPath ? { SAFIRE_VAULT_CONFIG_PATH: configPath } : {}), ...extraEnv },
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
  return { request, notify, close, stderr: () => stderr };
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
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name).sort(),
    [
      'create_note',
      'list_notes',
      'list_tasks',
      'quick_capture',
      'read_note',
      'toggle_task',
      'update_note',
      'vault_health',
    ],
  );

  const created = await client.request('tools/call', {
    name: 'create_note',
    arguments: { path: 'Projects/MCP.md', content: '# MCP\n\n- [ ] Verify integration\n' },
  });
  assert.match(created.result.content[0].text, /Projects\/MCP\.md/);

  const read = await client.request('tools/call', {
    name: 'read_note',
    arguments: { path: 'Projects/MCP.md' },
  });
  assert.match(read.result.content[0].text, /Verify integration/);

  const search = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'integration' },
  });
  assert.match(search.result.content[0].text, /Projects\/MCP\.md/);

  const tasks = await client.request('tools/call', {
    name: 'list_tasks',
    arguments: { state: 'open' },
  });
  assert.match(tasks.result.content[0].text, /Verify integration/);

  const toggled = await client.request('tools/call', {
    name: 'toggle_task',
    arguments: { path: 'Projects/MCP.md', line: 3 },
  });
  assert.match(toggled.result.content[0].text, /Verify integration/);

  const updated = await client.request('tools/call', {
    name: 'update_note',
    arguments: { path: 'Projects/MCP.md', content: '# MCP updated\n' },
  });
  assert.match(updated.result.content[0].text, /\.safire-backups/);
  assert.equal(await fs.readFile(path.join(vault, 'Projects', 'MCP.md'), 'utf8'), '# MCP updated\n');

  const captured = await client.request('tools/call', {
    name: 'quick_capture',
    arguments: { text: 'Scoped MCP capture', tag: 'mcp' },
  });
  assert.match(captured.result.content[0].text, /Inbox\//);

  const health = await client.request('tools/call', { name: 'vault_health', arguments: {} });
  assert.match(health.result.content[0].text, /"noteCount"/);
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

test('Safire MCP vault health rejects a junction at the backup root without traversing it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-backup-junction-'));
  const vault = path.join(root, 'vault');
  const outside = path.join(root, 'outside-backups');
  const sentinel = path.join(outside, 'outside-sentinel.bak');
  await fs.mkdir(vault);
  await fs.mkdir(outside);
  await fs.writeFile(sentinel, 'outside backup sentinel', 'utf8');
  try {
    await fs.symlink(outside, path.join(vault, '.safire-backups'), 'junction');
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    t.skip(`Windows junctions are unavailable in this environment: ${error.message}`);
    return;
  }

  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-backup-junction-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const health = await client.request('tools/call', { name: 'vault_health', arguments: {} });
  assert.equal(health.result.isError, true);
  assert.equal(health.result.content[0].text, 'Vault paths cannot use symlinks or junctions');
  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /backupCount|noteCount|outside-sentinel/i);
  assert.equal(serialized.includes(path.resolve(root)), false);
  assert.equal(client.stderr().includes(path.resolve(root)), false);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside backup sentinel');
});

test('Safire MCP metadata and search share the fail-closed public evidence projection', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-evidence-'));
  const noteContent = [
    '# Evidence note',
    '',
    'Visible prose #visible [[Visible Target]].',
    '',
    '```safire-evidence',
    'claim: "Public claim #public-evidence [[Public Evidence]]"',
    'status: verified',
    'private_notes: |',
    '  synthetic private search marker',
    '  #private-evidence [[Private Evidence]]',
    '```',
    '',
  ].join('\n');
  await fs.writeFile(path.join(vault, 'Evidence.md'), noteContent, 'utf8');
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-evidence-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/call', { name: 'list_notes', arguments: {} });
  const listedPayload = JSON.parse(listed.result.content[0].text);
  const evidenceMetadata = listedPayload.notes.find((note) => note.path === 'Evidence.md');
  assert.deepEqual(evidenceMetadata.tags, ['public-evidence', 'visible']);
  assert.deepEqual(evidenceMetadata.links, ['Visible Target', 'Public Evidence']);
  assert.doesNotMatch(JSON.stringify(evidenceMetadata), /private search marker|private-evidence|Private Evidence/i);

  const privateSearch = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'synthetic private search marker' },
  });
  assert.deepEqual(JSON.parse(privateSearch.result.content[0].text).results, []);

  const publicSearch = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'Public claim' },
  });
  const publicPayload = JSON.parse(publicSearch.result.content[0].text);
  assert.equal(publicPayload.results.length, 1);
  assert.deepEqual(publicPayload.results[0].tags, ['public-evidence', 'visible']);
  assert.deepEqual(publicPayload.results[0].links, ['Visible Target', 'Public Evidence']);
  assert.doesNotMatch(JSON.stringify(publicPayload.results[0]), /private search marker|private-evidence|Private Evidence/i);
});

test('Safire MCP excludes private nested blockquoted evidence from list and search', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-blockquote-evidence-'));
  const noteContent = [
    '# Blockquote evidence',
    '',
    'Outside prose #outside [[Outside Link]].',
    '',
    '> > ```safire-evidence',
    '> > id: "blockquote-valid"',
    '> > claim: >-',
    '> >   Public blockquote claim #quoted-public [[Quoted Public Link]]',
    '> > private_notes: |+',
    '> >   MCP-BLOCKQUOTE-PRIVATE #quoted-private [[Quoted Private Link]]',
    '> > ```',
    '',
    '> ```safire-evidence',
    '> id: "blockquote-malformed"',
    '> private_notes: "MCP-MALFORMED-PRIVATE',
    '> claim: MCP-PRIVATE-PROMOTION #promoted-private [[Promoted Private Link]]',
    '> ```',
    '',
    '> ```safire-evidence',
    '> private_notes: |',
    '>   MCP-UNCLOSED-PRIVATE #unclosed-private [[Unclosed Private Link]]',
  ].join('\r\n');
  await fs.writeFile(path.join(vault, 'Blockquote Evidence.md'), noteContent, 'utf8');
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-blockquote-evidence-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/call', { name: 'list_notes', arguments: {} });
  const listedPayload = JSON.parse(listed.result.content[0].text);
  const metadata = listedPayload.notes.find((note) => note.path === 'Blockquote Evidence.md');
  assert.deepEqual(metadata.tags, ['outside', 'quoted-public']);
  assert.deepEqual(metadata.links, ['Outside Link', 'Quoted Public Link']);
  assert.doesNotMatch(JSON.stringify(metadata), /MCP-(?:BLOCKQUOTE|MALFORMED|PRIVATE|UNCLOSED)|quoted-private|promoted-private|unclosed-private|Private Link/);

  for (const query of ['MCP-BLOCKQUOTE-PRIVATE', 'MCP-MALFORMED-PRIVATE', 'MCP-PRIVATE-PROMOTION', 'MCP-UNCLOSED-PRIVATE']) {
    const searched = await client.request('tools/call', { name: 'list_notes', arguments: { query } });
    assert.deepEqual(JSON.parse(searched.result.content[0].text).results, [], `${query} must not be searchable`);
  }
  const publicSearch = await client.request('tools/call', { name: 'list_notes', arguments: { query: 'Public blockquote claim' } });
  const publicPayload = JSON.parse(publicSearch.result.content[0].text);
  assert.equal(publicPayload.results.length, 1);
  assert.deepEqual(publicPayload.results[0].tags, ['outside', 'quoted-public']);
  assert.deepEqual(publicPayload.results[0].links, ['Outside Link', 'Quoted Public Link']);
  assert.doesNotMatch(JSON.stringify(publicPayload.results[0]), /MCP-(?:BLOCKQUOTE|MALFORMED|PRIVATE|UNCLOSED)|quoted-private|promoted-private|unclosed-private|Private Link/);
});

test('Safire MCP uses only its in-process eight-tool service and cannot reach hidden HTTP mutations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-isolation-'));
  const vault = path.join(root, 'vault');
  const outside = path.join(root, 'outside');
  const protectedNote = path.join(vault, 'Protected.md');
  const backup = path.join(vault, '.safire-backups', '2026-08-15', 'Protected.md.1.bak');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(protectedNote, '# Protected\n', 'utf8');
  await fs.writeFile(backup, '# Original backup\n', 'utf8');
  await fs.mkdir(path.join(vault, 'Blocked.md'));
  await fs.writeFile(path.join(outside, 'Outside.md'), '# Outside\n', 'utf8');
  let junctionAvailable = true;
  try {
    await fs.symlink(outside, path.join(vault, 'linked'), 'junction');
  } catch (error) {
    junctionAvailable = false;
    t.diagnostic(`Junction assertion skipped: ${error.message}`);
  }

  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${denyNetworkListenFixture}`].filter(Boolean).join(' ');
  const client = createClient({ vaultDir: vault, extraEnv: { NODE_OPTIONS: nodeOptions } });
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const initialized = await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-isolation-test', version: '1.0.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'safire');
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list');
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name).sort(),
    [
      'create_note',
      'list_notes',
      'list_tasks',
      'quick_capture',
      'read_note',
      'toggle_task',
      'update_note',
      'vault_health',
    ],
  );

  for (const name of ['delete_note', 'restore_backup']) {
    const rejected = await client.request('tools/call', { name, arguments: { path: 'Protected.md' } });
    assert.equal(rejected.result.isError, true, `${name} must not be callable`);
  }

  assert.equal(await fs.readFile(protectedNote, 'utf8'), '# Protected\n');
  assert.equal(await fs.readFile(backup, 'utf8'), '# Original backup\n');

  const missing = await client.request('tools/call', { name: 'read_note', arguments: { path: 'Missing.md' } });
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.content[0].text, 'The requested item was not found');

  const blocked = await client.request('tools/call', { name: 'read_note', arguments: { path: 'Blocked.md' } });
  assert.equal(blocked.result.isError, true);
  assert.equal(blocked.result.content[0].text, 'The requested item is not a file');

  const traversal = await client.request('tools/call', { name: 'create_note', arguments: { path: '../Escaped.md', content: 'escape' } });
  assert.equal(traversal.result.isError, true);
  await assert.rejects(fs.access(path.join(root, 'Escaped.md')));

  if (junctionAvailable) {
    const junction = await client.request('tools/call', { name: 'read_note', arguments: { path: 'linked/Outside.md' } });
    assert.equal(junction.result.isError, true);
    assert.equal(await fs.readFile(path.join(outside, 'Outside.md'), 'utf8'), '# Outside\n');
  }

  const serializedErrors = JSON.stringify([missing, blocked, traversal]);
  assert.equal(serializedErrors.includes(path.resolve(root)), false);
  assert.equal(client.stderr().includes(path.resolve(root)), false);

  const entrySource = await fs.readFile(mcpEntry, 'utf8');
  assert.doesNotMatch(entrySource, /startSafireServer|server\.mjs|\bfetch\s*\(/);
});
