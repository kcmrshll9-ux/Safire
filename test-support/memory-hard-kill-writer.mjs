import { createPortableMcpProfile } from '../lib/memory/profile.mjs';
import { createMemoryStore } from '../lib/memory/store.mjs';

const vault = process.argv[2];
if (typeof vault !== 'string' || !vault) throw new Error('A vault path is required');

const profile = createPortableMcpProfile({
  profileId: 'profile:hard-kill-writer',
  principal: { id: 'agent:hard-kill', type: 'agent', displayName: 'Hard-kill test agent' },
  agentInstance: { id: 'agent_instance:hard-kill:test', type: 'agent_instance' },
  ingestedBy: { id: 'adapter:safire-memory-mcp:hard-kill-test' },
  sourceIdentity: 'mcp:hard-kill-test',
  allowedActors: [],
  namespaceGrants: [
    { namespace: 'agents/hard-kill', read: true, write: true, descendants: true },
  ],
});

const keepAlive = setInterval(() => {}, 1_000);
let firstChildCommitted = false;
const store = createMemoryStore({
  vaultDir: vault,
  profile,
  faultInjector(stage) {
    if (stage !== 'after_idempotency_create' || firstChildCommitted) return undefined;
    firstChildCommitted = true;
    process.stdout.write('FIRST_CHILD_COMMITTED\n');
    return new Promise(() => {});
  },
});

await store.recordEvents(['turn.1', 'turn.2'].map(turnId => ({
  schema_version: 1,
  namespace: 'agents/hard-kill',
  actor_type: 'agent',
  actor_id: 'agent:hard-kill',
  agent_instance_id: 'agent_instance:hard-kill:test',
  kind: 'visible_agent_response',
  speech_act: 'proposal',
  content: `Recover every member of this batch after the writer is terminated (${turnId}).`,
  occurred_at: '2026-08-14T17:00:00.000Z',
  context: { conversation_id: 'hard-kill.recovery', turn_id: turnId },
  source: { stream: 'hard-kill.recovery', event_id: turnId },
})));

clearInterval(keepAlive);
