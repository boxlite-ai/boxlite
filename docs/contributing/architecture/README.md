# Architecture

How the BoxLite runtime's code fits together, for contributors. The user-level picture is in
[Concepts](../../concepts/README.md).

## Design documents

- [VMM](vmm/README.md): BoxLite's own VMM, which is replacing libkrun.
- [Jailer network permissions](jailer-network-permissions.md): guest networking, host IP grants,
  and the AF_UNIX control plane.
- [Container capabilities](container-capabilities.md): the Linux capability API.
- [Jailer threat model](../../../src/boxlite/src/jailer/THREAT_MODEL.md).

## Source map

| Subsystem   | Code                                            | User-level explanation                        |
| ----------- | ----------------------------------------------- | --------------------------------------------- |
| Runtime     | `src/boxlite/src/runtime/`                      | [Concepts](../../concepts/README.md)          |
| Box handle  | `src/boxlite/src/litebox/`                      | [Concepts](../../concepts/README.md)          |
| Images      | `src/boxlite/src/images/`                       | [Images](../../concepts/images.md)            |
| Storage     | `src/boxlite/src/rootfs/`, `src/boxlite/src/volumes/` | [Storage](../../concepts/storage.md)    |
| Networking  | `src/boxlite/src/net/`                          | [Networking](../../concepts/networking.md)    |
| Jailer      | `src/boxlite/src/jailer/`                       | [Security](../../concepts/security.md)        |
| Metrics     | `src/boxlite/src/metrics/`                      | [Metrics](../../concepts/metrics.md)          |
| VMM         | `src/boxlite/src/vmm/`                          | —                                             |
| Shared      | `src/shared/`                                   | —                                             |

## Core components

### BoxliteRuntime

The main entry point for creating and managing Boxes. Holds all runtime state protected by a single
`RwLock`.

**Source:** `src/boxlite/src/runtime/`

**Key responsibilities:**

- Box lifecycle management (create, list, get, remove)
- Image management (pull, cache)
- Runtime-wide metrics collection
- Filesystem layout management

**State architecture:**

```text
RuntimeInnerImpl
├── sync_state (RwLock)
│   ├── BoxManager      # Tracks all Boxes and their states (Source: src/boxlite/src/litebox/manager.rs)
│   └── ImageManager    # OCI image cache and management (Source: src/boxlite/src/images/manager.rs)
└── non_sync_state (immutable)
    ├── FilesystemLayout  # Directory structure (~/.boxlite)

    ├── InitRootfs        # Shared init rootfs for guests
    └── RuntimeMetrics    # Atomic counters (lock-free)
```

### LiteBox

Individual Box handle providing execution capabilities. Supports lazy initialization - heavy work (
image pulling, Box startup) is deferred until first use.

**Source:** `src/boxlite/src/litebox/`

**Key responsibilities:**

- Command execution (`exec`)
- Metrics collection
- Graceful shutdown

**Lazy initialization flow:**

1. `runtime.create()` returns immediately with handle
2. First API call triggers initialization pipeline
3. Pipeline: filesystem layout → boot assets + rootfs prep → Box spawn → guest ready

Custom kernels are an [RC feature](../../guides/custom-kernel.md). They are
prepared by the initialization pipeline, not by the VMM controller. The pipeline
copies the kernel and optional initramfs into an immutable per-box generation,
verifies their checksums, and atomically publishes the generation before
`VmmSpawn`. Restarting a stopped or failed Box reuses the published generation,
so the caller-owned source files are only required when a generation must first
be created. Reattaching to a running Box skips preparation.

Nested virtualization is also an
[RC feature](../../guides/nested-virtualization.md). Its opt-in is persisted
with the box and rechecked on every local start. The VMM exposes virtualization
extensions to the guest, then the guest agent grants only its `/dev/kvm` device
to the OCI workload.

### ShimController

Universal subprocess-based Box controller. Spawns `boxlite-shim` binary in a subprocess to isolate
Box process takeover from the host application.

**Source:** `src/boxlite/src/vmm/controller/shim.rs`, `src/shim/src/main.rs`

**Why subprocess isolation:**

- libkrun performs process takeover (`krun_start_enter` never returns)
- Subprocess ensures host application continues running
- Clean process tree management
- Enables jailer to sandbox the shim process

### Jailer (security isolation)

Defense-in-depth sandbox around the shim process. The layers, platforms, and configuration are
described in [Security](../../concepts/security.md).

**Source:** `src/boxlite/src/jailer/`

### Portal (host-guest communication)

gRPC-based communication layer between host and guest.

**Components:**

- `GuestSession`: High-level facade for service interfaces
- `Connection`: Lazy gRPC channel management
- Service interfaces: `GuestInterface`, `ContainerInterface`, `ExecutionInterface`

### Guest agent

Runs inside the Box, receives commands from host via gRPC.

**Source:** `src/guest/` (crate: `boxlite-guest`)

**Services:**

- `Guest`: Environment initialization (mounts, rootfs, network)
- `Container`: OCI container lifecycle management (via libcontainer)
- `Execution`: Command execution with streaming I/O

**Guest-side modules:**

- `container/`: OCI container lifecycle using libcontainer
- `storage/`: Filesystem mounts and overlayfs management
- `network.rs`: Virtual NIC configuration and DHCP

## Image store

```text
ImageManager
├── ImageStore         # OCI blob storage and retrieval
├── ImageStorage       # Layer extraction and caching
└── Archive handlers   # TAR archive processing
```

## Network backend interface

```rust
pub trait NetworkBackend: Send + Sync {
    fn start(&mut self) -> BoxliteResult<NetworkConfig>;
    fn stop(&mut self) -> BoxliteResult<()>;
    fn metrics(&self) -> NetworkMetrics;
}
```

## Vmm abstraction

BoxLite uses a pluggable Vmm (Virtual Machine Monitor) architecture for Box execution.

**Location:** `src/boxlite/src/vmm/`

### Vmm trait

```rust
pub trait Vmm {
    fn create(&mut self, config: InstanceSpec) -> BoxliteResult<VmmInstance>;
}
```

### VmmInstance

Represents a configured Box ready to execute:

```rust
pub struct VmmInstance {
    inner: Box<dyn VmmInstanceImpl>,
}

impl VmmInstance {
    /// Transfer control to the Box (may never return)
    pub fn enter(self) -> BoxliteResult<()>;
}
```

### libkrun (Krun Vmm)

Current production Vmm implementation using libkrun hypervisor.

**Features:**

- Hardware virtualization (macOS Hypervisor.framework, Linux KVM)
- virtio-fs for filesystem sharing
- virtio-blk for disk images
- vsock for host-guest communication
- Process takeover model (`krun_start_enter`)

**Configuration flow:**

1. Create libkrun context
2. Set Box resources (CPUs, memory)
3. Configure network (TSI or gvproxy)
4. Mount virtiofs shares
5. Attach disk images
6. Configure vsock ports
7. Set guest entrypoint
8. Return `VmmInstance`

### Adding new Vmm implementations

To add a new Vmm implementation:

1. Implement `Vmm` trait
2. Implement `VmmInstanceImpl` for the instance type
3. Register in `VmmFactory`
4. Add `VmmKind` variant

## Host-guest communication

Communication uses gRPC over transport channels, bridged via libkrun's vsock support.

### Transport flow

```text
Host Application
      │
      │ Unix Socket (boxes/{id}/sockets/box.sock)
      ▼
┌─────────────────┐
│  libkrun vsock  │  (Unix socket ↔ vsock bridge)
│     bridge      │
└─────────────────┘
      │
      │ Vsock (port 2695)
      ▼
Guest Agent (gRPC Server)
```

### Protocol definition

Defined in `src/shared/proto/boxlite/v1/service.proto`:

```protobuf
service Guest {
  rpc Init(GuestInitRequest) returns (GuestInitResponse);
  rpc Ping(PingRequest) returns (PingResponse);
  rpc Shutdown(ShutdownRequest) returns (ShutdownResponse);
}

service Container {
  rpc Init(ContainerInitRequest) returns (ContainerInitResponse);
}

service Execution {
  rpc Exec(ExecRequest) returns (ExecResponse);
  rpc Attach(AttachRequest) returns (stream ExecOutput);
  rpc SendInput(stream ExecStdin) returns (SendInputAck);
  rpc Wait(WaitRequest) returns (WaitResponse);
  rpc Kill(KillRequest) returns (KillResponse);
  rpc ResizeTty(ResizeTtyRequest) returns (ResizeTtyResponse);
}
```

### Initialization sequence

```text
Host                              Guest (Box)
  │                                 │
  │──── spawn Box subprocess ──────▶│
  │                                 │
  │◀─── ready notification ─────────│ (vsock connect to port 2696)
  │                                 │
  │──── Guest.Init ────────────────▶│ (mounts, rootfs, network)
  │◀─── GuestInitResponse ──────────│
  │                                 │
  │──── Container.Init ────────────▶│ (OCI container setup)
  │◀─── ContainerInitResponse ──────│
  │                                 │
  │──── Execution.Exec ────────────▶│ (run commands)
  │◀─── streaming stdout/stderr ────│
  │                                 │
```

## SDK architecture

BoxLite provides language-specific SDKs built on the core Rust library.

```text
┌─────────────────────────────────────────┐
│           Host Application              │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│     Language SDK (Python, Node, C)      │
│         (Native bindings)               │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         BoxLite Core (Rust)             │
└─────────────────────────────────────────┘
```

| SDK         | Technology     | Status      | Location       |
|-------------|----------------|-------------|----------------|
| **Python**  | PyO3 + maturin | Available   | `sdks/python/` |
| **Node.js** | napi-rs        | In Progress | `sdks/node/`   |
| **C**       | FFI + cbindgen | Available   | `sdks/c/`      |

## Shared library

The `boxlite-shared` crate contains data types, error definitions, and constants shared between the
host runtime, the shim, and the guest agent.

**Location:** `src/shared/`

**Key Components:**

- `BoxliteError`: Centralized error type.
- `Constants`: Shared constants (e.g. socket paths, default ports).
- `Transport`: gRPC transport utilities.

## Concurrency model

### Thread safety

- `BoxliteRuntime`: `Send + Sync`, safely shareable across threads
- `LiteBox`: `Send + Sync`, handles can be passed between threads
- Single `RwLock` protects all mutable runtime state
- Metrics use `AtomicU64` for lock-free updates

### Single lock design

BoxLite uses one `RwLock` for all mutable state:

- Eliminates nested locking complexity
- Simplifies reasoning about concurrency
- Filesystem lock prevents multiple runtimes using same `BOXLITE_HOME`

### Async design

- All I/O operations are async (Tokio runtime)
- Streaming operations use `futures::Stream`
- gRPC uses tonic's async support

## Error handling

Centralized error type: `BoxliteError`

```rust
pub enum BoxliteError {
    UnsupportedEngine,
    Engine(String),
    Storage(String),
    Image(String),
    Portal(String),
    Network(String),
    Rpc(String),
    RpcTransport(String),
    Internal(String),
    Execution(String),
}
```

All public APIs return `BoxliteResult<T>` = `Result<T, BoxliteError>`.
