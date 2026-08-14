# Safire agent memory architecture

## Scope and invariants

Version 1 is a local, event-backed memory subsystem attached to one explicit Safire vault. It is not the Markdown note graph, a conversation recorder, or a cloud service.

Its central invariants are:

1. attribution comes from a fixed, operator-controlled profile;
2. namespace access is denied unless an explicit grant allows it;
3. events, event-backed memory items, feedback, actors, and idempotency markers are immutable;
4. corrections are append-only evidence;
5. every record retains its source and vault provenance;
6. crash recovery completes a journaled transaction rather than guessing which files to keep;
7. retrieval is actor-aware but has no age-based decay or lifecycle policy.

## Components and trust boundaries

```text
MCP-capable agent
    |
    | six explicit tools
    v
local safire-memory-mcp sidecar
    |-- fixed version-1 profile (identity, delegation, ACLs)
    |-- schema and authorization
    |-- MemoryStore (transactions and retrieval)
    v
selected Safire vault/.safire/memory/v1
```

The ordinary sidecar receives explicit tool calls. It does not monitor a conversation or infer user identity. The separate trusted-bridge library is a host integration seam for authenticated, visible/observable events; it installs no listener or hook. See [Trusted bridge](TRUSTED_BRIDGE.md).

## Profile and attribution

One process has one normalized profile. The profile fixes:

- the principal agent;
- its agent-instance identity;
- the ingest adapter identity;
- the stable source identity;
- allowed delegated automations/external services;
- namespace read/write grants;
- whether a `trusted_bridge` may accept authenticated user events.

Callers provide an authorized `actor_id` when needed and a source reference `{stream, event_id}`. Safire resolves the actor against the profile and persists the full attribution:

- `actor`;
- `ingested_by`;
- `agent_instance`;
- `delegated_by` for automation;
- `source`, expanded with the profile's `source_identity`.

A portable MCP profile cannot enable user attribution. It also cannot impersonate another agent. `visible_user_message` and `user_result_interaction` therefore require a trusted bridge whose host authenticated an allowlisted user.

## Event input schema

Every event is a strict object with `schema_version: 1` and these fields:

| Field | Requirement |
| --- | --- |
| `namespace` | Canonical logical path authorized for profile write access. |
| `actor_type` | One version-1 actor type. |
| `actor_id` | Optional only where the profile's principal/instance default is unambiguous; explicit is recommended. |
| `delegated_by` | Optional caller assertion; if supplied, must exactly match the profile's delegation. |
| `agent_instance_id` | Optional caller assertion; if supplied, must match the configured instance. |
| `kind` | One event kind coherent with the resolved actor. |
| `speech_act` | One speech act. |
| `content` | Visible or observable text, not empty. |
| `occurred_at` | ISO-8601 timestamp with `Z` or an explicit offset. |
| `context` | Optional strict IDs: `conversation_id`, `session_id`, `thread_id`, `turn_id`, `message_id`, `tool_call_id`, `automation_run_id`. |
| `relations` | Optional unique `{type, target_event_id}` entries pointing to readable existing events. |
| `derived` | Optional `{summary?, claim?, source_event_ids}`; at least summary or claim and one unique readable source event ID. |
| `attributes` | Optional safe lowercase-snake-case scalar/string-array metadata. |
| `source` | Required `{stream, event_id}` origin controlled by the caller's source adapter. |

Unknown fields fail validation. Logical namespaces are NFKC-normalized and lowercased, permit at most 16 safe segments, and reject filesystem syntax such as backslashes, drive prefixes, `.`/`..`, leading/trailing slashes, and percent escapes.

### Actor types

`user`, `agent`, `agent_instance`, `automation`, `external_service`, `system`, `unknown`

`agent_instance` activity is grouped with its agent during ranking. A profile's allowed-actor rules further restrict which of these a particular integration can claim.

### Event kinds

`visible_user_message`, `visible_agent_response`, `delegated_instruction`, `tool_prompt`, `tool_call`, `tool_result`, `observable_action`, `automation_decision`, `explicit_conclusion`, `supplied_file`, `supplied_link`, `user_result_interaction`, `external_observation`

The store enforces a closed actor/kind matrix. Users may provide visible user messages, supplied files/links, and result interactions. Agents and agent instances may provide visible responses, delegated instructions, tool prompts/calls, observable actions, and explicit conclusions. Automations have the same observable work kinds plus automation decisions. External services may provide tool results and external observations. System actors are trusted-bridge-only and limited to tool results, observable actions, and external observations; explicitly allowlisted unknown actors are limited to external observations.

### Speech acts

`request`, `assertion`, `preference`, `proposal`, `correction`, `approval`, `rejection`, `observation`, `conclusion`, `unknown`

Speech acts describe what the visible content does, independent of who produced it. Keeping both fields prevents an agent proposal from being treated as a user preference.

### Relations

`replies_to`, `causes`, `results_in`, `corrects`, `approves`, `rejects`, `contradicts`, `supports`, `belongs_to`

Relations point from the new event to `target_event_id`. They do not mutate the target. A correction can be represented as a new correction event and/or append-only correction feedback; neither overwrites history.

Use `replies_to` for a parent-event association and `tool_call_id` for the equivalent tool-invocation context. Storage keeps only the active edge. Search, get, and recall derive ACL-filtered `incoming_relations` entries with `{type, source_event_id}`, which provides the inverse traversal without writing a second edge or exposing an inaccessible source event.

Stored provenance is never rewritten when readers have different grants. Retrieval projections omit unreadable outbound relation targets, derived and memory `source_event_ids`, and feedback `related_target` IDs. A reader with grants to the source namespace receives the complete fields; a narrower reader receives the shared record without private opaque IDs.

The returned integrity digest still commits the complete immutable stored record. It is not recalculated over an ACL-filtered projection, so a narrower reader cannot reproduce that digest from only the visible response fields.

## Feedback input schema

Every feedback input is a strict version-1 object:

| Field | Requirement |
| --- | --- |
| `target` | `{type: "event" | "memory", id}`; the profile must be able to write its namespace. |
| `signal` | One feedback signal. |
| `correction` | Required visible text when `signal` is `correction`. |
| `related_target` | Required when `signal` is `superseded`; it must be readable. |
| `actor_id` | Actor authorized by the fixed profile. |
| `source` | Required `{stream, event_id}` source reference. |

Signals are `useful`, `not_useful`, `correction`, `superseded`, `user_confirmed`, and `user_rejected`. Trusted user confirmation/rejection requires authenticated user attribution. Ordinary portable MCP cannot manufacture it.

## Event-backed records and provenance

One successfully committed event produces two independent immutable records:

- an event (`evt_...`) containing content, attribution, source, relations, context, optional derivation, and integrity data;
- a memory item (`mem_...`) mapping the memory ID to its event and provenance sources.

For a direct event, the memory item's `source_event_ids` contains that event ID. For derived content, it retains the input's explicitly supplied `derived.source_event_ids`. Feedback has its own immutable `fbk_...` ID. Actor descriptors are also recorded immutably so a stable actor ID cannot later change type or automation delegation.

All stored records include `schema_version`, `vault_id`, and a SHA-256 integrity digest over canonical JSON. Digests make accidental or unsanctioned changes detectable; they are not signatures.

## Idempotency

The trusted source key is the SHA-256 digest of:

```text
(profile.source_identity, input.source.stream, input.source.event_id)
```

Event and feedback operations keep distinct idempotency markers. The request digest also covers the input and resolved attribution.

- Same operation + same source tuple + same request: return the original record with duplicate status.
- Same operation + same source tuple + different request: fail with `MEMORY_IDEMPOTENCY_CONFLICT`.
- Same content + a new source event ID: create a new event.

This rule lets a source retry safely without turning text similarity into identity.

## Local sidecar layout

The selected vault contains:

```text
<vault>/.safire/memory/v1/
  manifest.json
  records/
    actors/
    events/
    memories/
    feedback/
    idempotency/
  state/
  journals/
    <opaque-journal-name>/
      <opaque-transaction-name>.json
  locks/
    vault.lock
```

Record, journal, and state filenames are SHA-256-derived opaque names. Content, actor names, source IDs, and namespaces are not exposed in filenames. The `state/` directory is reserved for controlled mutable version-1 state; current ingestion records remain immutable.

The path implementation requires an explicit absolute, non-root vault path and creates the selected vault directory when needed. It checks lexical and real-path containment, treats Windows containment case-insensitively, rejects symlinked layout/target paths, and limits immutable collection names to a fixed allowlist.

## Durability, locking, and recovery

Immutable creation serializes canonical JSON to a same-directory temporary file, flushes the file, and atomically publishes it with an exclusive hard link. Publication fails rather than replacing an existing immutable record. Mutable manifest replacement requires the expected revision and digest while holding the vault lock, then uses a synced same-directory temporary and atomic replacement.

Writes and identity-sensitive reads are serialized by a cross-process `vault.lock`, so a read uses one manifest/record snapshot while identity regeneration waits. Lock acquisition has bounded retry and timeout. Complete lock metadata is atomically published. A confirmed-live owner is never displaced merely because time elapsed; a confirmed-dead PID is recovered immediately, while stale-time fallback is reserved for legacy/invalid metadata whose owner liveness cannot be determined.

An event transaction proceeds under the lock:

1. write and flush an ingestion journal containing the complete event, memory item, and transaction metadata;
2. exclusively create the event;
3. exclusively create its memory item;
4. exclusively create the idempotency marker;
5. remove the verified journal entry and its empty journal directory.

Feedback uses the same pattern for feedback plus its marker. On enabled initialization and each consistent store operation, Safire acquires the lock and replays any pending verified journals. Each creation is idempotent and digest-checked, so recovery completes a partially committed transaction or reports conflicting/corrupt state. A successful `memory_status` therefore reports zero pending transactions; invalid or conflicting recovery state fails closed. Its record counts are scoped to the current profile's readable namespaces rather than exposing vault-wide private activity.

## Vault identity, copy, and clone semantics

`manifest.json` holds a stable `vlt_...` identity, revision, lineage, and integrity digest.

- Moving or copying the complete vault preserves its identity by default. That is the correct behavior for a backup, restore, or the same logical vault on another path.
- Two independently evolving copies should not keep the same current identity. Regeneration must be an explicit operator action with `confirmIndependentClone: true` through the store API.
- Regeneration creates a new vault ID, increments the manifest revision, records the prior manifest digest, and appends the old identity to lineage.
- Existing immutable records keep the vault ID with which they were created. Lineage allows the regenerated manifest to accept those records without rewriting history.

Do not regenerate merely because a vault path changed. Do not hand-edit the manifest or copy only selected memory subdirectories between unrelated vaults.

## Retrieval and ranking

Search is local and lexical. It can filter by authorized namespaces, actor types, event kinds, and a limit of 1 through 100. Results retain actor, delegation, source, ingest adapter, instance, active and derived incoming relations, derivation, timestamps, and integrity data.

Ranking combines lexical matches with actor-aware feedback:

- authenticated user `user_confirmed`/`user_rejected` signals have magnitude 6; user `useful`/`not_useful` have magnitude 4;
- agent feedback has magnitude 1 per signal and is capped to plus/minus 2;
- automation feedback has magnitude 0.25 and is capped to plus/minus 0.5;
- external-service feedback has magnitude 0.1 and is capped to plus/minus 0.2;
- system and unknown feedback add no relevance weight.

Activity and signals remain reported by actor bucket. Corrections and supersessions are retained as evidence but do not themselves add a positive/negative ranking score. There is no temporal decay, fading, reinforcement-by-age, automatic deletion, lifecycle transition, or archive tier in version 1.

## Explicit non-goals for this milestone

Version 1 contains no:

- automatic capture or transcript monitoring;
- hidden-reasoning or chain-of-thought storage;
- semantic embedding/vector search;
- lifecycle, retention scheduler, archive, or decay policy;
- cloud persistence, remote API, AWS service, or AWS archive path;
- external Hermes modification;
- mutation of Safire Markdown notes or graph links.

Legacy Markdown remains outside this event ledger unless explicitly submitted. An adapter without reliable legacy authorship must attribute that observation to an explicitly allowlisted `unknown` actor, never infer `user`.
