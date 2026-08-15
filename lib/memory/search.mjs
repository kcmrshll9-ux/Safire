const ACTIVITY_BUCKETS = Object.freeze([
  'user',
  'agent',
  'automation',
  'external_service',
  'system',
  'unknown',
]);

const POSITIVE_SIGNALS = new Set(['useful', 'user_confirmed']);
const NEGATIVE_SIGNALS = new Set(['not_useful', 'user_rejected']);

export const HARD_MAX_SEARCH_CANDIDATES = 10_000;
export const HARD_MAX_SEARCH_RESULTS = 100;

function emptyActivity() {
  return Object.fromEntries(ACTIVITY_BUCKETS.map((bucket) => [bucket, 0]));
}

function activityBucket(actorType) {
  if (actorType === 'agent_instance') return 'agent';
  return ACTIVITY_BUCKETS.includes(actorType) ? actorType : 'unknown';
}

function emptySignals() {
  return {
    useful: 0,
    not_useful: 0,
    correction: 0,
    superseded: 0,
    user_confirmed: 0,
    user_rejected: 0,
  };
}

function stableActorActivity(actor) {
  return {
    actor_id: actor.id,
    actor_type: actor.type,
    events: 0,
    feedback: 0,
    total: 0,
    signals: emptySignals(),
  };
}

function recordStableActorActivity(records, actor, kind, signal = null) {
  if (!actor?.id || !actor?.type) return;
  const entry = records.get(actor.id) || stableActorActivity(actor);
  entry[kind] += 1;
  entry.total += 1;
  if (signal && Object.hasOwn(entry.signals, signal)) entry.signals[signal] += 1;
  records.set(actor.id, entry);
}

function feedbackWeight(feedback) {
  const bucket = activityBucket(feedback.actor?.type);
  const signal = feedback.signal;
  const direction = POSITIVE_SIGNALS.has(signal) ? 1 : NEGATIVE_SIGNALS.has(signal) ? -1 : 0;
  if (direction === 0) return 0;

  // User feedback is authoritative user activity. Agent and automation feedback
  // remains useful local evidence, but cannot masquerade as user interest.
  const magnitude = bucket === 'user'
    ? (signal === 'user_confirmed' || signal === 'user_rejected' ? 6 : 4)
    : bucket === 'agent'
      ? 1
      : bucket === 'automation'
        ? 0.25
        : bucket === 'external_service'
          ? 0.1
          : 0;
  return direction * magnitude;
}

function lexicalScore(content, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('en-US');
  if (!normalizedQuery) return 0;
  const haystack = String(content || '').toLocaleLowerCase('en-US');
  if (!haystack) return 0;

  let score = haystack.includes(normalizedQuery) ? 10 : 0;
  const tokens = [...new Set(normalizedQuery.split(/\s+/u).filter(Boolean))];
  for (const token of tokens) {
    let offset = 0;
    let matches = 0;
    while (matches < 5) {
      const index = haystack.indexOf(token, offset);
      if (index < 0) break;
      matches += 1;
      offset = index + token.length;
    }
    score += matches;
  }
  return score;
}

export function summarizeActivity(event, feedbackRecords = []) {
  const activity = emptyActivity();
  const signals_by_actor = Object.fromEntries(
    ACTIVITY_BUCKETS.map((bucket) => [bucket, emptySignals()]),
  );
  const stableActorRecords = new Map();

  activity[activityBucket(event.actor?.type)] += 1;
  recordStableActorActivity(stableActorRecords, event.actor, 'events');
  for (const feedback of feedbackRecords) {
    const bucket = activityBucket(feedback.actor?.type);
    activity[bucket] += 1;
    if (Object.hasOwn(signals_by_actor[bucket], feedback.signal)) {
      signals_by_actor[bucket][feedback.signal] += 1;
    }
    recordStableActorActivity(
      stableActorRecords,
      feedback.actor,
      'feedback',
      feedback.signal,
    );
  }

  const activity_by_stable_actor = Object.fromEntries(
    [...stableActorRecords.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  return { activity, signals_by_actor, activity_by_stable_actor };
}

export function scoreMemoryEvent(event, feedbackRecords = [], query = '') {
  const lexical = lexicalScore(event.content, query);
  const feedbackByActor = emptyActivity();
  for (const record of feedbackRecords) {
    feedbackByActor[activityBucket(record.actor?.type)] += feedbackWeight(record);
  }
  // Bound non-user self-reinforcement. Repeated agent/automation feedback can
  // help tie-breaking, but can never manufacture an unbounded relevance boost.
  feedbackByActor.agent = Math.max(-2, Math.min(2, feedbackByActor.agent));
  feedbackByActor.automation = Math.max(-0.5, Math.min(0.5, feedbackByActor.automation));
  feedbackByActor.external_service = Math.max(-0.2, Math.min(0.2, feedbackByActor.external_service));
  feedbackByActor.system = 0;
  feedbackByActor.unknown = 0;
  const feedback = Object.values(feedbackByActor).reduce((sum, value) => sum + value, 0);
  return {
    lexical,
    feedback,
    feedback_by_actor: feedbackByActor,
    total: lexical + feedback,
  };
}

function rankingOrder(left, right) {
  return right.score.total - left.score.total
    || String(right.event.ingested_at).localeCompare(String(left.event.ingested_at))
    || String(left.event.event_id).localeCompare(String(right.event.event_id));
}

function addToTopResults(results, candidate, limit) {
  if (results.length < limit) {
    results.push(candidate);
    return;
  }
  let worstIndex = 0;
  for (let index = 1; index < results.length; index += 1) {
    if (rankingOrder(results[worstIndex], results[index]) < 0) worstIndex = index;
  }
  if (rankingOrder(candidate, results[worstIndex]) < 0) results[worstIndex] = candidate;
}

export function rankMemoryEvents(events, feedbackRecords = [], options = {}) {
  if (!Array.isArray(events) || events.length > HARD_MAX_SEARCH_CANDIDATES) {
    throw new RangeError('Memory search candidate limit exceeded');
  }
  const feedbackByMemory = new Map();
  const feedbackByEvent = new Map();
  for (const feedback of feedbackRecords) {
    const map = feedback.target?.type === 'event' ? feedbackByEvent : feedbackByMemory;
    const id = feedback.target?.id;
    if (!id) continue;
    const records = map.get(id) || [];
    records.push(feedback);
    map.set(id, records);
  }

  const query = options.query || '';
  const hasQuery = Boolean(String(query).trim());
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, HARD_MAX_SEARCH_RESULTS));
  const results = [];
  for (const event of events) {
    const feedback = [
      ...(feedbackByMemory.get(event.memory_id) || []),
      ...(feedbackByEvent.get(event.event_id) || []),
    ];
    const candidate = {
      event,
      score: scoreMemoryEvent(event, feedback, query),
      ...summarizeActivity(event, feedback),
    };
    if (hasQuery && candidate.score.lexical <= 0) continue;
    addToTopResults(results, candidate, limit);
  }
  return results.sort(rankingOrder);
}

export { ACTIVITY_BUCKETS };
