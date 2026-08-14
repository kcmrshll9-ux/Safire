# Safire agent memory security

## Security posture

Version-1 agent memory is a local sidecar whose authority is bounded by one operator-controlled profile and one selected vault. It stores only explicit, schema-valid events and feedback beneath `<vault>/.safire/memory/v1`.

The primary security boundaries are:

- operating-system access to the vault and profile file;
- the fixed profile's actor allowlist and namespace grants;
- strict payload schemas and attribution resolution;
- filesystem containment, immutable publication, locking, integrity verification, and journal recovery;
- authentication supplied by a host before the trusted bridge accepts user attribution.

This milestone is not a sandbox for a malicious local process. A process that can read or rewrite the vault/profile with the user's operating-system privileges is outside the MCP authorization boundary.

## Operator responsibilities

- Keep each profile file outside untrusted write locations and restrict it to the account that launches the integration.
- Give every agent integration a distinct profile, principal, instance, adapter ID, and source identity.
- Grant the smallest necessary namespaces. Prefer a private root such as `agents/example` and enable descendants only when required.
- Use an explicit absolute `--vault` path for managed configurations and verify `memory_status` before the first write.
- Protect the vault with operating-system permissions, device encryption, and an appropriate backup policy.
- Treat complete vault copies as the same logical vault unless deliberately creating and confirming an independent clone.
- Never put credentials, tokens, private keys, session cookies, or private reasoning in memory payloads.

The `--profile-config` argument is always a JSON file path. Startup caps the file at 1 MiB, validates strict version 1, and reports generic read/parse failures without echoing its contents or path details. The profile is then fixed for the process. MCP tools cannot edit it, change the profile's trust flag, add actors, broaden ACLs, choose another ingest adapter, or replace the source identity.

## Identity and authorization

An enabled ordinary MCP process requires a valid `portable_mcp` profile. That profile controls one agent principal and one agent instance. It may additionally allow:

- an `automation` only when its `delegated_by` is the principal;
- an `external_service` with its own stable identity.

It cannot allowlist a user, system, another agent, or another agent instance. Consequently ordinary MCP cannot create user events or trusted user feedback, even though `user` exists in the general record vocabulary. `visible_user_message` and `user_result_interaction` require an authenticated trusted bridge.

Namespace grants are fail-closed. Exact grants do not imply descendant access. Read and write are checked separately for search, get/recall, new events, relation/derived references, feedback targets, and related targets. Where appropriate, an unauthorized record is reported as not found so the caller cannot probe its existence.

Cross-namespace provenance stays complete in immutable storage, but retrieval is projected through the reader's grants. Unreadable outbound relation targets, derived/memory source IDs, feedback related-target IDs, and incoming edges are omitted rather than exposing a private opaque identifier through a shared record.

The caller may supply an actor/source reference needed for a record, but persisted `ingested_by`, source identity, agent instance, and delegation are resolved from the profile. Caller-supplied attribution that disagrees with the profile fails.

## Payload rules

Inputs are strict version-1 objects: unknown fields fail. IDs, namespaces, timestamps, arrays, attributes, and visible text are bounded. Namespaces are logical paths, never raw filesystem paths.

Only visible or observable material belongs in memory:

- visible user messages through an authenticated bridge;
- visible agent responses;
- explicit delegated instructions, prompts, calls, and results;
- observable actions and external observations;
- explicit conclusions;
- user-supplied file/link references and visible result interactions.

Do not capture private chain-of-thought, hidden reasoning, reasoning traces, or scratchpads. The schema rejects those phrases and common credential/token patterns in content and derived text, and rejects sensitive attribute keys. This is defense in depth, not complete secret detection. A novel credential format or sensitive personal detail may pass; upstream adapters must minimize and review content before submission.

Safire's memory filesystem and expected sidecar behavior do not log record content. Authentication and error logs should contain only bounded metadata and redacted error codes. Do not add raw payload logging in host adapters.

## Filesystem protections

The layout implementation:

- requires an explicit absolute, non-filesystem-root vault path and creates only that selected path when needed;
- resolves and verifies containment under that vault;
- compares containment case-insensitively on Windows;
- rejects symlinked layout directories and JSON targets;
- uses only fixed immutable collection names;
- derives on-disk filenames from SHA-256 rather than record content or raw IDs;
- creates immutable JSON by flushed same-directory temporary plus exclusive atomic publication;
- replaces mutable versioned JSON only under the vault lock and only when expected revision and digest both match;
- verifies stored schema, vault membership, and integrity digests when records are read or recovered.

These controls protect against traversal, accidental overwrite, torn publication, common races, and many unsafe-link substitutions. They do not protect against an administrator or same-user malicious process with unrestricted filesystem access.

## Lock and journal safety

All ingestion, identity-sensitive reads, and manifest identity changes use a cross-process vault lock with bounded retry. Complete metadata is atomically published. A live PID is never age-stolen; a dead PID is recoverable immediately; stale-time fallback applies only when liveness is indeterminate. Recovery quarantines and rechecks the old lock rather than blindly deleting a path. Do not manually delete `locks/vault.lock` while any Safire memory process could be active.

Before immutable records are published, Safire writes a complete ingestion journal. Enabled initialization replays verified journals under the lock. If status reports pending transactions or startup reports integrity/ownership conflicts:

1. stop all writers for that vault;
2. preserve a complete copy of `.safire/memory/v1` for diagnosis;
3. restart one correctly configured writer and recheck `memory_status`;
4. do not edit records, markers, journals, digests, or the manifest by hand.

Idempotency markers prevent retry duplication. Reusing `(source_identity, stream, event_id)` with different payload/attribution fails rather than silently overwriting history.

## Integrity, confidentiality, and backups

SHA-256 record digests and previous-manifest digests are integrity evidence, not digital signatures, authentication tokens, encryption, or proof against a malicious writer that can recompute them.

Memory content is plaintext JSON. Filename opacity does not encrypt it. Anyone with read access to the vault can read the records. Use full-disk/device encryption and OS access controls where confidentiality matters.

Back up the entire vault, including `.safire/memory/v1`, so the manifest, records, idempotency markers, and any recovery journals stay consistent. A full copy retains the same vault identity. Only regenerate identity when intentionally allowing the copy to evolve as an independent logical vault; regeneration keeps prior IDs in lineage and does not erase history.

## Trusted bridge requirements

The trusted bridge is not a bypass around authentication. A host must provide an async authenticator that binds transport/session context to an allowlisted actor and returns a strict successful authentication result. Payload actor fields are forbidden; the bridge constructs attribution only after authentication. Hashes supplied in authentication metadata help bind a decision to an envelope but are not authentication by themselves.

User events additionally require a `trusted_bridge` profile with `trust.accept_user_events: true` and the exact user in `allowed_actors`. Role, actor type, event kind, delegation, agent instance, and namespace write access are then checked. Failure is generic and must not record the event.

The ordinary six-tool MCP rejects `trusted_bridge` profiles entirely, including injected stores. Host integration code must keep its bridge-enabled `MemoryStore` private, construct it with `trustedIngress: true`, and invoke it only after the adapter has authenticated and authorized the visible event or feedback. This flag is an in-process capability boundary, not transport authentication; exposing that raw store to untrusted callers would violate the integration contract.

The current milestone installs no hook, listener, or external integration, performs no automatic capture, and makes no changes to Hermes or another agent product. See [Trusted bridge](TRUSTED_BRIDGE.md).

## Excluded systems

There is no lifecycle engine, automatic expiration, archive, deletion scheduler, cloud replication, AWS integration, or AWS archival fallback in this milestone. Operators should not infer remote backup or retention guarantees from the local-first label.
