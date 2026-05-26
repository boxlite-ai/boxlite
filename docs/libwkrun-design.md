# libwkrun: Windows-Native VMM Library for BoxLite

## Executive Summary

**libwkrun** (Windows Krun) is a proposed new Rust library that provides libkrun-compatible APIs backed by Microsoft Hypervisor (MSHV/WHPX), enabling BoxLite to support Windows as a first-class platform with the same user experience as macOS and Linux.

### Why a New Library?

| Factor | libkrun | libwkrun (proposed) |
|--------|---------|---------------------|
| Hypervisor | KVM (Linux), Hypervisor.framework (macOS) | WHPX / MSHV (Windows) |
| Process Model | Process takeover (`krun_start_enter` never returns) | Thread-based VM loop (returns on exit) |
| Host-Guest IPC | vsock → Unix socket bridge | Hyper-V sockets (AF_HYPERV) → Named Pipes |
| Networking | Unix sockets (stream/dgram) | Named Pipes / TCP loopback |
| Filesystem Sharing | virtiofs (in-process) | Plan 9 / virtiofs over Hyper-V sockets |
| Sandbox | N/A (OS-level: namespaces, seatbelt) | Windows Job Objects + AppContainer |
| Windows Support | None, no plans | Native, first-class |

### Design Philosophy

1. **API-compatible with libkrun** — Same C function signatures where possible
2. **Rust-first implementation** — Built on `rust-vmm` crate ecosystem
3. **No process takeover** — Thread-based VM execution (Windows cannot fork+exec)
4. **Minimal viable device set** — Only what BoxLite needs, nothing more

---

## 1. Architecture Overview

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BoxLite Runtime                        │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ VmmKind::     │  │ VmmKind::     │  │ VmmKind::     │ │
│  │ Libkrun       │  │ Libwkrun      │  │ Firecracker   │ │
│  │ (Linux/macOS) │  │ (Windows)     │  │ (Linux)       │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────┘ │
│         │                  │                             │
│  ┌──────▼───────┐  ┌──────▼───────┐                    │
│  │ libkrun-sys  │  │ libwkrun-sys │                    │
│  │ (C FFI)      │  │ (Rust FFI)   │                    │
│  └──────┬───────┘  └──────┬───────┘                    │
└─────────┼──────────────────┼────────────────────────────┘
          │                  │
   ┌──────▼───────┐  ┌──────▼───────────────────────┐
   │   libkrun     │  │         libwkrun              │
   │  (C library)  │  │      (Rust library)           │
   │               │  │  ┌─────────────────────────┐  │
   │  KVM /        │  │  │ Hypervisor Abstraction  │  │
   │  HVF backend  │  │  │  ┌──────┐  ┌─────────┐ │  │
   │               │  │  │  │ WHPX │  │  MSHV   │ │  │
   │               │  │  │  └──────┘  └─────────┘ │  │
   │               │  │  └─────────────────────────┘  │
   │  virtio       │  │  ┌─────────────────────────┐  │
   │  devices      │  │  │ Virtio Device Layer     │  │
   │  (in-process) │  │  │ blk / fs / net / vsock  │  │
   │               │  │  └─────────────────────────┘  │
   └───────────────┘  └──────────────────────────────┘
```

### 1.2 Component Stack

```
┌──────────────────────────────────────────────────┐
│                 libwkrun C API                    │  ← wkrun_create_ctx(), etc.
├──────────────────────────────────────────────────┤
│              WkrunContext (Rust)                  │  ← Safe wrapper (like KrunContext)
├──────────────────────────────────────────────────┤
│              VM Manager                          │  ← vCPU threads, memory mapping
├────────────┬──────────┬──────────┬───────────────┤
│ virtio-blk │ virtio-fs│virtio-net│ hv-socket     │  ← Device backends
├────────────┴──────────┴──────────┴───────────────┤
│         Hypervisor Abstraction Layer             │
├──────────────────┬───────────────────────────────┤
│   WHPX Backend   │     MSHV Backend              │  ← Platform hypervisors
│  (Hyper-V API)   │  (rust-vmm/mshv)              │
└──────────────────┴───────────────────────────────┘
```

---

## 2. Hypervisor Backend

### 2.1 Target: Windows Hypervisor Platform (WHPX)

**WHPX** (Windows Hypervisor Platform) is the primary target:

- Available on Windows 10 Pro/Enterprise and Windows 11
- User-space API — no kernel driver needed (unlike `/dev/kvm`)
- Enable via: `Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform`
- C API: `WinHvPlatform.h` / `WinHvEmulation.h`

**Key WHPX APIs:**

| WHPX API | KVM Equivalent | Purpose |
|----------|---------------|---------|
| `WHvCreatePartition` | `KVM_CREATE_VM` | Create VM |
| `WHvSetupPartition` | (after config) | Finalize partition |
| `WHvCreateVirtualProcessor` | `KVM_CREATE_VCPU` | Create vCPU |
| `WHvRunVirtualProcessor` | `KVM_RUN` | Run vCPU (returns on exit) |
| `WHvMapGpaRange` | `KVM_SET_USER_MEMORY_REGION` | Map guest memory |
| `WHvGetVirtualProcessorRegisters` | `KVM_GET_REGS` | Read registers |
| `WHvSetVirtualProcessorRegisters` | `KVM_SET_REGS` | Write registers |
| `WHvTranslateGva` | (page walk) | GVA→GPA translation |
| `WHvCancelRunVirtualProcessor` | (signal) | Cancel vCPU run |

### 2.2 Secondary: MSHV (Microsoft Hypervisor)

**MSHV** via `rust-vmm/mshv` crate is supported as a secondary backend, primarily for:
- Azure VMs (root partition access)
- Linux hosts running on Hyper-V
- Future Windows `/dev/mshv`-like interface

**rust-vmm/mshv crate structure:**
```
mshv-bindings    — Raw ioctl/hypercall structs
mshv-ioctls      — Safe Rust wrappers
  ├── Mshv        — /dev/mshv handle
  ├── VmFd        — Partition handle
  └── VcpuFd      — vCPU handle
```

### 2.3 Hypervisor Abstraction Layer

```rust
/// Platform-agnostic hypervisor interface.
/// Inspired by Cloud Hypervisor's hypervisor crate.
pub trait Hypervisor: Send + Sync {
    fn create_vm(&self) -> Result<Box<dyn Vm>>;
    fn check_capability(&self, cap: HypervisorCap) -> bool;
}

pub trait Vm: Send + Sync {
    fn create_vcpu(&self, id: u8) -> Result<Box<dyn Vcpu>>;
    fn map_memory(&self, slot: u32, guest_addr: u64, host_addr: u64, size: u64) -> Result<()>;
    fn unmap_memory(&self, slot: u32) -> Result<()>;
    fn set_irq_line(&self, irq: u32, active: bool) -> Result<()>;
    fn create_irq_chip(&self) -> Result<()>;
}

pub trait Vcpu: Send {
    fn run(&self) -> Result<VcpuExit>;
    fn get_regs(&self) -> Result<StandardRegisters>;
    fn set_regs(&self, regs: &StandardRegisters) -> Result<()>;
    fn get_sregs(&self) -> Result<SpecialRegisters>;
    fn set_sregs(&self, sregs: &SpecialRegisters) -> Result<()>;
}

pub enum VcpuExit {
    IoIn { port: u16, data: &mut [u8] },
    IoOut { port: u16, data: &[u8] },
    MmioRead { addr: u64, data: &mut [u8] },
    MmioWrite { addr: u64, data: &[u8] },
    Hlt,
    Shutdown,
    HypervHcall { input: u64, params: [u64; 2] },
    Unknown(u32),
}
```

### 2.4 WHPX Backend Implementation

```rust
pub struct WhpxHypervisor {
    // WHPX is partition-per-VM, no global handle needed
}

pub struct WhpxVm {
    partition: WHV_PARTITION_HANDLE,
    // Memory region tracking
    memory_slots: HashMap<u32, MemorySlot>,
}

pub struct WhpxVcpu {
    partition: WHV_PARTITION_HANDLE,
    index: u32,
}

impl Vcpu for WhpxVcpu {
    fn run(&self) -> Result<VcpuExit> {
        let mut exit_context: WHV_RUN_VP_EXIT_CONTEXT = unsafe { std::mem::zeroed() };

        // WHvRunVirtualProcessor is synchronous — blocks until VM exit
        let hr = unsafe {
            WHvRunVirtualProcessor(
                self.partition,
                self.index,
                &mut exit_context as *mut _ as *mut c_void,
                std::mem::size_of::<WHV_RUN_VP_EXIT_CONTEXT>() as u32,
            )
        };
        check_hresult(hr)?;

        match exit_context.ExitReason {
            WHvRunVpExitReasonX64IoPortAccess => { /* decode I/O */ }
            WHvRunVpExitReasonMemoryAccess => { /* decode MMIO */ }
            WHvRunVpExitReasonX64Halt => Ok(VcpuExit::Hlt),
            WHvRunVpExitReasonCanceled => { /* handle cancel */ }
            _ => Ok(VcpuExit::Unknown(exit_context.ExitReason)),
        }
    }
}
```

---

## 3. C API Surface (libkrun-Compatible)

### 3.1 API Mapping

libwkrun provides the **same 26 C functions** that BoxLite uses from libkrun, with `wkrun_` prefix:

#### Context Management
```c
// Create/destroy VM context
int32_t wkrun_create_ctx(void);                     // → krun_create_ctx
int32_t wkrun_free_ctx(uint32_t ctx_id);             // → krun_free_ctx
```

#### Logging
```c
int32_t wkrun_init_log(int32_t target, uint32_t level,
                       uint32_t style, uint32_t flags);  // → krun_init_log
```

#### VM Configuration
```c
int32_t wkrun_set_vm_config(uint32_t ctx_id, uint8_t num_vcpus,
                            uint32_t ram_mib);            // → krun_set_vm_config
int32_t wkrun_split_irqchip(uint32_t ctx_id, bool enable); // → krun_split_irqchip
int32_t wkrun_set_nested_virt(uint32_t ctx_id, bool en);   // → krun_set_nested_virt
```

#### Filesystem & Root
```c
int32_t wkrun_set_root(uint32_t ctx_id, const char* root_path);
int32_t wkrun_set_root_disk_remount(uint32_t ctx_id, const char* device,
                                     const char* fstype, const char* options);
int32_t wkrun_add_virtiofs(uint32_t ctx_id, const char* tag, const char* host_path);
```

#### Execution & Environment
```c
int32_t wkrun_set_exec(uint32_t ctx_id, const char* exec_path,
                       const char** argv, const char** envp);
int32_t wkrun_set_env(uint32_t ctx_id, const char** envp);
int32_t wkrun_set_workdir(uint32_t ctx_id, const char* workdir_path);
int32_t wkrun_set_rlimits(uint32_t ctx_id, const char** rlimits);
```

#### Kernel & Boot
```c
int32_t wkrun_set_kernel(uint32_t ctx_id, const char* kernel_path,
                         uint32_t format, const char* initramfs, const char* cmdline);
```

#### Networking
```c
// Windows: these accept Named Pipe paths instead of Unix socket paths
int32_t wkrun_add_net_pipe(uint32_t ctx_id, const char* pipe_path,
                           const uint8_t* mac, uint32_t features, uint32_t flags);
// Compatibility shims (map to wkrun_add_net_pipe internally):
int32_t wkrun_add_net_unixstream(uint32_t ctx_id, const char* path, int fd,
                                  const uint8_t* mac, uint32_t features, uint32_t flags);
int32_t wkrun_add_net_unixgram(uint32_t ctx_id, const char* path, int fd,
                                const uint8_t* mac, uint32_t features, uint32_t flags);
int32_t wkrun_set_port_map(uint32_t ctx_id, const char** port_map);
```

#### Block Devices
```c
int32_t wkrun_add_disk2(uint32_t ctx_id, const char* block_id,
                        const char* disk_path, uint32_t format, bool read_only);
```

#### Host-Guest Communication
```c
// Windows: bridges Hyper-V socket to Named Pipe (instead of vsock → Unix socket)
int32_t wkrun_add_vsock_port2(uint32_t ctx_id, uint32_t port,
                              const char* filepath, bool listen);
```

#### GPU, UID/GID, Console
```c
int32_t wkrun_set_gpu_options(uint32_t ctx_id, uint32_t flags);
int32_t wkrun_setuid(uint32_t ctx_id, uint32_t uid);   // No-op on Windows
int32_t wkrun_setgid(uint32_t ctx_id, uint32_t gid);   // No-op on Windows
int32_t wkrun_set_console_output(uint32_t ctx_id, const char* filepath);
```

#### VM Execution (KEY DIFFERENCE)
```c
// Unlike krun_start_enter which never returns (process takeover),
// wkrun_start_enter runs the VM in threads and BLOCKS until exit.
// Returns: 0 on success, negative on error, positive = guest exit code.
int32_t wkrun_start_enter(uint32_t ctx_id);

// NEW: Non-blocking start + separate wait (preferred for Windows)
int32_t wkrun_start(uint32_t ctx_id);                // Start VM in background threads
int32_t wkrun_wait(uint32_t ctx_id);                  // Block until VM exits
int32_t wkrun_stop(uint32_t ctx_id);                  // Request graceful shutdown
```

### 3.2 API Behavior Differences

| Function | libkrun Behavior | libwkrun Behavior |
|----------|-----------------|-------------------|
| `*_start_enter` | **Process takeover** — never returns on success, calling process becomes the VM | **Blocking call** — spawns vCPU threads, blocks calling thread until VM exits, then returns |
| `*_add_vsock_port2` | Bridges guest vsock port to host Unix socket | Bridges guest Hyper-V socket to host Named Pipe |
| `*_add_net_unixstream` | Connects to Unix SOCK_STREAM | Maps to Named Pipe (or TCP loopback fallback) |
| `*_add_net_unixgram` | Connects to Unix SOCK_DGRAM | Maps to Named Pipe (gvproxy-win) |
| `*_setuid` / `*_setgid` | Sets process UID/GID before VM | No-op (Windows has no UID/GID) |
| `*_set_root` | Sets virtiofs root directory | Sets Plan 9 / virtiofs-over-pipe root |

---

## 4. Process Model

### 4.1 libkrun Process Model (Current)

```
                     libkrun Process Model
┌──────────────────────────────────────────────────┐
│ BoxLite Host Process                              │
│                                                   │
│   BoxBuilder::spawn() ──────► fork() ──────►     │
│                                                   │
│   ┌──────────────────────────────────────────┐   │
│   │ boxlite-shim (child process)              │   │
│   │                                           │   │
│   │   Jailer::prepare()                       │   │
│   │   NetworkBackend::start()                 │   │
│   │   KrunContext::create()                   │   │
│   │   KrunContext::set_vm_config()            │   │
│   │   KrunContext::add_virtiofs()             │   │
│   │   KrunContext::add_vsock_port()           │   │
│   │   ...                                     │   │
│   │   KrunContext::start_enter()  ◄── POINT   │   │
│   │           │                   OF NO RETURN│   │
│   │           ▼                               │   │
│   │   ╔═══════════════════════════════════╗   │   │
│   │   ║  Process IS the VM now            ║   │   │
│   │   ║  (libkrun took over)              ║   │   │
│   │   ║                                   ║   │   │
│   │   ║  vCPU threads                     ║   │   │
│   │   ║  virtio device threads            ║   │   │
│   │   ║  virtiofs daemon thread           ║   │   │
│   │   ╚═══════════════════════════════════╝   │   │
│   └──────────────────────────────────────────┘   │
│                                                   │
│   Host monitors shim PID via pidfd/kqueue         │
└──────────────────────────────────────────────────┘
```

### 4.2 libwkrun Process Model (Proposed)

```
                    libwkrun Process Model
┌──────────────────────────────────────────────────┐
│ BoxLite Host Process                              │
│                                                   │
│   BoxBuilder::spawn() ──────► CreateProcess() ──►│
│                                                   │
│   ┌──────────────────────────────────────────┐   │
│   │ boxlite-shim.exe (child process)          │   │
│   │                                           │   │
│   │   WindowsSandbox::prepare()  (Job Object) │   │
│   │   NetworkBackend::start()                 │   │
│   │   WkrunContext::create()                  │   │
│   │   WkrunContext::set_vm_config()           │   │
│   │   WkrunContext::add_virtiofs()            │   │
│   │   WkrunContext::add_hvsock_port()         │   │
│   │   ...                                     │   │
│   │   WkrunContext::start_enter()             │   │
│   │           │                               │   │
│   │           ▼                               │   │
│   │   ┌───────────────────────────────────┐   │   │
│   │   │  VM runs in threads (not takeover)│   │   │
│   │   │                                   │   │   │
│   │   │  Thread 1: vCPU 0 loop            │   │   │
│   │   │  Thread 2: vCPU 1 loop            │   │   │
│   │   │  Thread 3: virtio-blk backend     │   │   │
│   │   │  Thread 4: virtiofs backend       │   │   │
│   │   │  Thread 5: hv-socket proxy        │   │   │
│   │   │  Thread 6: network backend        │   │   │
│   │   │                                   │   │   │
│   │   │  Main thread: blocked on VM exit  │   │   │
│   │   └───────────────────────────────────┘   │   │
│   │                                           │   │
│   │   ◄── start_enter() returns when VM exits │   │
│   │   Process cleanup & exit                  │   │
│   └──────────────────────────────────────────┘   │
│                                                   │
│   Host monitors shim via Job Object / WaitFor*    │
└──────────────────────────────────────────────────┘
```

### 4.3 Key Difference: No Process Takeover

On Linux/macOS, `krun_start_enter()` performs a **process takeover** — the calling process IS the VM. This is fundamental to libkrun's design (reduces overhead, eliminates IPC).

On Windows, process takeover is not possible because:
1. Windows has no `fork()` — `CreateProcess` creates independent processes
2. WHPX runs VMs via `WHvRunVirtualProcessor` in a loop — it returns on each VM exit
3. Windows process model doesn't support "becoming" another process

**libwkrun solution:** `wkrun_start_enter()` spawns vCPU threads and blocks the main thread until the VM exits. From BoxLite's perspective, the behavior is identical — the shim process runs until the VM exits, then the shim exits.

---

## 5. Host-Guest Communication

### 5.1 vsock vs Hyper-V Sockets

| Feature | vsock (Linux/macOS) | Hyper-V Sockets (Windows) |
|---------|--------------------|-----------------------------|
| Address Family | `AF_VSOCK` | `AF_HYPERV` |
| Addressing | CID + Port | VM GUID + Service GUID |
| Host-side | Unix socket bridge (via libkrun) | Native `AF_HYPERV` socket |
| Guest-side | `/dev/vsock` | `hv_sock` driver (built into Linux guests) |
| Performance | Near-native | Near-native |

### 5.2 Communication Architecture

```
                    Current (libkrun)
┌──────────┐  Unix Socket  ┌──────────┐  vsock    ┌──────────┐
│   Host   │◄─────────────►│  libkrun │◄─────────►│  Guest   │
│  (gRPC   │  /tmp/box/    │  bridge  │  port     │  Agent   │
│  client) │  grpc.sock    │          │  2695     │  (gRPC   │
│          │               │          │           │  server) │
└──────────┘               └──────────┘           └──────────┘

                    Proposed (libwkrun)
┌──────────┐  Named Pipe   ┌──────────┐  AF_HYPERV ┌──────────┐
│   Host   │◄─────────────►│ libwkrun │◄──────────►│  Guest   │
│  (gRPC   │  \\.\pipe\    │  bridge  │  Service   │  Agent   │
│  client) │  box_grpc     │          │  GUID      │  (gRPC   │
│          │               │          │            │  server) │
└──────────┘               └──────────┘            └──────────┘
```

### 5.3 Transport Mapping

BoxLite's `Transport` enum needs a Windows variant:

```rust
// In boxlite-shared/src/transport.rs
pub enum Transport {
    Tcp { port: u16 },
    Unix { socket_path: PathBuf },
    Vsock { port: u32 },
    #[cfg(target_os = "windows")]
    HvSocket { vm_id: Guid, service_id: Guid },
    #[cfg(target_os = "windows")]
    NamedPipe { pipe_name: String },
}
```

### 5.4 Hyper-V Socket Bridge (replaces vsock bridge)

libkrun's `krun_add_vsock_port2(port, socket_path, listen)` bridges a guest vsock port to a host Unix socket.

libwkrun's `wkrun_add_vsock_port2(port, pipe_path, listen)` bridges a guest Hyper-V socket service to a host Named Pipe:

```
Guest port 2695 (gRPC)   ←→  \\.\pipe\boxlite\{box_id}\grpc
Guest port 2696 (ready)  ←→  \\.\pipe\boxlite\{box_id}\ready
```

**Guest-side:** The guest agent detects Windows host and uses `AF_HYPERV` instead of `AF_VSOCK`. Service GUIDs are deterministically derived from port numbers:

```rust
// Deterministic Service GUID from port number
// Format: 00000000-facb-11e6-bd58-64006a{port_hex}
fn port_to_service_guid(port: u32) -> Guid {
    let port_bytes = port.to_be_bytes();
    Guid::from_fields(
        0x00000000,
        0xfacb,
        0x11e6,
        &[0xbd, 0x58, 0x64, 0x00, 0x6a, port_bytes[0], port_bytes[1], port_bytes[2]],
    )
}
```

---

## 6. Virtio Device Layer

### 6.1 Required Devices

Based on BoxLite's actual usage, libwkrun needs these virtio devices:

| Device | Purpose | BoxLite Usage | Implementation Source |
|--------|---------|--------------|---------------------|
| **virtio-blk** | Block device (disk images) | qcow2/raw disk attachment | rust-vmm/vm-virtio or cloud-hypervisor |
| **virtio-fs** | Filesystem sharing | Host↔guest dir sharing | virtiofsd or Plan 9 fallback |
| **virtio-net** | Network interface | gvproxy/passt integration | rust-vmm/vm-virtio |
| **virtio-console** | Serial console | Console output redirection | Minimal implementation |

### 6.2 NOT Required (libkrun has, BoxLite doesn't use)

- virtio-gpu (venus) — BoxLite is headless
- virtio-snd — No audio needed
- virtio-balloon — Memory overcommit not needed
- virtio-rng — Can use RDRAND instruction
- virtio-vsock — Replaced by Hyper-V sockets natively

### 6.3 Virtio Transport: MMIO vs PCI

| Transport | Pros | Cons | Recommendation |
|-----------|------|------|---------------|
| **virtio-mmio** | Simple, less code, what libkrun uses | Limited to ~8 devices, no hotplug | Phase 1 |
| **virtio-pci** | Standard, hotplug, >8 devices | More complex, needs PCI bus emulation | Phase 2 (if needed) |

**Recommendation:** Start with **virtio-mmio** (matches libkrun's approach). Add virtio-pci only if we need >8 devices or hotplug.

### 6.4 Filesystem Sharing on Windows

libkrun uses **in-process virtiofsd** for filesystem sharing. On Windows:

**Option A: virtiofs over Hyper-V socket** (Recommended)
- Run virtiofsd as a Windows service
- Guest connects via `AF_HYPERV` to virtiofs backend
- virtiofsd serves host filesystem via FUSE protocol over socket
- Similar to how virtiofs works with QEMU on Windows

**Option B: Plan 9 (9P) filesystem**
- Simpler protocol, well-supported in Linux guests
- Guest mounts via `mount -t 9p`
- Lower performance than virtiofs but easier to implement
- Good fallback / Phase 1 option

**Phased approach:**
1. Phase 1: Plan 9 over Hyper-V socket (simpler, proven)
2. Phase 2: virtiofs over Hyper-V socket (better performance)

---

## 7. Networking

### 7.1 Current Linux/macOS Networking

```
BoxLite:  gvproxy (Go) ←→ Unix socket ←→ libkrun (virtio-net) ←→ Guest
```

gvproxy (gvisor-tap-vsock) provides:
- DHCP server
- DNS sinkhole / forwarding
- NAT/masquerade
- Port mapping

### 7.2 Windows Networking Options

**Option A: gvproxy-windows + Named Pipes** (Recommended)
```
gvproxy.exe ←→ Named Pipe ←→ libwkrun (virtio-net) ←→ Guest
```
- gvproxy already builds on Windows (Go cross-compilation)
- Replace Unix socket with Named Pipe or TCP loopback
- Minimal changes to BoxLite networking stack

**Option B: Windows NAT + Hyper-V Default Switch**
```
Guest ←→ virtio-net ←→ Hyper-V Default Switch ←→ Windows NAT
```
- Uses Hyper-V's built-in networking
- More complex, requires admin privileges
- Less control over network configuration

**Option C: TAP adapter (WinTUN/WinTAP)**
```
Guest ←→ virtio-net ←→ WinTUN adapter ←→ Windows TCP/IP stack
```
- Proven approach (used by Docker Desktop, WSL2)
- Requires driver installation
- Good performance

**Recommendation:** Option A for Phase 1 (minimal changes), Option C for Phase 2 (performance).

### 7.3 Network Backend Adaptation

```rust
// In BoxLite's net/mod.rs
pub enum NetworkBackendEndpoint {
    #[cfg(unix)]
    UnixSocket {
        path: PathBuf,
        connection_type: ConnectionType,
        mac_address: [u8; 6],
    },
    #[cfg(windows)]
    NamedPipe {
        pipe_name: String,
        mac_address: [u8; 6],
    },
    #[cfg(windows)]
    TcpLoopback {
        port: u16,
        mac_address: [u8; 6],
    },
}
```

---

## 8. Sandbox / Jailer (Windows)

### 8.1 Current Jailer Architecture

```
Jail (trait)
└── Jailer<S: Sandbox>
    ├── BwrapSandbox       (Linux — bubblewrap + seccomp + namespaces)
    ├── SeatbeltSandbox    (macOS — sandbox-exec SBPL)
    ├── CompositeSandbox   (Linux — Bwrap + Landlock)
    └── NoopSandbox        (disabled)
```

### 8.2 Windows Sandbox Implementation

```
Jail (trait)
└── Jailer<S: Sandbox>
    ├── ... (existing)
    └── WindowsSandbox     (Windows — Job Objects + AppContainer)
```

**Windows Job Objects** provide:
- Process group isolation (all child processes contained)
- CPU/memory limits (similar to cgroups)
- Process termination guarantees (kill group on shim exit)
- No UI access restrictions

**AppContainer** (optional, Phase 2) provides:
- Filesystem isolation (per-container namespace)
- Network isolation
- Reduced token privileges

```rust
#[cfg(target_os = "windows")]
pub struct WindowsSandbox {
    job_handle: HANDLE,
}

#[cfg(target_os = "windows")]
impl Sandbox for WindowsSandbox {
    fn prepare(&mut self, ctx: &SandboxContext) -> BoxliteResult<()> {
        // Create Job Object
        let job = unsafe { CreateJobObjectW(null(), null()) };

        // Set limits
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |     // Kill all on close
            JOB_OBJECT_LIMIT_PROCESS_MEMORY |          // Memory limit
            JOB_OBJECT_LIMIT_JOB_MEMORY;               // Total memory limit
        info.ProcessMemoryLimit = ctx.memory_limit;
        info.JobMemoryLimit = ctx.memory_limit;

        unsafe {
            SetInformationJobObject(job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of_val(&info) as u32);
        }

        self.job_handle = job;
        Ok(())
    }

    fn command(&self, binary: &Path, args: &[String]) -> Command {
        let mut cmd = Command::new(binary);
        cmd.args(args);
        // Assign to Job Object on spawn
        cmd.creation_flags(CREATE_SUSPENDED);
        cmd
    }
}
```

---

## 9. Guest Agent Adaptation

### 9.1 Current Guest Agent

The guest agent (`src/guest/src/main.rs`) is Linux-only:
- Compiled for Linux (x86_64/aarch64)
- Listens on vsock port 2695 (gRPC server)
- Sends ready notification on vsock port 2696
- Zygote pattern: forks before Tokio runtime to avoid musl malloc deadlock

### 9.2 Guest Agent Changes for libwkrun

The Linux guest running inside a libwkrun-managed VM on Windows needs:

1. **Hyper-V socket support** (instead of vsock):
   ```rust
   // Detect host type at runtime
   enum HostTransport {
       Vsock(u32),           // Linux/macOS host (AF_VSOCK)
       HvSocket(Guid),       // Windows host (AF_HYPERV)
   }

   fn detect_transport() -> HostTransport {
       if Path::new("/dev/vsock").exists() {
           HostTransport::Vsock(GRPC_PORT)
       } else {
           // Hyper-V socket — service GUID from kernel cmdline or DMI
           HostTransport::HvSocket(grpc_service_guid())
       }
   }
   ```

2. **9P mount support** (Phase 1, if using Plan 9 filesystem):
   ```bash
   # Guest init script mounts host filesystem
   mount -t 9p -o trans=virtio,version=9p2000.L hostshare /mnt/host
   ```

3. **No changes to gRPC protocol** — The gRPC service contract remains identical.

---

## 10. BoxLite Integration Plan

### 10.1 Changes to BoxLite Core

#### New VmmKind variant
```rust
// src/boxlite/src/vmm/mod.rs
pub enum VmmKind {
    #[default]
    Libkrun,
    Firecracker,
    #[cfg(target_os = "windows")]
    Libwkrun,
}
```

#### New Engine Implementation
```rust
// src/boxlite/src/vmm/wkrun/mod.rs
#[cfg(target_os = "windows")]
pub mod context;    // WkrunContext (mirrors KrunContext)
#[cfg(target_os = "windows")]
pub mod engine;     // Wkrun implements Vmm trait

// src/boxlite/src/vmm/wkrun/engine.rs
pub struct Wkrun {
    options: VmmConfig,
}

impl Vmm for Wkrun {
    fn create(&mut self, config: InstanceSpec) -> BoxliteResult<VmmInstance> {
        let ctx = WkrunContext::create()?;
        ctx.set_vm_config(config.cpus, config.memory_mib)?;
        ctx.set_rootfs(&config.guest_rootfs)?;
        // ... configure devices ...
        Ok(VmmInstance::new(Box::new(WkrunVmmInstance { context: ctx })))
    }
}

struct WkrunVmmInstance {
    context: WkrunContext,
}

impl VmmInstanceImpl for WkrunVmmInstance {
    fn enter(self: Box<Self>) -> BoxliteResult<()> {
        // Unlike libkrun, this RETURNS when VM exits
        let status = self.context.start_enter();
        if status < 0 {
            Err(BoxliteError::Engine(format!("VM failed: {status}")))
        } else {
            Ok(())
        }
    }
}
```

#### System Check for Windows
```rust
// src/boxlite/src/system_check.rs
#[cfg(target_os = "windows")]
{
    check_whpx()?;
    Ok(Self {})
}

#[cfg(target_os = "windows")]
fn check_whpx() -> BoxliteResult<()> {
    // Check if WHPX is available
    let capability: WHV_CAPABILITY = unsafe { std::mem::zeroed() };
    let hr = unsafe {
        WHvGetCapability(
            WHvCapabilityCodeHypervisorPresent,
            &capability as *const _ as *mut c_void,
            std::mem::size_of::<WHV_CAPABILITY>() as u32,
            std::ptr::null_mut(),
        )
    };

    if FAILED(hr) || !capability.HypervisorPresent {
        return Err(BoxliteError::Unsupported(
            "Windows Hypervisor Platform (WHPX) not available\n\n\
             Enable via:\n\
             - Settings > Apps > Optional Features > More Windows Features\n\
             - Enable 'Windows Hypervisor Platform'\n\
             - Restart Windows\n\n\
             Or PowerShell (admin):\n\
             Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform"
                .into(),
        ));
    }
    Ok(())
}
```

#### Process Monitoring (Windows)
```rust
// src/boxlite/src/util/process.rs
#[cfg(target_os = "windows")]
pub struct ProcessMonitor {
    process_handle: OwnedHandle,  // HANDLE from CreateProcess
}

#[cfg(target_os = "windows")]
impl ProcessMonitor {
    pub async fn wait_for_exit(&self) -> ProcessExit {
        use tokio::signal::windows;
        // WaitForSingleObject on process handle (async via tokio)
        let handle = self.process_handle.as_raw_handle();
        tokio::task::spawn_blocking(move || {
            unsafe { WaitForSingleObject(handle, INFINITE) };
            let mut exit_code: u32 = 0;
            unsafe { GetExitCodeProcess(handle, &mut exit_code) };
            ProcessExit::Code(exit_code as i32)
        }).await.unwrap()
    }
}
```

### 10.2 Files Changed in BoxLite

| File | Change |
|------|--------|
| `src/boxlite/src/vmm/mod.rs` | Add `VmmKind::Libwkrun` variant |
| `src/boxlite/src/vmm/wkrun/` | **NEW:** Wkrun engine module (context.rs, engine.rs) |
| `src/boxlite/src/vmm/factory.rs` | Add Wkrun to engine factory |
| `src/boxlite/src/system_check.rs` | Add WHPX check |
| `src/boxlite/src/jailer/sandbox.rs` | Add `WindowsSandbox` |
| `src/boxlite/src/net/mod.rs` | Add `NamedPipe` endpoint variant |
| `src/boxlite/src/util/process.rs` | Add Windows `ProcessMonitor` |
| `src/shared/src/transport.rs` | Add `HvSocket` / `NamedPipe` transport |
| `src/guest/src/main.rs` | Add HvSocket detection |
| `src/deps/libwkrun-sys/` | **NEW:** FFI bindings crate |

### 10.3 What Stays the Same

These layers are **platform-agnostic** and need NO changes:

- `LiteBox` API (start, exec, stop, metrics, copy_into, copy_out)
- `BoxCommand` / `Execution` / `ExecResult`
- `InstanceSpec` structure (engine-agnostic)
- gRPC protocol (host↔guest)
- OCI image management
- SQLite persistence layer
- Python/Node.js SDK API surface

---

## 11. Project Structure

```
libwkrun/
├── Cargo.toml
├── src/
│   ├── lib.rs                  # Public C API (wkrun_* functions)
│   ├── context.rs              # WkrunContext (configuration state machine)
│   ├── vm.rs                   # VM lifecycle (create, start, stop)
│   ├── vcpu.rs                 # vCPU thread loop
│   ├── memory.rs               # Guest memory management
│   │
│   ├── hypervisor/             # Hypervisor abstraction layer
│   │   ├── mod.rs              # Hypervisor/Vm/Vcpu traits
│   │   ├── whpx.rs             # WHPX backend (primary)
│   │   └── mshv.rs             # MSHV backend (secondary)
│   │
│   ├── devices/                # Virtio device implementations
│   │   ├── mod.rs
│   │   ├── blk.rs              # virtio-blk (disk images)
│   │   ├── fs.rs               # virtiofs / Plan 9
│   │   ├── net.rs              # virtio-net
│   │   ├── console.rs          # virtio-console
│   │   └── mmio.rs             # MMIO transport
│   │
│   ├── transport/              # Host-guest communication
│   │   ├── mod.rs
│   │   └── hvsock.rs           # Hyper-V socket ↔ Named Pipe bridge
│   │
│   └── boot/                   # Boot/kernel loading
│       ├── mod.rs
│       ├── linux.rs            # Linux direct boot (bzImage)
│       └── firmware.rs         # UEFI boot (future)
│
├── include/
│   └── libwkrun.h              # C header (mirrors libkrun.h)
│
└── tests/
    ├── integration.rs
    └── whpx_smoke.rs           # WHPX capability test
```

---

## 12. Dependencies (Rust Crates)

| Crate | Purpose | From |
|-------|---------|------|
| `vm-memory` | Guest memory management | rust-vmm |
| `vm-virtio` | Virtio device traits | rust-vmm |
| `virtio-queue` | Virtio queue implementation | rust-vmm |
| `virtio-blk` | Block device backend | rust-vmm |
| `linux-loader` | Linux kernel loading | rust-vmm |
| `mshv-bindings` | MSHV ioctl structs | rust-vmm/mshv |
| `mshv-ioctls` | MSHV safe wrappers | rust-vmm/mshv |
| `windows-sys` | Windows API bindings | microsoft/windows-rs |
| `tokio` | Async runtime | tokio-rs |
| `qcow` | QCOW2 disk format | CrosVM |

---

## 13. Phased Implementation Plan

### Phase 1: Minimal Viable VM (MVP)

**Goal:** Boot a Linux guest on Windows with basic I/O

| Component | Scope |
|-----------|-------|
| WHPX backend | Create VM, run vCPU, handle exits |
| Memory management | Map guest RAM, load kernel |
| Linux boot | Direct bzImage boot (no UEFI) |
| virtio-console | Serial console output |
| virtio-blk | Read-only root disk (raw format) |
| C API | `wkrun_create_ctx`, `wkrun_set_vm_config`, `wkrun_set_kernel`, `wkrun_add_disk2`, `wkrun_start_enter` |

**Deliverable:** `wkrun_start_enter()` boots Linux, prints to console, halts.

### Phase 2: Guest Communication

**Goal:** BoxLite guest agent can communicate with host

| Component | Scope |
|-----------|-------|
| Hyper-V socket bridge | Guest HvSocket ↔ Host Named Pipe |
| virtio-blk | Read-write, qcow2 format |
| Plan 9 filesystem | Host directory sharing |
| Guest agent adaptation | Detect HvSocket transport |
| gRPC communication | Host↔guest gRPC over HvSocket bridge |

**Deliverable:** Guest agent starts, host can exec commands via gRPC.

### Phase 3: Full BoxLite Integration

**Goal:** BoxLite runs on Windows with same UX as macOS/Linux

| Component | Scope |
|-----------|-------|
| virtio-net + gvproxy-win | Guest network access |
| Windows Sandbox (Job Objects) | Process isolation |
| BoxLite vmm/wkrun module | Full engine integration |
| Process monitoring | Job Object / WaitForSingleObject |
| SDK support | Python/Node.js on Windows |
| System check | WHPX capability detection |

**Deliverable:** `boxlite.runtime()` works on Windows.

### Phase 4: Performance & Polish

**Goal:** Production-ready Windows support

| Component | Scope |
|-----------|-------|
| virtiofs (replace Plan 9) | Better filesystem performance |
| virtio-pci transport | More devices, hotplug |
| AppContainer sandbox | Enhanced security isolation |
| Snapshot/Clone support | COW via NTFS sparse files |
| CI/CD | Windows CI pipeline |
| MSHV backend | Azure VM support |

---

## 14. Risk Assessment

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **WHPX API limitations** | May not support all needed features (e.g., MSI injection for virtio) | Prototype Phase 1 early; fall back to MSHV if needed |
| **virtiofs on Windows host** | No mature virtiofs daemon for Windows | Phase 1 uses Plan 9; virtiofs added in Phase 4 |
| **Guest kernel needs hv_sock** | Linux kernel must have `CONFIG_HYPERV_SOCKETS` | Pre-built kernel with config enabled; Alpine already has it |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **gvproxy Windows compatibility** | gvproxy may need patches for Named Pipe support | TCP loopback as fallback; contribute patches upstream |
| **Performance gap** | WHPX may be slower than KVM/HVF for virtio | Benchmark early; optimize hot paths; virtio-pci in Phase 4 |
| **Antivirus interference** | Windows Defender may flag VM operations | Document exclusion paths; sign binaries |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Windows Job Objects** | Feature gap vs Linux namespaces | Job Objects cover core use case (resource limits, kill-on-close) |
| **Named Pipe performance** | May be slower than Unix sockets | Named Pipes have excellent performance on Windows; TCP loopback as alternative |

---

## 15. Comparison with Alternatives

### Why Not WSL2?

| Factor | libwkrun | WSL2 |
|--------|----------|------|
| Dependency | WHPX only (user-space) | Full WSL2 stack (admin install) |
| Isolation | True VM per box | Shared Linux kernel |
| Startup time | ~100ms (microVM) | ~1-5s (full distro) |
| SDK integration | Native Rust library | Process spawning + IPC |
| Portability | Works in CI, containers | Requires full WSL2 install |

### Why Not Docker Desktop?

| Factor | libwkrun | Docker Desktop |
|--------|----------|---------------|
| License | Open source | Paid for enterprise |
| Architecture | Embedded library | Daemon + CLI |
| Isolation | VM per box | Container per box (shared kernel) |
| Control | Full API control | Docker API constraints |
| Overhead | ~20MB per VM | ~2GB Docker Desktop |

### Why Not Cloud Hypervisor Directly?

Cloud Hypervisor is a **full VMM binary**, not an embeddable library:

| Factor | libwkrun | Cloud Hypervisor |
|--------|----------|-----------------|
| Form factor | Library (`.dll` / `.lib`) | Binary (`cloud-hypervisor.exe`) |
| Integration | In-process, C API | IPC to separate process |
| Size | ~5MB (minimal devices) | ~20MB (all devices) |
| API | libkrun-compatible (BoxLite drop-in) | Custom REST API |
| Scope | Only what BoxLite needs | Full VMM feature set |

However, Cloud Hypervisor is an **excellent reference implementation**. We should:
- Reuse their `hypervisor` crate for WHPX/MSHV abstraction
- Study their virtio device implementations
- Reference their MSHV integration code

---

## 16. Summary

libwkrun enables BoxLite on Windows by providing a libkrun-compatible Rust library that uses Windows Hypervisor Platform (WHPX) instead of KVM/HVF. The key architectural differences are:

1. **Thread-based VM execution** instead of process takeover
2. **Hyper-V sockets** instead of vsock
3. **Named Pipes** instead of Unix sockets
4. **Job Objects** instead of namespaces/seatbelt
5. **Plan 9 / virtiofs-over-pipe** instead of in-process virtiofs

The phased approach (4 phases) allows incremental delivery while the API-compatible design ensures BoxLite's core codebase and SDKs need minimal changes.

**Estimated scope:**
- Phase 1 (MVP): ~4,000 lines Rust
- Phase 2 (Communication): ~3,000 lines Rust + guest agent changes
- Phase 3 (Integration): ~2,000 lines in BoxLite + SDK support
- Phase 4 (Polish): ~3,000 lines optimization + CI
- **Total: ~12,000 lines of Rust code**
