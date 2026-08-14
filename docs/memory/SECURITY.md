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
- Use one fixed local filesystem path whose complete memory sidecar supports same-directory hard links. Windows UNC/device namespace paths, mapped network drives, nested mount points beneath `.safire/memory/v1`, and folders concurrently synchronized by another host are unsupported.
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

Cross-namespace provenance stays complete in immutable storage, but retrieval is projected through the reader's grants. Unreadable outbound relation targets are removed. A derived projection is omitted if any required source is unreadable. Retrieval event and memory projections uniformly omit stored digests, and memory projections uniformly omit provenance, so their shape cannot confirm that filtering or a hidden source exists. Feedback that requires an unreadable related target is omitted entirely, including from returned counts and ranking/activity aggregates. Version 1 does not return a projection digest.

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

### Sensitive-material validation

Do not capture private chain-of-thought, hidden reasoning, reasoning traces, or scratchpads. The schema rejects those phrases and common credential/token patterns across caller-controlled visible text, namespaces, opaque identifiers, source/context/relation/provenance IDs, attribute keys and values, profile identifiers and display names, and echoed search queries. In addition to generic credential forms, the provider-shaped rules cover AWS long-term and temporary STS access key IDs, npm access tokens, classic and routable GitLab personal, project, and group access tokens, Google API keys, Stripe secret and restricted keys for test/live modes, Hugging Face user tokens, and credible three-part compact JWTs. Stripe publishable keys are intentionally not classified as secrets by this rule.

The centralized provider shapes are exact-case `AKIA` or `ASIA` plus 16 uppercase alphanumeric characters; `npm_` plus 36 alphanumeric characters; classic `glpat-` plus 20 letters, digits, underscores, or hyphens; routable `glpat-` plus 27 through 300 of those same characters, a dot, and 9 lowercase alphanumeric characters; `AIza` plus 35 letters, digits, underscores, or hyphens; `sk_test_`, `sk_live_`, `rk_test_`, or `rk_live_` plus 20 through 247 alphanumeric characters; and `hf_` plus 34 alphanumeric characters. Matching requires token boundaries, so longer or malformed lookalikes are not accepted as partial matches.

Scanning NFKC-normalizes input and removes a narrow set of zero-width separators. Namespace and stable-profile values are checked before lowercase canonicalization so case-sensitive formats are not destroyed, and the canonical result is checked again so canonicalization cannot create a token-shaped stored value. Inputs already beyond their schema limit fail with the existing generic size error before normalization or credential scanning. Bridge envelopes are validated before their identifier-derived authentication metadata or canonical payload digest is constructed. Errors are generic and do not echo rejected values.

JWT handling is deliberately structural rather than cryptographic: Safire bounds the total and each segment before decoding, requires exactly three nonempty canonical unpadded base64url segments, decodes the header and payload as strict UTF-8 JSON objects, requires an own nonempty string `alg` header, and requires a nontrivial signature segment. It does not verify that signature, log decoded claims, or treat a match as authenticated. Encrypted JWE forms, customized GitLab prefixes, novel provider formats, encoded secrets outside the documented normalization, and sensitive personal details can still pass. This is defense in depth, not complete secret detection; upstream adapters must minimize and review content before submission.

Format sources are the providers' current documentation for [AWS IAM unique identifiers](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html#identifiers-unique-ids), [npm access-token handling](https://docs.npmjs.com/about-access-tokens/), [GitLab token prefixes](https://docs.gitlab.com/security/tokens/#token-prefixes), [Google API keys](https://docs.cloud.google.com/docs/authentication/api-keys#api_key_components), [Stripe API keys](https://docs.stripe.com/keys), and [Hugging Face user tokens](https://huggingface.co/docs/hub/security-tokens), together with the official [npm/GitHub token-format announcement](https://github.blog/changelog/2021-09-23-npm-has-a-new-access-token-format/). Exact shapes and conservative length bounds are cross-checked against the maintained [Gitleaks default rules](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) and TruffleHog's [GitLab](https://github.com/trufflesecurity/trufflehog/tree/main/pkg/detectors/gitlab), [Stripe](https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/stripe/stripe.go), [Hugging Face](https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/huggingface/huggingface.go), and [JWT](https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/jwt/jwt.go) detectors. The `alg` protected-header parameter follows [RFC 7515 section 4.1.1](https://datatracker.ietf.org/doc/html/rfc7515#section-4.1.1), compact JWS serialization follows [RFC 7515 section 7.1](https://datatracker.ietf.org/doc/html/rfc7515#section-7.1), and a JWT's claims object follows [RFC 7519 section 3](https://datatracker.ietf.org/doc/html/rfc7519#section-3).

Safire's memory filesystem and expected sidecar behavior do not log record content. Authentication and error logs should contain only bounded metadata and redacted error codes. Do not add raw payload logging in host adapters.

## Resource-exhaustion controls

Collection reads use incremental capped directory enumeration, a bounded worker pool, and shared per-operation entry plus per-request record/byte budgets. Every entry examined across every collection in that operation, including unexpected names and non-files, consumes the directory-entry ceiling. Exact get and recall read addressed pairs directly by default; feedback and relation expansion require explicit opt-in and have separate caps. Search candidates and retained top-K results are independently capped. Search, status, recovery, marker validation, write-quota accounting, and requested expansions fail with generic `MEMORY_RESOURCE_LIMIT` when their processing boundary would be crossed. The error contains no record count, byte count, namespace, filename, or inaccessible-record detail. Every configurable resource limit has an immutable maximum and can only be lowered by a trusted host.

No JSON read allocates from an unbounded file size. Memory JSON files have a non-configurable 160 MiB pre-read and pre-write ceiling; lock metadata has a 4 KiB ceiling. Reads enforce the applicable limit against the already opened, identity-validated handle and use an overflow-byte probe, so observed growth or truncation fails closed. A smaller request-byte reservation becomes the per-file read limit where available. Oversized files and locks return a generic resource-limit failure and are preserved for operator inspection; the resource-control path does not remove them.

New unique writes are checked under the vault lock before journal creation against both a stable-profile ownership quota and a namespace-wide quota. Profile ownership uses sealed `ingested_by.profile_id`, so another integration's record in a shared namespace does not consume this profile's quota; it does consume the shared namespace quota. Full quotas do not block an exact duplicate retry and never trigger eviction, compaction, rewriting, or deletion. Existing version-1 records remain readable without a format migration, although collection-scanning operations can be refused if an older sidecar already exceeds a configured request boundary.

Opaque filenames prevent namespace preselection in version 1. A bounded scan therefore validates stored records before applying namespace filters. This is an internal processing limitation, not authorization to return inaccessible content. These controls reduce accidental or adversarial resource exhaustion; they do not provide retention, deletion, storage provisioning, or protection from a same-user process that can create arbitrary files in the sidecar.

## Filesystem protections

The layout implementation:

- requires an explicit absolute, non-filesystem-root vault path and creates only that selected path when needed;
- rejects Windows UNC paths (including extended UNC) and device namespace paths before creating the vault;
- resolves and verifies containment under that vault;
- compares containment case-insensitively on Windows;
- rejects symlinked layout directories and JSON targets, including NTFS junctions that Node reports as symbolic links;
- records the real path and filesystem identity of persistent layout directories and revalidates them immediately before and after identity-sensitive reads, publication, replacement, and removal;
- uses only fixed immutable collection names;
- during each enabled store instance's one-time lazy initialization, triggered by its first direct store API or memory-tool operation, ensures the layout exists, requires every persistent JSON-publication directory to report the same filesystem device, and identity-verifies a hard-link probe only in non-data `locks/` before publishing a new lock, manifest, journal, or record;
- derives on-disk filenames from SHA-256 rather than record content or raw IDs;
- creates immutable JSON by flushed same-directory temporary plus exclusive atomic publication;
- replaces mutable versioned JSON only under the vault lock and only when expected revision and digest both match;
- verifies stored schema, vault membership, and integrity digests when records are read or recovered.

Mapped drives cannot be reliably distinguished from local drive-letter paths with the bounded Node filesystem API, so the implementation cannot automatically reject every mapped drive. Operators must not select one. Network shares and multi-host/synchronization-provider concurrency are outside the supported locking and durability model.

The hard-link probe captures the source inode identity from its opened handle, requires the destination to share that identity and have a real multi-link count, and cleans only exact random paths that still have a proven probe identity. Expected unsupported-operation codes are mapped to the path-free `MEMORY_HARD_LINK_UNAVAILABLE` error; unrelated I/O and identity errors remain generic filesystem failures. On a new sidecar, a normal unsupported result leaves only empty version-1 layout directories; an existing sidecar's stored files remain unchanged. If a collision or concurrent replacement makes a probe pathname's ownership uncertain, Safire preserves that bounded pathname in `locks/` and fails instead of deleting it. There is no copy, rename, native-module, or reduced-safety fallback; the operator must select a supported local filesystem.

These controls protect against traversal, accidental overwrite, torn publication, common races, and many unsafe-link substitutions. Node's portable stat API does not expose every Windows reparse tag, and the implementation cannot make the final pathname operation handle-relative or conditional. Unrecognized reparse behavior is unsupported, and a malicious same-user process can still replace a validated directory or final path in the last interval before a pathname-based operation. Full containment against that actor would require native Windows reparse inspection plus handle-relative filesystem primitives, or a stronger OS isolation boundary; it is a residual risk, not a solved property. Administrators and same-user malicious processes with unrestricted filesystem access remain outside this milestone's threat boundary.

## Lock and journal safety

All ingestion, identity-sensitive reads, and manifest identity changes use a cross-process vault lock with bounded retry. The current protocol exclusively creates a plain `vault.lock/` directory, atomically publishes one bounded owner-specific metadata file inside it, and revalidates both directory identities before reporting acquisition. Concurrent release calls on one lock object share one state transition and one cleanup attempt. Release checks that exact version-3 metadata and removes only its token-specific file before a non-recursive removal of the verified-empty gate. If a successor has completed acquisition, its different metadata filename prevents the former owner's unlink from targeting it and keeps the directory nonempty so a delayed `rmdir` cannot remove it. If a setup-stage empty gate is removed, that contender fails before reporting ownership. A crash before child removal preserves the complete gate; every later pre-release cleanup crash preserves an empty held gate. Successful `rmdir` commits ownership release. A best-effort parent-directory sync follows for durability but performs no pathname deletion and is not a cleanup stage. Safire never automatically steals, renames, quarantines, migrates, or removes an existing or abandoned lock artifact based on its age, PID, metadata validity, or an apparent dead process. A legacy version-2 regular lock file remains held until operator recovery. The PID is diagnostic only: PID reuse never authorizes recovery. A crashed or hard-killed writer therefore leaves the vault fail-closed until an operator intervenes; no MCP tool performs that intervention.

For an apparently abandoned `locks/vault.lock`:

1. stop every memory writer that can access the vault;
2. independently verify that the recorded process is no longer the owner, remembering that PIDs can be reused;
3. preserve a complete copy of `.safire/memory/v1` for diagnosis;
4. inspect the exact `locks/vault.lock` without following a symlink or junction. For a legacy plain lock file, remove only that file. For a current plain lock directory containing exactly one canonical `owner-<token>.json`, remove that exact owner file and then remove only the verified-empty directory non-recursively. A setup crash can leave an empty plain directory, which may be removed non-recursively after the same checks. If the artifact is a reparse point or contains any unexpected entry, stop and obtain specialist review; never use recursive removal;
5. start one correctly configured writer and run `memory_status` so verified journals are recovered before normal use resumes.

Never remove the lock while any writer may still be active. Do not automate this procedure, infer safety from lock age alone, or recursively delete a lock directory.

Before immutable records are published, Safire validates the complete request, writes one canonical journal containing every new member, and writes a guard bound to the journal's exact byte digest. Child markers carry protected batch membership, and a sealed completion receipt is created only after every child marker exists. Enabled initialization and every consistent store operation replay verified journals under the lock, rolling an interrupted batch fully forward before exposing records. A journal without a guard remains recoverable for the guard-creation crash window and older v1 recovery state; a guard without its exact journal fails closed. If both transient files disappear after publication, a batch-linked marker without its matching receipt still fails closed. Unexpected journal artifacts, noncanonical or malformed JSON, and sealed identity/path mismatches are rejected generically and preserved for review. Only a surviving verified journal may recreate a missing idempotency marker. A missing marker without such a journal, a malformed or mismatched marker, or multiple sealed records claiming one source key fails closed without automatic adoption, deletion, or rewriting. A bounded source-key scan runs under the vault lock before a source with no marker can be treated as new. If status reports pending transactions or startup reports integrity/ownership conflicts after lock ownership is safely resolved:

1. stop all writers for that vault;
2. preserve a complete copy of `.safire/memory/v1` for diagnosis;
3. restart one correctly configured writer and recheck `memory_status`;
4. do not edit records, markers, journals, digests, or the manifest by hand.

Idempotency markers prevent retry duplication. Reusing `(source_identity, stream, event_id)` with different payload/attribution fails rather than silently overwriting history.

## Durability boundary

Safire flushes each temporary JSON file before atomic same-directory publication or replacement. It also attempts to flush directory metadata. On Windows, Node may reject opening or syncing a directory (for example with `EPERM`); that unsupported directory-sync result is tolerated. Consequently the implementation does not claim that a just-published rename or hard link survives sudden power loss, kernel failure, controller-cache loss, or storage-device failure on Windows.

Automated recovery tests cover injected exceptions and an actual child process terminated after its journal file was flushed. After explicit operator recovery of the abandoned lock, a fresh process rolls that verified journal forward. A user-space hard kill with the operating system and storage stack still running is not a power-loss test and must not be represented as one.

## Integrity, confidentiality, and backups

SHA-256 record digests and previous-manifest digests are integrity evidence, not digital signatures, authentication tokens, encryption, or proof against a malicious writer that can recompute them.

Memory content is plaintext JSON. Filename opacity does not encrypt it. Anyone with read access to the vault can read the records. Use full-disk/device encryption and OS access controls where confidentiality matters.

Back up the entire vault, including `.safire/memory/v1`, so the manifest, records, idempotency markers, and any recovery journals stay consistent. A full copy retains the same vault identity. Only regenerate identity when intentionally allowing the copy to evolve as an independent logical vault; regeneration keeps prior IDs in lineage and does not erase history.

## Trusted bridge requirements

The trusted bridge is not a bypass around authentication. A host must provide an async authenticator that binds transport/session context to an allowlisted actor and returns a strict successful authentication result. Event actor fields and feedback `actor_id` are forbidden in bridge envelopes; the bridge constructs attribution only after authentication. Hashes supplied in authentication metadata help bind a decision to an envelope but are not authentication by themselves. Event content and feedback correction text are not included in authentication metadata.

User events and all user-attributed feedback additionally require a `trusted_bridge` profile with `trust.accept_user_events: true` and the exact user in `allowed_actors`. Role, actor type, event kind or feedback signal, delegation, agent instance, namespace access, and feedback target access are then checked. `user_confirmed` and `user_rejected` are restricted to an authenticated user. Failure is generic and must not record the event or feedback item.

Host integration code must use `createTrustedMemoryBridge({ vaultDir, profile, authenticate })`, which keeps the underlying `MemoryStore` private and returns a paired `{ store, bridge }` with a restricted store facade. The bridge owns a private persistence capability that is neither returned nor accepted from callers. Only `bridge.ingest` and `bridge.ingestFeedback` can use it, and only after successful authentication and authorization. Direct `store.recordEvents` and `store.recordFeedback` calls are unprivileged and reject user attribution, and transaction/publication internals are not exposed on the facade. There is no public trust-enabling flag: supplying `trustedIngress` is rejected.

Keep the returned store and bridge inside the trusted host integration. Although the store cannot manufacture trusted user attribution, it still carries the profile's read and authorized non-user write access. The ordinary six-tool MCP rejects `trusted_bridge` profiles entirely, including injected stores, and must never expose either member of the pair.

The current milestone installs no hook, listener, or external integration, performs no automatic capture, and makes no changes to Hermes or another agent product. See [Trusted bridge](TRUSTED_BRIDGE.md).

## Excluded systems

There is no lifecycle engine, automatic expiration, archive, deletion scheduler, cloud replication, AWS integration, or AWS archival fallback in this milestone. Operators should not infer remote backup or retention guarantees from the local-first label.
