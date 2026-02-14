# Architecture

## Overview

BoxLite is an embeddable virtual machine runtime that follows the SQLite philosophy: a library that
can be embedded directly into applications without requiring a daemon or external service.

> **Terminology**: Throughout this documentation, we use **"Box"** to refer to an isolated execution
> environment (the underlying implementation uses a lightweight VM). A Box provides hardware-level
> isolation while presenting a simple, container-like interface.

```
┌────────────────────────────────────────────────────────────────────┐
│                        Host Application                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    BoxliteRuntime                            │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐      │  │
│  │  │ BoxManager  │  │ImageManager │  │ RuntimeMetrics  │      │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                        LiteBox                               │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐      │  │
│  │  │  Lifecycle  │  │    Exec     │  │    Metrics      │      │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   ShimController                             │  │
│  │        (Spawns shim with jailer isolation)                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                               │
                     Spawns subprocess
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                      JAILER BOUNDARY (OS Sandbox)                  │
│  ╔══════════════════════════════════════════════════════════════╗  │
│  ║                      Shim Process (boxlite-shim)             ║  │
│  ║  - Seccomp filtering (Linux)                                 ║  │
│  ║  - Namespace isolation (Linux)                               ║  │
│  ║  - sandbox-exec (macOS)                                      ║  │
│  ║  - Resource limits (cgroups/rlimits)                         ║  │
│  ╚══════════════════════════════════════════════════════════════╝  │
│                              │                                      │
│                   Unix Socket / Vsock                               │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     Box (Guest VM)                           │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │                  Guest Agent                           │  │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐     │  │  │
│  │  │  │  Guest   │  │Container │  │   Execution      │     │  │  │
│  │  │  │  Service │  │  Service │  │    Service       │     │  │  │
│  │  │  └──────────┘  └──────────┘  └──────────────────┘     │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  │                              │                                │  │
│  │                              ▼                                │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │               OCI Container Runtime                    │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

## Core Components

### BoxliteRuntime

The main entry point for creating and managing Boxes. Holds all runtime state protected by a single
`RwLock`.

**Source:** `boxlite/src/runtime/`

**Key responsibilities:**

- Box lifecycle management (create, list, get, remove)
- Image management (pull, cache)
- Runtime-wide metrics collection
- Filesystem layout management

**State architecture:**

```
RuntimeInnerImpl
├── sync_state (RwLock)
│   ├── BoxManager      # Tracks all Boxes and their states (Source: boxlite/src/management/box_manager.rs)
│   └── ImageManager    # OCI image cache and management (Source: boxlite/src/management/image_manager.rs)
└── non_sync_state (immutable)
    ├── FilesystemLayout  # Directory structure (~/.boxlite)

    ├── InitRootfs        # Shared init rootfs for guests
    └── RuntimeMetrics    # Atomic counters (lock-free)
```

### LiteBox

Individual Box handle providing execution capabilities. Supports lazy initialization - heavy work (
image pulling, Box startup) is deferred until first use.

**Source:** `boxlite/src/litebox/`

**Key responsibilities:**

- Command execution (`exec`)
- Metrics collection
- Graceful shutdown

**Lazy initialization flow:**

1. `runtime.create()` returns immediately with handle
2. First API call triggers initialization pipeline
3. Pipeline: image pull → rootfs prep → Box spawn → guest ready

### ShimController

Universal subprocess-based Box controller. Spawns `boxlite-shim` binary in a subprocess to isolate
Box process takeover from the host application.

**Source:** `boxlite/src/vmm/controller/shim.rs`, `boxlite/src/bin/shim.rs`

**Why subprocess isolation:**

- libkrun performs process takeover (`krun_start_enter` never returns)
- Subprocess ensures host application continues running
- Clean process tree management
- Enables jailer to sandbox the shim process

### Jailer (Security Isolation)

Defense-in-depth security layer that sandboxes the shim process, inspired by Firecracker's jailer.
Provides OS-level isolation on top of hardware virtualization.

**Source:** `boxlite/src/jailer/`

**Key responsibilities:**

- OS-level process isolation for shim
- Syscall filtering and sandboxing
- Resource limit enforcement
- Environment sanitization

**Security layers:**

**Linux:**
- Namespace isolation (mount, PID, network)
- Chroot/pivot_root for filesystem isolation
- Seccomp BPF for syscall filtering
- Privilege dropping (unprivileged user)
- cgroups v2 for resource limits

**macOS:**
- sandbox-exec (Seatbelt) for kernel-enforced sandboxing
- rlimits for resource constraints

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                              HOST OS                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                      JAILER BOUNDARY                          │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │                  SHIM PROCESS (sandboxed)               │  │  │
│  │  │  ┌───────────────────────────────────────────────────┐  │  │  │
│  │  │  │              VM (libkrun/KVM)                     │  │  │  │
│  │  │  │  ┌─────────────────────────────────────────────┐  │  │  │  │
│  │  │  │  │            GUEST (untrusted)                │  │  │  │  │
│  │  │  │  └─────────────────────────────────────────────┘  │  │  │  │
│  │  │  └───────────────────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Configuration:**

```rust
use boxlite::{AdvancedBoxOptions, SecurityOptions};

// Most users don't need to configure security — defaults prioritize compatibility
// For advanced users who need maximum isolation:
let opts = BoxOptions {
    advanced: AdvancedBoxOptions {
        security: SecurityOptions::maximum(),
        ..Default::default()
    },
    ..Default::default()
};
```

**For complete threat model and security design, see:** `boxlite/src/jailer/THREAT_MODEL.md`

### Portal (Host-Guest Communication)

gRPC-based communication layer between host and guest.

**Components:**

- `GuestSession`: High-level facade for service interfaces
- `Connection`: Lazy gRPC channel management
- Service interfaces: `GuestInterface`, `ContainerInterface`, `ExecutionInterface`

### Guest Agent

Runs inside the Box, receives commands from host via gRPC.

**Source:** `guest/` (crate: `boxlite-guest`)

**Services:**

- `Guest`: Environment initialization (mounts, rootfs, network)
- `Container`: OCI container lifecycle management (via libcontainer)
- `Execution`: Command execution with streaming I/O

**Guest-side modules:**

- `container/`: OCI container lifecycle using libcontainer
- `storage/`: Filesystem mounts and overlayfs management
- `network.rs`: Virtual NIC configuration and DHCP

## Image Management

BoxLite uses OCI-compatible container images with intelligent caching.

**Location:** `boxlite/src/images/`

### Components

```
ImageManager
├── ImageStore         # OCI blob storage and retrieval
├── ImageStorage       # Layer extraction and caching
└── Archive handlers   # TAR archive processing
```

### Image Pull Flow

```
Registry (Docker Hub, GHCR, ECR, etc.)
           │
           ▼
┌─────────────────────┐
│   OCI Client        │  Pull manifest and layers
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   ImageStore        │  Store blobs in ~/.boxlite/images/blobs/
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Layer Extraction  │  Extract to cached layer directories
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Rootfs Assembly   │  Combine layers for Box rootfs
└─────────────────────┘
```

### Caching Strategy

- **Blob-level caching**: Image layers stored by digest, shared across images
- **Layer deduplication**: Common base layers (e.g., debian:slim) extracted once
- **Copy-on-write**: Boxes share base layers, only modifications are per-Box

## Rootfs & Volumes

### Rootfs Preparation

**Location:** `boxlite/src/rootfs/`

The rootfs builder assembles a container filesystem from OCI image layers:

```
Image Layers          Rootfs Builder              Box Rootfs
┌─────────┐          ┌─────────────┐          ┌─────────────┐
│ Layer 1 │────┐     │             │          │ /bin        │
├─────────┤    │     │  Extract &  │          │ /etc        │
│ Layer 2 │────┼────▶│   Overlay   │─────────▶│ /usr        │
├─────────┤    │     │             │          │ /var        │
│ Layer N │────┘     └─────────────┘          │ ...         │
└─────────┘                                   └─────────────┘
```

**Key operations:**

- Layer extraction and overlay mounting
- DNS configuration injection
- Copy-on-write snapshot creation

### Volume Management

**Location:** `boxlite/src/volumes/`

**Supported volume types:**

| Type           | Description              | Use Case               |
|----------------|--------------------------|------------------------|
| **virtiofs**   | Host directory mount     | Sharing files with Box |
| **QCOW2 disk** | Copy-on-write disk image | Persistent storage     |

**QCOW2 features:**

- Thin provisioning (allocate on write)
- Snapshot support
- Shared base images across Boxes

## Network Backends

BoxLite supports pluggable network backends for Box connectivity.

**Location:** `boxlite/src/net/`

### Architecture

```rust
pub trait NetworkBackend: Send + Sync {
    fn start(&mut self) -> BoxliteResult<NetworkConfig>;
    fn stop(&mut self) -> BoxliteResult<()>;
    fn metrics(&self) -> NetworkMetrics;
}
```

### Available Backends

#### gvproxy (Default)

User-mode networking based on gVisor's network stack.

```
Box                    gvproxy                  Internet
┌──────┐              ┌───────┐              ┌──────────┐
│ eth0 │◄────vsock───▶│       │◄────TCP/UDP─▶│          │
└──────┘              │ NAT   │              │ External │
                      │ DHCP  │              │ Services │
                      │ DNS   │              └──────────┘
                      └───────┘
```

**Features:**

- Full outbound internet access
- Port forwarding (TCP/UDP)
- Built-in DHCP and DNS
- Network metrics (bytes sent/received)

#### libslirp (Alternative)

QEMU's user-mode networking stack.

**Use case:** Environments where gvproxy isn't available.

### Network Configuration

Boxes receive network configuration via DHCP:

- IP address from virtual subnet
- Default gateway
- DNS servers (configurable, defaults to host resolvers)

## Vmm Abstraction

BoxLite uses a pluggable Vmm (Virtual Machine Monitor) architecture for Box execution.

**Location:** `boxlite/src/vmm/`

### Vmm Trait

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

### Adding New Vmm Implementations

To add a new Vmm implementation:

1. Implement `Vmm` trait
2. Implement `VmmInstanceImpl` for the instance type
3. Register in `VmmFactory`
4. Add `VmmKind` variant

## Host-Guest Communication

Communication uses gRPC over transport channels, bridged via libkrun's vsock support.

### Transport Flow

```
Host Application
      │
      │ Unix Socket (/tmp/boxlite-{id}.sock)
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

### Protocol Definition

Defined in `boxlite-shared/proto/boxlite/v1/service.proto`:

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

### Initialization Sequence

```
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

## Metrics System

BoxLite provides comprehensive metrics at runtime and per-Box levels.

**Location:** `boxlite/src/metrics/`

### Architecture

```
┌─────────────────────────────────────────┐
│            RuntimeMetrics               │
│  ┌─────────────────────────────────┐   │
│  │  AtomicU64 counters (lock-free) │   │
│  │  - boxes_created                │   │
│  │  - boxes_destroyed              │   │
│  │  - total_exec_calls             │   │
│  │  - total_bytes_transferred      │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│            BoxMetrics (per-Box)         │
│  - cpu_time_ms                          │
│  - memory_usage_bytes                   │
│  - exec_count                           │
│  - network_bytes_sent                   │
│  - network_bytes_received               │
└─────────────────────────────────────────┘
```

### Design Principles

- **Lock-free**: Uses `AtomicU64` for concurrent updates without synchronization
- **Low overhead**: Metrics collection doesn't impact Box performance
- **Hierarchical**: Runtime-wide aggregates + per-Box details

## SDK Architecture

BoxLite provides language-specific SDKs built on the core Rust library.

```
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

## Shared Library

The `boxlite-shared` crate contains data types, error definitions, and constants shared between the
host runtime, the shim, and the guest agent.

**Location:** `boxlite-shared/`

**Key Components:**

- `BoxliteError`: Centralized error type.
- `Constants`: Shared constants (e.g. socket paths, default ports).
- `Transport`: gRPC transport utilities.

## Directory Layout

Default home directory: `~/.boxlite`

```
~/.boxlite/
├── boxes/              # Per-Box runtime data
│   └── {box-id}/
│       ├── rootfs/     # Container rootfs
│       └── config.json
├── images/             # OCI image cache
│   ├── blobs/          # Image layer blobs (by digest)
│   └── index.json      # Image index
├── init/               # Shared init rootfs
│   └── rootfs/
├── logs/               # Runtime logs
│   └── boxlite.log     # Daily rotating log
└── boxlite.lock        # Runtime lock file (prevents multiple instances)
```

## Concurrency Model

### Thread Safety

- `BoxliteRuntime`: `Send + Sync`, safely shareable across threads
- `LiteBox`: `Send + Sync`, handles can be passed between threads
- Single `RwLock` protects all mutable runtime state
- Metrics use `AtomicU64` for lock-free updates

### Single Lock Design

BoxLite uses one `RwLock` for all mutable state:

- Eliminates nested locking complexity
- Simplifies reasoning about concurrency
- Filesystem lock prevents multiple runtimes using same `BOXLITE_HOME`

### Async Design

- All I/O operations are async (Tokio runtime)
- Streaming operations use `futures::Stream`
- gRPC uses tonic's async support

## Error Handling

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
