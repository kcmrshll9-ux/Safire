import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_MAX_SEARCH_CANDIDATES,
  rankMemoryEvents,
  scoreMemoryEvent,
  summarizeActivity,
} from '../lib/memory/search.mjs';

function event(overrides = {}) {
  return {
    event_id: 'evt_11111111-1111-4111-8111-111111111111',
    memory_id: 'mem_11111111-1111-4111-8111-111111111111',
    actor: { type: 'agent', id: 'agent:example' },
    content: 'Review the crimson launch checklist',
    ingested_at: '2026-08-14T10:00:00.000Z',
    ...overrides,
  };
}

function feedback(actor, signal, target = { type: 'memory', id: event().memory_id }) {
  return { actor, signal, target };
}

test('agent and automation activity never becomes user activity', () => {
  const memoryEvent = event();
  const records = [
    feedback({ type: 'agent', id: 'agent:example' }, 'useful'),
    feedback({ type: 'automation', id: 'automation:indexer' }, 'useful'),
    feedback({ type: 'automation', id: 'automation:indexer' }, 'useful'),
  ];

  const summary = summarizeActivity(memoryEvent, records);
  assert.deepEqual(summary.activity, {
    user: 0,
    agent: 2,
    automation: 2,
    external_service: 0,
    system: 0,
    unknown: 0,
  });
  assert.equal(summary.signals_by_actor.user.useful, 0);
  assert.equal(summary.signals_by_actor.automation.useful, 2);
});

test('trusted user feedback remains distinct and stronger than agent repetition', () => {
  const memoryEvent = event();
  const agentRepeated = Array.from({ length: 100 }, () => (
    feedback({ type: 'agent', id: 'agent:example' }, 'useful')
  ));
  const automationRepeated = Array.from({ length: 100 }, () => (
    feedback({ type: 'automation', id: 'automation:indexer' }, 'useful')
  ));
  const userConfirmed = [feedback({ type: 'user', id: 'user:owner' }, 'user_confirmed')];

  assert.ok(
    scoreMemoryEvent(memoryEvent, userConfirmed, 'crimson').feedback
      > scoreMemoryEvent(memoryEvent, agentRepeated, 'crimson').feedback,
  );
  assert.ok(
    scoreMemoryEvent(memoryEvent, userConfirmed, 'crimson').feedback
      > scoreMemoryEvent(memoryEvent, automationRepeated, 'crimson').feedback,
  );
  assert.equal(scoreMemoryEvent(memoryEvent, agentRepeated, 'crimson').feedback_by_actor.agent, 2);
  assert.equal(scoreMemoryEvent(memoryEvent, automationRepeated, 'crimson').feedback_by_actor.automation, 0.5);
});

test('ranking is lexical, actor-aware, deterministic, and has no time decay', () => {
  const older = event();
  const newer = event({
    event_id: 'evt_22222222-2222-4222-8222-222222222222',
    memory_id: 'mem_22222222-2222-4222-8222-222222222222',
    actor: { type: 'automation', id: 'automation:indexer' },
    ingested_at: '2026-08-14T11:00:00.000Z',
  });
  const ranked = rankMemoryEvents([older, newer], [], { query: 'crimson', limit: 10 });

  assert.deepEqual(ranked.map((result) => result.event.event_id), [newer.event_id, older.event_id]);
  assert.equal(ranked[0].score.lexical, ranked[1].score.lexical);
  assert.equal(ranked[0].score.feedback, 0);
  assert.equal(ranked[1].score.feedback, 0);
});

test('feedback for event and memory targets is both retained', () => {
  const memoryEvent = event();
  const ranked = rankMemoryEvents([memoryEvent], [
    feedback({ type: 'user', id: 'user:owner' }, 'useful'),
    feedback(
      { type: 'agent', id: 'agent:example' },
      'not_useful',
      { type: 'event', id: memoryEvent.event_id },
    ),
  ], { query: 'checklist' });

  assert.equal(ranked[0].activity.user, 1);
  assert.equal(ranked[0].activity.agent, 2);
  assert.equal(ranked[0].signals_by_actor.user.useful, 1);
  assert.equal(ranked[0].signals_by_actor.agent.not_useful, 1);
});

test('ranking retains only bounded top-k candidates with deterministic ordering', () => {
  const candidates = Array.from({ length: 1_000 }, (_, index) => event({
    event_id: `evt_synthetic_${String(index).padStart(5, '0')}`,
    memory_id: `mem_synthetic_${String(index).padStart(5, '0')}`,
    content: 'Bounded top-k needle.',
    ingested_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
  })).reverse();
  const ranked = rankMemoryEvents(candidates, [], { query: 'needle', limit: 7 });
  assert.deepEqual(
    ranked.map(({ event: item }) => item.event_id),
    Array.from({ length: 7 }, (_, offset) => `evt_synthetic_${String(999 - offset).padStart(5, '0')}`),
  );
  assert.equal(ranked.length, 7);
});

test('ranking rejects candidate collections above its immutable ceiling', () => {
  const repeated = event();
  assert.throws(
    () => rankMemoryEvents(new Array(HARD_MAX_SEARCH_CANDIDATES + 1).fill(repeated)),
    { name: 'RangeError', message: 'Memory search candidate limit exceeded' },
  );
});
