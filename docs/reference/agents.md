## TL;DR

The agent API groups Box-owned agents, submitted turns, and interaction across Rust, Python, Node.js, Go, C and the CLI.

## Details

`Agents` is the Box-owned collection. `agents.create("opencode", options)`
selects an implementation and returns an `Agent` instance; `agents.get(agent_id)`
looks up that instance. Each agent owns its conversation and configuration;
turns represent submitted work. The create argument selects an implementation,
while `agent_id` identifies a created instance.
Use agent methods to send work and handle requests, and turn methods to observe,
steer or interrupt that work. See [the failure contract](#failure-contract) for
operation availability.

### API by purpose

| Purpose | Rust | Python | Node.js | Go |
|---|---|---|---|---|
| Namespace | `box.agents()` | `box.agents` | `box.agents` | `box.Agents()` |
| Agents | `agents.create/get`, `agent.close` | Same | Same | `Create/Get`, `Close` |
| Work | `agent.send/get_turn`, `turn.wait` | Same | `send/getTurn`, `wait` | `Send/GetTurn`, `Wait` |
| Events | `agent.events`, `turn.events` | Same | Same | `Events` |
| Interaction | `turn.steer/interrupt`, `agent.requests/respond` | Same | Same | `Steer/Interrupt`, `Requests/Respond` |
| Read-only state | `agent.state/config/capabilities()`, `turn.state()` | Properties | Properties | `State/Config/Capabilities()` |

Python exposes both async and synchronous handles, including `SimpleBox`,
`SyncBox` and `SyncSimpleBox`. Node exposes the namespace on native `JsBox`
and `SimpleBox`. Each SDK retains its error conventions.

### Failure contract

Rust on a local runtime runs the operations listed in
[OpenCode on a local runtime](#opencode-on-a-local-runtime). Everywhere else, agent
operations return an unsupported error before agent execution: namespace access and
data construction work, but execution, queues, event delivery, configuration
validation, retry deduplication and timeout handling are unavailable.

| SDK | Error behavior |
|---|---|
| Rust | `Err(BoxliteError::Unsupported(…))` naming the operation or option; no panic |
| Python | `UnsupportedError` on awaiting operations or reading a property |
| Node.js | Rejected operation promises; synchronous getter/event errors |
| Go | `*Error` with `Code: ErrUnsupported` and no result |
| C | Synchronous `Unsupported` return and optional `CBoxliteError`; no callback is invoked |
| CLI | `boxlite agent …` reports the unavailable operation on stderr and exits with code 1 |

Event opening never returns an empty successful stream. Python/Node fail when
`events()` is called; Rust fails when its future is awaited; Go returns a nil
stream with an error. C clears the subscription output pointer.

No agent or turn is returned by `create`, `get`, `send` or `respond`.
C getters clear output pointers; callbacks are not invoked and no agent, turn,
subscription or JSON result object is allocated.

### OpenCode on a local runtime

Rust on a local runtime forwards agents to OpenCode 2.2 inside the Box
([design #2227](https://github.com/boxlite-ai/boxlite/issues/2227)). BoxLite installs
nothing: the Box must already provide `opencode` 2.2.2 and `sh`, plus the provider
configuration and keys OpenCode reads, such as `ANTHROPIC_API_KEY` in the Box
environment. Another OpenCode version fails with `Unsupported` once its service
answers, or with `Execution` when it lacks the `opencode service` commands. Remote
runtimes and the other SDKs return `Unsupported`.

```text
agents.create("opencode") ──exec───► check OpenCode's service registration; set the
                                     service address to 0.0.0.0:47096 when different;
                                     read the service password
                          ──tunnel─► GET /api/info                  (exactly 2.2.2)
                          ──exec───► opencode service start         (only when none runs)
                          ──tunnel─► POST /api/session              → Agent (ses_…)
agent.send(text)          ──tunnel─► POST …/prompt, delivery queue  → AgentTurn (msg_…)
turn.wait()               ──tunnel─► inbox, history, pending requests
```

| Operation | Behavior |
|---|---|
| `agents.create` | Starts OpenCode's managed service on first use and creates a session. Only `cwd` and `config.model` (`provider/model`) are accepted |
| `agents.get` | Reads a session by its `ses_…` ID, starting the service again after a Box restart |
| `agent.send` | Admits the text with `queue` delivery under a BoxLite-chosen `msg_…` ID. A lost response is retried once with that ID; a second failure is a `Network` error naming the ID to read with `get_turn` |
| `agent.get_turn`, `turn.state` | `get_turn` reads the turn now, among the newest 1,000 messages of the session (older turns are `NotFound`); `turn.state` returns the snapshot taken when the handle was obtained. A turn is `queued` in the inbox; `running` or `waiting_input` until its run records an outcome; `completed`, `failed` or `cancelled` from that outcome; `unknown` when its execution was cut off and a later run took the next input |
| `turn.wait` | Polls every 500 ms. A timeout, or an `unknown` turn, returns `InvalidState` and never interrupts |
| `agent.config`, `agent.capabilities` | The session model; the operations above, with unknown limits as `None` |

BoxLite runs OpenCode's own managed service, the `opencode serve --service`
process that `opencode service start` launches, so OpenCode's recovery applies:

- **Address and password.** The service listens on `0.0.0.0:47096` so the Box
  tunnel reaches it. OpenCode keeps that address and the service password in its
  service configuration (mode 0600) under the Box user's home. Processes in the Box
  running as the same user, including the agent's own tools, can read the password.
- **Refusals.** `agents.create` and `agents.get` return `InvalidState` when OpenCode
  remote access is on, when a service started outside BoxLite runs at another
  address, when the service at port 47096 does not answer, or when another server
  holds that port. BoxLite never stops or signals a process.
- **Stale registrations.** OpenCode's service registration outlives an unclean
  exit, and its pid can later belong to another process, which `opencode service set`
  would signal. BoxLite deletes a registration whose pid no longer runs
  `opencode serve --service` before it changes any setting.
- **Recovery.** After a Box restart, the next `agents.get` starts the service again.
  It resumes an interrupted turn, then delivers queued inputs, at least once: a
  tool call may run twice. Background shells end cancelled. A clone of a Box with a
  turn in flight resumes its own copy of that turn.

Sessions deny reading `.env` and `.env.*` files (`.env.example` stays readable)
and OpenCode's `question` tool. OpenCode's defaults would ask first, nobody can
answer through BoxLite yet, and a pending ask holds every later input; denied, the
tool call fails and the turn continues. A turn waiting on another permission, such
as one asked in a subagent, lists it in its snapshot. Answering requests through
BoxLite is not available yet; every other operation and option returns
`Unsupported` before reaching OpenCode.

### Record migration (breaking change)

Agent records from v0.11.0 represent values an adapter cannot know:

| Field | v0.11.0 | Now |
|---|---|---|
| `AgentState.cursor`, `AgentTurnState.cursor`, `AgentEvent.cursor` | Required string | Optional; missing when the adapter cannot resume after it: `None` in Rust and Python, absent in TypeScript, `null` in C JSON, empty in Go |
| `AgentCapabilities` queue, steering and retention limits | Required numbers | Optional; missing means unknown or unsupported, never zero (Go: `nil`) |

No operation returned these records before, so only code that reads or builds these fields changes.

### Namespace ownership

Accessing a Box's agent namespace does not start or resume the Box. Python's
`SimpleBox`, `SyncBox` and `SyncSimpleBox` accessors need no runtime initialization.
Node's native `JsBox.agents` and `SimpleBox.agents` both expose `Agents`.

In C, `boxlite_box_agents` requires a live `CBoxHandle` and a writable output
pointer. It returns `Ok` with an owned `CAgents` namespace even while agent
operations return `Unsupported`. Release that namespace with
`boxlite_agents_free`; release the Box separately with `boxlite_box_free`.
A null Box handle or output pointer returns `InvalidArgument`.

### Grouped options

In SDK calls, keep identifiers and message text positional; group optional arguments in these types:

| Options type | Used by | Fields |
|---|---|---|
| `AgentCreateOptions` | `agents.create` | working directory, config, retry key |
| `AgentSendOptions` | `agent.send` | queue/reject mode, JSON data, retry key |
| `AgentControlOptions` | close, respond, steer, interrupt | retry key |
| `AgentWaitOptions` | `turn.wait` | timeout |
| `AgentEventsOptions` | both `events` methods | cursor |

Rust/Go accept option structs; Python accepts dataclass instances; Node accepts typed
objects. Python/Node may omit the options argument. Rust/Go use default/zero-valued
option structs. C uses corresponding `CAgent…Options` pointers; null means omitted.

### Inputs and records

Rust types live in `boxlite::agents`; Python types in `boxlite.agents`;
TypeScript types are exported from the package; Go types use the `Agent` prefix.

- Create selects an agent implementation and accepts a working directory, initial configuration and retry key.
- Send accepts text, optional JSON data, a retry key, and `queue` (default) or `reject` mode.
- Close, respond, steer and interrupt accept a retry key. Wait accepts an optional timeout.
- Config includes model, reasoning, instructions, tools/MCP references, permissions, limits and output schema.
- Requests retain their originating turn and distinguish a question from a permission request. Responses distinguish an answer from explicit permission approval/denial.
- Agent/turn snapshots include an optional opaque cursor, requests and steering receipts; the cursor is absent when the adapter cannot resume events after it. Capability limits are optional: absent means unknown or unsupported, never zero. Results retain the turn ID, status, outcome, output, artifacts, usage and errors.
- Unknown execution and steering states are representable. Accepted and applied steering are distinct; a question outcome is distinct from a final answer.

These records define SDK data types. The
[REST design](../contributing/investigations/2026-10-28-agent-rest-api-design.md)
maps them to nine HTTP operations, including snapshot reads, resumable events,
steering and typed replies. It also defines cached getter behavior and retry
headers. Agent HTTP routes and REST client support are unavailable.

### Example: handle operation errors

Python (the Box may already exist; this call starts no work):

```python
from boxlite import AgentCreateOptions, UnsupportedError

try:
    agent = await box.agents.create(
        "coder", AgentCreateOptions(cwd="/workspace")
    )
except UnsupportedError as error:
    print(error)
```

Rust:

```rust,no_run
use boxlite::{BoxliteError, LiteBox};
use boxlite::agents::AgentCreateOptions;

async fn example(sandbox: &LiteBox) {
    let result = sandbox.agents()
        .create("coder", AgentCreateOptions::default()).await;
    assert!(matches!(result, Err(BoxliteError::Unsupported(_))));
}
```

### C API and ownership

Include `boxlite.h`. `boxlite_box_agents` obtains `CAgents` from a live
`CBoxHandle`; release it with `boxlite_agents_free`. A null Box/output pointer
returns `InvalidArgument`.

| Purpose | C entry points |
|---|---|
| Agents | `boxlite_agents_create`, `boxlite_agents_get`, `boxlite_agent_close` |
| Work | `boxlite_agent_send`, `boxlite_agent_get_turn`, `boxlite_agent_turn_wait` |
| Events | `boxlite_agent_events`, `boxlite_agent_turn_events` |
| Interaction | `boxlite_agent_turn_steer`, `boxlite_agent_turn_interrupt`, `boxlite_agent_requests`, `boxlite_agent_respond` |
| Getters | `boxlite_agent_state/config/capabilities`, `boxlite_agent_turn_state` |

C option structs group the related arguments. `CAgentCreateOptions` contains
`cwd`, `config_json` and `idempotency_key`; `CAgentSendOptions` contains
`mode`, `data_json` and `idempotency_key`. Control options contain
`idempotency_key`; event options contain `after`; wait options contain
`timeout_seconds`. Null strings mean omitted. `AgentSendQueue = 0` and
`AgentSendReject = 1`.

Null options or a negative C timeout means no deadline.
Rust/Go use optional durations; Python uses `AgentWaitOptions.timeout` in seconds;
Node uses `AgentWaitOptions.timeoutSeconds`.

The C JSON fields use the following shapes. A question's
`schema` and an answer's `data` may be omitted. Nullable output fields use JSON
`null`; arrays remain arrays, including when empty.

| Record | C JSON fields |
|---|---|
| Config | Optional `model`, `reasoning`, `instructions`, `tools`, `mcp`, `permissions`, `limits`, `output_schema`; tools/MCP are string arrays |
| Request | `id`, `turn_id`, `kind`: either `{"type":"question","text":"…","schema":null}` or `{"type":"permission","tool":"…","arguments":{}}` |
| Response | `{"type":"answer","text":"yes"}` with optional `data`, or `{"type":"permission","approved":false}` |
| Steering receipt | `id`, `turn_id`, `status`: `accepted`, `applied`, `unused` or `unknown` |
| Agent snapshot | `id`, `status`, nullable `cursor`, nullable `active_turn_id`, `queued_turn_ids`, `requests`, `steering` |
| Turn snapshot | `id`, `agent_id`, `status`, nullable `cursor`, nullable `result`, `requests`, `steering` |
| Event | nullable `cursor`, `agent_id`, nullable `turn_id`, `kind` string, JSON `data` |
| Result | `turn_id`, `status`, nullable `outcome` (`answer` or `question`), nullable `text`, JSON `data`, `artifacts` string array, nullable JSON `usage`, nullable `error` string |
| Capabilities | `operations`, `input_kinds` string arrays; nullable integer `max_queued_turns`, `max_pending_steering`; nullable `idempotency_retention_seconds` number |

Agent status is `ready`, `busy`, `closing`, `closed` or `unknown`.
Turn status is `queued`, `running`, `waiting_input`, `interrupting`,
`completed`, `cancelled`, `failed` or `unknown`. Requests callbacks carry an
array of request records; wait/steer callbacks carry a result/receipt respectively.

A synchronous error means no callback will run. State/config/capability getters
clear `out_json` on error; event openers clear `out`.
Output/error pointers must be null or writable.

Errors written to `out_error` belong to the caller; release their messages with
`boxlite_error_free`. Callback error pointers and JSON strings are borrowed for
the callback's duration; copy their contents to retain them. JSON strings returned
through getter output pointers belong to the caller; use `boxlite_free_string`.

`boxlite_agent_free`, `boxlite_agent_turn_free` and
`boxlite_agent_events_free` release local handles only; they never close an agent
or interrupt work. Null handles may be freed.

### CLI commands

The [CLI reference](cli/README.md#boxlite-agent) lists nine flat `agent` commands.
BOX is positional. Creation uses `--agent IMPLEMENTATION`; other commands use
`--agent ID` to select an instance, with `--turn` and `--request` selecting its work.
`inspect` combines state and agent views, and `events` selects either scope.
SDKs expose `get`/`get_turn` methods; CLI targeting subsumes handle lookup.
CLI options reuse the five groups above and add `AgentInspectOptions` for view
selection.
