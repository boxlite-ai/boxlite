## TL;DR

Expose Box-owned agents and turns through nine HTTP operations, with shared snapshots, resumable events and explicit control actions.

## Details

This is a REST contract design for [the agent API](../../reference/agents.md)
and [tracking issue #2140](https://github.com/boxlite-ai/boxlite/issues/2140).
This PR adds no HTTP handlers, OpenAPI paths or REST client implementation.
The declared SDK operations continue to return Unsupported.

### Why this shape

| Evidence | Lesson for BoxLite |
|---|---|
| [Shelley API: streaming and conversation endpoints](https://github.com/boldsoftware/shelley/blob/main/API.md) uses snapshots and SSE; conversation creation also sends a prompt. | Adopt snapshots and events. Separate creation from sending so configuration can be inspected before execution. |
| [Rivet agent sessions](https://github.com/rivet-dev/agents/blob/main/sandbox-agent/docs/content/docs/agent-sessions.mdx) separates agent selection, sessions, event subscriptions and permission replies. | Keep implementation selection separate from instance identity; use typed replies. This source describes SDK behavior, not wire routes. |
| [OpenHands: get conversation](https://docs.openhands.dev/sdk/guides/agent-server/api-reference/conversations/get-conversation) returns a conversation resource containing agent configuration and state. | Combine read-only views in one resource instead of adding a route for every getter. |
| [OpenComputer OpenAPI](https://opencomputer.dev/openapi.json), session and turn operations, separates creation from submission, supports retry keys and exposes a polled event log. | Adopt durable identities and retry reconciliation. Use SSE for BoxLite streams; target interruption at a turn and confirm it, unlike OpenComputer's session-level asynchronous interrupt. |

BoxLite already defines [routing, authentication and errors](../../../openapi/box.openapi.yaml).
Its [agent handles](../../../src/boxlite/src/agents/mod.rs) include synchronous
getters, so a REST implementation needs cached snapshots. No existing agent
transport can be reused: the methods currently reject operations.

An RPC route per SDK method would duplicate reads and expose local handle helpers.
A single action endpoint would hide resource identity and response types.
Resource reads plus explicit mutation routes keep both visible. Keeping SDK-only
access would leave remote Box clients without this contract.

BoxLite calls the conversation-owning instance `Agent`, matching `agents.create`
and `boxlite agent create`. The collection is `Agents`, and submitted work is
`AgentTurn`. OpenComputer and OpenHands use session/conversation terminology;
BoxLite's choice keeps its own SDK, CLI and REST resource names consistent.

### Routes by purpose

Use the existing Bearer authentication and deployment routing prefix:

```text
B = /v1/{prefix}/boxes/{box_id}
A = B/agents/{agent_id}
T = A/turns/{turn_id}
```

`{prefix}` is the existing optional routing slot; without it, `B` starts with
`/v1/boxes`. Encode each opaque ID as one path segment. `/agents` is the instance
collection. The create body's `agent` selects an implementation; `state.id` in
the returned resource identifies the new instance and becomes `{agent_id}`.

| Purpose | Method and path | Input | Success |
|---|---|---|---|
| Agents | `POST B/agents` | `agent`, creation `options` | `201 AgentResource`; `Location: A` |
| Agents/read | `GET A` | — | `200 AgentResource` |
| Agents | `POST A/close` | — | `200 AgentResource`, confirmed closed |
| Work | `POST A/turns` | `text`, send `options` | `201 AgentTurnState`; `Location: T` |
| Work/read | `GET T` | — | `200 AgentTurnState` |
| Observe | `GET A/events` | optional `after`, `turn_id` query | `200 text/event-stream` |
| Interact | `POST A/requests/{request_id}/respond` | typed `response` | `200 AgentTurnState` |
| Interact | `POST T/steer` | `text` | `200 AgentSteeringReceipt` |
| Interact | `POST T/interrupt` | — | `200 AgentTurnState`, confirmed stopped |

All JSON uses `application/json`, snake_case fields and the record shapes in
[Inputs and records](../../reference/agents.md#inputs-and-records) and
[C JSON fields](../../reference/agents.md#c-api-and-ownership).
`AgentResource` is the wire envelope
`{ "agent": string, "state": AgentState, "config": AgentConfig, "capabilities": AgentCapabilities }`.
These shapes require explicit serialization; the Rust records are not wire DTOs.

Every resource read is an atomic snapshot. Nullable response fields are present
as `null`; collections are arrays, including when empty. A terminal turn
(`completed`, `cancelled` or `failed`) always includes its result. Config contains
effective values and Box-managed tool/MCP references, never provider credentials.

### Inputs and grouped options

Illustrative bodies, not runnable examples against the current server:

```json
{"agent":"coder","options":{"cwd":"/workspace","config":{"model":"configured-model"}}}
```

```json
{"text":"Review the change","options":{"mode":"queue","data":{"focus":"tests"}}}
```

```json
{"text":"Focus on the parser"}
```

```json
{"response":{"type":"permission","approved":false}}
```

The bodies above create an agent, send a turn, steer that turn and deny a
permission request, respectively. An answer uses
`{"response":{"type":"answer","text":"Use option A","data":{}}}`.

| SDK options | HTTP representation |
|---|---|
| `AgentCreateOptions` | `options.cwd`, `options.config`; retry key in header |
| `AgentSendOptions` | `options.mode`, `options.data`; retry key in header |
| `AgentControlOptions` | Retry key in header for close/respond/steer/interrupt |
| `AgentEventsOptions` | `after` query; a turn handle supplies `turn_id` |
| `AgentWaitOptions` | SDK deadline only; no wait route or timeout query |

The retry header is `Idempotency-Key`; do not duplicate it in JSON.
Omitted options/config mean `{}`; omitted mode means `queue`. Omitted cwd leaves
directory selection to the adapter. Reject null option/config objects, unknown
structural fields, invalid enum values and malformed identifiers with 400.
SDK encoders omit absent structural fields: Python's default `config=None`
means no `options.config`, not a JSON null object.
Close/interrupt accept an empty body or `{}` only.

For send only, omitted `options.data` and explicit JSON `null` both mean no
supplemental data and normalize to `null`. [Python defaults this field to
None](../../../sdks/python/boxlite/agents.py), so distinguishing them would require
a new SDK sentinel. Preserve `false`, zero, empty strings/collections and nested
JSON nulls; do not apply this omission rule to other JSON fields.

These send bodies have the same meaning and retry fingerprint:

```json
{"text":"Review the change"}
```

```json
{"text":"Review the change","options":{"mode":"queue","data":null}}
```

### SDK coverage and snapshot freshness

| SDK operation | Transport behavior |
|---|---|
| `box.agents()` | Local namespace; no HTTP request |
| `agents.create/get`, `agent.close` | Agent create/read/close routes |
| `agent.send/get_turn/respond` | Turn create/read and request response routes |
| `agent.state/config/capabilities`, `turn.state` | Read the handle's cached snapshot synchronously |
| `agent.requests()` | Fetch `GET A`, then return `state.requests` |
| `agent.events`, `turn.events` | Same SSE route; turn view sets `turn_id` |
| `turn.steer/interrupt` | Targeted control routes |
| `turn.wait` | Fetch `GET T` until a result or the caller's deadline |

Async create/get/send/get_turn/respond hydrate returned handles. Close/interrupt
responses refresh their target handle; getters do not perform blocking network
requests. Existing handles are snapshots, not live views of other handles.
Call `agents.get` or `agent.get_turn` for a fresh handle.

Serialize refreshes of one handle; never compare opaque cursors or overwrite a
newer snapshot with a response from an earlier concurrent read. A deduplicated
mutation may return its original, older snapshot; fetch a fresh handle before
making a current-state decision. Event consumption does not silently mutate
cached state.

Wait uses bounded, backoff polling; events may wake a read sooner. Omitted timeout
means no overall deadline; zero performs one bounded read. A wait timeout or
disconnect leaves the turn running. `unknown` execution surfaces an uncertainty
error instead of being treated as completion or replayed automatically.

### Admission, replies and controls

Send creates a turn without waiting for its result. Preserve the issue's bounded
FIFO queue and explicit reject mode. Busy rejection is 409; exhausted capacity
is 429. A blocked request or uncertain execution prevents queue advancement.

Respond checks request ownership and variant before atomically resolving the
request and admitting the answer. It returns the active turn, or an answering
turn after a terminal question. That answer runs before work held behind the
question. Revoked/resolved requests reject new replies with 409; retries with
the original key recover their original response.

Steer targets a running or waiting-input turn. Reject other states with 409.
An accepted receipt means admission; applied means delivered to context, not
model compliance. Steering grants no permission and never becomes a queued
turn. An adapter unable to preserve this contract returns Unsupported.

Interrupt cancels a queued turn or confirms its running loop stopped. An already
terminal turn returns its unchanged snapshot. Close blocks admissions, cancels
queued turns and requests, and confirms active-loop shutdown. Neither action
stops unrelated Box processes or deletes files/history; close is therefore not DELETE.

Unconfirmed shutdown returns an error and retains `interrupting`, `closing` or
`unknown` state as appropriate. Never return success merely because a stop signal
was sent. Clients reconcile with GET and, where provided, the same retry key.

### Events and recovery

Use the [SSE format and Last-Event-ID header](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header):

```text
id: opaque-cursor
event: agent
data: {"cursor":"opaque-cursor","agent_id":"a1","turn_id":"t1","kind":"turn.state","data":{"status":"running"}}

```

`kind` is an extensible adapter/event string; the example is illustrative.
The `id` equals the record's cursor. Replay is strictly after that cursor,
followed by live records with no replay-to-live gap. Snapshots and events share
one durable agent journal. Clients deduplicate reconnect delivery by cursor.

Read a snapshot, then open the stream with `after=state.cursor` for race-free
recovery. With no cursor, tail from the stream's opening watermark; do not imply
complete history. On reconnect, `Last-Event-ID` takes precedence over `after`:
SSE clients may reuse the initial URL while advancing that header. A cursor
from another agent is invalid.

`turn_id` filters the same journal to that turn; cursors need not be consecutive.
Validate the turn's parent even if no events match. A turn stream drains through
its terminal transition; an agent stream drains through closure. Clients check
the snapshot after EOF before reconnecting. Stream disconnect never cancels work.

An expired cursor returns `410 cursor_expired` before opening the stream; recover
with a fresh snapshot, explicitly accepting lost event history. Heartbeat comments
carry no ID. Errors after headers use `event: error` with the error envelope and
no ID, then close. Use authenticated fetch/SSE clients for Bearer headers, not
credentials in query strings.

### Retries, ownership and errors

Authorize every request against its Box and validate all parent-child bindings.
Missing, inaccessible or wrong-parent agent/turn/request IDs return 404.
No control implicitly selects the currently active turn.

For every mutation, authenticate and validate syntax before looking up the retry
key; deduplicate before mutable-state checks. Scope keys to principal, routing
prefix and Box. Compare method, target and normalized input using the documented
wire defaults above. Compare JSON values independent of object-key order;
preserve array order and value types. Do not re-resolve adapter defaults when
fingerprinting a retry.
Equal retries replay the original status/body/Location; pending retries join the
same operation. A different fingerprint returns 422, following the Box API.

An unconfirmed shutdown leaves its operation pending. Its transient 503 response
is not a completed idempotency result; a retry with the same key rejoins
reconciliation. Persist the final response only after the outcome is known.

Agent keys are opaque, nonempty ASCII header values of at most 256 bytes; UUIDs
are recommended. Define an agent-specific OpenAPI parameter when implementing:
the existing Box parameter requires UUIDs, while agent SDK options accept strings.
Do not widen the existing parameter or change other Box operations.

Publish the retention guarantee in `GET /v1/config`'s
`capabilities.idempotency_key_lifetime` (ISO 8601 duration), and the same guarantee
as `idempotency_retention_seconds` in agent capabilities. Retention starts
when an operation finishes; pending records cannot expire.

For an uncertain mutation, retry the same request and key while its record is
retained. A known resource ID permits a GET, but retry only when reconciliation
can establish that no duplicate effect will occur. A snapshot alone does not
identify which mutation produced it.

If a create response is lost without a retained key or returned agent ID, this
slice has no discovery route to recover that identity. Report an uncertain
outcome; never automatically repeat creation with a new or expired key. A caller
may explicitly start another creation, accepting that the first agent may exist.

Use the existing nested Box error envelope and [typed mapping](../../../src/shared/src/errors.rs):

```json
{"error":{"message":"Agent operation is unavailable","type":"UnsupportedError","code":"unsupported","request_id":"request-id"}}
```

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `invalid_argument` / `unsupported` | Invalid input or unavailable adapter operation |
| 401 / 403 | Existing authentication/authorization errors | Follow Box authentication policy |
| 404 | `not_found` | Missing or inaccessible target |
| 409 | `invalid_state` | Busy/revoked request/wrong execution state |
| 410 | `cursor_expired` | New stream-recovery code; use `InvalidStateError` as type |
| 422 | `invalid_argument` | Retry-key fingerprint conflict |
| 429 | `resource_exhausted` | Queue or steering capacity reached |
| 503 | Existing unavailable codes | Backend unavailable or shutdown unconfirmed |

`cursor_expired` is a proposed extension, not an existing Box error code.
Implementation must update OpenAPI and client decoding together. Do not infer
capability from an agent name or silently downgrade an unsupported action.

### Validation and boundaries

Observed during design: all declared SDK operations map above; current shared
types, synchronous signatures, prefix handling and error envelopes were inspected.
No server or adapter conformance is claimed.

Implementation acceptance checks:

- Capture each SDK request at a local HTTP server: method, encoded target, options and retry header match this contract. Python's absent config is omitted; false, zero, empty values and nested nulls survive encoding.
- Compare omitted/null send data and explicit wire defaults under one key: the same turn is returned. Different data conflicts; object-key order does not, while array order does.
- Race duplicate sends/replies/controls, including lost responses: one logical effect; different input under one key yields 422.
- Lose a create response with retained, absent and expired keys: only a retained key permits automatic replay; an unknown identity without it reports uncertainty and issues no second creation.
- Reconnect after a snapshot and during live delivery: no gaps; Last-Event-ID overrides the initial URL cursor; duplicate cursors are harmless; expired cursors require explicit recovery.
- Cross Box/agent targets fail; late permission replies cannot revive revoked requests; steering never grants approval or changes turn identity.
- Cache reads perform no I/O; explicit get refreshes; wait expiry does not interrupt; close/interrupt succeed only after confirmed shutdown.

List/discovery, deletion, configuration updates, history, pause/resume, attachments,
fork/compaction and provider administration remain outside this slice. Before
implementation, settle journal storage and retention, adapter shutdown guarantees
and the shared error mapping; then add OpenAPI schemas and transport tests.
