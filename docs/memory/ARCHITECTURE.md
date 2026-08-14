# Safire agent memory architecture

## Scope and invariants

Version 1 is a local, event-backed memory subsystem attached to one explicit Safire vault. It is not the Markdown note graph, a conversation recorder, or a cloud service.

Its central invariants are:

1. attribution comes from a fixed, operator-controlled profile;
2. namespace access is denied unless an explicit grant allows it;
3. events, event-backed memory items, feedback, actors, and idempotency markers are immutable;
4. corrections are append-only evidence;
5. every record retains its source and vault provenance;
6. restart recovery completes a fully written journaled transaction rather than guessing which files to keep;
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

The ordinary sidecar receives explicit tool calls. It does not monitor a conversation or infer user identity. The separate trusted-bridge library is a host integration seam for authenticated, visible/observable events and feedback; it installs no listener or hook. `createTrustedMemoryBridge` keeps the underlying store private and returns a restricted store facade plus a bridge whose closures hold the private persistence capability. Direct facade methods remain unprivileged. See [Trusted bridge](TRUSTED_BRIDGE.md).

## Profile and attribution

One process has one normalized profile. The profile fixes:

- the principal agent;
- its agent-instance identity;
- the ingest adapter identity;
- the stable source identity;
- allowed delegated automations/external services;
- namespace read/write grants;
- whether a `trusted_bridge` may accept authenticated user events and feedback.

Callers provide an authorized `actor_id` when needed and a source reference `{stream, event_id}`. Safire resolves the actor against the profile and persists the full attribution:

- `actor`;
- `ingested_by`;
- `agent_instance`;
- `delegated_by` for automation;
- `source`, expanded with the profile's `source_identity`.

A portable MCP profile cannot enable user attribution. It also cannot impersonate another agent. User-attributed events and feedback therefore require a trusted bridge whose host authenticated an allowlisted user.

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

Unknown fields fail validation. Logical namespaces are NFKC-normalized and lowercased, permit at most 16 safe segments, and reject filesystem syntax such as backslashes, drive prefixes, `.`/`..`, leading/trailing slashes, and percent escapes. Known credential, token, and private-reasoning patterns are rejected before caller-controlled text, namespaces, opaque IDs, source/context/relation/provenance identifiers, attribute keys or values, display names, or search queries can be persisted, returned, logged, hashed for bridge authentication, or forwarded. Rejections use generic errors and do not include the rejected value. This is defense in depth rather than complete data-loss prevention.

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

Stored provenance is never rewritten when readers have different grants. Retrieval projections omit unreadable outbound relation targets. If any source of a derived event is unreadable, the whole dependent `derived` projection is omitted rather than returning a partial or empty required source list. Retrieval memory projections uniformly omit `source_event_ids`, whether their provenance is readable or not, so their shape cannot disclose that a hidden source exists. Fully readable derived provenance remains available on `event.derived`. Feedback whose semantics depend on an unreadable `related_target` is omitted entirely and does not contribute to returned counts, ranking, or activity aggregates.

Retrieval event and memory projections uniformly omit their stored full-record integrity digests; memory projections also uniformly omit stored provenance. This makes digest/provenance presence independent of whether ACL filtering occurred. Version 1 does not return a projection digest. Write results and internal persistence verification still use the complete stored digests. Visible feedback records remain unmodified and retain their stored integrity data.

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

The ordinary store input includes `actor_id`. The strict trusted-bridge feedback envelope omits it; successful authentication supplies the actor before the bridge invokes its private persistence capability.

Signals are `useful`, `not_useful`, `correction`, `superseded`, `user_confirmed`, and `user_rejected`. Every user-attributed feedback signal requires authenticated user attribution, and `user_confirmed`/`user_rejected` additionally reject every non-user actor. Ordinary portable MCP cannot manufacture trusted user feedback.

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

Event and feedback operations keep distinct idempotency markers. The request digest covers a normalized input plus resolved stable attribution fields. Mutable actor display names are deliberately excluded. For a marker written by the earlier display-name-sensitive implementation, Safire compares the incoming stable identity with the sealed persisted record, so a label-only retry remains a duplicate without accepting an actor ID/type change or rewriting the old record.

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

The path implementation requires an explicit absolute, non-root vault path and creates the selected vault directory when needed. It rejects Windows UNC paths (including extended UNC) and device namespace paths, checks lexical and real-path containment, treats Windows containment case-insensitively, rejects symlinked layout/target paths (including NTFS junctions reported by Node), and limits immutable collection names to a fixed allowlist. Persistent layout directories are pinned to their real paths and filesystem identities for the process, with revalidation immediately before and after identity-sensitive operations.

A mapped network drive can look like an ordinary local drive-letter path to Node and cannot be rejected reliably by this bounded implementation. Mapped drives, network shares, and folders with concurrent multi-host synchronization are unsupported. Node's portable stat API also does not expose every Windows reparse tag. Unrecognized reparse behavior and the remaining final-component race against a malicious same-user process are not solved: pathname-based Node APIs do not provide the native reparse inspection and handle-relative/conditional operations needed to close the last interval between validation and use. That actor remains outside the version-1 threat boundary.

## Durability, locking, and recovery

Immutable creation serializes canonical JSON to a same-directory temporary file, flushes the file, and atomically publishes it with an exclusive hard link. Publication fails rather than replacing an existing immutable record. Mutable manifest replacement requires the expected revision and digest while holding the vault lock, then uses a flushed same-directory temporary and atomic replacement.

Writes and identity-sensitive reads are serialized by a cross-process `vault.lock`, so a read uses one manifest/record snapshot while identity regeneration waits. Lock acquisition has bounded retry and timeout. Complete version-2 lock metadata is atomically published with a random ownership token. An existing lock is never automatically stolen or removed based on time, PID liveness, or metadata validity; PID is diagnostic only and reuse does not affect ownership. An abandoned lock requires the operator-only stop/verify/preserve/remove/restart procedure in the security guide. A delayed former contender cannot remove a newer owner's lock because release verifies the ownership token and stable lock-directory identity.

File handles are flushed before publication. Directory metadata flush is attempted, but Windows may reject directory open/sync and those unsupported results are tolerated. Therefore the design claims recovery after a flushed journal and a clean restart (including a tested hard-killed writer process after explicit abandoned-lock recovery), not guaranteed survival of sudden power loss, kernel failure, or storage-device/controller failure. The hard-kill test leaves the operating system and storage stack running and is not a power-loss test.

An event batch transaction proceeds under the lock:

1. validate every reference, idempotency key, generated ID, and destination before publication;
2. write and flush one ingestion journal containing every new event, memory item, and child transaction;
3. exclusively create each event and its memory item;
4. exclusively create each idempotency marker;
5. remove the verified journal entry and its empty journal directory.

Feedback batches use the same pattern for feedback plus its marker. Validation or idempotency failure occurs before the journal and commits none of the batch. Once the journal exists, recovery rolls the entire batch forward. On enabled initialization and each consistent store operation, Safire acquires the lock and replays any pending verified journals before exposing records. Each creation is idempotent and digest-checked, so callers observe the pre-batch state or the completed batch rather than a successful prefix. A successful `memory_status` therefore reports zero pending transactions; invalid or conflicting recovery state fails closed. Its record counts are scoped to the current profile's readable namespaces rather than exposing vault-wide private activity.

## Vault identity, copy, and clone semantics

`manifest.json` holds a stable `vlt_...` identity, revision, lineage, and integrity digest.

- Moving or copying the complete vault preserves its identity by default. That is the correct behavior for a backup, restore, or the same logical vault on another path.
- Two independently evolving copies should not keep the same current identity. Regeneration must be an explicit operator action with `confirmIndependentClone: true` through the store API.
- Regeneration creates a new vault ID, increments the manifest revision, records the prior manifest digest, and appends the old identity to lineage.
- Existing immutable records keep the vault ID with which they were created. Lineage allows the regenerated manifest to accept those records without rewriting history.

Do not regenerate merely because a vault path changed. Do not hand-edit the manifest or copy only selected memory subdirectories between unrelated vaults.

## Retrieval and ranking

Search is local and lexical. It can filter by authorized namespaces, actor types, event kinds, and a limit of 1 through 100. Results retain actor, delegation, source, ingest adapter, instance, active and derived incoming relations, derivation, and timestamps. Stored event integrity digests are not part of retrieval projections.

Exact get and recall read the addressed event/memory pairs directly. They scan collections only when the caller explicitly requests bounded feedback or relation expansion. Search and status use a fixed-size read worker pool and share per-request record/byte budgets across their collection reads. Opaque version-1 filenames do not encode namespaces, so collection scans must validate records before filtering by namespace; a future secondary index would be needed to preselect namespaces without such reads.

Ranking combines lexical matches with actor-aware feedback:

- authenticated user `user_confirmed`/`user_rejected` signals have magnitude 6; user `useful`/`not_useful` have magnitude 4;
- agent feedback has magnitude 1 per signal and is capped to plus/minus 2;
- automation feedback has magnitude 0.25 and is capped to plus/minus 0.5;
- external-service feedback has magnitude 0.1 and is capped to plus/minus 0.2;
- system and unknown feedback add no relevance weight.

Activity and signals remain reported by actor-type bucket for compatibility and additionally in `activity_by_stable_actor`, keyed by stable actor ID with separate event, feedback, and signal counts. This keeps another agent, the principal agent, and its agent-instance actor distinct. Corrections and supersessions are retained as evidence but do not themselves add a positive/negative ranking score. There is no temporal decay, fading, reinforcement-by-age, automatic deletion, lifecycle transition, or archive tier in version 1.

## Resource accounting

The runtime has fixed conservative defaults for bounded read concurrency, records and bytes processed per request, logical event/feedback records and bytes owned by a stable profile ID, logical records and bytes in each exact namespace across profiles, and returned feedback/relation expansion. Hosts may lower these through the additive store `resourceLimits` option. Profile ownership comes from sealed `ingested_by.profile_id`; another profile writing a shared namespace consumes the namespace-wide quota but not this profile's quota.

New unique writes calculate projected namespace/profile usage under the vault lock and reject a limit violation before journal creation. Duplicate retries do not consume new quota. No quota path evicts, rewrites, or deletes data, and existing version-1 sidecars require no migration. A sidecar already above a configured quota remains available for direct unexpanded retrieval, but a scan that would exceed its request budget fails generically. Quotas bound denial-of-service exposure; they are not a retention or lifecycle mechanism.

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
