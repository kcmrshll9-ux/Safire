# Trusted bridge for authenticated visible events and feedback

## Current status

The version-1 trusted bridge is a library seam and an explicit in-process simulator. It is not an installed transport, background listener, hook, proxy, or transcript monitor. It captures nothing unless host code constructs the paired trusted-memory bridge with an authenticator and deliberately invokes `bridge.ingest` or `bridge.ingestFeedback`.

This milestone makes no external Hermes changes and does not automatically capture from Hermes or any other agent. An integration with an external host would be separate, reviewed work.

Ordinary portable MCP cannot create user events or user-attributed feedback. A portable profile cannot allowlist a user or enable `accept_user_events`, MCP tools expose no trust-setting field, and the ordinary MCP server rejects a `trusted_bridge` profile or store at startup. Authenticated user attribution requires this trusted-bridge path.

## What may be captured

Only visible or observable events and explicit feedback are in scope:

- visible user messages;
- visible agent responses;
- delegated instructions and tool prompts;
- tool calls and observable actions;
- tool results and external observations;
- automation decisions and explicit conclusions;
- user-supplied file/link references;
- visible user interactions with results;
- explicit usefulness signals, confirmations, rejections, corrections, and supersession links.

Private chain-of-thought, hidden reasoning, scratchpads, reasoning traces, credentials, and tokens must not be captured. Safire rejects common forms in both visible text and identifier fields, but the host remains responsible for data minimization and redaction before ingestion.

There is no automatic capture today. The bridge never watches a session and never decides on its own which content to store.

## Required profile

The host must load a normalized version-1 profile whose `profile_type` is `trusted_bridge`. To accept any user-attributed event or feedback, all of the following are required:

- `trust.accept_user_events` is exactly `true`;
- the authenticated user ID appears in `allowed_actors` with type `user`;
- the successful authentication result has role `user` and that exact actor ID;
- the event namespace or feedback target has write permission;
- any related feedback target has read permission.

An event kind must also be allowed for the user role. The `user_confirmed` and `user_rejected` feedback signals require an authenticated user; a non-user role cannot submit them.

[`trusted-bridge-profile.json`](examples/trusted-bridge-profile.json) is an invented reference. It contains no authentication key or secret. Profile allowlisting is authorization configuration, not proof that the caller owns an identity.

## Event envelope

The envelope is strict schema `safire.memory.trusted-bridge-envelope/v1` with `schema_version: 1`. It has the event fields described in [Architecture](ARCHITECTURE.md) except all actor fields are omitted.

An envelope must not contain:

- `actor_type`;
- `actor_id`;
- `delegated_by`;
- `agent_instance_id`.

The bridge adds those fields exclusively from successful authentication plus the profile. See [`trusted-bridge-user-event.json`](examples/trusted-bridge-user-event.json) for a synthetic envelope.

## Feedback envelope

Trusted feedback uses strict schema `safire.memory.trusted-bridge-feedback-envelope/v1` with `schema_version: 1`. It contains:

- `target`;
- `signal`;
- optional `correction`;
- optional `related_target`;
- `source`.

It never accepts `actor_id`. The bridge obtains the feedback actor exclusively from successful authentication. The ordinary feedback rules still apply: correction text is required for `correction`, a related target is required for `superseded`, the target namespace must be writable, and a related target must be readable.

## Authentication contract

Host integration code constructs a paired store and bridge with:

```js
const { store, bridge } = createTrustedMemoryBridge({
  vaultDir,
  profile,
  authenticate,
});
```

- `vaultDir` is the selected absolute, non-root Safire vault path.
- `profile` is the validated `trusted_bridge` profile.
- `authenticate(metadata, authContext)` is an async host callback that authenticates the visible host session or transport.
- `store` is a restricted, unprivileged facade for status, retrieval, identity regeneration, and authorized non-user operations. The underlying `MemoryStore` and its transaction internals are not returned.
- `bridge.ingest(eventEnvelope, authContext)` authenticates and records one visible or observable event.
- `bridge.ingestFeedback(feedbackEnvelope, authContext)` authenticates and records one feedback item.

`createTrustedMemoryBridge` owns the private capability that connects successful bridge authentication to persistence. That capability is not returned on `store` or accepted from callers. Direct `store.recordEvents` and `store.recordFeedback` calls remain unprivileged and reject user attribution, even when the store has a `trusted_bridge` profile.

There is no public trust-enabling constructor flag. Supplying `trustedIngress` to `MemoryStore`, `createMemoryStore`, or `createTrustedMemoryBridge` is rejected. Additional supported store options may be passed to `createTrustedMemoryBridge`, but none can grant trusted attribution. Keep both returned objects inside the trusted host integration; the store still carries the profile's read and non-user write authority and must not be exposed through an untrusted RPC surface.

Before calling the authenticator, Safire validates the actor-free envelope, including its namespace and every source, context, relation, provenance, target, and related-target identifier. Credential-like identifiers fail with a generic non-echoing schema error before metadata is constructed, hashed, or forwarded. For an event, the immutable metadata supplied to `authenticate` contains:

- bridge schema version and envelope schema ID;
- `operation: "event"`;
- profile ID;
- namespace, kind, speech act, occurrence time, source, and optional context;
- UTF-8 content length;
- SHA-256 of the content;
- SHA-256 of the canonical envelope.

For feedback, the immutable metadata contains:

- bridge schema version and feedback-envelope schema ID;
- `operation: "feedback"`;
- profile ID;
- target, signal, source, and optional related target;
- SHA-256 of the canonical envelope;
- when correction text is present, its UTF-8 length and SHA-256 digest.

Authentication metadata never contains the visible event content or correction text. The hashes bind an authentication decision to the submitted envelope without turning a digest into a credential.

The authenticator must bind `authContext` to a real, already authenticated host session or signed transport assertion and bind its decision to the supplied metadata. A hash is not authentication. Do not accept actor IDs asserted in the envelope, an unauthenticated process argument, a display name, or a caller-controlled header without independent verification.

Success must be a strict object:

```json
{
  "authenticated": true,
  "role": "user",
  "actor_id": "user:example-owner"
}
```

Allowed roles are `user`, `agent`, `automation`, and `external_service`. An authenticated agent may additionally return `agent_instance_id`. An authenticated automation may additionally return `delegated_by`. Other roles cannot carry those fields. Any authenticator-thrown error, false/partial authentication object, unknown authentication field, role mismatch, or actor mismatch becomes a generic `TRUSTED_BRIDGE_AUTHENTICATION_FAILED` or authorization failure and must not record an event or feedback item. Schema, storage, and filesystem errors retain their own domain error.

The example above is also available as [`trusted-bridge-authentication-result.json`](examples/trusted-bridge-authentication-result.json). It represents only the callback result after authentication; it is not a reusable credential.

## Exact role-to-kind authorization

| Authenticated role | Allowed event kinds |
| --- | --- |
| `user` | `visible_user_message`, `supplied_file`, `supplied_link`, `user_result_interaction` |
| `agent` | `visible_agent_response`, `delegated_instruction`, `tool_prompt`, `tool_call`, `observable_action`, `explicit_conclusion` |
| `automation` | `automation_decision`, `delegated_instruction`, `tool_prompt`, `tool_call`, `observable_action`, `explicit_conclusion` |
| `external_service` | `tool_result`, `external_observation` |

The authenticated role must match the allowlisted actor type. Automation attribution is accepted only when its configured `delegated_by` matches the profile principal. An authenticated `agent_instance_id` must resolve to the configured instance. Namespace write access is checked after authentication.

These checks keep distinct provenance streams distinct. A visible user request, agent proposal, delegated automation decision, and external tool observation cannot silently masquerade as one another.

For feedback, authentication supplies the actor before the normal profile and target checks run. Every user-attributed feedback item requires the trusted user configuration above, including `useful`, `not_useful`, `correction`, and `superseded`. Confirmation and rejection signals are additionally restricted to a user actor.

## Explicit integration sequence

1. The host observes a visible/observable event or feedback action through an authorized integration point.
2. The host removes secrets and excludes hidden reasoning.
3. It constructs the appropriate actor-free version-1 envelope with a stable source stream/event ID.
4. It calls `bridge.ingest(envelope, authenticatedHostContext)` for an event or `bridge.ingestFeedback(envelope, authenticatedHostContext)` for feedback.
5. Safire validates the envelope and passes bounded metadata to the host authenticator.
6. The host authenticates the session/transport and returns an allowlisted role/actor result.
7. Safire verifies the role, actor, trust setting, and event-kind or feedback-signal constraints.
8. Safire constructs the attributed input and uses its private capability to call the normal journaled store path, which enforces namespace and target access.

Source retries obey the normal idempotency tuple `(profile.source_identity, source.stream, source.event_id)`. Use a stable event ID from the authenticated source; never generate a new ID merely to retry a failed response.

## Simulator limitations

`simulateTrustedBridge` is an explicit developer demonstration. It creates no listener, installs no hook, and does not provide the paired store capability used by `createTrustedMemoryBridge`. Its invented default envelope is suitable for tests only. It does not prove transport security, persist by itself, or authorize production user capture.

## Milestone exclusions

The bridge adds no lifecycle, retention, decay, archive, cloud, AWS, or external Hermes behavior. Those capabilities must not be inferred from this design seam.
