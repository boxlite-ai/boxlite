# Reference

Exact facts about BoxLite: every API, flag, option, error, and file it reads or writes. For
step-by-step tasks, see [Guides](../guides/README.md).

## Pages

- [Agent API](agents.md): agents, turns, interaction and error handling across SDKs.
- [Configuration](configuration.md): `BoxOptions` parameters, runtime options, and environment variables.
- [Error codes and handling](errors.md): error types and patterns for handling them.
- [File formats](file-formats.md): the `~/.boxlite` home directory, QCOW2 and ext4 disk images, the OCI image cache, and the SQLite database.
- [API changelog](#api-changelog): unreleased interface changes and migration notes.

## SDK API references

Complete API documentation for each SDK:

| SDK | Documentation | Description |
|-----|---------------|-------------|
| **Python** | [Python API Reference](python/README.md) | Async/sync API, box types, metrics |
| **Node.js** | [Node.js API Reference](nodejs/README.md) | TypeScript definitions, box types, CDP endpoints |
| **Rust** | [Rust API Reference](rust/README.md) | Core runtime, stream APIs, security options |
| **C** | [C API Reference](c/README.md) | FFI bindings, typed options, callback streaming |

## CLI reference

| Surface | Documentation | Description |
|---------|---------------|-------------|
| **`boxlite`** | [CLI Reference](cli/README.md) | All subcommands, global flags, volume/port grammar, installation & verification, exit codes |

## HTTP API reference

| Surface | Documentation | Description |
|---------|---------------|-------------|
| **Box API** | [`openapi/box.openapi.yaml`](../../openapi/box.openapi.yaml) | The portable REST contract. Groups: configuration & discovery, authentication, volumes, boxes, box lifecycle, snapshot/portability, execution, files, network, metrics, images, registries |
| **Agent REST design** | [Agents and turns](../contributing/investigations/2026-10-28-agent-rest-api-design.md) | Nine proposed HTTP operations covering the agent SDK API; no server routes or OpenAPI paths are added yet |
| **Admin API** | [`openapi/admin.openapi.yaml`](../../openapi/admin.openapi.yaml) | Cloud-only contract for organization members and invitations, 4 paths, meant for the CLI and SDKs, which do not call it yet. Shares the Box API's host and credentials, but uses the hosted service's flat error response; local servers do not serve it |
| **Reference server** | [`openapi/reference-server/`](../../openapi/reference-server/README.md) | A partial implementation used as a client test fixture, not a conformance target |

The spec is the contract, not an inventory of any one server, and no
implementation currently serves all 35 paths:

| Server | Serves | Does not serve |
|--------|--------|----------------|
| `boxlite serve` | boxes, lifecycle, exec, files, snapshots, clone/export/import, metrics, config, me, images (from its local image cache) | registries, `network/tunnel`, `network/inbound`. Volume routes are registered but every operation answers `400 UnsupportedError`, as do `images/usage` and both alias write routes |
| reference server | boxes, lifecycle, exec, files, snapshots, clone/export/import, metrics, config, me | volumes, images, registries, `network/tunnel`, `network/inbound`, attach, and `DELETE …/executions/{exec_id}` (kill) |

`GET /v1/config` reports `api_version`, using the server's product release
number (the same numbering as SDK releases), with a generated development identity before finalization. Version compatibility does not
promise that every deployment enables every operation. Servers still reject
unsupported features and unauthorized requests explicitly. Existing discovery
flags remain for older SDKs; new SDK checks use only the version.

### SDK server version checks

The shared Rust REST transport matches each outgoing request against generated
OpenAPI routes. An operation minimum applies to every call; a property minimum
applies only when that property triggers its declared condition. JSON, empty
responses, binary responses, file streams, and WebSocket handshakes all use the
same evaluator. Proxy CONNECT is a separate protocol; its REST preparation is checked.

The first request that needs a version fetches `/v1/config`. Successful discovery
is cached for the client lifetime and shared with clones and derived boxes.
There is no TTL or refresh API. Failed or cancelled discovery is retryable;
a valid but insufficient version remains cached. Recreate the client after a
server upgrade. Ordinary requests without triggered rules never fetch config.
Rolling upgrades and downgrades are outside this cache contract.

Comparisons use SemVer precedence: `0.13.0-rc.1` is below `0.13.0`, while
`0.13.0+build.7` has equal precedence. Missing, malformed, or insufficient versions
produce `Unsupported` before the business request, with the operation, field,
required version, and upgrade advice. Authentication and network failures keep
their usual categories. Requested values are never silently omitted.

### Adding an operation or request field

Use `next-release` for an API or request field that will ship with the next product release.
Set `info.version: next-release` too; contributors do not guess a future release number.
Use `unplanned` when no supporting server release is known.

```yaml
include_details:
  type: boolean
  default: false
  x-boxlite-min-server-version: next-release
  x-boxlite-version-check: non-default
```

Omitted or `false` preserves the legacy request; `true` triggers the rule.
Use `present` when any supplied value requires support, including null, an empty
string, or an empty object. Version annotations never add or change defaults.
An operation-level annotation applies to every request to that operation.

| Minimum | Development behavior | Bump behavior |
| --- | --- | --- |
| `next-release` | Requires the identical generated development API identity | Replaced with the chosen release version |
| `unplanned` | Returns `Unsupported`: not yet supported, before version discovery | Preserved unchanged |
| Concrete SemVer | Requires that release or newer by SemVer precedence | Preserved unchanged |

Development identity is `<workspace-version>+dev.<SHA-256 of canonical OpenAPI>`.
For example, a `0.12.0+dev.<digest>` SDK does not accept stable `0.12.0` or an
unrelated newer release as proof of a pending feature; only the same full identity matches.
This identifies the declared contract, not implementation correctness or authorization.
A different contract, even a documentation edit, changes the digest.
Numeric minima cannot exceed the workspace release, so exact development rules
cannot hide a stricter released requirement. `unplanned` dominates all triggered rules.

1. Add the operation or request field and its declaration to `openapi/box.openapi.yaml`.
2. Run `make setup:openapi` once, then `make generate:openapi`.
3. Add real SDK request tests; fixtures use the generated API identity rather than a guessed version.
4. Run `make test:unit:openapi BASE=origin/main` and the relevant SDK tests.

CI rejects stale generated rules/identity, ungated new operations and reachable
request fields, malformed minima, and numeric requirements newer than the workspace.
Response-only/read-only additions do not require request gates. Unknown SDK routes
fail locally instead of bypassing checks.

The generator supports local references, nested object properties, `allOf`,
whole-property `present` checks, scalar `non-default` checks, and scalar query,
header, and path parameters. Annotations inside arrays, maps, unions, parameter
content, or non-JSON bodies fail generation; use an operation gate for those shapes.
Consumers use packaged rules and need no Python or YAML parser.

### Finalizing a release

After the [workspace/SDK version bump](../contributing/development/building.md#release-version-alignment), run:

```bash
make finalize:openapi BASE=origin/main
make check:openapi:release
```

The target requires a stable workspace version newer than the Git base. It replaces
only `next-release` minima, sets `info.version` to that release, and regenerates
`src/boxlite/src/rest/{version_rules,api_version}.json`. It preserves comments,
previously assigned minima, and every `unplanned` declaration.
Include those changes in the bump PR. Release checks refuse remaining `next-release`,
stale artifacts, and mismatched release tags; `unplanned` remains valid and explicitly refused.
SDK release workflows and cloud image release publication enforce these checks.

The initial migration's snapshot, clone/export/import, capability policy,
privilege, execution-user, and private-tunnel rules are `next-release`.
They make no claim that released `0.12.0` supports the new compatibility contract.

`{prefix}` is a deployment-defined routing slot, opaque to the client, published
by a server as `Principal.path_prefix`. A single-tenant server may omit the
segment entirely — that is the contract's null-prefix case, and what `boxlite
serve` does, so its `/v1/boxes/…` routes are conformant. The field name is not:
both servers serialize it as `prefix` (`serve/handlers/me.rs`,
`reference-server/server.py`) where the contract says `path_prefix`. The Rust
client sidesteps discovery altogether and takes `path_prefix` from its own
options. Treat the segment as server-supplied configuration; never hardcode one.

A deployed BoxLite platform also runs services of its own — control plane,
runner, preview proxy, telemetry collector — catalogued separately in
[service interfaces](../contributing/architecture/platform/api.md). Those are deployment internals, not part of
the portable contract above.

## API changelog

### Unreleased: fractional CPU allocation (breaking change)

`Box.cpus` responses now use `number` instead of `integer` and may
contain fractional values such as `0.5`.
Older clients expecting integers can fail to decode individual Boxes
or an entire list containing a fractional allocation.

Before creating fractional Boxes, upgrade affected SDKs and regenerate
clients from the updated OpenAPI schema.
This also applies to clients that only create integer allocations but
list Boxes created by other clients.
Until affected clients are upgraded, keep shared environments on
integer CPU allocations.

The C ABI now uses `double` for CPU allocation fields and parameters.
Rebuild C and Go consumers against matching headers and libraries.
Existing integer Boxes retain their saved CPU allocations.

### Unreleased: exec command rejections

For `exec`, missing executables now complete with exit status `127`;
non-executable files complete with `126`. The guest diagnostic arrives on
stderr without a TTY, or on merged stdout with a TTY, through the normal
execution streams instead of a nested internal error or HTTP 500. This applies
to local and REST `exec` executions with either executor; other nonzero
process exit codes are unchanged. `126` and `127` are the special cases for an
`exec` startup refusal; every other value keeps its usual meaning.
Rejection of the box's init command during `start()` remains an error, so
`boxlite run` prints an error and exits `1`. See
[execution error handling](errors.md#executionstring).

### Unreleased: execution inventory (POL-485, additive)

Boxes expose live executions through the SDK `executions` namespace
(`box.executions().list()` in Python, Node, and Rust; `box.Executions().List(ctx)`
in Go; `boxlite_box_executions_list(box, cb, user_data, &error)` in C), CLI
`boxlite top BOX`, and REST `GET /{prefix}/boxes/{box_id}/executions`. The main
command is included.
Discovered IDs work with attach and control operations; listing never starts
a box and retains no completed-session history. Existing status schemas and
request defaults are unchanged.

REST main-session attachment accepts a box name or ID. Session ownership uses
the canonical box ID, so status queries work with either spelling.

See [recovering a lost handle](../guides/ai-agent-integration.md#recovering-control-after-losing-the-handle)
for usage and the bounded exit-status/output retention policy.

### Image API migration (breaking change)

The image catalog replaces the old pull and digest-ID image operations. Regenerate
clients from the current OpenAPI specification before upgrading servers.

| Previous operation | Replacement |
|--------------------|-------------|
| `POST /{prefix}/images/pull` | Create a box with an image reference; there is no standalone REST pull operation |
| `GET /{prefix}/images/{image_id}` | `GET /{prefix}/images/{image_name}` returns `ImageDetail`, including its versions, instead of a single `ImageInfo` |
| `HEAD /{prefix}/images/{image_id}` | Get the image by name and inspect `versions[].digest`; a missing image returns 404 |

`image_name` is the registry and repository, without a tag or digest, URL-encoded
as one segment: `quay.io/acme/app` becomes `quay.io%2Facme%2Fapp`. An old digest ID
is not an image name. `DELETE /{prefix}/images/{image_name}` removes the name and
its aliases, subject to dependency checks; it is part of the current API.

The REST SDK maps malformed image recording times, alias-event times and registry
creation times to `1970-01-01T00:00:00Z`, so repeated reads do not invent newer
timestamps. Valid RFC 3339 timestamps retain their instant.

Catalog `tags` fields are now `aliases`; history uses `ImageAliasEvent` with
`alias` and `recorded_at`. Create a binding with `POST …/images/{name}/aliases`
using `{alias, digest}`; an existing name returns `409 already_exists`, even
for the same digest. Replace one only by explicitly deleting
`…/images/{name}/aliases/{alias}` before creating it again. There is no move API.
Registry tags and existing boxes remain unchanged.

Registry routes also move under images:

| Surface | Current path |
|---------|--------------|
| Product API | `/api/images/registries` |
| Box API | `/api/v1[/{prefix}]/images/registries` |
| Internal proxy lookup | `/api/runners/me/images/registry-credentials` |

SDK registry handles move from the runtime root to `runtime.images.registries`
(Python/Node), `runtime.images()?.registries()?` (Rust), `images.Registries()`
(Go) and `boxlite_image_registries()` (C). Existing image methods stay on the
image handle. The internal lookup stays excluded from customer OpenAPI and SDKs.

### Nullable response fields

The Box API uses OpenAPI 3.1.1 and JSON Schema type unions such as
`type: [string, "null"]` and `type: [integer, "null"]`. A field's presence is
controlled separately by `required`: an optional nullable field may be omitted
or explicitly null, while a required identifier must still be present and non-null.

Image versions may have null sizes, last-use times or upstream-missing times.
Alias history may have a null prior digest or actor; registry credentials may have
a null creator. `ImageInfo.size_bytes` and image-list `next_page_token` also allow
null; those two contracts predate the image catalog stack.

Regenerate clients derived from the Box specification and verify their nullable
types. The correction changes the schema, not server JSON or core SDK behavior.
The separately generated product API clients use an OpenAPI 3.0 contract, where
`nullable: true` remains valid.

---

## Quick reference

### Python API

For complete Python API documentation, see **[Python API Reference](python/README.md)**.

**Key Classes:**

| Class | Description |
|-------|-------------|
| `Boxlite` | Main runtime for creating and managing boxes |
| `Box` | Handle to a running or stopped box |
| `SimpleBox` | Context manager for basic execution |
| `CodeBox` | Specialized box for Python code execution |
| `BrowserBox` | Box configured for browser automation |
| `ComputerBox` | Box with desktop automation capabilities |
| `InteractiveBox` | Box for interactive shell sessions |

### Node.js API

For complete Node.js API documentation, see **[Node.js API Reference](nodejs/README.md)**.

**Key Classes:**

| Class | Description |
|-------|-------------|
| `SimpleBox` | Basic container for command execution |
| `CodeBox` | Python code execution sandbox |
| `BrowserBox` | Browser automation with CDP endpoint |
| `ComputerBox` | Desktop automation (14 methods) |
| `InteractiveBox` | PTY terminal sessions |

### Rust API

For complete Rust API documentation, see **[Rust API Reference](rust/README.md)**.

**Core Types:**

```rust
use boxlite::{
    BoxliteRuntime,  // Main runtime
    BoxOptions,       // Box configuration
    LiteBox,          // Box handle
    BoxCommand,       // Command builder
    RootfsSpec,       // Rootfs specification
    VolumeSpec,       // Volume mount specification
    PortSpec,         // Port forwarding specification
};
```

### C API

For complete C API documentation, see **[C API Reference](c/README.md)**.

**Functions:**

| Function | Description |
|----------|-------------|
| `boxlite_runtime_new` | Create runtime instance |
| `boxlite_create_box` | Create a new box |
| `boxlite_execute` | Run command with streaming |
| `boxlite_stop_box` | Stop and free box |

### CLI

For the complete CLI reference, see **[CLI Reference](cli/README.md)**.

**Common subcommands:**

| Command | Description |
|---------|-------------|
| `boxlite run` | Create a box from an image and run a command |
| `boxlite exec` | Run a command inside a running box |
| `boxlite list` | List boxes (aliases: `ls`, `ps`) |
| `boxlite cp` | Copy files between host and box |
| `boxlite inspect` | Show detailed box info (JSON, YAML, or Go template) |
| `boxlite serve` | Start the long-running REST API server |
