import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrustedBridgeProfile } from '../lib/memory/profile.mjs';
import { MemorySchemaValidationError } from '../lib/memory/schema.mjs';
import {
  MemoryStore,
  createMemoryStore,
  createTrustedMemoryBridge,
} from '../lib/memory/store.mjs';

function profile() {
  return createTrustedBridgeProfile({
    profile_id: 'profile:trusted-ingress-test',
    principal: { id: 'agent:example', type: 'agent' },
    agent_instance: { id: 'agent_instance:example:bridge', type: 'agent_instance' },
    ingested_by: { id: 'adapter:trusted-bridge:test' },
    source_identity: 'bridge:trusted-ingress-test',
    accept_user_events: true,
    allowed_actors: [{ id: 'user:owner', type: 'user' }],
    namespace_grants: [
      { namespace: 'tests/trusted-ingress', read: true, write: true, descendants: true },
    ],
  });
}

function eventEnvelope(overrides = {}) {
  return {
    schema_version: 1,
    namespace: 'tests/trusted-ingress',
    kind: 'visible_user_message',
    speech_act: 'request',
    content: 'Please retain this visible authenticated request.',
    occurred_at: '2026-08-14T19:00:00.000Z',
    context: { conversation_id: 'trusted-ingress-test', message_id: 'message.1' },
    source: { stream: 'host:conversation', event_id: 'message.1' },
    ...overrides,
  };
}

function attributedEvent(overrides = {}) {
  return {
    ...eventEnvelope(),
    actor_type: 'user',
    actor_id: 'user:owner',
    agent_instance_id: 'agent_instance:example:bridge',
    ...overrides,
  };
}

function feedbackEnvelope(targetId, overrides = {}) {
  return {
    schema_version: 1,
    target: { type: 'event', id: targetId },
    signal: 'user_confirmed',
    source: { stream: 'host:feedback', event_id: 'feedback.1' },
    ...overrides,
  };
}

function attributedFeedback(targetId, overrides = {}) {
  return {
    ...feedbackEnvelope(targetId),
    actor_id: 'user:owner',
    ...overrides,
  };
}

async function temporaryVault(t) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'safire-trusted-ingress-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  return vault;
}

const PUBLIC_STORE_METHODS = [
  'initialize',
  'recordEvents',
  'recordFeedback',
  'search',
  'get',
  'recall',
  'status',
  'regenerateVaultIdentity',
];

const FORMER_INTERNAL_HOOKS = [
  '_manifestPath',
  '_listCollection',
  '_assertCollectionIdentity',
  '_readAccessibleEvents',
  '_readAccessibleFeedback',
  '_getUnlocked',
];

function installPrototypeTraps() {
  const names = [...PUBLIC_STORE_METHODS, ...FORMER_INTERNAL_HOOKS];
  const descriptors = new Map(names.map(name => [
    name,
    Object.getOwnPropertyDescriptor(MemoryStore.prototype, name),
  ]));
  const intercepted = [];
  for (const name of names) {
    Object.defineProperty(MemoryStore.prototype, name, {
      configurable: true,
      writable: true,
      value: function prototypeTrap() {
        intercepted.push({ name, receiver: this });
        throw new Error(`prototype trap invoked: ${name}`);
      },
    });
  }
  return {
    intercepted,
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(MemoryStore.prototype, name, descriptor);
        else delete MemoryStore.prototype[name];
      }
    },
  };
}

function isProfileDenied(error) {
  return error?.code === 'MEMORY_PROFILE_DENIED';
}

test('legacy trustedIngress is rejected and a leaked store cannot grant itself user authority', async (t) => {
  const vault = await temporaryVault(t);
  assert.throws(
    () => createMemoryStore({ vaultDir: vault, profile: profile(), trustedIngress: true }),
    isProfileDenied,
  );

  let authenticationCalls = 0;
  const { store, bridge } = createTrustedMemoryBridge({
    vaultDir: vault,
    profile: profile(),
    authenticate: async () => {
      authenticationCalls += 1;
      return { authenticated: true, role: 'user', actor_id: 'user:owner' };
    },
  });

  assert.equal('trustedIngress' in store, false);
  assert.equal(Object.getPrototypeOf(store), null);
  for (const internal of [
    '_withConsistentVault',
    '_buildTransaction',
    '_createBatchTransaction',
    '_commitEventTransaction',
    '_commitFeedbackTransaction',
    '_commitBatchTransaction',
    '_ensureImmutable',
    'layout',
  ]) {
    assert.equal(internal in store, false, internal);
  }
  for (const internal of [
    '_assertReferencesAccessible',
    '_resolveTarget',
    '_withConsistentVault',
    '_commitEventTransaction',
    '_commitFeedbackTransaction',
  ]) {
    assert.equal(internal in MemoryStore.prototype, false, internal);
  }
  await assert.rejects(
    () => store.recordEvents([attributedEvent({
      source: { stream: 'direct:conversation', event_id: 'direct.1' },
    })]),
    isProfileDenied,
  );
  assert.equal((await store.status()).counts.events, 0);

  // An arbitrary public property with the old name is inert; authority remains
  // in the bridge's private lexical capability.
  store.trustedIngress = true;
  await assert.rejects(
    () => store.recordEvents([attributedEvent({
      source: { stream: 'direct:conversation', event_id: 'direct.2' },
    })]),
    isProfileDenied,
  );
  assert.equal((await store.status()).counts.events, 0);
  assert.equal(authenticationCalls, 0);

  const ingested = await bridge.ingest(eventEnvelope());
  const eventId = ingested.record_result.results[0].event.event_id;
  assert.equal(ingested.record_result.created_count, 1);
  assert.equal(ingested.record_result.results[0].event.actor.type, 'user');
  assert.equal(authenticationCalls, 1);

  await assert.rejects(
    () => store.recordFeedback([attributedFeedback(eventId, {
      source: { stream: 'direct:feedback', event_id: 'direct.feedback.1' },
    })]),
    isProfileDenied,
  );
  assert.equal((await store.status()).counts.feedback, 0);

  const feedback = await bridge.ingestFeedback(feedbackEnvelope(eventId));
  assert.equal(feedback.record_result.created_count, 1);
  assert.equal(feedback.record_result.results[0].feedback.actor.type, 'user');
  assert.equal(authenticationCalls, 2);

  await assert.rejects(() => store.recordEvents([ingested.event]), isProfileDenied);

  const recalled = await store.get(eventId, { includeFeedback: true });
  assert.equal(recalled.event.actor.id, 'user:owner');
  assert.equal(recalled.feedback.length, 1);
  assert.equal(recalled.feedback[0].actor.id, 'user:owner');
  assert.deepEqual((await store.status()).counts, {
    actors: 3,
    events: 1,
    memories: 1,
    feedback: 1,
  });
});

test('actor-bearing bridge envelopes fail before authentication', async (t) => {
  const vault = await temporaryVault(t);
  let authenticationCalls = 0;
  const { store, bridge } = createTrustedMemoryBridge({
    vaultDir: vault,
    profile: profile(),
    authenticate: async () => {
      authenticationCalls += 1;
      return { authenticated: true, role: 'user', actor_id: 'user:owner' };
    },
  });

  await assert.rejects(
    () => bridge.ingest({ ...eventEnvelope(), actor_id: 'user:claimed' }),
    MemorySchemaValidationError,
  );
  await assert.rejects(
    () => bridge.ingestFeedback({
      ...feedbackEnvelope('evt_11111111-1111-4111-8111-111111111111'),
      actor_id: 'user:claimed',
    }),
    MemorySchemaValidationError,
  );
  assert.equal(authenticationCalls, 0);
  assert.equal((await store.status()).counts.events, 0);
  assert.equal((await store.status()).counts.feedback, 0);
});

test('public method monkeypatches cannot intercept bridge-owned private writers', async (t) => {
  const vault = await temporaryVault(t);
  const { store, bridge } = createTrustedMemoryBridge({
    vaultDir: vault,
    profile: profile(),
    authenticate: async () => ({ authenticated: true, role: 'user', actor_id: 'user:owner' }),
  });
  let eventInterceptions = 0;
  let feedbackInterceptions = 0;
  let helperInterceptions = 0;
  store.recordEvents = async () => {
    eventInterceptions += 1;
    throw new Error('public recordEvents was intercepted');
  };
  store.recordFeedback = async () => {
    feedbackInterceptions += 1;
    throw new Error('public recordFeedback was intercepted');
  };
  store._assertReferencesAccessible = async (input) => {
    helperInterceptions += 1;
    input.content = 'intercepted event content';
  };
  store._resolveTarget = async () => {
    helperInterceptions += 1;
    throw new Error('public target resolution was intercepted');
  };

  const ingested = await bridge.ingest(eventEnvelope({
    source: { stream: 'host:conversation', event_id: 'monkeypatch.message.1' },
  }));
  const eventId = ingested.record_result.results[0].event.event_id;
  await bridge.ingestFeedback(feedbackEnvelope(eventId, {
    source: { stream: 'host:feedback', event_id: 'monkeypatch.feedback.1' },
  }));

  assert.equal(eventInterceptions, 0);
  assert.equal(feedbackInterceptions, 0);
  assert.equal(helperInterceptions, 0);
  const recalled = await store.get(eventId, { includeFeedback: true });
  assert.equal(recalled.event.actor.type, 'user');
  assert.equal(recalled.event.content, 'Please retain this visible authenticated request.');
  assert.equal(recalled.feedback[0].actor.type, 'user');
  assert.equal(recalled.feedback[0].target.id, eventId);
});

test('prototype hooks installed before or after bridge creation cannot reach the hidden store', async (t) => {
  for (const phase of ['before', 'after']) {
    await t.test(`${phase} bridge creation`, async (subtest) => {
      const vault = await temporaryVault(subtest);
      let traps;
      if (phase === 'before') traps = installPrototypeTraps();
      const access = createTrustedMemoryBridge({
        vaultDir: vault,
        profile: profile(),
        authenticate: async () => ({ authenticated: true, role: 'user', actor_id: 'user:owner' }),
      });
      if (phase === 'after') traps = installPrototypeTraps();

      try {
        const userResult = await access.bridge.ingest(eventEnvelope({
          source: { stream: 'host:conversation', event_id: `prototype.${phase}.user` },
        }));
        const userEventId = userResult.record_result.results[0].event.event_id;
        await access.bridge.ingestFeedback(feedbackEnvelope(userEventId, {
          source: { stream: 'host:feedback', event_id: `prototype.${phase}.user-feedback` },
        }));

        const agentResult = await access.store.recordEvents([attributedEvent({
          kind: 'visible_agent_response',
          speech_act: 'assertion',
          content: 'A directly attributed agent response.',
          actor_type: 'agent',
          actor_id: 'agent:example',
          source: { stream: 'host:conversation', event_id: `prototype.${phase}.agent` },
        })]);
        const agentEventId = agentResult.results[0].event.event_id;
        await access.store.recordFeedback([attributedFeedback(agentEventId, {
          signal: 'useful',
          actor_id: 'agent:example',
          source: { stream: 'host:feedback', event_id: `prototype.${phase}.agent-feedback` },
        })]);

        await access.store.initialize();
        assert.equal((await access.store.search({ query: '' })).count, 2);
        assert.equal((await access.store.get(userEventId, { includeFeedback: true })).feedback.length, 1);
        assert.equal((await access.store.recall([userEventId, agentEventId])).results.length, 2);
        assert.deepEqual((await access.store.status()).counts, {
          actors: 3,
          events: 2,
          memories: 2,
          feedback: 2,
        });
        await assert.rejects(
          () => access.store.regenerateVaultIdentity(),
          error => error?.code === 'MEMORY_IDENTITY_CONFIRMATION_REQUIRED',
        );
        assert.deepEqual(traps.intercepted, []);
      } finally {
        traps.restore();
      }
    });
  }

  for (const name of FORMER_INTERNAL_HOOKS) {
    assert.equal(Object.prototype.hasOwnProperty.call(MemoryStore.prototype, name), false, name);
  }
});

test('store callbacks are detached and security-relevant configuration is immutable', async (t) => {
  const vault = await temporaryVault(t);
  const callbackReceivers = {
    authenticate: [],
    now: [],
    idFactory: [],
    faultInjector: [],
  };
  let idSequence = 0;
  const { store, bridge } = createTrustedMemoryBridge({
    vaultDir: vault,
    profile: profile(),
    authenticate: async function authenticate() {
      callbackReceivers.authenticate.push(this);
      return { authenticated: true, role: 'user', actor_id: 'user:owner' };
    },
    now: function now() {
      callbackReceivers.now.push(this);
      return new Date('2026-08-14T20:00:00.000Z');
    },
    idFactory: function idFactory(prefix) {
      callbackReceivers.idFactory.push(this);
      idSequence += 1;
      return `${prefix}_callback_${idSequence}`;
    },
    faultInjector: async function faultInjector() {
      callbackReceivers.faultInjector.push(this);
    },
  });

  const ingested = await bridge.ingest(eventEnvelope({
    source: { stream: 'host:conversation', event_id: 'callback.user-event' },
  }));
  const eventId = ingested.record_result.results[0].event.event_id;
  await bridge.ingestFeedback(feedbackEnvelope(eventId, {
    source: { stream: 'host:feedback', event_id: 'callback.user-feedback' },
  }));
  await store.get(eventId, { includeFeedback: true, includeRelations: true });
  await store.status();

  for (const [name, receivers] of Object.entries(callbackReceivers)) {
    assert.ok(receivers.length > 0, `${name} was invoked`);
    assert.ok(receivers.every(receiver => receiver === undefined), `${name} was detached`);
  }
  assert.equal(Object.isFrozen(store.profile), true);
  assert.equal(Object.isFrozen(store.profile.namespace_grants), true);
  assert.throws(() => {
    store.profile.namespace_grants[0].namespace = 'tests/other';
  }, TypeError);
  assert.equal(store.profile.namespace_grants[0].namespace, 'tests/trusted-ingress');
  assert.equal('layout' in store, false);

  const directVault = await temporaryVault(t);
  const direct = createMemoryStore({ vaultDir: directVault, profile: profile() });
  await direct.initialize();
  for (const [name, replacement] of [
    ['vaultDir', directVault],
    ['enabled', false],
    ['profile', null],
    ['resourceLimits', {}],
    ['layout', null],
  ]) {
    const original = direct[name];
    assert.equal(Object.prototype.hasOwnProperty.call(direct, name), false, name);
    assert.throws(() => { direct[name] = replacement; }, TypeError, name);
    assert.strictEqual(direct[name], original, name);
  }
  assert.equal(Object.isFrozen(direct.layout), true);
  assert.equal(Object.isFrozen(direct.resourceLimits), true);
});
