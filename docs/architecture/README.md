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

The main entry point for creating and managing Boxes. Uses a coordination
`RwLock` (`sync_state`) plus manager-internal locks and atomic counters.

**Source:** `src/boxlite/src/runtime/`

**Key responsibilities:**

- Box lifecycle management (create, list, get, remove)
- Image management (pull, cache)
- Runtime-wide metrics collection
- Filesystem layout management

**State architecture:**

```text
RuntimeImpl
├── sync_state (RwLock<SynchronizedState>)
│   ├── active_boxes_by_id   # Weak cache of BoxImpl handles
│   └── active_boxes_by_name # Weak cache of named BoxImpl handles
├── box_manager        # DB-backed Box metadata/state management
├── image_manager      # OCI image pull/cache management
├── layout             # FilesystemLayout (~/.boxlite)
├── image_disk_mgr     # Cached image layer -> ext4 conversion
├── guest_rootfs_mgr   # Versioned guest rootfs cache manager
├── guest_rootfs       # Arc<OnceCell<GuestRootfs>> lazy singleton
├── base_disk_mgr      # Clone base/rootfs backing lifecycle
├── snapshot_mgr       # Snapshot metadata + disk lifecycle
├── lock_manager       # Per-entity multiprocess file locks
├── _runtime_lock      # BOXLITE_HOME process-wide lock
└── runtime_metrics    # Atomic counters (lock-free)
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
3. Pipeline: image pull → rootfs prep → Box spawn → guest ready

### ShimController

Universal subprocess-based Box controller. Spawns `boxlite-shim` binary in a subprocess to isolate
Box process takeover from the host application.

**Source:** `src/boxlite/src/vmm/controller/shim.rs`, `src/boxlite/src/bin/shim/main.rs`

**Why subprocess isolation:**

- libkrun performs process takeover (`krun_start_enter` never returns)
- Subprocess ensures host application continues running
- Clean process tree management
- Enables jailer to sandbox the shim process

### Jailer (Security Isolation)

Defense-in-depth security layer that sandboxes the shim process, inspired by Firecracker's jailer.
Provides OS-level isolation on top of hardware virtualization.

**Source:** `src/boxlite/src/jailer/`

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

**For complete threat model and security design, see:** `src/boxlite/src/jailer/THREAT_MODEL.md`

### Portal (Host-Guest Communication)

gRPC-based communication layer between host and guest.

**Components:**

- `GuestSession`: High-level facade for service interfaces
- `Connection`: Lazy gRPC channel management
- Service interfaces: `GuestInterface`, `ContainerInterface`, `ExecutionInterface`, `FilesInterface`

### Guest Agent

Runs inside the Box, receives commands from host via gRPC.

**Source:** `src/guest/` (crate: `boxlite-guest`)

**Services:**

- `Guest`: Environment initialization (mounts, rootfs, network)
- `Container`: OCI container lifecycle management (via libcontainer)
- `Execution`: Command execution with streaming I/O
- `Files`: Tar-based upload/download between host and container rootfs

**Guest-side modules:**

- `container/`: OCI container lifecycle using libcontainer
- `storage/`: Filesystem mounts and overlayfs management
- `network.rs`: Virtual NIC configuration and DHCP

## Image Management

BoxLite uses OCI-compatible container images with intelligent caching.

**Location:** `src/boxlite/src/images/`

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
│   ImageStore        │  Store manifests/configs/layers in ~/.boxlite/images/
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Layer Extraction  │  Extract to cached layer directories
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Disk Cache Build  │  Build/reuse ext4 base images for fast COW startup
└─────────────────────┘
```

### Caching Strategy

- **Blob-level caching**: Image layers stored by digest, shared across images
- **Layer deduplication**: Common base layers (e.g., debian:slim) extracted once
- **Copy-on-write**: Boxes share base layers, only modifications are per-Box

## Rootfs & Volumes

### Rootfs Preparation

**Location:** `src/boxlite/src/rootfs/` and `src/boxlite/src/litebox/init/tasks/`

Current startup path is disk-first (faster restart/clone), orchestrated by init tasks:

```
OCI Image
   │
   ▼
ImageDiskManager (cached ext4 base image)
   │
   ▼
ContainerRootfsTask (create/reuse per-box qcow2 COW disk)
   │
   ▼
GuestInitTask (mount + initialize container in guest)
```

Guest bootstrap rootfs follows a separate cache path:
- `GuestRootfsManager`: versioned guest rootfs cache keyed by image digest + guest binary hash
- `GuestRootfsTask`: create/reuse per-box guest-rootfs COW overlay

**Key operations:**

- Layer extraction and cached ext4 image preparation
- Guest rootfs bootstrap and versioned caching
- Per-box COW disk creation/reuse for fast restart

### Volume Management

**Location:** `src/boxlite/src/volumes/`

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

**Location:** `src/boxlite/src/net/`

### Architecture

```rust
pub trait NetworkBackend: Send + Sync {
    fn endpoint(&self) -> BoxliteResult<NetworkBackendEndpoint>;
    fn name(&self) -> &'static str;
    fn metrics(&self) -> BoxliteResult<Option<NetworkMetrics>>;
}
```

### Available Backends

#### gvproxy (recommended when `gvproxy` feature is enabled)

User-mode networking based on gVisor's network stack.

```
Box (virtio-net)        gvproxy                 Internet
┌──────────────┐       ┌───────┐              ┌──────────┐
│ guest eth0   │◄─────▶│ NAT   │◄────TCP/UDP─▶│ External │
└──────────────┘       │ DHCP  │              │ Services │
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

**Location:** `src/boxlite/src/vmm/`

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
3. Register engine factory via inventory (`EngineFactoryRegistration`)
4. Add `VmmKind` variant

## Host-Guest Communication

Communication uses gRPC over transport channels, bridged via libkrun's vsock support.

### Transport Flow

```
Host Application
      │
      │ Unix Socket (~/.boxlite/boxes/{id}/sockets/box.sock)
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

Defined in `src/shared/proto/boxlite/v1/service.proto`:

```protobuf
service Guest {
  rpc Init(GuestInitRequest) returns (GuestInitResponse);
  rpc Ping(PingRequest) returns (PingResponse);
  rpc Shutdown(ShutdownRequest) returns (ShutdownResponse);
  rpc Quiesce(QuiesceRequest) returns (QuiesceResponse);
  rpc Thaw(ThawRequest) returns (ThawResponse);
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

service Files {
  rpc Upload(stream UploadChunk) returns (UploadResponse);
  rpc Download(DownloadRequest) returns (stream DownloadChunk);
}
```

### Initialization Sequence

```
Host                              Guest (Box)
  │                                 │
  │──── spawn Box subprocess ──────▶│
  │                                 │
  │◀─── ready notification ─────────│ (host-ready socket signaled)
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

**Location:** `src/boxlite/src/metrics/`

### Architecture

```
┌─────────────────────────────────────────┐
│            RuntimeMetrics               │
│  ┌─────────────────────────────────┐   │
│  │  AtomicU64 counters (lock-free) │   │
│  │  - boxes_created                │   │
│  │  - boxes_failed                 │   │
│  │  - boxes_stopped                │   │
│  │  - total_commands               │   │
│  │  - total_exec_errors            │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│            BoxMetrics (per-Box)         │
│  - commands_executed                    │
│  - exec_errors                          │
│  - cpu_percent / memory_bytes           │
│  - network_bytes_sent                   │
│  - network_bytes_received               │
│  - stage_*_duration_ms                  │
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
| **Node.js** | napi-rs        | Available   | `sdks/node/`   |
| **C**       | FFI + cbindgen | Available   | `sdks/c/`      |

## Shared Library

The `boxlite-shared` crate contains data types, error definitions, and constants shared between the
host runtime, the shim, and the guest agent.

**Location:** `src/shared/`

**Key Components:**

- `BoxliteError`: Centralized error type.
- `Constants`: Shared constants (e.g. socket paths, default ports).
- `Transport`: gRPC transport utilities.

## Directory Layout

Default home directory: `~/.boxlite`

```
~/.boxlite/
├── .lock               # Runtime lock file (single process per BOXLITE_HOME)
├── db/
│   └── boxlite.db      # SQLite metadata (boxes/images/snapshots/base refs)
├── boxes/              # Per-Box runtime data
│   └── {box-id}/
│       ├── sockets/    # box.sock / ready.sock / net.sock
│       ├── mounts/     # Host preparation area
│       ├── shared/     # Guest-visible share root
│       ├── disks/
│       │   ├── disk.qcow2
│       │   └── guest-rootfs.qcow2
│       ├── logs/       # boxlite-shim.log / console.log
│       └── tmp/
├── images/             # OCI image cache
│   ├── layers/
│   ├── extracted/
│   ├── disk-images/
│   ├── manifests/
│   ├── configs/
│   └── local/
├── bases/              # Shared base/backing files
├── locks/              # Per-entity lock files
├── tmp/                # Runtime temp files
└── logs/
    └── boxlite.log     # Runtime log
```

## Concurrency Model

### Thread Safety

- `BoxliteRuntime`: `Send + Sync`, safely shareable across threads
- `LiteBox`: `Send + Sync`, handles can be passed between threads
- Runtime coordination uses `sync_state: RwLock<...>` plus manager-internal locks
- Metrics use `AtomicU64` for lock-free updates

### Locking Design

BoxLite uses layered synchronization:

- Runtime-level coordination lock (`sync_state`) for multi-step atomic flows
- Manager-level internal locks (`BoxManager`, `ImageStore`, etc.)
- Filesystem lock prevents multiple runtimes using same `BOXLITE_HOME`
- Per-entity file locks provide cross-process safety for box operations

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
    Config(String),
    Storage(String),
    Image(String),
    Portal(String),
    Network(String),
    Rpc(String),
    RpcTransport(String),
    Internal(String),
    Execution(String),
    Unsupported(String),
    NotFound(String),
    AlreadyExists(String),
    InvalidState(String),
    Database(String),
    MetadataError(String),
    InvalidArgument(String),
    Stopped(String),
    ResourceExhausted(String),
}
```

All public APIs return `BoxliteResult<T>` = `Result<T, BoxliteError>`.
