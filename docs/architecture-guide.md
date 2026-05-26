# BoxLite Architecture Guide

> Cross-Platform Architecture & Design Reference for Windows Native Support Preparation

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Layered Architecture](#2-layered-architecture)
3. [Complete Call Chain](#3-complete-call-chain)
4. [Platform Abstraction Map](#4-platform-abstraction-map)
5. [Module Deep Dive](#5-module-deep-dive)
6. [External Dependencies & Libraries](#6-external-dependencies--libraries)
7. [Guest Agent Architecture](#7-guest-agent-architecture)
8. [Host-Guest Communication](#8-host-guest-communication)
9. [Windows Native Porting Analysis](#9-windows-native-porting-analysis)
10. [Initialization Pipeline](#10-initialization-pipeline)
11. [Snapshot & Clone Architecture](#11-snapshot--clone-architecture)
12. [Key Design Decisions](#12-key-design-decisions)

---

## 1. High-Level Architecture

BoxLite is an **embeddable VM runtime** — "SQLite for sandboxing." It runs OCI containers inside lightweight VMs with hardware-level isolation, without requiring a daemon or root privileges.

```mermaid
graph TB
    subgraph "User Applications"
        PY[Python App]
        JS[Node.js App]
        C_APP[C/Go App]
        CLI[CLI]
        REST[REST Client]
    end

    subgraph "SDK Layer"
        PY_SDK["Python SDK<br/>(PyO3)"]
        JS_SDK["Node.js SDK<br/>(napi-rs)"]
        FFI_SDK["C FFI Layer"]
        CLI_BIN["CLI Binary"]
        REST_SERVER["REST/gRPC Server"]
    end

    subgraph "Core Runtime (boxlite crate)"
        RT["BoxliteRuntime"]
        LB["LiteBox"]
        VMM["VMM Engine"]
        JAIL["Jailer"]
        NET["Network Backend"]
        IMG["Image Manager"]
        DISK["Disk Manager"]
        ROOTFS["Rootfs Builder"]
        DB["SQLite DB"]
        PORTAL["Portal (gRPC)"]
    end

    subgraph "Shim Process (boxlite-shim)"
        SHIM["Shim Controller"]
        KRUN["libkrun Engine"]
    end

    subgraph "Guest VM"
        GUEST["Guest Agent<br/>(boxlite-guest)"]
        CONTAINER["OCI Container"]
    end

    PY --> PY_SDK
    JS --> JS_SDK
    C_APP --> FFI_SDK
    CLI --> CLI_BIN
    REST --> REST_SERVER

    PY_SDK --> RT
    JS_SDK --> RT
    FFI_SDK --> RT
    CLI_BIN --> RT
    REST_SERVER --> RT

    RT --> LB
    RT --> IMG
    RT --> DB

    LB --> VMM
    LB --> PORTAL
    LB --> DISK
    LB --> ROOTFS

    VMM --> JAIL
    VMM --> NET
    VMM --> SHIM

    SHIM --> KRUN

    KRUN -.->|"vsock/gRPC"| GUEST
    PORTAL -.->|"vsock/gRPC"| GUEST
    GUEST --> CONTAINER
```

---

## 2. Layered Architecture

```mermaid
graph TB
    subgraph "Layer 5: SDK / API"
        direction LR
        L5A["Python SDK<br/>(PyO3 + pyo3-async-runtimes)"]
        L5B["Node.js SDK<br/>(napi-rs + napi-derive)"]
        L5C["C FFI<br/>(boxlite-ffi crate)"]
        L5D["REST/gRPC Server<br/>(axum + tonic)"]
    end

    subgraph "Layer 4: Runtime Orchestration"
        direction LR
        L4A["BoxliteRuntime<br/>(RuntimeBackend trait)"]
        L4B["RuntimeImpl<br/>(LocalRuntime)"]
        L4C["BoxManager<br/>(Box lifecycle)"]
        L4D["ImageManager<br/>(OCI pull/cache)"]
    end

    subgraph "Layer 3: Box Lifecycle"
        direction LR
        L3A["LiteBox<br/>(BoxBackend trait)"]
        L3B["BoxImpl<br/>(VM-backed)"]
        L3C["BoxBuilder<br/>(Init pipeline)"]
        L3D["Execution<br/>(Process handle)"]
    end

    subgraph "Layer 2: VM Management"
        direction LR
        L2A["VmmController<br/>(Spawn trait)"]
        L2B["ShimController<br/>(Subprocess spawn)"]
        L2C["VmmHandler<br/>(Runtime ops)"]
        L2D["ProcessMonitor<br/>(Exit detection)"]
    end

    subgraph "Layer 1: Platform Services"
        direction LR
        L1A["Jailer<br/>(Sandbox trait)"]
        L1B["NetworkBackend<br/>(trait)"]
        L1C["Disk/Rootfs<br/>(ext4/qcow2)"]
        L1D["Portal<br/>(gRPC channel)"]
    end

    subgraph "Layer 0: Native / OS"
        direction LR
        L0A["libkrun<br/>(KVM / Hvf)"]
        L0B["bubblewrap / seatbelt"]
        L0C["gvproxy<br/>(Go, userspace net)"]
        L0D["e2fsprogs<br/>(mke2fs)"]
    end

    L5A --> L4A
    L5B --> L4A
    L5C --> L4A
    L5D --> L4A
    L4A --> L4B
    L4B --> L4C
    L4B --> L4D
    L4C --> L3A
    L3A --> L3B
    L3B --> L3C
    L3B --> L3D
    L3C --> L2A
    L2A --> L2B
    L2B --> L2C
    L2B --> L2D
    L2C --> L1A
    L2B --> L1A
    L3C --> L1B
    L3C --> L1C
    L3B --> L1D
    L1A --> L0A
    L1A --> L0B
    L1B --> L0C
    L1C --> L0D
```

---

## 3. Complete Call Chain

### 3.1 Box Creation Flow

```mermaid
sequenceDiagram
    participant User as User Code
    participant SDK as SDK (Python/Node/C)
    participant RT as BoxliteRuntime
    participant RI as RuntimeImpl
    participant BB as BoxBuilder
    participant IMG as ImageManager
    participant DISK as DiskManager
    participant ROOTFS as RootfsBuilder
    participant SHIM as ShimSpawner
    participant JAIL as Jailer
    participant VMM as boxlite-shim
    participant KRUN as libkrun
    participant GUEST as Guest Agent

    User->>SDK: boxlite.run(image, cmd)
    SDK->>RT: BoxliteRuntime::run()
    RT->>RI: RuntimeImpl::create_box()

    Note over RI: Step 1: Prepare Box Config
    RI->>IMG: ImageManager::pull(image)
    IMG-->>RI: ImageHandle (layers, config)
    RI->>DISK: Create container rootfs disk (ext4)
    RI->>DISK: Create guest rootfs disk (qcow2 COW)
    RI->>ROOTFS: RootfsBuilder::build()
    ROOTFS-->>RI: Prepared rootfs + mounts

    Note over RI: Step 2: Build InstanceSpec
    RI->>BB: BoxBuilder::new(config)
    BB->>BB: Configure transport (Unix socket)
    BB->>BB: Configure network (gvproxy)
    BB->>BB: Build InstanceSpec

    Note over RI: Step 3: Spawn Shim
    BB->>SHIM: ShimSpawner::spawn(config_json)
    SHIM->>JAIL: JailerBuilder::build()
    JAIL-->>SHIM: Jail (BwrapSandbox / SeatbeltSandbox)
    SHIM->>JAIL: jail.prepare() [cgroups on Linux]
    SHIM->>JAIL: jail.command(shim_binary, args)
    Note over JAIL: Adds pre_exec hook:<br/>FD cleanup, rlimits,<br/>PID file, cgroup join

    SHIM->>VMM: Child::spawn() [boxlite-shim]
    VMM->>VMM: Read config from stdin
    VMM->>VMM: Start gvproxy (if network)
    VMM->>KRUN: libkrun FFI setup
    Note over KRUN: krun_create_ctx()<br/>krun_set_vm_config()<br/>krun_set_root()<br/>krun_set_mapped_volumes()<br/>krun_set_port_map()<br/>krun_start_enter()
    KRUN->>KRUN: Process takeover (never returns)

    Note over GUEST: Inside VM
    GUEST->>GUEST: Mount overlayfs
    GUEST->>GUEST: Start gRPC server (vsock)
    GUEST->>VMM: Ready notification (vsock)
    VMM-->>BB: Shim PID + transport

    Note over RI: Step 4: Establish Connection
    BB->>BB: Wait for ready notification
    BB->>BB: Create GuestSession (gRPC)
    BB-->>RI: BoxImpl (LiveState)
    RI-->>RT: LiteBox
    RT-->>SDK: Box handle
    SDK-->>User: box
```

### 3.2 Command Execution Flow

```mermaid
sequenceDiagram
    participant User as User Code
    participant LB as LiteBox
    participant BI as BoxImpl
    participant GS as GuestSession
    participant GUEST as Guest Agent
    participant CTR as Container Runtime

    User->>LB: box.exec(cmd)
    LB->>BI: BoxBackend::exec()
    BI->>BI: Ensure VM running (lazy start)
    BI->>GS: GuestSession::exec(command)
    GS->>GUEST: gRPC ExecRequest (vsock)
    GUEST->>CTR: Fork + exec in container
    CTR-->>GUEST: Process spawned
    GUEST-->>GS: ExecResponse (exec_id)
    GS-->>BI: Execution handle
    BI-->>LB: Execution
    LB-->>User: Execution {stdin, stdout, stderr, wait()}
```

---

## 4. Platform Abstraction Map

### 4.1 Platform Decision Tree

```mermaid
graph TD
    START["BoxLite Startup"] --> SYSCHECK["SystemCheck::run()"]

    SYSCHECK -->|"Linux"| LINUX_CHECK["Open /dev/kvm<br/>+ KVM_CREATE_VM smoke test"]
    SYSCHECK -->|"macOS"| MAC_CHECK["sysctl kern.hv_support == 1<br/>(Hypervisor.framework)"]
    SYSCHECK -->|"Other"| UNSUPPORTED["Err(Unsupported)"]

    LINUX_CHECK --> VMM_ENGINE
    MAC_CHECK --> VMM_ENGINE

    VMM_ENGINE["VMM Engine: libkrun"]

    VMM_ENGINE -->|"Linux"| KVM["KVM backend<br/>/dev/kvm ioctl"]
    VMM_ENGINE -->|"macOS"| HVF["Hypervisor.framework<br/>hv_vm_create()"]

    VMM_ENGINE --> JAIL_SELECT["Jailer Selection"]

    JAIL_SELECT -->|"Linux"| BWRAP["BwrapSandbox<br/>(bubblewrap)"]
    JAIL_SELECT -->|"macOS"| SEATBELT["SeatbeltSandbox<br/>(sandbox-exec)"]

    BWRAP --> LINUX_EXTRAS["+ Seccomp<br/>+ Landlock<br/>+ AppArmor<br/>+ Cgroups v2<br/>+ Credentials (uid/gid)"]

    JAIL_SELECT --> NET_SELECT["Network Backend"]
    NET_SELECT --> GVPROXY["gvproxy<br/>(gvisor-tap-vsock)"]

    GVPROXY -->|"Linux"| GVPROXY_LINUX["UnixStream socket<br/>+ virtio-net"]
    GVPROXY -->|"macOS"| GVPROXY_MAC["UnixDgram socket<br/>+ virtio-net"]

    JAIL_SELECT --> PROCESS_MON["ProcessMonitor"]
    PROCESS_MON -->|"Linux 5.3+"| PIDFD["pidfd_open()<br/>+ AsyncFd"]
    PROCESS_MON -->|"macOS"| KQUEUE["kqueue<br/>+ EVFILT_PROC"]
    PROCESS_MON -->|"Fallback"| POLLING["100ms poll<br/>(try_wait loop)"]
```

### 4.2 Platform-Specific Code Map

| Module | Linux | macOS | Windows (TODO) |
|--------|-------|-------|----------------|
| **Hypervisor** | KVM (`/dev/kvm`) | Hypervisor.framework | WHPX / Hyper-V (MSHV) |
| **VMM Library** | `libkrun` (KVM backend) | `libkrun` (Hvf backend) | Cloud Hypervisor / custom |
| **Jailer Sandbox** | `bubblewrap` (namespaces, pivot_root) | `sandbox-exec` (Seatbelt/SBPL) | Job Objects + AppContainer |
| **Seccomp/Syscall** | Seccomp BPF filter | N/A (Seatbelt covers) | N/A |
| **Landlock** | Landlock LSM (kernel 5.13+) | N/A | N/A |
| **Cgroups** | cgroups v2 | N/A | Job Objects |
| **AppArmor** | AppArmor profiles | N/A | N/A |
| **Network Socket** | `UnixStream` | `UnixDgram` | Named Pipes / AF_HYPERV |
| **Process Monitor** | `pidfd_open()` | `kqueue` + `EVFILT_PROC` | `WaitForSingleObject()` |
| **FD Cleanup** | `close_range()` / `/proc/self/fd` | `getrlimit` brute-force | `NtQueryInformationProcess` |
| **Host-Guest Transport** | vsock (`AF_VSOCK`) | vsock (via libkrun) | Hyper-V sockets (`AF_HYPERV`) |
| **Filesystem Sharing** | virtiofs | virtiofs | Plan 9 / virtiofs |
| **Disk Creation** | `mke2fs` (e2fsprogs) | `mke2fs` (e2fsprogs) | Need ext4 tools or alt format |
| **Bind Mounts** | `mount --bind` | N/A (virtiofs share) | N/A |
| **User Namespaces** | Clone + unshare | N/A | N/A |
| **DNS Configuration** | Write `/etc/resolv.conf` in rootfs | Same | Same |

---

## 5. Module Deep Dive

### 5.1 Runtime Layer (`src/boxlite/src/runtime/`)

```mermaid
classDiagram
    class BoxliteRuntime {
        +backend: Arc~dyn RuntimeBackend~
        +image_backend: Option~Arc~dyn ImageBackend~~
        +new(options: BoxliteOptions) BoxliteResult~Self~
        +default() BoxliteResult~Self~
        +run(image, cmd) BoxliteResult~LiteBox~
        +box_builder(options) BoxliteResult~LiteBox~
        +list() Vec~BoxInfo~
        +kill(id) BoxliteResult
        +shutdown()
    }

    class RuntimeBackend {
        <<trait>>
        +create_box(options, name) BoxliteResult~LiteBox~
        +list_boxes() Vec~BoxInfo~
        +get_box(id) Option~LiteBox~
        +kill_box(id) BoxliteResult
        +shutdown_sync()
    }

    class RuntimeImpl {
        +layout: FilesystemLayout
        +box_manager: BoxManager
        +lock: LockGuard
        +event_listeners: Vec~Arc~dyn EventListener~~
        +new(options) BoxliteResult~Self~
    }

    class LocalRuntime {
        +RuntimeImpl
    }

    BoxliteRuntime --> RuntimeBackend : delegates to
    LocalRuntime ..|> RuntimeBackend : implements
    LocalRuntime --> RuntimeImpl : wraps
```

**Key types:**
- `BoxliteRuntime` — Public API, cloneable (`Arc`), delegates to a `RuntimeBackend`
- `RuntimeImpl` — Local implementation: filesystem layout, box manager, SQLite DB, event listeners
- `BoxliteOptions` — Configuration: home dir, log level, event listeners, resource defaults
- `FilesystemLayout` — Typed paths: `~/.boxlite/{boxes,images,layers,bases,logs,db}`

### 5.2 LiteBox Layer (`src/boxlite/src/litebox/`)

```mermaid
classDiagram
    class LiteBox {
        +id: BoxID
        +name: Option~String~
        +box_backend: Arc~dyn BoxBackend~
        +snapshot_backend: Arc~dyn SnapshotBackend~
        +start()
        +exec(command) Execution
        +stop()
        +metrics() BoxMetrics
        +copy_into(src, dst)
        +copy_out(src, dst)
        +clone_box(options)
        +export(options, dest)
    }

    class BoxImpl {
        +config: BoxConfig
        +state: RwLock~BoxState~
        +live: OnceCell~LiveState~
        +runtime: SharedRuntimeImpl
    }

    class LiveState {
        +handler: Mutex~Box~dyn VmmHandler~~
        +guest_session: GuestSession
        +metrics: BoxMetricsStorage
        +container_rootfs_disk: Disk
        +bind_mount: Option~BindMountHandle~ [Linux]
    }

    class BoxBuilder {
        +build(config, options) BoxliteResult~BoxImpl~
    }

    class Execution {
        +id() String
        +stdin() Option~ExecStdin~
        +stdout() Option~ExecStdout~
        +stderr() Option~ExecStderr~
        +wait() ExecResult
        +kill()
        +resize_tty(rows, cols)
    }

    LiteBox --> BoxImpl : delegates to
    BoxImpl --> LiveState : lazy init
    BoxBuilder --> BoxImpl : creates
    BoxImpl --> Execution : creates via exec()
```

**Key design:**
- `LiteBox` is a thin wrapper over `BoxBackend` trait (enables REST and local backends)
- `BoxImpl` holds `BoxConfig` (persisted) and `LiveState` (lazy, via `OnceCell`)
- `BoxBuilder` is the init pipeline: disk creation, rootfs assembly, shim spawn, gRPC connect
- `Execution` wraps the gRPC exec stream: stdin/stdout/stderr via `Arc<Mutex<...>>`

### 5.3 VMM Layer (`src/boxlite/src/vmm/`)

```mermaid
classDiagram
    class Vmm {
        <<trait>>
        +create(config: InstanceSpec) VmmInstance
    }

    class VmmInstance {
        +enter() BoxliteResult
    }

    class VmmController {
        <<trait>>
        +start(bundle: InstanceSpec) Box~dyn VmmHandler~
    }

    class VmmHandler {
        <<trait>>
        +stop()
        +metrics() VmmMetrics
        +is_running() bool
        +pid() u32
    }

    class ShimController {
        +binary_path: PathBuf
        +layout: BoxFilesystemLayout
    }

    class ShimHandler {
        +child: Child
        +pid: u32
        +handler: Arc~Mutex~dyn VmmHandler~~
    }

    class InstanceSpec {
        +engine: VmmKind
        +box_id: String
        +security: SecurityOptions
        +cpus: Option~u8~
        +memory_mib: Option~u32~
        +fs_shares: FsShares
        +block_devices: BlockDevices
        +guest_entrypoint: Entrypoint
        +transport: Transport
        +network_config: NetworkBackendConfig
        +guest_rootfs: GuestRootfs
    }

    class Krun {
        +options: VmmConfig
        +create(config) VmmInstance
    }

    ShimController ..|> VmmController
    ShimHandler ..|> VmmHandler
    Krun ..|> Vmm
    Vmm --> VmmInstance : creates
    VmmController --> VmmHandler : returns
```

**Architecture split:**
- **VmmController** = spawn operations (creates a VmmHandler)
- **VmmHandler** = runtime operations (stop, metrics, is_running)
- **Vmm trait** = engine-specific (libkrun): used inside the **shim process**
- **ShimController** = spawns `boxlite-shim` as subprocess (isolation from process takeover)

### 5.4 Jailer Layer (`src/boxlite/src/jailer/`)

```mermaid
classDiagram
    class Jail {
        <<trait>>
        +prepare() BoxliteResult
        +command(binary, args) Command
    }

    class Sandbox {
        <<trait>>
        +name() str
        +is_available() bool
        +setup(ctx) BoxliteResult
        +apply(ctx, cmd)
    }

    class JailerS {
        +sandbox: S
        +security: SecurityOptions
        +volumes: Vec~VolumeSpec~
        +box_id: String
        +layout: BoxFilesystemLayout
        +preserved_fds: Vec~RawFd_i32~
    }

    class BwrapSandbox {
        <<Linux>>
        +Mount namespaces
        +PID namespaces
        +Network namespaces
        +Chroot/pivot_root
    }

    class SeatbeltSandbox {
        <<macOS>>
        +SBPL policy generation
        +sandbox-exec wrapping
        +Per-path allow rules
    }

    class NoopSandbox {
        +No isolation
    }

    class CompositeSandbox {
        <<Linux>>
        +Bwrap + Landlock
    }

    JailerS ..|> Jail
    BwrapSandbox ..|> Sandbox
    SeatbeltSandbox ..|> Sandbox
    NoopSandbox ..|> Sandbox
    CompositeSandbox ..|> Sandbox
    JailerS --> Sandbox : delegates to

    note for BwrapSandbox "Linux only:\n+ Seccomp BPF\n+ Landlock LSM\n+ AppArmor\n+ Cgroups v2\n+ Credential drop"
    note for SeatbeltSandbox "macOS only:\nSBPL deny-default policy\nPer-path granular access\nNetwork enable/disable"
```

**Pre-exec hook chain** (applied to `std::process::Command`):
1. FD preservation (dup2 watchdog pipe)
2. FD cleanup (`close_range` / `/proc/self/fd` / brute-force)
3. Resource limits (rlimits)
4. PID file write
5. Cgroup join (Linux, added by `BwrapSandbox::apply`)
6. Landlock enforcement (Linux, added by `CompositeSandbox::apply`)

### 5.5 Network Layer (`src/boxlite/src/net/`)

```mermaid
classDiagram
    class NetworkBackend {
        <<trait>>
        +endpoint() NetworkBackendEndpoint
        +name() str
        +metrics() Option~NetworkMetrics~
    }

    class NetworkBackendFactory {
        +create(config) Option~Box~dyn NetworkBackend~~
    }

    class GvisorTapBackend {
        +gvproxy process (Go binary)
        +UnixStream (Linux)
        +UnixDgram (macOS)
        +DNS sinkhole (allow_net)
        +MITM proxy (secrets)
    }

    class LibslirpBackend {
        +libslirp library
        +UnixStream
    }

    class NetworkBackendEndpoint {
        UnixSocket: path + ConnectionType + mac_address
    }

    class NetworkBackendConfig {
        +port_mappings: Vec~u16_u16~
        +socket_path: PathBuf
        +allow_net: Vec~String~
        +secrets: Vec~Secret~
        +ca_cert_pem: Option~String~
    }

    GvisorTapBackend ..|> NetworkBackend
    LibslirpBackend ..|> NetworkBackend
    NetworkBackendFactory --> NetworkBackend : creates
```

**gvproxy (gvisor-tap-vsock):**
- Go binary, vendored in `src/deps/libgvproxy-sys`
- Provides userspace TCP/IP stack (no root, no TUN/TAP)
- DNS sinkhole for `allow_net` filtering
- MITM proxy for `secrets` injection into HTTPS
- Connection type differs: `UnixStream` on Linux, `UnixDgram` on macOS

---

## 6. External Dependencies & Libraries

### 6.1 Vendored Sys Crates (`src/deps/`)

```mermaid
graph LR
    subgraph "src/deps/ (vendored C/Go sys crates)"
        LIBKRUN["libkrun-sys<br/>━━━━━━━━━<br/>VMM hypervisor<br/>KVM (Linux)<br/>Hvf (macOS)"]
        BWRAP["bubblewrap-sys<br/>━━━━━━━━━<br/>Linux sandbox<br/>Namespaces<br/>pivot_root"]
        E2FS["e2fsprogs-sys<br/>━━━━━━━━━<br/>ext4 creation<br/>mke2fs binary"]
        GVPROXY["libgvproxy-sys<br/>━━━━━━━━━<br/>Network backend<br/>Go binary<br/>gvisor-tap-vsock"]
    end

    subgraph "Platform Availability"
        direction TB
        LINUX["Linux ✅"]
        MACOS["macOS ✅"]
        WIN["Windows ❌"]
    end

    LIBKRUN -->|"✅"| LINUX
    LIBKRUN -->|"✅"| MACOS
    LIBKRUN -->|"❌ No WHPX/MSHV"| WIN

    BWRAP -->|"✅"| LINUX
    BWRAP -->|"❌ Linux-only"| MACOS
    BWRAP -->|"❌ Linux-only"| WIN

    E2FS -->|"✅"| LINUX
    E2FS -->|"✅ brew install"| MACOS
    E2FS -->|"⚠️ Cross-compile"| WIN

    GVPROXY -->|"✅"| LINUX
    GVPROXY -->|"✅"| MACOS
    GVPROXY -->|"⚠️ Needs Go build"| WIN
```

| Crate | Purpose | Linux | macOS | Windows |
|-------|---------|-------|-------|---------|
| `libkrun-sys` | VMM: KVM/Hvf hypervisor, virtio devices, process takeover | KVM | Hypervisor.framework | **Blocker**: No WHPX/MSHV backend |
| `bubblewrap-sys` | Sandbox: namespaces, pivot_root, seccomp | Full | Not used | Not applicable |
| `e2fsprogs-sys` | Disk: `mke2fs` for ext4 filesystem creation | Native | Homebrew | Needs cross-compile or alt |
| `libgvproxy-sys` | Network: Go-based userspace TCP/IP | Full | Full | Needs Go cross-compile |

### 6.2 Rust Crate Dependencies

| Category | Crate | Purpose |
|----------|-------|---------|
| **Async Runtime** | `tokio` | Event loop, tasks, timers, I/O |
| **gRPC** | `tonic` + `prost` | Host-guest communication protocol |
| **OCI Images** | `oci-client` | Container image pull/push |
| **Database** | `rusqlite` | Box metadata persistence |
| **HTTP Server** | `axum` | REST API server |
| **Serialization** | `serde` + `serde_json` | Config, IPC, persistence |
| **Logging** | `tracing` + `tracing-subscriber` | Structured logging |
| **Python FFI** | `pyo3` + `pyo3-async-runtimes` | Python SDK bindings |
| **Node.js FFI** | `napi` + `napi-derive` | Node.js SDK bindings |
| **Process** | `sysinfo` | Process CPU/memory metrics |
| **Crypto** | `rcgen` + `time` | MITM CA cert generation |
| **Concurrency** | `parking_lot` | Fast RwLock for BoxState |
| **Async Traits** | `async-trait` | Async trait methods |
| **TLS** | `rustls` | gRPC TLS support |

### 6.3 Key Library Choices & Rationale

```mermaid
mindmap
  root((BoxLite<br/>Library Choices))
    Hypervisor
      libkrun
        Process takeover model
        KVM + Hvf backends
        Built-in virtio devices
        TSI networking
    Sandboxing
      bubblewrap (Linux)
        Unprivileged namespaces
        pivot_root isolation
        Mature, well-tested
      sandbox-exec (macOS)
        Seatbelt/SBPL policy
        deny-default + allow rules
        No root required
    Networking
      gvproxy (gvisor-tap-vsock)
        Userspace TCP/IP
        No root/TUN/TAP
        DNS sinkhole
        MITM proxy
    Communication
      gRPC over vsock
        Streaming exec I/O
        Bidirectional
        Proto-defined API
    Storage
      ext4 + qcow2
        COW snapshots
        Thin clones
        Standard formats
```

---

## 7. Guest Agent Architecture

The guest agent (`src/guest/`) runs **inside the VM** and is always compiled for Linux.

```mermaid
graph TB
    subgraph "Guest VM (Linux)"
        MAIN["main.rs<br/>Entry point"]
        SERVER["GuestServer<br/>(gRPC server)"]
        SERVICE["GuestService<br/>(request handler)"]
        CONTAINER["Container Runtime<br/>(libcontainer)"]
        MOUNTS["Mounts Manager<br/>(overlayfs, volumes)"]
        NETWORK["Network Setup<br/>(resolv.conf, routes)"]
        STORAGE["Storage Manager<br/>(disks, filesystems)"]
        CA["CA Trust<br/>(inject MITM certs)"]
    end

    subgraph "gRPC Services"
        EXEC["Exec Service<br/>fork+exec in container"]
        FILE["File Service<br/>upload/download tar"]
        HEALTH["Health Service<br/>readiness probe"]
        RESIZE["Resize Service<br/>PTY terminal resize"]
    end

    MAIN --> SERVER
    SERVER --> SERVICE
    SERVICE --> EXEC
    SERVICE --> FILE
    SERVICE --> HEALTH
    SERVICE --> RESIZE

    EXEC --> CONTAINER
    FILE --> MOUNTS
    SERVICE --> NETWORK
    SERVICE --> STORAGE
    SERVICE --> CA

    HOST["Host (Portal)"] -.->|"vsock:2695<br/>gRPC"| SERVER
    HOST -.->|"vsock:2696<br/>Ready notify"| MAIN
```

**Guest startup sequence:**
1. **Start Zygote** (`clone3()` fork server) **before** Tokio — avoids musl `malloc` deadlock in forked async runtime
2. Mount essential tmpfs (`/tmp`, `/dev/shm`)
3. Parse args (`--listen vsock://2695 --notify vsock://2696`)
4. Initialize tracing
5. Prepare guest layout (`/boxlite/*`)
6. Start gRPC server on vsock
7. Send ready notification to host

**On `Guest.Init()` gRPC call:**
1. Mount volumes (virtiofs + block devices)
2. Configure network (DNS, routes)
3. Inject CA certs (if MITM secrets configured)

**On `Container.Init()` gRPC call:**
1. Assemble overlayfs (upper + lower layers)
2. Start OCI container via `libcontainer`

**Zygote pattern:** Container processes are spawned via the pre-forked Zygote using `clone3()` syscall. This avoids the musl libc deadlock that occurs when `fork()` is called from a multi-threaded Tokio runtime — the Zygote is started **before** any threads exist.

---

## 8. Host-Guest Communication

```mermaid
graph LR
    subgraph "Host Process"
        PORTAL["Portal<br/>(GuestSession)"]
        TONIC_C["tonic gRPC Client"]
    end

    subgraph "Transport Layer"
        direction TB
        VSOCK["vsock (AF_VSOCK)<br/>Port 2695: gRPC<br/>Port 2696: Ready"]
        UNIX["Unix Socket<br/>(fallback)"]
    end

    subgraph "Guest VM"
        TONIC_S["tonic gRPC Server"]
        GUEST_SVC["GuestService"]
    end

    PORTAL --> TONIC_C
    TONIC_C -->|"Host sends"| VSOCK
    VSOCK -->|"Guest receives"| TONIC_S
    TONIC_S --> GUEST_SVC

    TONIC_C -.->|"Fallback"| UNIX
    UNIX -.->|"Fallback"| TONIC_S
```

**Transport abstraction:**
```
Transport enum:
  ├── Vsock { port: u32 }        ← Primary (inside VM, no host setup)
  ├── Unix  { socket_path }      ← Fallback / development
  └── Tcp   { port: u16 }       ← Future / distributed
```

**Krun-specific transform:** The host configures `Unix` transport (socket in box dir), but libkrun's process bridges it to `vsock` inside the guest. The `Krun::transform_shell_arg_unix_to_vsock()` method rewrites the guest entrypoint args.

---

## 9. Windows Native Porting Analysis

### 9.1 Component Readiness

```mermaid
graph TB
    subgraph "Ready (No Changes)"
        style Ready fill:#90EE90
        SDK["SDK Layer<br/>Python/Node.js/C FFI"]
        RUNTIME["Runtime Orchestration<br/>BoxliteRuntime, RuntimeImpl"]
        LITEBOX["LiteBox Layer<br/>BoxImpl, Execution"]
        DB_W["SQLite DB"]
        IMG_W["Image Manager<br/>(OCI pull/cache)"]
        PROTO["gRPC Proto<br/>(protobuf definitions)"]
    end

    subgraph "Moderate Effort"
        style Moderate fill:#FFD700
        DISK_W["Disk Manager<br/>Need ext4 tools on Win"]
        NET_W["Network Backend<br/>Named Pipes or AF_HYPERV"]
        PORTAL_W["Portal Transport<br/>Hyper-V sockets"]
        PROCESS_W["ProcessMonitor<br/>WaitForSingleObject"]
        FD_W["FD Cleanup<br/>NtQueryInformationProcess"]
    end

    subgraph "Major Effort (Blockers)"
        style Major fill:#FF6347
        VMM_W["VMM Engine<br/>Replace libkrun entirely"]
        JAIL_W["Jailer / Sandbox<br/>Job Objects + AppContainer"]
        GUEST_W["Guest Agent<br/>Linux-only (runs in VM)"]
        SHIM_W["Shim Process<br/>No process takeover on Win"]
    end
```

### 9.2 Platform Abstraction Strategy

```mermaid
graph TB
    TRAIT["Platform Trait<br/>(new abstraction)"] --> LINUX_IMPL["LinuxPlatform"]
    TRAIT --> MACOS_IMPL["MacOSPlatform"]
    TRAIT --> WIN_IMPL["WindowsPlatform"]

    LINUX_IMPL --> L_VMM["libkrun (KVM)"]
    LINUX_IMPL --> L_JAIL["bubblewrap + seccomp"]
    LINUX_IMPL --> L_NET["gvproxy (UnixStream)"]
    LINUX_IMPL --> L_MON["pidfd_open()"]
    LINUX_IMPL --> L_TRANS["vsock (AF_VSOCK)"]

    MACOS_IMPL --> M_VMM["libkrun (Hvf)"]
    MACOS_IMPL --> M_JAIL["sandbox-exec (Seatbelt)"]
    MACOS_IMPL --> M_NET["gvproxy (UnixDgram)"]
    MACOS_IMPL --> M_MON["kqueue + EVFILT_PROC"]
    MACOS_IMPL --> M_TRANS["vsock (via libkrun)"]

    WIN_IMPL --> W_VMM["Cloud Hypervisor<br/>(MSHV backend)"]
    WIN_IMPL --> W_JAIL["Job Objects +<br/>AppContainer +<br/>Restricted Tokens"]
    WIN_IMPL --> W_NET["gvproxy<br/>(Named Pipes)"]
    WIN_IMPL --> W_MON["WaitForSingleObject<br/>(HANDLE)"]
    WIN_IMPL --> W_TRANS["Hyper-V sockets<br/>(AF_HYPERV)"]
```

### 9.3 Recommended Windows Porting Phases

| Phase | Component | Effort | Description |
|-------|-----------|--------|-------------|
| **Phase 0** | `SystemCheck` | Small | Add `target_os = "windows"` check for WHPX/Hyper-V |
| **Phase 1** | `ProcessMonitor` | Small | `WaitForSingleObject` implementation |
| **Phase 1** | `FD Cleanup` | Small | Replace with `NtQueryInformationProcess` or skip |
| **Phase 2** | `Transport` | Medium | Add `HyperVSocket { vm_id, service_id }` variant |
| **Phase 2** | `Portal` | Medium | Hyper-V socket gRPC transport |
| **Phase 3** | `VMM Engine` | **Large** | Cloud Hypervisor with MSHV backend (new engine impl) |
| **Phase 3** | `Shim` | Large | No process takeover — use subprocess model instead |
| **Phase 4** | `Jailer` | Medium | `WindowsSandbox` impl: Job Objects + AppContainer |
| **Phase 5** | `Network` | Medium | gvproxy on Windows (Named Pipes + Go cross-compile) |
| **Phase 6** | `Disk` | Medium | ext4 tools for Windows or alternative format |

---

## 10. Initialization Pipeline

BoxBuilder uses a **staged execution pipeline** (`src/boxlite/src/litebox/init/`) with parallel and sequential phases, adapting to the box's current status.

### 10.1 First Start (Configured)

```mermaid
graph LR
    subgraph "Stage 1 (Sequential)"
        FS["FilesystemTask<br/>Create box directory structure"]
    end

    subgraph "Stage 2 (Parallel)"
        CR["ContainerRootfsTask<br/>Pull OCI image → COW disk"]
        GR["GuestRootfsTask<br/>Prepare guest rootfs → COW disk"]
    end

    subgraph "Stage 3 (Sequential)"
        VMM["VmmSpawnTask<br/>Build InstanceSpec → spawn shim"]
    end

    subgraph "Stage 4 (Sequential)"
        GC["GuestConnectTask<br/>Wait ready signal → GuestSession"]
    end

    subgraph "Stage 5 (Sequential)"
        GI["GuestInitTask<br/>Guest.Init() → Container.Init()"]
    end

    FS --> CR
    FS --> GR
    CR --> VMM
    GR --> VMM
    VMM --> GC
    GC --> GI
```

### 10.2 Restart (Stopped)

Same pipeline, but:
- **ContainerRootfsTask**: Reuses existing COW disk (preserves user modifications)
- **GuestRootfsTask**: Reuses existing COW disk
- **VmmSpawnTask**: Spawns **new** VM process
- **GuestInitTask**: Must run (new VM has fresh guest daemon)

### 10.3 Reattach (Running)

```mermaid
graph LR
    ATT["VmmAttachTask<br/>Attach to existing PID"] --> GC["GuestConnectTask<br/>Reconnect to gRPC server"]
```

### 10.4 RAII Cleanup Guarantees

- **CleanupGuard** in BoxBuilder: Kills VM + removes directory on pipeline failure
- **Disk** RAII: Deletes file on drop (unless `persistent=true`)
- **BindMountHandle** RAII (Linux): Unmounts on drop
- **LockGuard**: Releases filesystem lock on drop

---

## 11. Snapshot & Clone Architecture

### 11.1 Snapshot Flow (Quiesce + Fork)

```mermaid
sequenceDiagram
    participant User as User Code
    participant LB as LiteBox
    participant SH as SnapshotHandle
    participant BI as BoxImpl
    participant GUEST as Guest Agent
    participant DISK as Disk Manager

    User->>LB: box.snapshots().create("snap1")
    LB->>SH: SnapshotHandle::create()
    SH->>BI: with_quiesce_async()

    Note over BI,GUEST: Quiesce Phase
    BI->>GUEST: guest.quiesce() [FIFREEZE ioctl]
    GUEST-->>BI: Filesystems frozen

    BI->>BI: SIGSTOP shim process

    Note over BI,DISK: Fork Phase
    BI->>DISK: fork_qcow2(disk.qcow2, bases/snap1/disk.qcow2)
    DISK->>DISK: 1. Read virtual size
    DISK->>DISK: 2. Rename disk.qcow2 → bases/snap1/disk.qcow2
    DISK->>DISK: 3. Create COW child at disk.qcow2
    DISK-->>BI: Immutable base + live overlay

    Note over BI,GUEST: Thaw Phase
    BI->>BI: SIGCONT shim process
    BI->>GUEST: guest.thaw() [FITHAW ioctl]
    GUEST-->>BI: Filesystems unfrozen

    BI-->>SH: SnapshotInfo
    SH-->>User: Snapshot created
```

### 11.2 Clone Flow (Thin Overlay)

```mermaid
graph TB
    subgraph "Source Box"
        SNAP["bases/snap1/disk.qcow2<br/>(immutable base)"]
        LIVE["boxes/src/disk.qcow2<br/>(COW overlay, ~64KB)"]
    end

    subgraph "Clone 1"
        C1["boxes/clone1/disk.qcow2<br/>(COW overlay, ~64KB)"]
    end

    subgraph "Clone 2"
        C2["boxes/clone2/disk.qcow2<br/>(COW overlay, ~64KB)"]
    end

    subgraph "Clone 3"
        C3["boxes/clone3/disk.qcow2<br/>(COW overlay, ~64KB)"]
    end

    LIVE -->|"backing_file"| SNAP
    C1 -->|"backing_file"| SNAP
    C2 -->|"backing_file"| SNAP
    C3 -->|"backing_file"| SNAP
```

**Batch clone** (`clone_boxes`): Source disks copied once into shared base, then each clone gets a thin qcow2 overlay (~64KB) — O(1) per clone instead of O(disk_size).

---

## 12. Key Design Decisions

### 12.1 Why Shim Process?

```mermaid
graph LR
    subgraph "Without Shim (Dangerous)"
        HOST1["Host Process"] -->|"krun_start_enter()"| TAKEOVER["Process Takeover<br/>Host process GONE"]
    end

    subgraph "With Shim (Current Design)"
        HOST2["Host Process"] -->|"spawn()"| SHIM2["boxlite-shim"]
        SHIM2 -->|"krun_start_enter()"| VM2["VM Running<br/>Host survives"]
    end
```

`libkrun`'s `krun_start_enter()` **takes over the calling process** — it never returns. The shim subprocess isolates this behavior, letting the host application continue running and manage multiple VMs concurrently.

### 12.2 Why vsock?

- No host network configuration needed
- Works inside hardware-isolated VM
- Faster than TCP (no network stack overhead)
- Secure by design (no network exposure)
- Standard Linux/macOS kernel support

### 12.3 Why gvproxy (not TUN/TAP)?

- **No root required** — userspace TCP/IP stack
- **No TUN/TAP device** — works in unprivileged containers
- **Built-in features** — DNS sinkhole, MITM proxy, port mapping
- **Cross-platform** — Go binary works on Linux and macOS

### 12.4 Trait-Based Extensibility

```
RuntimeBackend (trait)
├── LocalRuntime  → VM-backed boxes
└── RestRuntime   → HTTP-backed boxes (distributed)

BoxBackend (trait)
├── BoxImpl       → Local VM lifecycle
└── RestBox       → Remote box via REST API

Sandbox (trait)
├── BwrapSandbox      → Linux namespaces
├── SeatbeltSandbox   → macOS Seatbelt
├── CompositeSandbox  → Bwrap + Landlock
├── NoopSandbox       → Disabled
└── WindowsSandbox    → TODO: Job Objects + AppContainer

NetworkBackend (trait)
├── GvisorTapBackend  → gvproxy (primary)
└── LibslirpBackend   → libslirp (fallback)

VmmController (trait)
├── ShimController    → Subprocess shim
└── (future)          → Direct VM management

Vmm (trait)
├── Krun              → libkrun engine
└── (future)          → Cloud Hypervisor, Firecracker
```

The trait-based architecture is well-suited for Windows porting — new platform implementations can be added behind the existing trait boundaries without modifying the upper layers.
