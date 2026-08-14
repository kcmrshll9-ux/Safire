import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Windows packaging ships an externally launchable memory MCP runtime and documentation', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['mcp:memory'], 'node safire-memory-mcp.mjs');
  for (const entry of [
    'safire-memory-mcp.mjs',
    'safire-memory-mcp.cmd',
    'lib/memory/**/*',
    'docs/memory/**/*',
  ]) {
    assert.ok(packageJson.build.files.includes(entry), entry);
  }
  for (const entry of [
    'safire-memory-mcp.mjs',
    'lib/memory/**/*',
    'vault-config.cjs',
    'node_modules/**/*',
  ]) {
    assert.ok(packageJson.build.asarUnpack.includes(entry), entry);
  }
  assert.deepEqual(packageJson.build.extraResources, [
    { from: 'safire-memory-mcp.cmd', to: 'safire-memory-mcp.cmd' },
    { from: 'docs/memory', to: 'memory-docs' },
  ]);

  const launcher = await fs.readFile(path.join(projectRoot, 'safire-memory-mcp.cmd'), 'utf8');
  assert.match(launcher, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(launcher, /app\.asar\.unpacked\\safire-memory-mcp\.mjs/);
  assert.doesNotMatch(launcher, /https?:|powershell|curl|invoke-webrequest/i);
});

test('built Windows launcher serves the disabled memory MCP over stdio', {
  skip: process.env.SAFIRE_PACKAGED_MEMORY_LAUNCHER ? false : 'packaged launcher path not supplied',
}, async () => {
  const launcher = path.resolve(process.env.SAFIRE_PACKAGED_MEMORY_LAUNCHER);
  const transport = new StdioClientTransport({
    command: launcher,
    args: ['--disabled'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'safire-packaging-verifier', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'memory_record_events',
      'memory_search',
      'memory_get',
      'memory_record_feedback',
      'memory_recall',
      'memory_status',
    ]);
    const response = await client.callTool({ name: 'memory_status', arguments: {} });
    const status = JSON.parse(response.content[0].text);
    assert.equal(status.enabled, false);
    assert.equal(status.vault_id, null);
  } finally {
    await client.close();
  }
});

test('built Windows launcher records through its packaged runtime and installed example profile', {
  skip: process.env.SAFIRE_PACKAGED_MEMORY_LAUNCHER ? false : 'packaged launcher path not supplied',
}, async (t) => {
  const launcher = path.resolve(process.env.SAFIRE_PACKAGED_MEMORY_LAUNCHER);
  const resources = path.dirname(launcher);
  const installedProfilePath = path.join(
    resources,
    'memory-docs',
    'examples',
    'synthetic-portable-profile.json',
  );
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-packaged-memory-'));
  const profilePath = path.join(scratch, 'profile with spaces.json');
  const vault = path.join(scratch, 'vault with spaces');
  await fs.copyFile(installedProfilePath, profilePath);
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: launcher,
    args: ['--profile-config', profilePath, '--vault', vault],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'safire-packaged-runtime-verifier', version: '1.0.0' });
  try {
    await client.connect(transport);
    const recorded = await client.callTool({
      name: 'memory_record_events',
      arguments: {
        events: [{
          schema_version: 1,
          namespace: 'agents/synthetic',
          actor_type: 'agent',
          actor_id: 'agent:synthetic',
          agent_instance_id: 'agent_instance:synthetic:desktop',
          kind: 'visible_agent_response',
          speech_act: 'assertion',
          content: 'The installed Safire memory runtime completed its explicit package check.',
          occurred_at: '2026-08-14T12:00:00.000Z',
          source: { stream: 'packaging.verifier', event_id: 'event.1' },
        }],
      },
    });
    assert.equal(JSON.parse(recorded.content[0].text).created_count, 1);
    const searched = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'explicit package check' },
    });
    const result = JSON.parse(searched.content[0].text);
    assert.equal(result.count, 1);
    assert.equal(result.results[0].actor.id, 'agent:synthetic');
    assert.equal(result.results[0].source.identity, 'mcp:synthetic-local');
  } finally {
    await client.close();
  }
});
