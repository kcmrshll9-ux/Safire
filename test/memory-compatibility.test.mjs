import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import { createMemoryStore } from '../lib/memory/store.mjs';
import { startSafireServer } from '../server.mjs';

function profile() {
  return createPortableMcpProfile({
    profileId: 'profile:compatibility-agent',
    principal: { id: 'agent:compatibility', type: 'agent' },
    agentInstance: { id: 'agent_instance:compatibility:test', type: 'agent_instance' },
    ingestedBy: { id: 'adapter:safire-memory-mcp:compatibility' },
    sourceIdentity: 'mcp:compatibility',
    allowedActors: [{ id: 'unknown:legacy-markdown', type: 'unknown' }],
    namespaceGrants: [{ namespace: 'agents/compatibility', read: true, write: true, descendants: true }],
  });
}

test('memory sidecars remain invisible to existing Markdown notes, search, graph, and health', async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-memory-compat-'));
  await fs.writeFile(path.join(vault, 'Visible.md'), '# Visible\n\nordinary phrase\n', 'utf8');
  const store = createMemoryStore({ vaultDir: vault, profile: profile() });
  await store.recordEvents([{
    schema_version: 1,
    namespace: 'agents/compatibility',
    actor_type: 'agent',
    actor_id: 'agent:compatibility',
    kind: 'visible_agent_response',
    speech_act: 'assertion',
    content: 'sidecar-only invented phrase',
    occurred_at: '2026-08-14T17:00:00.000Z',
    source: { stream: 'compatibility.test', event_id: 'event.1' },
  }]);
  await store.recordEvents([{
    schema_version: 1,
    namespace: 'agents/compatibility',
    actor_type: 'unknown',
    actor_id: 'unknown:legacy-markdown',
    kind: 'external_observation',
    speech_act: 'unknown',
    content: 'An explicitly submitted observation of the legacy Visible.md note.',
    occurred_at: '2026-08-14T17:01:00.000Z',
    attributes: { legacy_markdown: true },
    source: { stream: 'legacy.markdown', event_id: 'visible.md.explicit-observation' },
  }]);
  const legacyObservation = await store.search({ query: 'legacy Visible.md' });
  assert.equal(legacyObservation.results[0].actor.type, 'unknown');
  assert.notEqual(legacyObservation.results[0].actor.type, 'user');

  const started = await startSafireServer({ vaultDir: vault, port: 0, log: () => {} });
  t.after(async () => {
    await new Promise((resolve) => started.server.close(resolve));
    await fs.rm(vault, { recursive: true, force: true });
  });

  const notes = await fetch(`${started.url}/api/notes`).then((response) => response.json());
  assert.deepEqual(notes.notes.map((note) => note.path), ['Visible.md']);
  assert.equal(notes.notes.some((note) => note.path.includes('.safire')), false);
  const ordinarySearch = await fetch(`${started.url}/api/search?q=ordinary%20phrase`).then((response) => response.json());
  assert.deepEqual(ordinarySearch.results.map((note) => note.path), ['Visible.md']);
  const sidecarSearch = await fetch(`${started.url}/api/search?q=sidecar-only`).then((response) => response.json());
  assert.deepEqual(sidecarSearch.results, []);
  const graph = await fetch(`${started.url}/api/graph`).then((response) => response.json());
  assert.deepEqual(graph.nodes.map((node) => node.id), ['Visible.md']);
  assert.equal(graph.nodes.some((node) => node.id.includes('.safire')), false);
  const health = await fetch(`${started.url}/api/vault-health`).then((response) => response.json());
  assert.equal(health.noteCount, 1);
});
