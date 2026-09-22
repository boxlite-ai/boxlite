# Reference

Exact facts about BoxLite: every API, flag, option, error, and file it reads or writes. For
step-by-step tasks, see [Guides](../guides/README.md).

## Pages

- [Configuration](configuration.md): `BoxOptions` parameters, runtime options, and environment variables.
- [Error codes and handling](errors.md): error types and patterns for handling them.
- [File formats](file-formats.md): the `~/.boxlite` home directory, QCOW2 and ext4 disk images, the OCI image cache, and the SQLite database.

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
| **Box API** | [`openapi/box.openapi.yaml`](../../openapi/box.openapi.yaml) | The portable REST contract, 26 paths. Groups: configuration & discovery, authentication, volumes, boxes, box lifecycle, snapshot/portability, execution, files, network, metrics, images |
| **Reference server** | [`openapi/reference-server/`](../../openapi/reference-server/README.md) | A partial implementation used as a client test fixture, not a conformance target |

The spec is the contract, not an inventory of any one server, and no
implementation currently serves all 26 paths:

| Server | Serves | Does not serve |
|--------|--------|----------------|
| `boxlite serve` | boxes, lifecycle, exec, files, snapshots, clone/export/import, metrics, config, me | `network/tunnel`, the three `images/*` paths. Volume routes are registered but every operation answers `400 UnsupportedError` |
| reference server | boxes, lifecycle, exec, files, snapshots, clone/export/import, metrics, config, me | volumes, images, `network/tunnel`, attach, and `DELETE …/executions/{exec_id}` (kill) |

Read each server's routes rather than either README — both under-report.
`GET /config` does not close this gap: it carries feature flags
(`tty_enabled`, `streaming_enabled`, `snapshots_enabled`, `clone_enabled`,
`export_enabled`, `import_enabled`), not route availability, has no flag at all
for volumes, images or tunnel, and can disagree with the routes — the reference
server advertises `streaming_enabled: true` while serving no attach route.

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
[`apps/API.md`](../../apps/API.md). Those are deployment internals, not part of
the portable contract above.

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
