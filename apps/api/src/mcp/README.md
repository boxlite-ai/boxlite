# MCP server

The root module, controller, and server factory assemble the HTTP endpoint and
bind the authenticated caller. Feature registrations, schemas, and their tests
live together under `tools/`; each feature module owns its input and output
contracts. Only schemas shared across tools are extracted: `tools/box/box.schema.ts`
defines Box selectors and responses for lifecycle, network, and listing tools.

```text
mcp/
├── auth/                 OAuth guards, discovery metadata, and origin policy
├── tools/
│   ├── box/              Lifecycle, listing schemas, inbound access, and tunnels
│   ├── config/           Hosted capability discovery
│   ├── execution/        Asynchronous execution controls
│   ├── files/            Upload/download tools and archive conversion
│   ├── image/            Catalog and alias tools
│   ├── metrics/          Box metrics tool
│   ├── registry/         Credential metadata tools
│   ├── shared/           Registration, authorization, and audit support
│   └── volume/           Managed volume tools
├── runner/               Trusted, bounded Runner HTTP adapter and its tests
├── tests/                Shared HTTP test harnesses
├── mcp.module.ts         Nest providers and module imports
├── mcp.controller.ts     MCP HTTP transport
└── mcp-server.factory.ts  Per-request server assembly
```

Every registered tool advertises `inputSchema` and `outputSchema`. The catalog
test exercises the assembled endpoint and checks all 31 registrations; schema
placement does not change the public tool contract.

## Runner HTTP boundary

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

## File transfer tools

`upload_files` accepts `file: {format: "utf8", content: "hello"}` or
`file: {format: "tar_base64", archive_base64: "...", source_is_directory: true}`.
The UTF-8 form creates a standard single-file tar in memory, using the destination
basename; existing copy destination semantics apply. Archive mode preserves directory
and binary transfers, with an optional source-kind hint for the guest.

`download_files` defaults to `format: "utf8"`; choose `"tar_base64"` for directory or
binary sources. Results contain a `file` object with the selected representation and
`source_is_directory`. Archive results use `null` when older guests omit the shape hint.
Text conversion requires an explicit file hint and exactly one complete regular UTF-8
file; directories, links, multiple entries, compressed or malformed tar, control bytes
and truncation fail with an archive-mode suggestion. UTF-8 BOMs are preserved.

Text payloads are capped at 60 KiB by encoded byte length; complete tar bodies are
capped at 64 KiB, including metadata. Base64 inputs are checked against decoded limits.
These payload caps do not raise the API's existing 100 KiB JSON request limit: the
entire serialized MCP request must also fit. JSON escaping can expand text beyond
that limit before tool validation runs; use a smaller payload or `tar_base64` for
heavily escaped text.
Header/PAX/Parser conversion never reads or extracts files on the API host.
Both tools require `WRITE_BOXES`, refresh activity and may auto-resume, matching REST.
Guest paths at or under mounted filesystems remain unsupported by the underlying copy API.
Runner ignores `overwrite` and `follow_symlinks`; these tools reject both arguments.

## Box metrics

`get_box_metrics` observes one organization's Box without refreshing activity or
auto-resuming it. Membership access follows the REST metrics route.
Results contain CPU, memory, execution and transfer counters, plus available network
counters. Zero values remain zero; unavailable optional network counters remain absent.
The tool omits Runner-only flat timing fields and does not advertise unimplemented
`boot_timing` stages or runtime-wide metrics.
