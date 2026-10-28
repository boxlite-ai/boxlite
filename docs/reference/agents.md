## TL;DR

The agent API groups Box-owned sessions, submitted turns, and interaction across Rust, Python, Node.js, Go, C and the CLI.

## Details

Sessions represent conversations and configuration; turns represent submitted work.
Use session methods to send work and handle requests, and turn methods to observe,
steer or interrupt that work. See [the failure contract](#failure-contract) for
operation availability.

### API by purpose

| Purpose | Rust | Python | Node.js | Go |
|---|---|---|---|---|
| Namespace | `box.agents()` | `box.agents` | `box.agents` | `box.Agents()` |
| Sessions | `agents.create/get`, `session.close` | Same | Same | `Create/Get`, `Close` |
| Work | `session.send/get_turn`, `turn.wait` | Same | `send/getTurn`, `wait` | `Send/GetTurn`, `Wait` |
| Events | `session.events`, `turn.events` | Same | Same | `Events` |
| Interaction | `turn.steer/interrupt`, `session.requests/respond` | Same | Same | `Steer/Interrupt`, `Requests/Respond` |
| Read-only state | `session.state/config/capabilities()`, `turn.state()` | Properties | Properties | `State/Config/Capabilities()` |

Python exposes both async and synchronous handles, including `SimpleBox`,
`SyncBox` and `SyncSimpleBox`. Node exposes the namespace on native `JsBox`
and `SimpleBox`. Each SDK retains its error conventions.

### Failure contract

Agent operations return an unsupported error before agent execution. Namespace
access and data construction work; execution, queues, event delivery, configuration
validation, retry deduplication and timeout handling are unavailable.

| SDK | Error behavior |
|---|---|
| Rust | `Err(BoxliteError::Unsupported("… is not implemented"))`; no panic |
| Python | `UnsupportedError` on awaiting operations or reading a property |
| Node.js | Rejected operation promises; synchronous getter/event errors |
| Go | `*Error` with `Code: ErrUnsupported` and no result |
| C | Synchronous `Unsupported` return and optional `CBoxliteError`; no callback is invoked |
| CLI | `boxlite agent …` reports the unavailable operation on stderr and exits with code 1 |

Event opening never returns an empty successful stream. Python/Node fail when
`events()` is called; Rust fails when its future is awaited; Go returns a nil
stream with an error. C clears the subscription output pointer.

No session or turn is returned by `create`, `get`, `send` or `respond`.
C getters clear output pointers; callbacks are not invoked and no session, turn,
subscription or JSON result object is allocated.

### Grouped options

In SDK calls, keep identifiers and message text positional; group optional arguments in these types:

| Options type | Used by | Fields |
|---|---|---|
| `AgentCreateOptions` | `agents.create` | working directory, config, retry key |
| `AgentSendOptions` | `session.send` | queue/reject mode, JSON data, retry key |
| `AgentControlOptions` | close, respond, steer, interrupt | retry key |
| `AgentWaitOptions` | `turn.wait` | timeout |
| `AgentEventsOptions` | both `events` methods | cursor |

Rust/Go accept option structs; Python accepts dataclass instances; Node accepts typed
objects. Python/Node may omit the options argument. Rust/Go use default/zero-valued
option structs. C uses corresponding `CAgent…Options` pointers; null means omitted.

### Inputs and records

Rust types live in `boxlite::agents`; Python types in `boxlite.agents`;
TypeScript types are exported from the package; Go types use the `Agent` prefix.

- Create selects the agent by identifier and accepts a working directory, initial configuration and retry key.
- Send accepts text, optional JSON data, a retry key, and `queue` (default) or `reject` mode.
- Close, respond, steer and interrupt accept a retry key. Wait accepts an optional timeout.
- Config includes model, reasoning, instructions, tools/MCP references, permissions, limits and output schema.
- Requests retain their originating turn and distinguish a question from a permission request. Responses distinguish an answer from explicit permission approval/denial.
- Session/turn snapshots include an opaque cursor, requests and steering receipts. Results retain the turn ID, status, outcome, output, artifacts, usage and errors.
- Unknown execution and steering states are representable. Accepted and applied steering are distinct; a question outcome is distinct from a final answer.

These records define SDK data types, not a network wire protocol.

### Example: handle operation errors

Python (the Box may already exist; this call starts no work):

```python
from boxlite import AgentCreateOptions, UnsupportedError

try:
    session = await box.agents.create(
        "agent-id", AgentCreateOptions(cwd="/workspace")
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
        .create("agent-id", AgentCreateOptions::default()).await;
    assert!(matches!(result, Err(BoxliteError::Unsupported(_))));
}
```

### C API and ownership

Include `boxlite.h`. `boxlite_box_agents` obtains `CAgentHandle` from a live
`CBoxHandle`; release it with `boxlite_agent_free`. A null Box/output pointer
returns `InvalidArgument`.

| Purpose | C entry points |
|---|---|
| Sessions | `boxlite_agent_create`, `boxlite_agent_get`, `boxlite_agent_session_close` |
| Work | `boxlite_agent_session_send`, `boxlite_agent_session_get_turn`, `boxlite_agent_turn_wait` |
| Events | `boxlite_agent_session_events`, `boxlite_agent_turn_events` |
| Interaction | `boxlite_agent_turn_steer`, `boxlite_agent_turn_interrupt`, `boxlite_agent_session_requests`, `boxlite_agent_session_respond` |
| Getters | `boxlite_agent_session_state/config/capabilities`, `boxlite_agent_turn_state` |

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
| Session snapshot | `id`, `status`, `cursor`, nullable `active_turn_id`, `queued_turn_ids`, `requests`, `steering` |
| Turn snapshot | `id`, `session_id`, `status`, `cursor`, nullable `result`, `requests`, `steering` |
| Event | `cursor`, `session_id`, nullable `turn_id`, `kind` string, JSON `data` |
| Result | `turn_id`, `status`, nullable `outcome` (`answer` or `question`), nullable `text`, JSON `data`, `artifacts` string array, nullable JSON `usage`, nullable `error` string |
| Capabilities | `operations`, `input_kinds` string arrays; integer `max_queued_turns`, `max_pending_steering`; `idempotency_retention_seconds` number |

Session status is `ready`, `busy`, `closing`, `closed` or `unknown`.
Turn status is `queued`, `running`, `waiting_input`, `interrupting`,
`completed`, `cancelled`, `failed` or `unknown`. Requests callbacks carry an
array of request records; wait/steer callbacks carry a result/receipt respectively.

A synchronous error means no callback will run. State/config/capability getters
clear `out_json` on error; event openers clear `out`.
Output/error pointers must be null or writable.

Use `boxlite_error_free` for returned error messages.
`boxlite_agent_session_free`, `boxlite_agent_turn_free` and
`boxlite_agent_events_free` release local handles only; they never close a session
or interrupt work. Null handles may be freed.

### CLI commands

The [CLI reference](cli/README.md#boxlite-agent) lists nine flat `agent` commands.
BOX is positional; creation requires `--agent AGENT` to select the agent for a new
session. Existing work is selected with `--session`, `--turn` and `--request`.
`inspect` combines state and session views, and `events` selects either scope.
SDKs retain the `get`/`get_turn` methods; CLI targeting subsumes handle lookup.
CLI options reuse the five groups above and add `AgentInspectOptions` for view
selection.
