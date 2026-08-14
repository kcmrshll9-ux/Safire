# Trusted bridge for authenticated visible events

## Current status

The version-1 trusted bridge is a library seam and an explicit in-process simulator. It is not an installed transport, background listener, hook, proxy, or transcript monitor. It captures nothing unless host code deliberately invokes `ingest` with both an authentication callback and a recording callback.

This milestone makes no external Hermes changes and does not automatically capture from Hermes or any other agent. An integration with an external host would be separate, reviewed work.

Ordinary portable MCP cannot create user events. A portable profile cannot allowlist a user or enable `accept_user_events`, MCP tools expose no trust-setting field, and the ordinary MCP server rejects a `trusted_bridge` profile or store at startup. Authenticated user attribution requires this trusted-bridge path.

## What may be captured

Only visible or observable events are in scope:

- visible user messages;
- visible agent responses;
- delegated instructions and tool prompts;
- tool calls and observable actions;
- tool results and external observations;
- automation decisions and explicit conclusions;
- user-supplied file/link references;
- visible user interactions with results.

Private chain-of-thought, hidden reasoning, scratchpads, reasoning traces, credentials, and tokens must not be captured. Safire rejects common forms, but the host remains responsible for data minimization and redaction before ingestion.

There is no automatic capture today. The bridge never watches a session and never decides on its own which content to store.

## Required profile

The host must load a normalized version-1 profile whose `profile_type` is `trusted_bridge`. To accept a user event, all of the following are required:

- `trust.accept_user_events` is exactly `true`;
- the authenticated user ID appears in `allowed_actors` with type `user`;
- the event namespace has write permission;
- the successful authentication result has role `user` and that exact actor ID;
- the event kind is allowed for the user role.

[`trusted-bridge-profile.json`](examples/trusted-bridge-profile.json) is an invented reference. It contains no authentication key or secret. Profile allowlisting is authorization configuration, not proof that the caller owns an identity.

## Envelope

The envelope is strict schema `safire.memory.trusted-bridge-envelope/v1` with `schema_version: 1`. It has the event fields described in [Architecture](ARCHITECTURE.md) except all actor fields are omitted.

An envelope must not contain:

- `actor_type`;
- `actor_id`;
- `delegated_by`;
- `agent_instance_id`.

The bridge adds those fields exclusively from successful authentication plus the profile. See [`trusted-bridge-user-event.json`](examples/trusted-bridge-user-event.json) for a synthetic envelope.

## Authentication contract

Host code constructs the bridge with:

```js
createTrustedBridge({ profile, authenticate, recordEvents })
```

- `profile` is the validated `trusted_bridge` profile.
- `authenticate(metadata, authContext)` is an async host callback.
- `recordEvents([event])` commits through the normal memory store after authentication and authorization.

The recording callback must belong to a private, in-process bridge store:

```js
const store = createMemoryStore({ vaultDir, profile, trustedIngress: true });
const bridge = createTrustedBridge({
  profile,
  authenticate,
  recordEvents: store.recordEvents.bind(store),
});
```

`trustedIngress: true` is accepted only with a `trusted_bridge` profile. It does not authenticate a transport and must never be used for a store exposed through ordinary MCP or another untrusted RPC surface. The bridge's successful authentication and closed role/kind checks are what authorize each event.

Before calling the authenticator, Safire validates the actor-free envelope. The immutable metadata supplied to `authenticate` contains:

- bridge schema version and envelope schema ID;
- profile ID;
- namespace, kind, speech act, occurrence time, source, and optional context;
- UTF-8 content length;
- SHA-256 of the content;
- SHA-256 of the canonical envelope.

The authenticator must bind `authContext` to a real, already authenticated host session or signed transport assertion and bind its decision to the supplied metadata. A hash is not authentication. Do not accept actor IDs asserted in the envelope, an unauthenticated process argument, a display name, or a caller-controlled header without independent verification.

Success must be a strict object:

```json
{
  "authenticated": true,
  "role": "user",
  "actor_id": "user:example-owner"
}
```

Allowed roles are `user`, `agent`, `automation`, and `external_service`. An authenticated agent may additionally return `agent_instance_id`. An authenticated automation may additionally return `delegated_by`. Other roles cannot carry those fields. Any thrown error, false/partial object, unknown field, role mismatch, or actor mismatch becomes a generic `TRUSTED_BRIDGE_AUTHENTICATION_FAILED` or authorization failure and must not record an event.

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

## Explicit integration sequence

1. The host observes a visible/observable event through an authorized integration point.
2. The host removes secrets and excludes hidden reasoning.
3. It constructs an actor-free version-1 envelope with a stable source stream/event ID.
4. It calls `bridge.ingest(envelope, authenticatedHostContext)`.
5. Safire validates the envelope and passes bounded metadata to the host authenticator.
6. The host authenticates the session/transport and returns an allowlisted role/actor result.
7. Safire verifies role, kind, delegation/instance, trust flag, and namespace ACL.
8. Safire constructs the attributed event and calls the normal journaled `recordEvents` path.

Source retries obey the normal idempotency tuple `(profile.source_identity, source.stream, source.event_id)`. Use a stable event ID from the authenticated source; never generate a new ID merely to retry a failed response.

## Simulator limitations

`simulateTrustedBridge` is an explicit developer demonstration. It creates no listener, installs no hook, and persists nothing unless the caller supplies both callbacks and the recording callback writes to a configured store. Its invented default envelope is suitable for tests only. It does not prove transport security or authorize production user capture.

## Milestone exclusions

The bridge adds no lifecycle, retention, decay, archive, cloud, AWS, or external Hermes behavior. Those capabilities must not be inferred from this design seam.
