# Safire agent memory (version 1)

Safire agent memory is an opt-in, local sidecar for persistent, attributed agent events. An operator chooses a Safire vault, supplies one fixed integration profile, and launches a separate Model Context Protocol (MCP) process for an agent. The milestone stores its data beneath the selected vault and does not change the vault's Markdown notes.

This milestone is deliberately narrow:

- local JSON records only;
- explicit event and feedback writes only;
- lexical, actor-aware retrieval;
- immutable provenance and append-only corrections;
- no automatic conversation capture;
- no lifecycle, retention, decay, archive, cloud, AWS, or remote-sync subsystem.

The profile is the trust boundary. It fixes the principal agent, agent instance, source identity, allowed delegated actors, and namespace permissions for the life of the process. None of the six MCP tools can change those settings.

## Install for any MCP-capable agent

Source-checkout requirements:

- Node.js 22.19 or newer;
- a Safire checkout with dependencies installed (`npm ci` from the checkout);
- an operator-selected absolute, non-filesystem-root Safire vault path (Safire creates the directory when needed);
- one fixed local filesystem for the complete memory sidecar, with working same-directory hard links and no nested mount point beneath `.safire/memory/v1`;
- an operator-controlled version-1 profile JSON file.

Each enabled store instance initializes lazily once, when its first direct store API or memory-tool operation runs. Initialization ensures that the version-1 layout directories exist and actively verifies hard-link semantics before publishing a new lock, manifest, journal, or record. On a new sidecar those directories are empty; an existing sidecar may already contain retained state. The check first requires the root, state, journals, locks, and immutable collection directories to report the same filesystem device, then creates random probe paths only in the non-data `locks/` directory so another process cannot observe probe names during a strict record or journal scan. Both names must identify the opened source inode, and cleanup removes only paths whose identity remains proven. `ENOTSUP`, `ENOSYS`, `EPERM`, and equivalent unsupported-operation results become the path-free `MEMORY_HARD_LINK_UNAVAILABLE` error; unrelated I/O or identity failures remain generic filesystem failures. Safire has no copy, rename, native-module, or unsafe locking fallback: choose another local vault filesystem. An ordinary unsupported result for which identity checking and cleanup complete removes both probe names; on a new sidecar it leaves only the empty layout directories, and probing an existing sidecar does not rewrite its stored files. Separately, if an I/O failure, semantic mismatch, collision, or concurrent replacement prevents Safire from proving ownership of a probe source or destination pathname, it fails closed and preserves each ownership-uncertain bounded random pathname in `locks/` rather than risk deleting another file. Usually this is one pathname; a persistent parent-revalidation failure after link creation can preserve both exact probe names. Each retry uses fresh random names, so repeated ownership-uncertain failures can leave up to two additional probe pathnames per failed attempt; retained probes are never adopted or automatically removed. A retained `.hard-link-capability-*` name is not proof of ownership: stop memory writers and obtain specialist review before manual removal.

1. Start from one of the reference profiles in [`examples/`](examples/). Give every real integration its own stable `profile_id`, `principal.id`, `agent_instance.id`, `ingested_by.id`, and `source_identity`. Do not reuse an agent's profile file for a different agent.

2. Grant only the namespaces that integration needs. A grant is exact unless `descendants` is `true`. Read and write are independent.

3. Register a local MCP server in the agent host. The host-specific configuration keys vary, but the command is:

   ```text
   node C:/path/to/Safire/safire-memory-mcp.mjs --profile-config C:/path/to/agent-memory-profile.json --vault C:/path/to/vault
   ```

   From the Safire checkout, the equivalent npm command is:

   ```text
   npm run mcp:memory -- --profile-config C:/path/to/agent-memory-profile.json --vault C:/path/to/vault
   ```

   A Windows installer also places an opt-in launcher at `<Safire install>/resources/safire-memory-mcp.cmd`, with its runtime dependencies unpacked beside the application. This mode needs no separate Node.js installation or source checkout. Configure that `.cmd` as the MCP command and pass the same `--profile-config` and `--vault` arguments:

   ```json
   {
     "mcpServers": {
       "safire-memory-installed": {
         "command": "C:/path/to/installed/Safire/resources/safire-memory-mcp.cmd",
         "args": [
           "--profile-config",
           "C:/path/to/agent-memory-profile.json",
           "--vault",
           "C:/path/to/vault"
         ]
       }
     }
   }
   ```

   The installer permits a custom destination, so confirm the actual installed path. The standalone portable EXE does not provide a permanent externally addressable launcher path; use the installed launcher or source-checkout command for MCP hosting. Registering the launcher remains a manual, opt-in host action and does not modify Hermes or another agent automatically.

   A typical MCP host entry has this shape:

   ```json
   {
     "mcpServers": {
       "safire-memory-reference": {
         "command": "node",
         "args": [
           "C:/path/to/Safire/safire-memory-mcp.mjs",
           "--profile-config",
           "C:/path/to/agent-memory-profile.json",
           "--vault",
           "C:/path/to/vault"
         ]
       }
     }
   }
   ```

4. Restart the host and call `memory_status`. Confirm `enabled`, `vault_id`, the public profile fields, grants, and zero or expected record counts before writing.

Use an explicit `--vault` in managed deployments. If it is omitted, vault selection follows this precedence:

1. `--vault`;
2. `SAFIRE_VAULT_PATH`;
3. the saved desktop selection (whose config location can be overridden with `SAFIRE_VAULT_CONFIG_PATH`);
4. Safire's normal default vault.

Enabled mode requires `--profile-config`. Its argument is always a JSON file path, never inline JSON. Startup limits the file to 1 MiB, parses and validates strict profile version 1, and reports read/parse failures without echoing file contents or path details. The loaded profile remains fixed for that process. Run a separate sidecar with a separate profile for each agent identity.

### Disabled mode

Launch with `--disabled` to expose status only:

```text
node C:/path/to/Safire/safire-memory-mcp.mjs --disabled
```

No profile is required. `memory_status` reports `enabled: false`; the other five tools fail with `MEMORY_DISABLED`. Merely starting disabled mode does not create `.safire/memory/v1` in a vault.

## Exact MCP surface

The server exposes exactly six tools:

| Tool | Input | Purpose |
| --- | --- | --- |
| `memory_record_events` | `{ "events": EventInput[1..100] }` | Validate, authorize, and append visible or observable events. |
| `memory_search` | `{ "query"?, "namespaces"?, "actor_types"?, "kinds"?, "limit"? }` | Search accessible event content. `limit` is 1 through 100. |
| `memory_get` | `{ "id": "evt_..." | "mem_...", "include_feedback"?, "include_relations"? }` | Return one accessible event/memory pair. Feedback and relation expansion are bounded, explicit opt-ins. |
| `memory_record_feedback` | `{ "feedback": FeedbackInput[1..100] }` | Append useful/not-useful, correction, supersession, or confirmation signals. |
| `memory_recall` | `{ "ids": ["evt_..." | "mem_...", ...], "include_feedback"?, "include_relations"? }` | Fetch 1 through 100 unique accessible IDs with the same optional bounded expansions. |
| `memory_status` | `{}` | Report mode, schema version, vault identity, public profile, profile-visible counts, and pending transactions. |

The tools do not accept `ingested_by`, a source identity, profile trust, or ACL configuration. Those values come only from the fixed profile. Every event and feedback input is strict schema version 1; unknown fields fail validation.

### Resource limits and quotas

Every store uses immutable hard ceilings. Trusted in-process hosts may lower them with the additive `resourceLimits` store option, but startup rejects any configured value above its hard ceiling. The installed MCP launcher uses these defaults:

| Limit | Default | Hard maximum |
| --- | ---: | ---: |
| Concurrent collection-record reads | 8 | 64 |
| Directory entries examined by one operation | 25,000 | 25,000 |
| Records processed by one request | 50,000 | 50,000 |
| JSON bytes processed by one request | 128 MiB | 128 MiB |
| Events considered by one search | 10,000 | 10,000 |
| Results retained by one search | 100 | 100 |
| Logical event/feedback records owned by one stable profile ID | 10,000 | 10,000 |
| Logical event/feedback bytes owned by one stable profile ID | 64 MiB | 64 MiB |
| Logical event/feedback records in one exact namespace, across profiles | 5,000 | 5,000 |
| Logical event/feedback bytes in one exact namespace, across profiles | 32 MiB | 32 MiB |
| Feedback records expanded by one request | 256 | 256 |
| Relation/derivation references expanded or accepted by one request | 512 | 512 |
| Event, feedback, or recall inputs in one batch | 100 | 100 |

Independently of the request limits, every memory JSON file has an immutable 160 MiB pre-read and pre-write ceiling, and the owner metadata inside the `vault.lock/` directory gate has a 4 KiB ceiling. Reads size the already opened, identity-checked handle, allocate only that bounded size, and probe one byte beyond it so concurrent growth fails closed. Truncation during a read also fails closed. These file ceilings cannot be raised through `resourceLimits`; a caller that has already reserved a smaller request-byte allowance applies that smaller bound to the read.

Quota checks for new unique writes finish before a journal is created. Exceeding a quota returns generic `MEMORY_RESOURCE_LIMIT`; it never reports hidden counts, evicts records, or deletes history. Duplicate retries remain available when a quota is full. Existing version-1 sidecars need no rewrite: exact unexpanded retrieval remains available if old contents already exceed a new quota, while collection-scanning operations can fail at the per-request processing boundary.

Exact `get` and unexpanded `recall` remain direct. Search, status, quotas, recovery, marker validation, and requested expansions perform bounded scans. Directory scans use incremental enumeration, share the operation's entry budget across collections, count valid and unexpected entries alike, and stop as soon as the entry ceiling is exceeded; they never sort an unbounded collection. Search keeps only a bounded top-K ranking set, and CPU-heavy scoring runs after the authorized consistent snapshot releases the vault lock. Version 1 uses opaque filenames and has no namespace secondary index, so a scan must validate a record before it can apply namespace ACLs; inaccessible records are never returned and generic limit errors reveal no inaccessible counts. Record-content byte limits combine with fixed schema field limits and the hard object-count ceilings above; they are not treated as a complete measurement of JavaScript object overhead. These quotas reduce denial-of-service exposure. They are not retention, expiration, archival, or deletion policies.

## Profile model

A normalized profile has these top-level fields:

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `profile_id` | Stable ID for this integration configuration. |
| `profile_type` | `portable_mcp` or `trusted_bridge`. Ordinary MCP uses `portable_mcp`. |
| `principal` | The one agent identity controlled by the profile. |
| `agent_instance` | Stable identity for this running/installed agent instance. |
| `ingested_by` | Adapter identity; its type and profile ID must match the profile. |
| `source_identity` | Stable origin included in the idempotency tuple. |
| `allowed_actors` | Delegated automations or external services the principal may attribute. |
| `namespace_grants` | Explicit read/write ACLs. |
| `trust.accept_user_events` | Always `false` for `portable_mcp`; only an authenticated trusted bridge may enable it. |

Actor IDs are stable, typed opaque IDs such as `agent:harry`, `automation:moltbook`, and `external_service:browser`. An automation must name the profile principal in `delegated_by`. A portable profile cannot allowlist a user, system, another agent, or another agent instance. An `unknown` actor must be explicitly allowlisted; it is the safe attribution for an explicitly submitted legacy item whose author cannot be established.

Harry is only a reference profile in this repository. In that profile, Moltbook is an `automation` delegated by `agent:harry`; it is not Harry, a user, or an independent agent. [`synthetic-portable-profile.json`](examples/synthetic-portable-profile.json) shows a second, invented agent with a different private namespace. Its isolation is intentional.

Existing Markdown is never auto-imported, rewritten, or assigned to a user by this milestone. If a future or operator-controlled adapter explicitly submits a legacy note without trustworthy authorship, it must use an explicitly configured `unknown` actor, never `user`.

### Namespace ACLs

Namespaces are logical, lowercase slash paths, not filesystem paths. For example:

```json
{
  "namespace": "agents/example",
  "read": true,
  "write": true,
  "descendants": true
}
```

`descendants: false` authorizes only `agents/example`. `descendants: true` also authorizes `agents/example/...`. There is no implicit global grant and no implicit sharing between profiles. Search, get, recall, event relations, derived provenance references, and feedback targets are checked against read/write access as applicable. Inaccessible records are reported as not found where revealing their existence would cross a namespace boundary.

A broadly authorized writer may associate a shared record with a private source. The immutable local record retains that complete provenance, but retrieval for a narrower profile removes unreadable relation targets, omits the whole derived projection, and omits feedback that requires an unreadable related target. Retrieval event and memory projections uniformly omit stored digests, while memory projections uniformly omit provenance, so response shape cannot confirm that filtering or hidden sources exist; fully readable derived provenance remains on `event.derived`. Hidden-dependent feedback does not affect returned counts, activity, or ranking aggregates. Grant the source namespace explicitly when a reader must inspect the full cross-namespace provenance chain.

## Version-1 vocabularies

Event inputs use one value from each relevant vocabulary. See [Architecture](ARCHITECTURE.md) for field-level rules.

- Actor types: `user`, `agent`, `agent_instance`, `automation`, `external_service`, `system`, `unknown`.
- Event kinds: `visible_user_message`, `visible_agent_response`, `delegated_instruction`, `tool_prompt`, `tool_call`, `tool_result`, `observable_action`, `automation_decision`, `explicit_conclusion`, `supplied_file`, `supplied_link`, `user_result_interaction`, `external_observation`.
- Speech acts: `request`, `assertion`, `preference`, `proposal`, `correction`, `approval`, `rejection`, `observation`, `conclusion`, `unknown`.
- Relations: `replies_to`, `causes`, `results_in`, `corrects`, `approves`, `rejects`, `contradicts`, `supports`, `belongs_to`.
- Feedback signals: `useful`, `not_useful`, `correction`, `superseded`, `user_confirmed`, `user_rejected`.

These labels preserve provenance. For example, an agent's `proposal` is not silently promoted to a user's `preference`, and automation activity remains attributed to the automation and its delegating agent.

## Write and correction rules

- Events and their event-backed memory items are immutable.
- Each accepted event gets a distinct `evt_...` ID and a distinct `mem_...` ID.
- A stored derived memory item retains its source event IDs; retrieval memory projections omit provenance uniformly, while a fully readable event exposes it through `event.derived`.
- Corrections and supersessions are new feedback records. They never edit or delete the original event.
- `correction` requires visible correction text.
- `superseded` requires a `related_target`.
- Reusing the same trusted source tuple with the same stable request identity returns the original result as a duplicate. Mutable actor display labels are excluded, so a label change does not break a retry; stable actor ID/type, payload, or attribution changes remain conflicts. A genuinely new source event ID creates a new event even if its text repeats earlier text.

The trusted source tuple is `(profile.source_identity, input.source.stream, input.source.event_id)`. Source event IDs therefore need to be stable and unique within their source stream.

## Reference JSON

All files below contain synthetic or requested reference identities and no secrets:

- [`harry-portable-profile.json`](examples/harry-portable-profile.json): Harry reference profile, including delegated Moltbook automation.
- [`synthetic-portable-profile.json`](examples/synthetic-portable-profile.json): isolated second-agent profile.
- [`harry-agent-event.json`](examples/harry-agent-event.json): visible Harry response event.
- [`harry-moltbook-event.json`](examples/harry-moltbook-event.json): separately attributed automation event.
- [`correction-feedback.json`](examples/correction-feedback.json): schema-valid append-only correction template; replace its target with a record accessible in the selected vault.
- [`trusted-bridge-profile.json`](examples/trusted-bridge-profile.json), [`trusted-bridge-user-event.json`](examples/trusted-bridge-user-event.json), and [`trusted-bridge-authentication-result.json`](examples/trusted-bridge-authentication-result.json): invented trusted-bridge configuration, envelope, and successful authentication result.

## Storage and privacy boundary

Persistent milestone state lives under `<vault>/.safire/memory/v1/`; see [Architecture](ARCHITECTURE.md) for the layout and recovery protocol. Filenames are SHA-256-derived opaque names rather than record content or actor names.

Local-first does not mean encrypted. Safire relies on the operating system, device encryption, backups, and vault permissions for confidentiality. Record digests detect accidental or unsanctioned modification but are not signatures or access-control credentials. Do not submit passwords, tokens, private keys, session cookies, hidden reasoning, chain-of-thought, or scratchpad content in content, identifiers, namespaces, attributes, display names, or search queries. The schema rejects common forms without echoing rejected values, but that validation is not a complete data-loss-prevention system.

For the security model, read [Security](SECURITY.md). A host that needs authenticated user attribution must read [Trusted bridge](TRUSTED_BRIDGE.md); ordinary MCP cannot create user events.
