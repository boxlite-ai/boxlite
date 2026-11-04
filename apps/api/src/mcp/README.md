# MCP server

The root module, controller, and server factory assemble the HTTP endpoint and
bind the authenticated caller. Feature registrations, schemas, and their tests
live together under `tools/`; each feature module owns its input and output
contracts. Only schemas shared across tools are extracted: `tools/box/box.schema.ts`
defines Box selectors and responses for lifecycle, network, and listing tools.

`OrganizationTools` lists the caller's member organizations without requiring an
organization ID. Each result includes `id`, `name`, and `is_default`; pass an `id`
as `organization_id` to organization-scoped tools such as `create_box`. Listing
does not imply permission or capacity to create a Box in every organization.

`BoxTools` owns all seven Box listing and lifecycle registrations, including
`list_boxes`. The factory depends on tool groups; it performs no Box queries or
membership lookups. Listing uses the shared organization access, cancellation,
output validation, and sanitized error handling. It still requires membership
without an additional read permission and returns the existing REST-mapped array
in modern structured and both eras' text results. Legacy structured results
use the SDK's `{ result: [...] }` wrapper.

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
│   ├── organization/     Member organization discovery
│   ├── registry/         Credential metadata tools
│   ├── shared/           Registration, authorization, and audit support
│   └── volume/           Managed volume tools
├── runner/               Trusted, bounded Runner HTTP/WebSocket adapters and tests
├── tests/                Shared HTTP test harnesses
├── mcp.module.ts         Nest providers and module imports
├── mcp.controller.ts     MCP HTTP transport
└── mcp-server.factory.ts  Per-request server assembly
```

Shared harnesses under `tests/` are excluded from the application TypeScript
build and remain compiled through the Jest test configuration.

Every registered tool advertises `inputSchema` and `outputSchema`. The catalog
test exercises the assembled endpoint and checks all 32 registrations; schema
placement does not change the public tool contract.

## Tool failures

Tool execution failures return `isError: true` and `structuredContent: {error: ...}`.
The first text block contains the public message; the second contains serialized
error JSON for clients that consume only text. Every output schema accepts either
its existing success value or the strict error envelope. This is an intentional
extension of the advertised result contract; successful payloads keep their shape.

Errors identify `source` (`service`, `runner`, or `mcp`), `operation`, `code`, and
`message`. `status` describes the underlying exception or Runner response, not the
outer MCP HTTP status. Recognized Runner file envelopes also supply `type`; public
service exceptions can supply `retry_after_seconds`. An interrupted mutation or an
invalid execution-start reply, or a service readiness timeout supplies
`outcome: "unknown"` and must not be replayed
automatically. An HTTP failure alone does not prove that no partial writes occurred.

The service adapter projects deliberate public 4xx exception messages, business
codes, and retry timing. Resource-denial messages retain the generic admission
wording; unknown exceptions and unclassified server failures hide their details.
Known unsupported and unavailable business exceptions retain public classification.
Validation of a tool's own success output reports an MCP internal error.

Typed service exceptions raised while resolving a Box or waiting for auto-resume
keep their service classification before any Runner request is dispatched. This
includes readiness timeout status, public cause, retry timing, and the unknown
lifecycle outcome; an unissued Runner operation does not cancel an earlier resume.

The Runner adapter bounds error bodies to 8 KiB and handles file error objects
separately from execution and metrics string errors. Known file codes/types and
execution messages are classified per operation. Recognized mount refusals return
staging guidance. Arbitrary response messages, unknown payloads, and internal details
are not forwarded; they retain safe operation/status fallback text. Neither adapter
copies stacks, causes, credentials, or arbitrary response fields.

For example, a service quota failure keeps `source: "service"`,
`operation: "create_box"`, `status: 429`, `code: "resource_exhausted"`, and its public
count/limit message. A file mount refusal uses `source: "runner"`,
`operation: "upload"`, `status: 400`, `code: "unsupported"`, and a controlled message
explaining how to stage the file and use `exec_box`.

Legacy array tools project structured errors as `{result: {error: ...}}`, just as
their successful arrays project as `{result: [...]}`. Legacy object tools and modern
tools use the natural `{error: ...}` shape. The serialized error text always carries
the natural object. Protocol and authentication failures remain outside this tool
execution contract.

REST capability flags describe the hosted API, including private tunnels and
per-execution user selection. The MCP MVP keeps public-only tunnel preparation
and its existing execution input. New REST operations for SSH, tunnel revocation,
and outbound policy remain explicit catalog exclusions until MCP contracts are added.

## Stateless HTTP compatibility

The controller explicitly selects the SDK's `legacy: 'stateless'` posture.
Modern `2026-07-28` requests retain their JSON response mode and envelope
validation. Legacy `2025-03-26`, `2025-06-18`, and `2025-11-25` clients use
`initialize`, `notifications/initialized`, then ordinary tool POSTs; replies
use request-scoped SSE and notifications receive an empty `202` response.

Both paths use the same authenticated factory and fresh server per request.
No session ID is issued, so initialization does not authorize a later request;
the route guards and tool organization admission run independently each time.
GET streams and DELETE session operations remain `405`.

The SDK owns legacy schema and result adaptation: non-object output schemas
become objects with a required `result` property, and matching structured
values receive the same wrapper. Object outputs and existing text results
keep their natural shape. The controller tests inspect actual SDK SSE replies,
mapped Box results, empty arrays, and authorization failures for all three
legacy revisions. See the [endpoint contract](../../../API.md#mcp-endpoint)
for headers and OAuth discovery.

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
HTTP endpoints. The separate WebSocket adapter is described below.

## Runner WebSocket boundary

`McpRunnerWebSocket.capture` adapts the existing Runner execution attachment
endpoint without adding a Runner API or changing execution behavior.
Callers supply an authorized organization context and validated byte/time budgets;
the adapter resolves the Box within that organization and rechecks ownership.
Runner addresses and credentials come only from the stored Runner record.

The adapter captures bounded stdout/stderr, validates exit frames, and reports
unknown history completeness because replay eviction and live loss are not exposed.
It sends no stdin or execution-control messages. Redirects, compression, and retries
are disabled; handshake, message size, reading, and connection cleanup are bounded.
Typed readiness failures keep their service classification.

Attachment claims the single connection slot and refreshes activity; it may resume
the Box. Disconnecting starts the Runner's existing orphan grace and may eventually
lead to execution termination. Tool callers must account for these lifecycle effects.

## Execution tools

`exec_box` starts an asynchronous command and returns only `execution_id`.
Commands can contact external systems under the Box network policy, so execution is
annotated as an open-world operation.
`get_execution` returns state, optional exit code and diagnostics; its response does not
include stdout or stderr.

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

### Execution input limits

`tools/list` describes these existing limits alongside the `exec_box` arguments.
String lengths count Unicode code points, so a non-BMP character counts once.

| Input | Limit |
| --- | --- |
| `command`, `working_dir` | 1-4096 code points; no NUL |
| `args` | At most 256 arguments, each at most 4096 code points; no NUL |
| `env` | At most 128 entries; keys have 1-256 code points, excluding `=` and NUL; values have at most 4096 code points, excluding NUL |
| `timeout_seconds` | At least 0.1 seconds when supplied |
| `tty` | `true` allocates a pseudo-terminal and enables `resize_execution` |

The complete serialized JSON request also has a default 100 KiB (102400-byte) API
limit, including JSON escaping and the protocol envelope. Per-field maxima may not
fit together, and the API can reject an oversized request before tool validation.

For longer scripts or source, use `upload_files`, then execute the staged file with
a short command and guest path. Uploads remain bounded at 60 KiB of UTF-8 text or
64 KiB for a complete decoded tar, including metadata. Stage files in a confirmed
existing guest root-filesystem directory outside mounts; `/workspace` is not guaranteed.

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
The tool and path descriptions name `/tmp`, `/dev/shm`, and mounted volumes explicitly.
Choose a root-filesystem directory confirmed to exist; `/workspace` is an example,
not a directory guaranteed by every image. To reach a mounted path, stage the file
outside the mount and use `exec_box` to copy it between the staging and mounted paths.
Directory downloads must not contain mounts, and upload archive entries must not
land under mounts, even when the requested root path is outside them.
Runner ignores `overwrite` and `follow_symlinks`; these tools reject both arguments.

## Box metrics

`get_box_metrics` observes one organization's Box without refreshing activity or
auto-resuming it. Membership access follows the REST metrics route.
Results contain CPU, memory, execution and transfer counters, plus available network
counters. Zero values remain zero; unavailable optional network counters remain absent.
The tool omits Runner-only flat timing fields and does not advertise unimplemented
`boot_timing` stages or runtime-wide metrics.
