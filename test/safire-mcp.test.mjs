import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERIC_INDEX_LIMITS, GRAPH_STORAGE_LIMITS } from '../lib/graph-policy.mjs';
import vaultConfig from '../vault-config.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpEntry = path.join(projectRoot, 'safire-mcp.mjs');
const packageVersion = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
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

async function snapshotFileTree(root) {
  const snapshot = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) snapshot.push([relative, (await fs.readFile(absolute)).toString('base64')]);
      else snapshot.push([relative, entry.isSymbolicLink() ? 'symbolic-link' : 'other']);
    }
  }
  await visit(root);
  return snapshot;
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
  assert.equal(initialized.result.serverInfo.version, packageVersion);
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

test('Safire MCP omits oversized imported bodies from list and search indexes but preserves explicit reads', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-oversized-'));
  const marker = 'MCP-OVERSIZED-IMPORTED-MARKER';
  const content = `# Oversized\n\n${marker}\n${'Z'.repeat(GRAPH_STORAGE_LIMITS.noteBytes)}\n`;
  await fs.writeFile(path.join(vault, 'Oversized.md'), content, 'utf8');
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-oversized-index-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/call', { name: 'list_notes', arguments: {} });
  const metadata = JSON.parse(listed.result.content[0].text).notes.find(note => note.path === 'Oversized.md');
  assert.equal(metadata.contentOmitted, true);
  assert.deepEqual({ tags: metadata.tags, links: metadata.links, excerpt: metadata.excerpt }, { tags: [], links: [], excerpt: '' });

  const searched = await client.request('tools/call', { name: 'list_notes', arguments: { query: marker } });
  assert.deepEqual(JSON.parse(searched.result.content[0].text).results, []);

  const explicit = await client.request('tools/call', { name: 'read_note', arguments: { path: 'Oversized.md' } });
  assert.match(explicit.result.content[0].text, new RegExp(marker));
});

test('real stdio MCP generic indexes cap imported metadata and pretty-JSON response bytes', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-index-budget-'));
  await fs.writeFile(path.join(vault, 'Task Amplifier.md'), Array(90_000).fill('- [ ] x').join('\n'), 'utf8');
  for (let file = 0; file < 4; file += 1) {
    const tags = Array.from(
      { length: 75_000 },
      (_value, index) => `#tag${file}${String(index).padStart(5, '0')}`,
    ).join(' ');
    await fs.writeFile(path.join(vault, `Tag Amplifier ${file}.md`), `common-mcp-index-marker\n${tags}`, 'utf8');
  }
  const backupRoot = path.join(vault, '.safire-backups');
  await fs.mkdir(backupRoot, { recursive: true });
  await Promise.all(Array.from({ length: GENERIC_INDEX_LIMITS.backups + 1 }, (_value, index) => (
    fs.writeFile(path.join(backupRoot, `Imported${String(index).padStart(4, '0')}.md.${index}.bak`), 'legacy')
  )));
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-index-budget-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const listedCall = await client.request('tools/call', { name: 'list_notes', arguments: {} });
  const listedText = listedCall.result.content[0].text;
  const listed = JSON.parse(listedText);
  assert.equal(listed.meta.responseBytes, Buffer.byteLength(listedText, 'utf8'));
  assert.ok(listed.meta.responseBytes <= GENERIC_INDEX_LIMITS.responseBytes);
  assert.equal(listed.meta.truncated, true);

  const searchedCall = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'common-mcp-index-marker' },
  });
  const searchedText = searchedCall.result.content[0].text;
  const searched = JSON.parse(searchedText);
  assert.equal(searched.results.length, 4);
  assert.equal(searched.meta.responseBytes, Buffer.byteLength(searchedText, 'utf8'));
  assert.ok(searched.meta.responseBytes <= GENERIC_INDEX_LIMITS.responseBytes);

  const taskCall = await client.request('tools/call', { name: 'list_tasks', arguments: { state: 'all' } });
  const taskText = taskCall.result.content[0].text;
  const tasks = JSON.parse(taskText);
  assert.equal(tasks.tasks.length, GENERIC_INDEX_LIMITS.tasks);
  assert.equal(tasks.meta.tasksComplete, false);
  assert.equal(tasks.meta.responseBytes, Buffer.byteLength(taskText, 'utf8'));
  assert.ok(tasks.meta.responseBytes <= GENERIC_INDEX_LIMITS.responseBytes);

  const healthCall = await client.request('tools/call', { name: 'vault_health', arguments: {} });
  const healthText = healthCall.result.content[0].text;
  const health = JSON.parse(healthText);
  assert.equal(health.meta.backupsComplete, false);
  assert.equal(health.meta.truncated, true);
  assert.equal(health.meta.responseBytes, Buffer.byteLength(healthText, 'utf8'));
  assert.ok(health.meta.responseBytes <= GENERIC_INDEX_LIMITS.responseBytes);
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

test('Safire MCP neither lists nor toggles a structurally private evidence task', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-private-task-'));
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });
  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-private-task-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');
  const content = [
    '# Private task fixture',
    '',
    '> ~~~safire-evidence',
    '> private_notes: |',
    '- [ ] SYNTHETIC-MCP-PRIVATE-TASK #mcp-private [[MCP Private Link]]',
    '> ~~~',
    '',
    '- [ ] Public MCP task',
    '',
  ].join('\n');
  await client.request('tools/call', {
    name: 'create_note',
    arguments: { path: 'Private Tasks.md', content },
  });
  const tasks = await client.request('tools/call', { name: 'list_tasks', arguments: { state: 'all' } });
  assert.doesNotMatch(tasks.result.content[0].text, /SYNTHETIC-MCP-PRIVATE-TASK|mcp-private|MCP Private Link/);
  assert.match(tasks.result.content[0].text, /Public MCP task/);

  const toggle = await client.request('tools/call', {
    name: 'toggle_task',
    arguments: { path: 'Private Tasks.md', line: 5 },
  });
  assert.equal(toggle.result.isError, true);
  assert.equal(await fs.readFile(path.join(vault, 'Private Tasks.md'), 'utf8'), content);
  const backups = await fs.readdir(path.join(vault, '.safire-backups'), { recursive: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(backups, []);
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

test('Safire MCP fails closed for malformed flow and evidence-like fences while parsing public multiline receipts', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-structural-evidence-'));
  const noteContent = [
    '# Structural evidence',
    '',
    'Outside prose #outside [[Outside Link]].',
    '',
    '```safire-evidence',
    'id: flow-private-id',
    'private_notes: [FLOW-PRIVATE-PREFIX',
    'claim: FLOW-PRIVATE-CONTINUATION #flow-private [[Flow Private Link]]',
    'status: verified',
    '```',
    '',
    '~~~~SAFIRE-EVIDENCE',
    'id: multiline-public',
    'claim: >-',
    '  Public multiline line one: with colon',
    '  Public multiline line two',
    'source_type: manual_observation',
    'status: verified',
    'private_notes: |-',
    '  TILDE-PRIVATE #tilde-private [[Tilde Private Link]]',
    '~~~~',
    '',
    '```safire-evidence extra',
    'claim: MALFORMED-INFO-PUBLIC',
    'private_notes: MALFORMED-INFO-PRIVATE #malformed-private [[Malformed Private Link]]',
    '```',
  ].join('\r\n');
  await fs.writeFile(path.join(vault, 'Structural Evidence.md'), noteContent, 'utf8');
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-structural-evidence-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/call', { name: 'list_notes', arguments: {} });
  const metadata = JSON.parse(listed.result.content[0].text).notes.find(note => note.path === 'Structural Evidence.md');
  assert.deepEqual(metadata.tags, ['outside']);
  assert.deepEqual(metadata.links, ['Outside Link']);
  assert.doesNotMatch(JSON.stringify(metadata), /FLOW-PRIVATE|flow-private|TILDE-PRIVATE|tilde-private|MALFORMED-INFO|malformed-private|Private Link/);

  for (const query of [
    'FLOW-PRIVATE-PREFIX',
    'FLOW-PRIVATE-CONTINUATION',
    'TILDE-PRIVATE',
    'MALFORMED-INFO-PUBLIC',
    'MALFORMED-INFO-PRIVATE',
  ]) {
    const searched = await client.request('tools/call', { name: 'list_notes', arguments: { query } });
    const payload = JSON.parse(searched.result.content[0].text);
    assert.deepEqual(payload.results, [], `${query} must not be searchable`);
    assert.doesNotMatch(JSON.stringify(payload), /FLOW-PRIVATE|TILDE-PRIVATE|MALFORMED-INFO|Private Link/);
  }

  const publicSearch = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'Public multiline line one' },
  });
  const publicPayload = JSON.parse(publicSearch.result.content[0].text);
  assert.equal(publicPayload.results.length, 1);
  assert.equal(publicPayload.results[0].evidence.receipts.length, 1);
  assert.equal(publicPayload.results[0].evidence.receipts[0].id, 'multiline-public');
  assert.equal(publicPayload.results[0].evidence.receipts[0].claim, 'Public multiline line one: with colon Public multiline line two');
  assert.equal(publicPayload.results[0].evidence.receipts[0].status, 'verified');
  assert.equal(publicPayload.results[0].evidence.receipts[0].sourceType, 'manual_observation');
  assert.equal(publicPayload.results[0].evidence.receipts[0].privateNotes, undefined);
  assert.doesNotMatch(JSON.stringify(publicPayload), /FLOW-PRIVATE|TILDE-PRIVATE|MALFORMED-INFO|Private Link/);
});

test('Safire MCP projects list-contained and malformed-family evidence and rejects private list-task toggles byte-for-byte', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-list-evidence-'));
  const notePath = path.join(vault, 'List Evidence.md');
  const backupSentinel = path.join(vault, '.safire-backups', 'sentinel', 'keep.bak');
  const noteContent = [
    '# List evidence',
    '- ~~~safire-evidence',
    '  id: list-public',
    '  claim: Public list claim #list-public [[List Public Link]]',
    '  private_notes: |-',
    '    - [ ] MCP-LIST-PRIVATE-TASK #list-private [[List Private Link]]',
    '  ~~~',
    '- [ ] Public outside task',
    '> 1. ~~~safire-evidence extra',
    '>    claim: MALFORMED-LIST-PUBLIC',
    '>    private_notes: MALFORMED-LIST-PRIVATE #malformed-private [[Malformed Private Link]]',
    '>    - [ ] MALFORMED-LIST-PRIVATE-TASK',
    '>    ~~~',
    '- ```safire-private-evidence+yaml',
    '  claim: MCP-FAMILY-QUERY ECHO-MCP-FAMILY-PRIVATE #family-private [[Family Private Link]]',
    '  private_notes: ECHO-MCP-FAMILY-NOTES',
    '  - [ ] MCP-FAMILY-TASK ECHO-MCP-FAMILY-TASK-PRIVATE',
    '  ```',
  ].join('\r\n');
  await fs.mkdir(path.dirname(backupSentinel), { recursive: true });
  await fs.writeFile(notePath, noteContent, 'utf8');
  await fs.writeFile(backupSentinel, 'unchanged backup sentinel', 'utf8');
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-list-evidence-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/call', { name: 'list_notes', arguments: {} });
  const metadata = JSON.parse(listed.result.content[0].text).notes.find(note => note.path === 'List Evidence.md');
  assert.deepEqual(metadata.tags, ['list-public']);
  assert.deepEqual(metadata.links, ['List Public Link']);
  assert.doesNotMatch(JSON.stringify(metadata), /MCP-LIST-PRIVATE|list-private|MALFORMED-LIST|malformed-private|ECHO-MCP-FAMILY|family-private|Private Link/);

  for (const query of ['MCP-LIST-PRIVATE-TASK', 'MALFORMED-LIST-PUBLIC', 'MALFORMED-LIST-PRIVATE', 'MCP-FAMILY-QUERY', 'MCP-FAMILY-TASK']) {
    const searched = await client.request('tools/call', { name: 'list_notes', arguments: { query } });
    const searchedPayload = JSON.parse(searched.result.content[0].text);
    assert.deepEqual(searchedPayload.results, []);
    assert.doesNotMatch(JSON.stringify(searchedPayload), /ECHO-MCP-FAMILY|family-private|Family Private Link/);
  }
  const publicSearch = await client.request('tools/call', { name: 'list_notes', arguments: { query: 'Public list claim' } });
  const publicPayload = JSON.parse(publicSearch.result.content[0].text);
  assert.equal(publicPayload.results.length, 1);
  assert.equal(publicPayload.results[0].evidence.receipts[0].claim, 'Public list claim #list-public [[List Public Link]]');
  assert.doesNotMatch(JSON.stringify(publicPayload), /MCP-LIST-PRIVATE|MALFORMED-LIST|ECHO-MCP-FAMILY|Private Link/);

  const tasks = await client.request('tools/call', { name: 'list_tasks', arguments: { state: 'all' } });
  assert.deepEqual(JSON.parse(tasks.result.content[0].text).tasks.map(task => ({ line: task.line, text: task.text })), [
    { line: 8, text: 'Public outside task' },
  ]);

  const before = await snapshotFileTree(vault);
  for (const privateLine of [6, 12, 17]) {
    const rejected = await client.request('tools/call', {
      name: 'toggle_task',
      arguments: { path: 'List Evidence.md', line: privateLine },
    });
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.content[0].text, 'No supported public task exists on that line');
    assert.deepEqual(await snapshotFileTree(vault), before);
  }
});

test('Safire MCP omits private tasks and rejects their toggles without changing note or backup bytes', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-private-tasks-'));
  const notePath = path.join(vault, 'Private Tasks.md');
  const noteContent = [
    '- [ ] Public first',
    '',
    '```safire-evidence',
    'private_notes: |-',
    '  - [ ] Standard private task',
    '```',
    '> ```safire-evidence',
    '- [ ] Malformed-depth private task',
    '> ```',
    '~~~safire-evidence',
    'private_notes: |-',
    '  - [ ] Tilde private task',
    '~~~',
    '- [x] Public second',
    '```safire-evidence extra',
    '- [ ] Malformed-info private task',
    '```',
    '```safire-evidence',
    'private_notes: |-',
    '- [ ] Unclosed private task',
  ].join('\r\n');
  const backupSentinel = path.join(vault, '.safire-backups', 'sentinel', 'keep.bak');
  await fs.mkdir(path.dirname(backupSentinel), { recursive: true });
  await fs.writeFile(notePath, noteContent, 'utf8');
  await fs.writeFile(backupSentinel, 'unchanged backup sentinel', 'utf8');
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-private-task-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const tasks = await client.request('tools/call', { name: 'list_tasks', arguments: { state: 'all' } });
  const taskPayload = JSON.parse(tasks.result.content[0].text);
  assert.deepEqual(taskPayload.tasks.map(task => ({ line: task.line, text: task.text })), [
    { line: 1, text: 'Public first' },
    { line: 14, text: 'Public second' },
  ]);
  assert.doesNotMatch(JSON.stringify(taskPayload), /Standard private|Malformed-depth private|Tilde private|Malformed-info private|Unclosed private/i);

  const before = await snapshotFileTree(vault);
  for (const privateLine of [5, 8, 12, 16, 20]) {
    const rejected = await client.request('tools/call', {
      name: 'toggle_task',
      arguments: { path: 'Private Tasks.md', line: privateLine },
    });
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.content[0].text, 'No supported public task exists on that line');
    assert.equal(JSON.stringify(rejected).includes(path.resolve(vault)), false);
    assert.deepEqual(await snapshotFileTree(vault), before, `line ${privateLine} rejection must be byte-preserving`);
  }
  assert.equal(client.stderr().includes(path.resolve(vault)), false);
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

test('Safire MCP rejects control-directory mutation paths without leaving a lock gate', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-reserved-path-'));
  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-reserved-path-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const lockDirectory = path.join(vault, '.safire-note-mutations.lock');
  for (const reservedPath of [
    '.safire-note-mutations.lock/Poison.md',
    'Nested/.safire/Poison.md',
    'Nested/.safire-backups/Poison.md',
  ]) {
    const rejected = await client.request('tools/call', {
      name: 'create_note',
      arguments: { path: reservedPath, content: 'synthetic poison' },
    });
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.content[0].text, 'Safire internal paths are reserved');
    assert.equal(JSON.stringify(rejected).includes(reservedPath), false);
    await assert.rejects(() => fs.access(path.join(vault, reservedPath)), { code: 'ENOENT' });
    await assert.rejects(() => fs.access(lockDirectory), { code: 'ENOENT' });
  }

  if (process.platform === 'win32') {
    for (const [toolName, reservedPath] of [
      ['create_note', 'SAFIRE~1.LOC/Poison.md'],
      ['update_note', '.safire-note-mutations.lock::$INDEX_ALLOCATION/Poison.md'],
    ]) {
      const rejected = await client.request('tools/call', {
        name: toolName,
        arguments: { path: reservedPath, content: 'synthetic Windows alias poison' },
      });
      assert.equal(rejected.result.isError, true);
      assert.equal(rejected.result.content[0].text, 'Safire internal paths are reserved');
      assert.equal(JSON.stringify(rejected).includes(reservedPath), false);
      await assert.rejects(() => fs.access(path.join(vault, reservedPath)), { code: 'ENOENT' });
      await assert.rejects(() => fs.access(lockDirectory), { code: 'ENOENT' });
    }
  }

  const ordinary = await client.request('tools/call', {
    name: 'create_note',
    arguments: { path: 'After Rejection.md', content: 'ordinary success' },
  });
  assert.equal(ordinary.result.isError, undefined);
  assert.equal(await fs.readFile(path.join(vault, 'After Rejection.md'), 'utf8'), 'ordinary success');
  await assert.rejects(() => fs.access(lockDirectory), { code: 'ENOENT' });
  assert.equal(client.stderr().includes(path.resolve(vault)), false);
});

test('Safire MCP generic indexes exclude ordinary fenced code while read_note retains it', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-mcp-ordinary-code-'));
  const hiddenTerms = [
    'MCP-BACKTICK-CODE',
    'MCP-TILDE-CODE',
    'MCP-QUOTE-CODE',
    'MCP-LIST-CODE',
    'MCP-INNER-TILDE-CODE',
    'MCP-INNER-BACKTICK-CODE',
    'MCP-INNER-DOUBLE-QUOTED-CODE',
    'MCP-INNER-SINGLE-QUOTED-CODE',
    'MCP-INNER-FLOW-CODE',
  ];
  const noteContent = [
    '# MCP generic projection',
    '',
    'Visible prose #visible [[Visible Target]]',
    '',
    '```text',
    'MCP-BACKTICK-CODE #backtick-code [[Backtick Destination]]',
    '```',
    '',
    '~~~~text',
    'MCP-TILDE-CODE #tilde-code [[Tilde Destination]]',
    '~~~~',
    '',
    '> `````text',
    '> MCP-QUOTE-CODE #quote-code [[Quote Destination]]',
    '> ```',
    '> `````',
    '',
    '3. ~~~~text',
    '   MCP-LIST-CODE #list-code [[List Destination]]',
    '   - [ ] MCP-LIST-CODE-TASK',
    '   ~~~~',
    '',
    '```safire-evidence',
    'id: public-mcp-receipt',
    'claim: MCP-PUBLIC-EVIDENCE #public-evidence [[Public Evidence Destination]]',
    'status: verified',
    'private_notes: MCP-PRIVATE-EVIDENCE #private-evidence [[Private Evidence Destination]]',
    '```',
    '',
    '````safire-evidence',
    'id: nested-mcp-tilde',
    'claim: |',
    '  ~~~text',
    '  MCP-INNER-TILDE-CODE #inner-tilde-code [[Inner Tilde Destination]]',
    '  ~~~',
    'status: verified',
    '````',
    '',
    '~~~~safire-evidence',
    'id: nested-mcp-backtick',
    'claim: |',
    '  ```text',
    '  MCP-INNER-BACKTICK-CODE #inner-backtick-code [[Inner Backtick Destination]]',
    '  ```',
    'status: verified',
    '~~~~',
    '',
    '````safire-evidence',
    'id: nested-mcp-double-quoted',
    'claim: "Visible double-quoted claim',
    '~~~text',
    'MCP-INNER-DOUBLE-QUOTED-CODE #inner-double-code [[Inner Double Destination]]',
    '~~~',
    '"',
    'status: verified',
    '````',
    '',
    '~~~~safire-evidence',
    'id: nested-mcp-single-quoted',
    "claim: 'Visible single-quoted claim",
    '```text',
    'MCP-INNER-SINGLE-QUOTED-CODE #inner-single-code [[Inner Single Destination]]',
    '```',
    "'",
    'status: verified',
    '~~~~',
    '',
    '````safire-evidence',
    'id: nested-mcp-flow',
    'claim: [',
    '  Visible flow claim,',
    '  ~~~text,',
    '  MCP-INNER-FLOW-CODE #inner-flow-code [[Inner Flow Destination]],',
    '  ~~~',
    ']',
    'status: verified',
    '````',
  ].join('\n');
  await fs.writeFile(path.join(vault, 'Ordinary Code.md'), noteContent, 'utf8');

  const client = createClient({ vaultDir: vault });
  t.after(async () => {
    await client.close();
    await fs.rm(vault, { recursive: true, force: true });
  });
  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'safire-ordinary-code-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/call', { name: 'list_notes', arguments: {} });
  const listedPayload = JSON.parse(listed.result.content[0].text);
  const metadata = listedPayload.notes.find(note => note.path === 'Ordinary Code.md');
  assert.deepEqual(metadata.tags, ['public-evidence', 'visible']);
  assert.deepEqual(metadata.links, ['Visible Target', 'Public Evidence Destination']);

  for (const hidden of hiddenTerms) {
    const searched = await client.request('tools/call', { name: 'list_notes', arguments: { query: hidden } });
    assert.deepEqual(JSON.parse(searched.result.content[0].text).results, [], `${hidden} must not be searchable`);
  }
  const tasks = await client.request('tools/call', { name: 'list_tasks', arguments: { state: 'all' } });
  assert.equal(JSON.stringify(tasks).includes('MCP-LIST-CODE-TASK'), false);
  const health = await client.request('tools/call', { name: 'vault_health', arguments: {} });
  const publicSearch = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'MCP-PUBLIC-EVIDENCE' },
  });
  const visibleSearch = await client.request('tools/call', {
    name: 'list_notes',
    arguments: { query: 'Visible prose' },
  });
  assert.equal(JSON.parse(visibleSearch.result.content[0].text).results.some(result => result.path === 'Ordinary Code.md'), true);
  const genericOutput = JSON.stringify({ listed, tasks, health, publicSearch, visibleSearch });
  assert.doesNotMatch(genericOutput, /MCP-(?:BACKTICK|TILDE|QUOTE|LIST|INNER-TILDE|INNER-BACKTICK|INNER-DOUBLE-QUOTED|INNER-SINGLE-QUOTED|INNER-FLOW)-CODE|(?:backtick|tilde|quote|list|inner-tilde|inner-backtick|inner-double|inner-single|inner-flow)-code|(?:Backtick|Tilde|Quote|List|Inner Tilde|Inner Backtick|Inner Double|Inner Single|Inner Flow) Destination|MCP-PRIVATE-EVIDENCE|private-evidence|Private Evidence Destination/);
  assert.match(genericOutput, /MCP-PUBLIC-EVIDENCE|public-evidence|Public Evidence Destination/);

  const explicit = await client.request('tools/call', {
    name: 'read_note',
    arguments: { path: 'Ordinary Code.md' },
  });
  const explicitPayload = JSON.parse(explicit.result.content[0].text);
  for (const hidden of hiddenTerms) assert.match(explicitPayload.content, new RegExp(hidden));
  assert.match(explicitPayload.content, /MCP-PRIVATE-EVIDENCE/);
  assert.equal(client.stderr().includes(path.resolve(vault)), false);
});
