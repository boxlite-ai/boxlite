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
