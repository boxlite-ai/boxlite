# MCP runtime boundary

`McpRunnerHttp.execute` accepts an authorized `OrganizationAuthContext`, a Box identifier,
and one typed operation. It resolves the Box within that organization, checks ownership,
and substitutes the internal Box ID into a fixed Runner route.

The Runner URL and bearer credential come from the stored Runner record. MCP tokens,
client URLs, arbitrary routes and client headers never enter this transport. Normal TLS
verification applies; redirects and automatic retries are disabled.

Execution, file operations and execution status preserve REST activity semantics: record
activity before readiness, heartbeat throughout the operation, and auto-resume when enabled.
Metrics only observe: they neither refresh activity nor resume a stopped Box.
Heartbeats, cancellation listeners, response readers and timeout timers are released on every exit.
Cancellation stops waiting for resume but cannot revoke an already submitted lifecycle operation.

Network requests, including response reading, have a 30-second deadline. JSON bodies are
bounded at 128 KiB; tar archives are bounded at 64 KiB. Oversized results fail explicitly.
An interrupted effectful request may already have started; its unknown outcome does not
establish that repeating it is safe. Runner error bodies and credentials are never returned.

This adapter has no tool registrations. Its consumers own tool schemas, representation
conversion and result projection. It covers only the existing execution, file and Box metrics
HTTP endpoints; streaming attachment requires a separate transport.

## Execution tools

`exec_box` starts an asynchronous command and returns `execution_id`.
Commands can contact external systems under the Box network policy, so execution is
annotated as an open-world operation.
`get_execution` returns state, optional exit code and diagnostics; command output requires
the separate streaming transport, which these tools do not implement.

`kill_execution` uses DELETE and removes the Runner registry entry.
`signal_execution` accepts only signals 1, 2, 3, 6, 10, 12, 15 and 28; SIGKILL uses
the kill tool. `resize_execution` requires an execution started with `tty: true`.

Execution mutations require `WRITE_BOXES`; status follows REST membership access.
All five operations refresh activity and may auto-resume, so their annotations reflect
these lifecycle effects. Box names may include spaces or Unicode; only the resolved
internal ID enters the Runner route. Unknown arguments and unsupported signals fail
before authorization or network access.

Responses project only implemented fields. Malformed or oversized execution-start
responses report an uncertain outcome because the command may already be running.
