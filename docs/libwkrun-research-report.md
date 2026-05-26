# libwkrun Comprehensive Research Report

> Research Date: 2026-04-07
> Scope: libkrun architecture, BoxLite integration, Cloud Hypervisor MSHV reference, libwkrun feasibility

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [libkrun Complete Architecture](#2-libkrun-complete-architecture)
3. [BoxLite's libkrun Usage Map](#3-boxlites-libkrun-usage-map)
4. [Cloud Hypervisor MSHV Reference Value](#4-cloud-hypervisor-mshv-reference-value)
5. [libwkrun Feasibility Assessment](#5-libwkrun-feasibility-assessment)
6. [Conclusions & Recommendations](#6-conclusions--recommendations)

---

## 1. Executive Summary

This report synthesizes findings from four parallel research efforts analyzing the feasibility of building **libwkrun** -- a Windows-native libkrun-compatible VMM library using WHPX (Windows Hypervisor Platform).

**Key Findings:**

| Topic | Verdict |
|-------|---------|
| libkrun architecture | Well-understood; 26 C API functions, 10 virtio devices, process-takeover model |
| BoxLite's libkrun usage | Only uses 4/10 virtio devices (blk, fs, net, vsock) + 16/26 API functions |
| Cloud Hypervisor MSHV reference | **Low reference value** -- MSHV = Linux-on-Hyper-V, not Windows native |
| libwkrun feasibility | **Feasible** -- 8-12 weeks (revised down from 11-16), 3 original blockers resolved via crosvm |

**Bottom Line:** Building libwkrun is technically feasible. The strongest reference implementation is **crosvm** (Google's VMM with production WHPX backend), not Cloud Hypervisor. The three originally-identified blockers (Linux kernel boot, filesystem sharing, host-guest IPC) all have existing Rust solutions in crosvm that can be extracted or used as dependencies. The remaining risk is primarily integration and WHPX interrupt injection quirks.

---

## 2. libkrun Complete Architecture

### 2.1 Project Overview

libkrun is a minimal, embeddable VMM from the `containers/` GitHub org. Source analyzed at: `src/deps/libkrun-sys/vendor/libkrun/`

**Key Stats:**
- **Core implementation:** `src/libkrun/src/lib.rs` (~80K lines)
- **Language:** Rust (guest init in C)
- **Platforms:** Linux (KVM) + macOS ARM64 (Hypervisor.framework)
- **Build variants:** Generic, SEV, TDX, EFI, Nitro

### 2.2 C API Surface (26+ functions)

**Full API from `include/libkrun.h`:**

| Category | Functions | Count |
|----------|-----------|-------|
| Context | `krun_create_ctx`, `krun_free_ctx` | 2 |
| Logging | `krun_init_log`, `krun_set_log_level` | 2 |
| VM Config | `krun_set_vm_config`, `krun_set_nested_virt`, `krun_split_irqchip`, `krun_get_max_vcpus` | 4 |
| Boot/Kernel | `krun_set_kernel`, `krun_set_firmware` | 2 |
| Rootfs | `krun_set_root`, `krun_set_root_disk_remount` | 2 |
| Entrypoint | `krun_set_exec`, `krun_set_env`, `krun_set_workdir` | 3 |
| Storage | `krun_add_disk`, `krun_add_disk2`, `krun_add_disk3`, `krun_add_virtiofs`, `krun_add_virtiofs2` | 5 |
| Network | `krun_add_net_unixstream`, `krun_add_net_unixgram`, `krun_add_net_tap`, `krun_set_port_map` | 4 |
| Vsock IPC | `krun_add_vsock_port`, `krun_add_vsock_port2` | 2 |
| Console | `krun_set_console_output`, `krun_add_virtio_console_*` (5 variants) | 6 |
| Resources | `krun_set_rlimits`, `krun_setuid`, `krun_setgid` | 3 |
| GPU/Sound | `krun_set_gpu_options*`, `krun_set_snd_device`, `krun_add_display`, `krun_add_input_device*` | 8 |
| Startup | `krun_start_enter` | 1 |

### 2.3 Virtio Device Implementations

All in `src/devices/src/virtio/`:

| Device | Purpose | Guest Interface |
|--------|---------|-----------------|
| **console** | Text I/O (multi-port) | /dev/hvc0, /dev/vportNpM |
| **block** | Storage (raw, qcow2, vmdk) | /dev/vda, /dev/vdb |
| **fs** | Filesystem (FUSE-based virtiofs) | mount by tag |
| **net** | Network (unixstream/dgram/tap) | eth0, eth1 |
| **vsock** | Host-guest IPC + TSI | vsock CID 3 |
| **gpu** | Graphics (virglrenderer) | display backend |
| **snd** | Audio | virtio sound |
| **input** | Keyboard/mouse/touchpad | input backend |
| **balloon** | Memory (free-page reporting) | memory pressure |
| **rng** | Random number generator | /dev/urandom |

### 2.4 Hypervisor Backends

**Linux (KVM):**
- `kvm-bindings` + `kvm-ioctls` crates
- `/dev/kvm` ioctl interface
- Flow: `KVM_CREATE_VM` -> `KVM_CREATE_VCPU` -> `KVM_RUN` loop

**macOS (Hypervisor.framework / HVF):**
- Separate `hvf` crate
- ARM64 only (Apple Silicon)
- Flow: `hv_vm_create()` -> `hv_vcpu_create()` -> `hv_vcpu_run()` loop

### 2.5 Process Takeover Model

`krun_start_enter()` is the critical function:
1. Extracts context from global CTX_MAP (consumes it)
2. Loads libkrunfw kernel (dynamically linked `libkrunfw.so.5`/`.dylib`)
3. Builds kernel command line with KRUN_INIT, KRUN_WORKDIR, etc.
4. Calls `vmm::builder::build_microvm()` to configure VM
5. Optionally drops UID/GID (setuid/setgid)
6. **Enters infinite event loop -- NEVER RETURNS**
7. Exit happens via `libc::exit()` from init when guest workload completes

**Critical Implication for libwkrun:** Windows cannot use process-takeover (no fork). Must use thread-based VM execution with `wkrun_start()` + `wkrun_wait()`.

### 2.6 Kernel Loading (libkrunfw)

- **Mechanism:** Dynamically loads `libkrunfw.so.5`/`.dylib` at runtime
- **Content:** Library contains compiled Linux kernel embedded as data
- **Function:** `krunfw_get_kernel()` returns pointer to kernel binary + load address
- **Custom kernel:** Supports TSI (Transparent Socket Impersonation) patches

### 2.7 Guest Init Process

- **Location:** `init/init.c` (static C binary, ~32KB)
- **Path inside guest:** `/init.krun`
- **Purpose:** Parse KRUN_* env vars from kernel cmdline, set up mount namespace, exec workload
- **Exit propagation:** Translates workload exit code to VM exit via `libc::exit()`

### 2.8 Event Management

- **Library:** `polly` crate (internal)
- **Linux:** `epoll` event loop
- **macOS:** `kevent` event loop
- **Threading:** Worker threads for virtiofs (FUSE I/O), GPU, TEE; main thread runs event loop

---

## 3. BoxLite's libkrun Usage Map

### 3.1 Architecture Layers

```
User Code (Python/Node/C SDK)
    |
BoxBuilder::build() --> InstanceSpec
    |
ShimController::start(InstanceSpec)
    |-- Serialize config to JSON
    |-- Spawn boxlite-shim subprocess (with Jailer isolation)
    |-- Watchdog pipe (parent death detection)
    |
    v (inside boxlite-shim subprocess)
    |
boxlite-shim::main()
    |-- Read config from stdin
    |-- GvproxyInstance::from_config(network_config)
    |-- vmm::create_engine(Libkrun) --> Krun::new()
    |-- engine.create(config) --> Krun::create()
    |   |-- KrunContext::init_logging()    --> krun_init_log()
    |   |-- KrunContext::create()          --> krun_create_ctx()
    |   |-- ctx.set_vm_config(cpus, mem)   --> krun_set_vm_config()
    |   |-- ctx.add_net_path(...)          --> krun_add_net_unixstream/dgram()
    |   |-- ctx.set_rlimits(...)           --> krun_set_rlimits()
    |   |-- ctx.add_virtiofs(tag, path) x3 --> krun_add_virtiofs()
    |   |-- ctx.add_disk_with_format(...)  --> krun_add_disk2()
    |   |-- ctx.set_root[_disk_remount]()  --> krun_set_root/krun_set_root_disk_remount()
    |   |-- ctx.set_workdir("/boxlite")    --> krun_set_workdir()
    |   |-- ctx.set_exec(guest_agent,...)  --> krun_set_exec()
    |   |-- ctx.add_vsock_port(2695,...)   --> krun_add_vsock_port2() (gRPC)
    |   |-- ctx.add_vsock_port(2696,...)   --> krun_add_vsock_port2() (ready)
    |   |-- ctx.set_console_output(...)    --> krun_set_console_output()
    |   '-- Return VmmInstance
    |
    '-- instance.enter() --> krun_start_enter()
        === PROCESS TAKEOVER ===
```

### 3.2 FFI Functions Actually Used by BoxLite

**ESSENTIAL (required for every Box):**

| Function | Purpose | Called From |
|----------|---------|-------------|
| `krun_create_ctx()` | Create VM context | `KrunContext::create()` |
| `krun_free_ctx()` | Release context | `Drop for KrunContext` |
| `krun_init_log()` | Initialize logging | `KrunContext::init_logging()` |
| `krun_set_vm_config()` | CPU/RAM config | `Krun::create()` |
| `krun_set_exec()` | Guest entrypoint | `Krun::set_entrypoint()` |
| `krun_add_virtiofs()` | Filesystem shares (x3) | `Krun::create()` - rootfs, layers, shared |
| `krun_set_root()` or `krun_set_root_disk_remount()` | Boot rootfs | `Krun::create()` |
| `krun_add_vsock_port2()` | gRPC bridge (port 2695) | `Krun::create()` |
| `krun_add_vsock_port2()` | Ready notification (port 2696) | `Krun::create()` |
| `krun_set_workdir()` | Working directory (/boxlite) | `Krun::create()` |
| `krun_start_enter()` | Start VM | `KrunVmmInstance::enter()` |

**HIGHLY RECOMMENDED:**

| Function | Purpose | Called From |
|----------|---------|-------------|
| `krun_add_disk2()` | Attach disk images | `Krun::create()` - qcow2/raw |
| `krun_set_rlimits()` | Guest resource limits | `Krun::create()` |
| `krun_set_console_output()` | Console redirection | `Krun::create()` (if configured) |

**CONDITIONALLY USED:**

| Function | Purpose | Condition |
|----------|---------|-----------|
| `krun_add_net_unixstream()` | Stream socket net | gvproxy on Linux |
| `krun_add_net_unixgram()` | Datagram socket net | gvproxy on macOS |
| `krun_add_net_fd()` (via unixstream) | Dead socket trick | `disable_network = true` |

**NOT USED by BoxLite:**

| Function | Notes |
|----------|-------|
| `krun_set_kernel()` | Uses libkrunfw embedded kernel |
| `krun_set_firmware()` | No EFI mode |
| `krun_set_gpu_options*()` | No GPU passthrough |
| `krun_set_snd_device()` | No audio |
| `krun_add_input_device*()` | No input devices |
| `krun_add_net_tap()` | No TAP networking |
| `krun_set_port_map()` | No TSI port mapping |
| `krun_set_nested_virt()` | No nested virt |
| `krun_split_irqchip()` | No split IRQ |
| `krun_set_smbios_oem_strings()` | No SMBIOS customization |

### 3.3 Virtio Devices Required by BoxLite

| Device | Required | Usage |
|--------|----------|-------|
| **virtio-fs** | YES | Rootfs, layers, shared directories (3 mounts) |
| **virtio-blk** | YES | Persistent disk images (qcow2 for snapshots, raw for scratch) |
| **virtio-vsock** | YES | gRPC host-guest communication (port 2695 + 2696) |
| **virtio-net** | YES (conditional) | Networking via gvproxy (unixstream/dgram backend) |
| **virtio-console** | Optional | Console output redirection (debugging) |
| gpu, snd, input, balloon, rng | NO | Not used |

### 3.4 Key Constants

```
GUEST_AGENT_PORT = 2695    // gRPC (guest listens, host connects via vsock bridge)
GUEST_READY_PORT = 2696    // Ready notification (host listens, guest connects)
GUEST_MAC = [0x02, 0x00, 0x00, 0x00, 0x00, 0x01]  // Network MAC address
```

### 3.5 URI Transformation (Engine-Specific)

BoxLite passes Unix socket URIs to the guest entrypoint. The Krun engine transforms them:
```
--listen unix:///path/to/grpc.sock  -->  --listen vsock://2695
--notify unix:///path/to/ready.sock -->  --notify vsock://2696
```
libwkrun would transform to Hyper-V socket URIs instead.

---

## 4. Cloud Hypervisor MSHV Reference Value

### 4.1 What MSHV Actually Is

**MSHV (Microsoft Hypervisor)** = Linux kernel module (`/dev/mshv`) that provides ioctl-based access to the Microsoft Hypervisor **when Linux runs as the Hyper-V Root Partition**.

- It is **NOT** a Windows-native API
- It is **NOT** usable on a standard Windows installation
- It only works on Linux running on bare-metal Hyper-V (server/cloud scenarios)

### 4.2 Cloud Hypervisor's Hypervisor Abstraction

Cloud Hypervisor uses a **trait-based abstraction** layer:

```rust
// hypervisor/src/hypervisor.rs
trait Hypervisor {
    fn create_vm(&self, config: HypervisorVmConfig) -> Result<Arc<dyn Vm>>;
    fn check_required_extensions(&self) -> Result<()>;
    fn get_max_vcpus(&self) -> u32;
    // ...
}

// hypervisor/src/vm.rs
trait Vm {
    fn create_user_memory_region(&self, ...);
    fn create_vcpu(&self, ...) -> Result<Arc<dyn Vcpu>>;
    fn register_irqfd(&self, ...);
    // ...
}

// hypervisor/src/cpu.rs
trait Vcpu {
    fn run(&mut self) -> Result<VmExit>;
    fn state(&self) -> Result<CpuState>;
    fn set_state(&self, state: &CpuState) -> Result<()>;
    // ...60+ methods
}
```

With **enum-based dispatch** for backend-specific types:
```rust
enum CpuState {
    Kvm(kvm::VcpuKvmState),
    Mshv(mshv::VcpuMshvState),
}
```

### 4.3 MSHV API (rust-vmm/mshv crate)

The `mshv` crate provides:
- `Mshv::new()` -- open `/dev/mshv`
- `MshvVm` -- VM file descriptor (similar to KVM VM fd)
- `VcpuFd` -- vCPU file descriptor
- Memory operations: `map_user_memory()`, `unmap_user_memory()`
- Register access: `get_regs()`, `set_regs()`, `get_sregs()`, etc.
- vCPU execution: `run()` returning exit reason

**API comparison to KVM:** Nearly identical structure -- `VmFd` ~ KVM VM fd, `VcpuFd` ~ KVM vCPU fd. Main difference: MSHV uses hypercalls alongside ioctls.

### 4.4 Reference Value Assessment

| Aspect | Reference Value | Why |
|--------|----------------|-----|
| Trait-based hypervisor abstraction | **HIGH** | The `Hypervisor/Vm/Vcpu` trait pattern is directly applicable to libwkrun |
| MSHV API as template for WHPX | **LOW** | MSHV uses Linux ioctls; WHPX uses Win32 API -- fundamentally different |
| Virtio device implementations | **MEDIUM** | CH's virtio devices are platform-independent but coupled to CH's architecture |
| rust-vmm ecosystem crates | **MEDIUM** | `vm-memory` has Windows support (winapi dep); `virtio-queue` is platform-agnostic |
| CH process model | **LOW** | CH is a standalone binary, not an embeddable library |

### 4.5 Better References Than Cloud Hypervisor

| Project | Why Better | Reference Value |
|---------|------------|-----------------|
| **crosvm** (Google) | **Production WHPX backend**, builds on Windows, Rust | **VERY HIGH** |
| **OpenVMM** (Microsoft) | Multi-backend (KVM/MSHV/WHPX/HVF), Rust, open-source | **HIGH** |
| **libwhp** (Rust crate) | Safe Rust WHPX bindings with examples | **HIGH** |
| **QEMU** | Proves Linux boots on WHPX, reference for boot setup | **HIGH** |
| **libkrun** itself | API to match, architecture to mirror | **ESSENTIAL** |

### 4.6 rust-vmm Crates Windows Support

| Crate | Windows Support | Notes |
|-------|----------------|-------|
| `vm-memory` | **YES** | Has `winapi` dependency for `backend-mmap` |
| `virtio-queue` | **YES** (platform-agnostic) | No OS-specific code in queue logic |
| `virtio-bindings` | **YES** (pure data) | Just constant definitions |
| `linux-loader` | **NO** | Assumes KVM/HVF, not WHPX |
| `kvm-ioctls` | **NO** | Linux KVM only |
| `mshv` | **NO** | Linux MSHV only |

### 4.7 Hyper-V Sockets (AF_HYPERV) -- vsock Replacement

| Feature | AF_VSOCK (Linux) | AF_HYPERV (Windows) |
|---------|------------------|---------------------|
| Addressing | CID (32-bit) + Port (32-bit) | VMID (GUID) + ServiceID (GUID) |
| Registration | Not required | Service must be registered in Windows registry |
| Stream sockets | YES | YES |
| Datagram | YES (limited) | NO (data stream only) |
| Linux guest support | Native | Via CONFIG_HYPERV_VSOCKETS (kernel 4.14+) |
| Port-to-GUID mapping | N/A | `{port-hex}-FACB-11E6-BD58-64006A7986D3` |

**Translation layer design:** libwkrun exposes vsock-like API, internally translates port numbers to Hyper-V socket GUIDs.

---

## 5. libwkrun Feasibility Assessment

### 5.1 Component-by-Component Rating

| # | Component | Rating | Existing Reference | Effort |
|---|-----------|--------|-------------------|--------|
| 1 | WHPX hypervisor backend | **FEASIBLE** | libwhp, crosvm WHPX (`hypervisor/src/whpx/`), windows crate | 1 week |
| 2 | Linux kernel boot on WHPX | ~~CHALLENGING~~ **FEASIBLE** | crosvm `x86_64/src/regs.rs` — hypervisor-agnostic boot code (page tables, GDT, boot params) | **1-2 weeks** |
| 3 | virtio-blk (block devices) | **FEASIBLE** | rust-vmm `virtio-queue` (platform-agnostic), `qcow2-rs` (Windows support), crosvm `devices/src/virtio/block/`, Tokio abstracts IOCP for async file I/O | 1-2 weeks |
| 4 | virtiofs / 9P (filesystem sharing) | ~~CHALLENGING~~ **FEASIBLE** | crosvm `common/p9/` — production 9P2000.L server (ChromeOS), 28 message types | **~1 week** |
| 5 | Host-guest IPC (vsock) | ~~CHALLENGING~~ **FEASIBLE** | crosvm userspace virtio-vsock on Windows (`devices/src/virtio/vsock/`), avoids AF_HYPERV entirely | **~1 week** |
| 6 | virtio-net (networking) | **FEASIBLE** | gvproxy builds on Windows, WinTUN | < 1 week |
| 7 | Guest agent communication | **FEASIBLE** | Standard AF_VSOCK in guest (via virtio-vsock) | < 1 week |
| 8 | Windows sandbox (Job Objects) | **FEASIBLE** | win32job crate, windows crate | 1 week |
| 9 | Process monitoring | **FEASIBLE** | Tokio handles transparently | < 1 day |
| 10 | Event loop (IOCP) | **FEASIBLE** | Tokio abstracts IOCP | 2-3 weeks |

> **Note:** All 10 components are now rated **FEASIBLE**. Items 2, 4, 5 were upgraded after crosvm research revealed existing Rust solutions. Item 3 (virtio-blk) was also corrected — `virtio-queue`, `qcow2-rs`, and Tokio's IOCP abstraction provide a complete solution path.

### 5.2 Major Blockers (Detailed)

#### ~~Blocker 1~~ Resolved: Linux Kernel Boot Setup on WHPX

**Original problem:** No existing Rust implementation boots a Linux kernel on WHPX from scratch.

**Resolution:** crosvm's `x86_64` crate contains hypervisor-agnostic boot code that works through abstract `Vm`/`Vcpu` traits:

- **`setup_page_tables()`** — Creates PML4 at `0x9000`, PDPTE at `0xa000`, PDE at `0xb000`; identity-maps lower 4GB using 2MB pages
- **`configure_segments_and_sregs()`** — Sets up GDT with code segment (`0xa09b`), data segment (`0xc093`), TSS segment (`0x808b`); configures CR0 (paging + protected mode), CR4 (PAE), EFER (long mode enable)
- **`configure_boot_params()`** — Fills Linux zero page at `0x7000` with kernel boot magic, command line pointer, initrd address/size, E820 memory map

This boot code is **not KVM-specific** — it operates through the `Hypervisor`/`Vm`/`Vcpu` trait interface, which crosvm also implements for WHPX (`hypervisor/src/whpx/`).

**Remaining work:** Adapt crosvm's boot code to libwkrun's architecture, verify with Alpine kernel on WHPX.

**Revised risk:** MEDIUM (down from HIGH) -- adaptation task, not from-scratch development. Estimated **1-2 weeks** (down from 3-4).

#### Blocker 2: WHPX Interrupt Injection

**Problem:** Known MSI/MSI-X injection issues in WHPX.

**Evidence:** QEMU GitHub issues report `"whpx: injection failed, MSI...lost (c0350005)"`. Workaround: `kernel-irqchip=off` (has performance impact).

**Impact:** Affects all virtio devices (they rely on MSI-X for notification).

**Risk:** MEDIUM -- workaround exists but may impact performance.

#### ~~Blocker 3~~ Resolved: virtiofs Replacement

**Original problem:** virtiofsd is Linux-specific (uses FUSE kernel interface, Linux mount namespaces). No Windows equivalent exists.

**Resolution:** crosvm includes a complete **9P2000.L server** at `common/p9/`:

- **28 message types:** Walk, Attach, Clunk, Read, Write, Lopen, Lcreate, Fsync, Readdir, Mkdir, RenameAt, UnlinkAt, GetAttr, SetAttr, Statfs, Symlink, Readlink, Link, XattrWalk, XattrCreate, Mknod, Lock, GetLock, Remove, Rename, Version, Flush, Auth
- **Production-tested:** Used in ChromeOS Crostini for host-guest file sharing for years
- **Transport-agnostic:** `p9::Server` struct processes 9P messages regardless of transport
- **Config options:** root path, msize (message size), uid_map, gid_map, ascii_casefold
- **Integration:** Already wired as virtio-9p device in crosvm (`devices/src/virtio/p9.rs`)
- **Standalone binary:** `9s` binary serves 9P over vsock, could run independently

**Remaining work:** Use `p9` crate as git dependency, wire to virtio-9p device frontend, test with Alpine Linux guest (`mount -t 9p`).

**Revised risk:** LOW (down from MEDIUM) -- proven crate, integration only. Estimated **~1 week** (down from 2-3).

### 5.3 What's Feasible vs What's Blocked

#### Clear Path / Proven Solutions

| Component | Solution | Evidence |
|-----------|----------|----------|
| WHPX API bindings | `libwhp` or `windows` crate | Production-ready Rust crates |
| qcow2 disk images | `qcow2-rs` crate | Explicitly supports Windows |
| Networking | gvproxy on Windows | Builds cross-platform (Makefile targets) |
| TUN adapter | WinTUN | Rust `wintun` crate available |
| Job Objects | `win32job` crate | Mature, safe API |
| Process monitoring | Tokio `process::Child` | Uses `RegisterWaitForSingleObject` on Windows |
| Async event loop | Tokio on IOCP | Transparent Windows support |
| virtio-queue logic | rust-vmm `virtio-queue` | Platform-agnostic Rust crate |
| Guest memory | rust-vmm `vm-memory` | Has `winapi` backend for Windows |

#### Uncertain / Requires Investigation

| Component | Uncertainty | Investigation Needed |
|-----------|-------------|---------------------|
| Alpine kernel CONFIG_HYPERV_VSOCKETS | Unknown if `linux-virt` kernel has it enabled | Check kernel config, possibly rebuild |
| WHPX on ARM64 Windows | Support exists but less tested | Test on Windows ARM64 device |
| Kernel command line injection | Different from KVM mechanism | Study QEMU's WHPX implementation |

#### Previously "No Known Rust Solution" -- Now Resolved via crosvm

> **Update (2026-04-07):** Further research into crosvm's Windows/WHPX support revealed that 3 of the 4 items originally listed as "no known Rust solution" are already solved in crosvm. The 4th (AF_HYPERV) can be avoided entirely.

| Component | Old Status | New Status | crosvm Solution | Revised Effort |
|-----------|-----------|------------|-----------------|----------------|
| Linux boot on WHPX | No solution | **SOLVED** | `x86_64/src/regs.rs` — hypervisor-agnostic boot code: `setup_page_tables()`, `configure_segments_and_sregs()`, `configure_boot_params()`. Creates PML4→PDPT→PD page tables, identity-maps lower 4GB with 2MB pages, sets CR0/CR3/CR4/EFER, builds GDT (code/data/TSS segments), fills Linux zero page at `0x7000` with E820 map. Works through abstract `Vm`/`Vcpu` traits — applies to WHPX backend. | **1-2 weeks** (adaptation + testing, down from 3-4) |
| 9P filesystem server | No solution | **SOLVED** | `common/p9/` crate — complete 9P2000.L server in pure Rust, 28 message types (Walk, Read, Write, Readdir, GetAttr, SetAttr, Mkdir, Symlink, etc.). **Production-tested in ChromeOS Crostini** for years. Transport-agnostic `Server` struct. Can be used as git dependency. | **~1 week** (integration + virtio-9p wiring, down from 2-3) |
| AF_HYPERV Rust bindings | No solution | **AVOIDABLE** | crosvm implements **userspace virtio-vsock** on Windows (`devices/src/virtio/vsock/`) — guest sees standard AF_VSOCK, host uses crosvm internal IPC (tubes/named pipes). BoxLite's guest agent already uses AF_VSOCK, so native AF_HYPERV is unnecessary. | **~1 week** (adapt crosvm's vsock approach, down from 1-2) |
| libwkrun C API | No solution | **Patterns available** | crosvm uses thread-based VM execution: VCPU threads with `mpsc::Sender<VcpuControl>` channels, `WaitContext` cross-platform event loop (epoll/`WaitForMultipleObjects`). Not a library API, but proven patterns. | **1-2 weeks** (unchanged, but lower risk) |

**Impact on timeline:** Total "new development" effort drops from **7-11 weeks → 4-6 weeks**. The two hardest blockers (kernel boot + filesystem sharing) are now adaptation tasks rather than from-scratch development.

#### crosvm Components Reuse Map

| crosvm Component | Location | Reusability for libwkrun |
|-----------------|----------|--------------------------|
| x86_64 boot code | `x86_64/src/regs.rs`, `x86_64/src/lib.rs` | **Extract directly** — pure Rust, hypervisor-agnostic |
| WHPX FFI bindings | `hypervisor/src/whpx/whpx_sys/` | **Reuse** — raw Windows Hypervisor Platform bindings |
| WHPX backend | `hypervisor/src/whpx/vm.rs`, `vcpu.rs` | **Reference** — `WhpxVm`/`WhpxVcpu` impl of `Vm`/`Vcpu` traits |
| 9P server | `common/p9/` | **Use as dependency** — standalone crate, production quality |
| virtio-9p device | `devices/src/virtio/p9.rs` | **Reference** — wraps `p9::Server` as virtio device |
| virtio-vsock (Windows) | `devices/src/virtio/vsock/` | **Reference** — userspace vsock, only implemented for Windows |
| Memory layout | [crosvm.dev/book/appendix/memory_layout.html](https://crosvm.dev/book/appendix/memory_layout.html) | **Reference** — zero page at 0x7000, kernel at 0x200000, page tables at 0x9000-0xF000 |

> **Note:** crosvm's WHPX support is listed as "not tested upstream" (maintainer: `vnagarnaik@google.com`). Users have reported UEFI boot issues on WHPX and problems on Windows 11. However, the hypervisor-agnostic boot code and the `p9` crate are production-quality regardless of the WHPX backend's maturity.

### 5.4 API Design Differences

libkrun's process-takeover model doesn't work on Windows. libwkrun must use a thread-based approach:

```c
// libkrun (current) - Process takeover, never returns
int krun_start_enter(uint32_t ctx_id);

// libwkrun (proposed) - Thread-based, returns immediately
int wkrun_start(uint32_t ctx_id);     // Spawns VM thread, returns immediately
int wkrun_wait(uint32_t ctx_id);      // Blocks until VM exits
int wkrun_stop(uint32_t ctx_id);      // Force-stop VM
```

BoxLite's shim process already runs in a subprocess, so this change is transparent to the main process. The shim just calls `wkrun_start()` + `wkrun_wait()` instead of `krun_start_enter()`.

### 5.5 Estimated Timeline

#### Revised (with crosvm reference)

| Phase | Description | Duration | Key crosvm Inputs |
|-------|-------------|----------|-------------------|
| **Phase 1: PoC** | WHPX VM creation + Linux kernel boot + console output | **2-3 weeks** | `x86_64/src/regs.rs` boot code, `hypervisor/src/whpx/` backend |
| **Phase 2: Virtio** | virtio-blk, virtio-net, 9P filesystem server | **2-3 weeks** | `common/p9/` crate (use as dep), `devices/src/virtio/p9.rs` |
| **Phase 3: Integration** | virtio-vsock, guest agent, Job Objects, shim adaptation | **2-3 weeks** | `devices/src/virtio/vsock/` (userspace Windows impl) |
| **Phase 4: Testing** | Alpine boot, SDK tests, performance, hardening | **2-3 weeks** | — |
| **Total** | | **8-12 weeks** | |

#### Original (before crosvm research)

| Phase | Description | Duration |
|-------|-------------|----------|
| Phase 1: PoC | WHPX VM creation + Linux kernel boot + console output | 4-6 weeks |
| Phase 2: Virtio | virtio-blk, virtio-net, 9P filesystem server | 3-4 weeks |
| Phase 3: Integration | AF_HYPERV, guest agent, Job Objects, shim adaptation | 2-3 weeks |
| Phase 4: Testing | Alpine boot, SDK tests, performance, hardening | 2-3 weeks |
| Total | | 11-16 weeks |

**Savings:** ~3-4 weeks saved by leveraging crosvm's boot code, 9P server, and userspace vsock.

---

## 6. Conclusions & Recommendations

### 6.1 Key Insights

1. **BoxLite's libkrun usage is narrow.** Only 16/26 API functions and 4/10 virtio devices. This dramatically reduces libwkrun's scope.

2. **Cloud Hypervisor's MSHV support has LOW reference value** for libwkrun. MSHV is a Linux kernel driver for Hyper-V root partitions -- completely different from WHPX (Win32 API for Windows applications).

3. **crosvm is the strongest reference.** Google's VMM has a production WHPX backend in Rust, proving the approach works. Critical crosvm assets:
   - **`x86_64/src/regs.rs`** — Hypervisor-agnostic Linux boot code (page tables, GDT, boot params)
   - **`common/p9/`** — Production 9P2000.L server (28 message types, ChromeOS Crostini proven)
   - **`devices/src/virtio/vsock/`** — Userspace virtio-vsock for Windows (eliminates AF_HYPERV need)
   - **`hypervisor/src/whpx/`** — WHPX backend with FFI bindings

4. **The three original blockers are all resolved in crosvm:**
   - Linux kernel boot on WHPX → crosvm's hypervisor-agnostic boot code
   - virtiofs replacement → crosvm's `p9` crate (production 9P server)
   - AF_HYPERV bindings → avoidable via crosvm's userspace virtio-vsock approach

5. **OpenVMM (Microsoft) is a secondary reference** worth monitoring. It's a Rust VMM that abstracts KVM/MSHV/WHPX/HVF behind unified traits, powering 1.5M+ Azure VMs.

### 6.2 Recommended Approach

**Option A: Build libwkrun with crosvm components (2-3 months)** ← RECOMMENDED
- Extract/depend on crosvm's `p9` crate, adapt boot code and WHPX FFI bindings
- Build libkrun-compatible C API with thread-based lifecycle
- Risk: LOW — key blockers resolved, mainly integration work

**Option B: Fork crosvm's full WHPX stack (1-2 months)**
- Wrap crosvm's complete WHPX VMM as a library
- Fastest path to working prototype
- Risk: MEDIUM — crosvm dependency management, not designed as embeddable library

**Option C: QEMU as subprocess (2-3 weeks, fallback)**
- Use QEMU with `-accel whpx` as VM backend
- Similar to current boxlite-shim pattern
- Risk: LOW but heavyweight (QEMU binary dependency, less embeddable)

### 6.3 Recommended Strategy

**Option A: Build libwkrun with crosvm components as primary references:**

1. **Week 1-2:** WHPX backend — adapt crosvm's `hypervisor/src/whpx/` bindings. Create/destroy VM, map memory, run vCPU.
2. **Week 3-4:** Linux kernel boot — adapt crosvm's `x86_64/src/regs.rs` boot code (page tables, GDT, boot params). Get Alpine kernel to serial console on WHPX.
3. **Week 5-6:** Virtio devices — virtio-blk (simplest), then virtio-net via gvproxy.
4. **Week 7-8:** File sharing + IPC — integrate crosvm's `p9` crate as git dependency, adapt crosvm's userspace virtio-vsock for host-guest communication.
5. **Week 9-10:** BoxLite integration — shim adaptation (`wkrun_start/wait`), Job Objects jailer.
6. **Week 11-12:** Testing and hardening — Alpine boot, SDK tests, performance.

**Decision Gate at Week 4:** If Linux boot on WHPX is not working, fall back to Option B (full crosvm fork).

### 6.4 ~~Remaining Risk~~ Resolved: WHPX Interrupt Injection

**Original concern:** QEMU reports `"whpx: injection failed, MSI...lost (c0350005)"` — error `ERROR_HV_INVALID_PARAMETER` from `WHvRequestInterrupt()`, mainly during early boot when firmware writes uninitialized MSI table values (vector=0).

**Resolution:** crosvm has solved this in production (Google Play Games, millions of Windows PCs):

1. **`WhpxSplitIrqChip`** — IOAPIC emulated in userspace, LAPIC managed by WHPX
2. **Proper APIC configuration** — Sets `LocalApicEmulationMode = XApic` at partition creation
3. **Parameter validation** — Never sends invalid interrupt parameters (vector 0, etc.)

**For libwkrun:** Follow crosvm's `WhpxSplitIrqChip` pattern (`devices/src/irqchip/whpx.rs`). Retain full userspace irqchip as fallback for older Windows versions.

**Risk level: LOW** (proven solution exists, adaptation only)

### 6.5 Prerequisites Before Starting

1. Windows 10/11 dev machine with WHPX enabled
2. Rust toolchain on Windows (`x86_64-pc-windows-msvc`)
3. crosvm source code cloned (`git clone https://chromium.googlesource.com/chromiumos/platform/crosvm`)
4. QEMU installed for comparison testing
5. Alpine Linux kernel binary for boot testing
