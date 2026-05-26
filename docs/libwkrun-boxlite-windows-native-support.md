# libwkrun & BoxLite Windows Native Support

> Comprehensive overview of the libwkrun project and BoxLite's Windows native integration.
> Last updated: 2026-04-13

---

## Table of Contents

1. [Why libwkrun](#1-why-libwkrun)
2. [libwkrun Design](#2-libwkrun-design)
3. [BoxLite Integrates libwkrun](#3-boxlite-integrates-libwkrun)
4. [Overall Status](#4-overall-status)

---

## 1. Why libwkrun

### 1.1 The Problem

BoxLite is an embeddable VM runtime — "SQLite for sandboxing." It provides hardware-level
VM isolation for running untrusted code safely. The core engine is **libkrun**, which
supports Linux (KVM) and macOS (Hypervisor.framework).

**Windows is missing.** BoxLite's current Windows story is WSL2-based — it works, but
requires a full WSL2 installation with admin privileges, has slower startup times (1-5s
vs ~100ms for a microVM), and provides only shared-kernel container isolation rather than
true VM isolation. For AI agent sandboxing — BoxLite's primary use case — native Windows
support is essential since many enterprise environments run Windows.

### 1.2 Why Not Just Use Existing Solutions?

We evaluated four alternatives before deciding to build libwkrun:

| Alternative | Why Not |
|-------------|---------|
| **WSL2** | Requires admin install, shared Linux kernel (not per-box VM isolation), 1-5s startup, not embeddable as a library |
| **Docker Desktop** | Paid enterprise license, daemon architecture (not embeddable), container isolation only, ~2GB overhead |
| **Cloud Hypervisor** | Full VMM binary (not a library), **does NOT support Windows as host OS** — its MSHV backend only works on Linux running as Hyper-V root partition, never been built on Windows, 23 crates with deep Linux assumptions (epoll, signals, mmap, Unix sockets) |
| **QEMU** | Heavyweight process dependency (~100MB), custom REST API (not embeddable), high startup overhead |

### 1.3 The Key Insight

BoxLite only uses a **narrow slice** of libkrun's capabilities:

- **16 of 26** C API functions (no GPU, audio, input, TAP networking, or advanced features)
- **4 of 10** virtio devices (blk, fs, net, vsock — no GPU, sound, balloon, RNG, input, console)
- **virtio-mmio** transport (simplest, sufficient for <8 devices)

This means a Windows-native VMM library doesn't need to be a full hypervisor — it just
needs the specific capabilities that BoxLite requires. This dramatically reduces scope.

### 1.4 The Decision: Build libwkrun

**libwkrun** (Windows Krun) is a new Rust library that provides libkrun-compatible APIs
backed by Windows Hypervisor Platform (WHPX). The name mirrors libkrun — "krun" for KVM
runtime, "wkrun" for Windows KVM-like runtime.

Core value proposition:

```
libkrun (Linux/macOS)  +  libwkrun (Windows)  =  BoxLite runs everywhere
     ↓                          ↓
  KVM / HVF                   WHPX
  Process takeover             Thread-based VM
  vsock + Unix sockets         virtio-vsock + TCP/Named Pipes
  virtiofs (in-process)        9P filesystem (in-process)
```

The two libraries form a symmetric pair: same logical API, different platform backends.
BoxLite's core runtime, SDK APIs, gRPC protocol, and OCI image management remain
completely unchanged.

### 1.5 Why Not Cloud Hypervisor?

Cloud Hypervisor deserves special discussion because it's the most prominent Rust-based
VMM project. However, it was **not a viable candidate** for BoxLite's Windows native
support:

**Cloud Hypervisor's MSHV backend is NOT Windows native.** MSHV (Microsoft Hypervisor)
is a Linux kernel module (`/dev/mshv`) that provides ioctl-based access to the Microsoft
Hypervisor **when Linux runs as the Hyper-V Type-1 root partition** — a server/cloud
scenario. It is fundamentally different from WHPX (Windows Hypervisor Platform), which
is a user-space Win32 API for running VMs from Windows applications. Cloud Hypervisor
has never been built on Windows, has no WHPX backend, and its 23 crates contain deep
Linux assumptions (epoll, signals, mmap, Unix sockets) that would require 10,000+ lines
of changes to port.

```
Cloud Hypervisor + MSHV:              libwkrun + WHPX:
┌────────────────────────────┐       ┌────────────────────────────┐
│ Linux (root partition)     │       │ Windows 10/11              │
│   Cloud Hypervisor         │       │   BoxLite + libwkrun       │
│     /dev/mshv ioctl        │       │     WHP user-space API     │
├────────────────────────────┤       ├────────────────────────────┤
│ MSHV kernel driver         │       │ WHP (Windows Hypervisor    │
│ (Linux kernel module)      │       │      Platform)             │
├────────────────────────────┤       ├────────────────────────────┤
│ Type-1 Hyper-V             │       │ Microsoft Hypervisor       │
│ (bare-metal hypervisor)    │       │ (enabled via Windows       │
│                            │       │  optional feature)         │
├────────────────────────────┤       ├────────────────────────────┤
│ Hardware                   │       │ Hardware                   │
└────────────────────────────┘       └────────────────────────────┘
  ↑ Linux as Hyper-V root partition    ↑ Windows as host OS
  ↑ Server/cloud scenario              ↑ Desktop/laptop/CI
```

That said, Cloud Hypervisor was valuable as a **design reference** — its `Hypervisor/Vm/Vcpu`
trait abstraction pattern influenced libwkrun's architecture. The actual implementation
reference came from **crosvm** (Google), which has a production WHPX backend, and from
**OpenVMM** (Microsoft), which validates WHPX as a viable production hypervisor interface.

### 1.6 Approach Comparison

Given Cloud Hypervisor's unsuitability, the real decision was between building a focused
library (libwkrun) versus wrapping an existing VMM as an external process (QEMU with
`-accel whpx`):

| Dimension | libwkrun (embedded library) | QEMU subprocess |
|-----------|---------------------------|-----------------|
| Architecture fit | Drop-in replacement for libkrun — same embedded model | External process + IPC — different model, new integration layer |
| Startup latency | ~100ms (in-process) | ~300ms+ (process spawn + device init) |
| Binary size | ~5MB (.dll) | ~100MB (qemu-system-x86_64.exe + firmware) |
| Dependency | WHPX only (user-space, no install) | QEMU binary must be distributed |
| API consistency | Same API as libkrun on macOS/Linux | Different API, needs translation layer |
| Maintainability | Self-owned Rust code, minimal scope | QEMU version tracking, compatibility testing |
| Risk | Higher initial effort (new code) | Lower initial effort, ongoing integration burden |

**Result:** libwkrun was chosen for its architectural symmetry with libkrun, minimal
dependency footprint, and long-term maintainability.

---

## 2. libwkrun Design

### 2.1 Reference Projects

libwkrun was designed by studying and selectively borrowing from these projects:

| Project | What We Learned | What We Used |
|---------|----------------|--------------|
| **libkrun** | API surface design, process model, virtio device set, guest agent protocol | API function signatures (26 functions), rlimits/console/logging patterns |
| **crosvm** (Google) | Production WHPX backend in Rust, hypervisor-agnostic boot code, 9P filesystem server, userspace virtio-vsock | x86_64 boot setup (page tables, GDT, boot params), `common/p9/` crate design (28 message types), virtio-vsock connection model |
| **Cloud Hypervisor** | Hypervisor abstraction traits (`Hypervisor/Vm/Vcpu`), MSHV integration patterns | Trait-based hypervisor abstraction design (adapted, not directly used) |
| **OpenVMM** (Microsoft) | Multi-backend hypervisor architecture (KVM/MSHV/WHPX/HVF) | Validation that WHPX is a viable production backend (powers 1.5M+ Azure VMs) |
| **QEMU** | Proof that Linux boots on WHPX, interrupt injection workarounds | WHPX boot register setup reference, MSI injection error handling patterns |

### 2.2 Architecture

```
┌────────────────────────────────────────────────────┐
│                   libwkrun                          │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │              Public API (lib.rs)               │ │
│  │  create_ctx, set_vm_config, set_kernel,       │ │
│  │  add_disk, add_virtiofs, add_vsock_port,      │ │
│  │  add_net, start, stop, wait, start_enter, ... │ │
│  └───────────────────┬───────────────────────────┘ │
│                      │                              │
│  ┌───────────────────▼───────────────────────────┐ │
│  │           VMM Layer (vmm/)                     │ │
│  │  ┌──────────┐  ┌─────────┐  ┌──────────────┐ │ │
│  │  │ context  │  │ runner  │  │    vcpu      │ │ │
│  │  │ (config  │  │ (VM     │  │  (vCPU loop, │ │ │
│  │  │  state   │  │  life-  │  │   exit       │ │ │
│  │  │  machine)│  │  cycle) │  │   handling)  │ │ │
│  │  └──────────┘  └─────────┘  └──────────────┘ │ │
│  │  ┌──────────┐  ┌─────────┐  ┌──────────────┐ │ │
│  │  │ memory   │  │ devices │  │    insn      │ │ │
│  │  │ (guest   │  │ (device │  │ (x86 insn    │ │ │
│  │  │  RAM)    │  │  setup) │  │  decoder)    │ │ │
│  │  └──────────┘  └─────────┘  └──────────────┘ │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │         Device Layer (devices/)                │ │
│  │  ┌──────┐  ┌──────┐  ┌─────────────────────┐ │ │
│  │  │ PIC  │  │ PIT  │  │      Serial         │ │ │
│  │  │(8259)│  │(8254)│  │     (8250 UART)     │ │ │
│  │  └──────┘  └──────┘  └─────────────────────┘ │ │
│  │  ┌─────────────────────────────────────────┐  │ │
│  │  │         Virtio Devices (MMIO transport)  │  │ │
│  │  │  ┌─────────┐  ┌──────────┐  ┌────────┐ │  │ │
│  │  │  │  block  │  │   9p     │  │  net   │ │  │ │
│  │  │  │ (raw +  │  │(9P2000.L │  │(TCP +  │ │  │ │
│  │  │  │  qcow2) │  │ server)  │  │ Unix)  │ │  │ │
│  │  │  └─────────┘  └──────────┘  └────────┘ │  │ │
│  │  │  ┌─────────┐  ┌──────────┐             │  │ │
│  │  │  │  vsock  │  │  queue   │             │  │ │
│  │  │  │(host TCP│  │ (virtio  │             │  │ │
│  │  │  │↔ guest) │  │  vring)  │             │  │ │
│  │  │  └─────────┘  └──────────┘             │  │ │
│  │  └─────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │        Boot Layer (boot/)                      │ │
│  │  ┌──────────┐  ┌─────────┐  ┌──────────────┐ │ │
│  │  │ loader   │  │ params  │  │    setup     │ │ │
│  │  │ (bzImage │  │ (Linux  │  │  (GDT, page  │ │ │
│  │  │  + init  │  │  boot   │  │   tables,    │ │ │
│  │  │  ramfs)  │  │  proto) │  │   registers) │ │ │
│  │  └──────────┘  └─────────┘  └──────────────┘ │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │     WHPX Backend (vmm/whpx.rs)                │ │
│  │  WHvCreatePartition, WHvCreateVirtualProcessor│ │
│  │  WHvRunVirtualProcessor, WHvMapGpaRange, ...   │ │
│  │  (via windows-sys 0.61 crate)                  │ │
│  └───────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

### 2.3 Key Design Decisions

#### 2.3.1 No Process Takeover

libkrun's `krun_start_enter()` performs a **process takeover** — the calling process
becomes the VM and the function never returns. This works on Linux/macOS because
`fork()` creates a child process that can be taken over.

Windows has no `fork()`. libwkrun uses a **thread-based model** instead:

```
libkrun:  krun_start_enter()  →  never returns, process IS the VM
libwkrun: wkrun_start_enter() →  spawns vCPU threads, BLOCKS until VM exits, returns exit code
libwkrun: wkrun_start()       →  spawns vCPU threads, returns immediately (non-blocking)
          wkrun_stop()        →  signals VM to stop
          wkrun_wait()        →  blocks until VM exits
```

The non-blocking `start()/stop()/wait()` pattern is essential for builder VMs where
the host needs to poll for a completion file (WHPX's `poweroff -f` enters an HLT loop
that blocks `start_enter()` indefinitely).

#### 2.3.2 Pure Rust — No C FFI

libkrun is a C library wrapped by `libkrun-sys` via FFI (`unsafe`). libwkrun is a
**pure Rust library** — BoxLite's `WkrunContext` calls libwkrun's Rust API directly
with no `unsafe` blocks. The only unsafe code is in libwkrun itself for WHPX API calls
(via `windows-sys` crate).

#### 2.3.3 Virtio-MMIO Transport

Like libkrun, libwkrun uses virtio-MMIO (not virtio-PCI). MMIO is simpler, requires
no PCI bus emulation, and supports up to ~8 devices — more than enough for BoxLite's
4-device requirement (block, 9P, net, vsock).

Device discovery uses the Linux kernel command line parameter
`virtio_mmio.device=SIZE@ADDR:IRQ`, which requires `CONFIG_VIRTIO_MMIO=y` and
`CONFIG_VIRTIO_MMIO_CMDLINE_DEVICES=y` in the guest kernel (Alpine `linux-virt` has both).

#### 2.3.4 9P Filesystem Instead of virtiofs

libkrun uses in-process virtiofs (FUSE protocol) for host-guest filesystem sharing.
virtiofs relies on Linux kernel FUSE interfaces that don't exist on Windows hosts.

libwkrun implements **9P2000.L** (Plan 9 filesystem protocol) instead:
- Pure userspace implementation — no kernel dependencies on the host
- Well-supported in Linux guests (`mount -t 9p -o trans=virtio,version=9p2000.L`)
- 28 message types: Walk, Read, Write, Readdir, GetAttr, SetAttr, Mkdir, Symlink, etc.
- Production-proven approach (ChromeOS Crostini uses the same pattern via crosvm)

#### 2.3.5 Userspace virtio-vsock

libkrun bridges guest vsock ports to host Unix sockets. libwkrun implements
**userspace virtio-vsock** — the guest sees standard `AF_VSOCK`, and the host side
uses TCP connections. This avoids the need for Windows `AF_HYPERV` sockets or any
kernel driver.

The host-guest bridge:
```
Guest (AF_VSOCK port 2695) ←→ virtio-vsock device ←→ Host (TCP 127.0.0.1:PORT)
```

### 2.4 Legacy Device Emulation

WHPX requires certain legacy x86 devices for Linux kernel boot:

| Device | Why Needed |
|--------|-----------|
| **PIC (i8259)** | Linux kernel expects programmable interrupt controller at I/O ports 0x20-0x21 (master) and 0xA0-0xA1 (slave). Required for IRQ routing. |
| **PIT (i8254)** | Programmable interval timer at port 0x40-0x43. Linux uses it for BogoMIPS calibration during boot. Without a timer thread calling `WHvCancelRunVirtualProcessor` every ~1ms, PIT never fires and kernel hangs. |
| **Serial (8250 UART)** | Port 0x3F8 (COM1). Provides `console=ttyS0` output. THRE (Transmitter Holding Register Empty) interrupt on IRQ 4 is required — without it, output truncates at 16 characters (FIFO buffer size). |
| **CMOS/RTC** | Port 0x70-0x71. Linux reads date/time and basic configuration during boot. |

### 2.5 WHPX x86 Instruction Decoder

Unlike KVM (which provides MMIO write data in the exit info), **WHPX does not provide
the data value for MMIO write exits**. libwkrun includes a custom x86 instruction decoder
(`vmm/insn.rs`) that parses the faulting instruction bytes to extract:
- Write value (from register operand or immediate)
- Access width (1/2/4/8 bytes)
- Register encoding (REX prefix handling for 64-bit mode)

### 2.6 Source Statistics

```
Repository:  github.com/lilongen/libwkrun
Language:    Rust
Total:       16,842 lines (src/) + 881 lines (tests/)
Files:       33 source files

Breakdown by layer:
  boot/       — Linux boot: bzImage loader, boot params, register setup
  devices/    — Legacy (PIC, PIT, Serial) + Virtio (block, 9p, net, vsock, queue, mmio)
  vmm/        — VM lifecycle: WHPX backend, vCPU loop, memory, device setup, context
  capi.rs     — C-compatible API surface (26 functions)
  lib.rs      — Rust public API, logging, VM handle management
  error.rs    — Error types

Tests: 415 unit tests (macOS) / 415 unit tests (Win10)
```

---

## 3. BoxLite Integrates libwkrun

### 3.1 Integration Architecture

BoxLite's VMM layer is pluggable. libwkrun integrates as a new engine alongside libkrun:

```
BoxLite Runtime
├── VmmKind::Libkrun    (Linux KVM / macOS HVF)
│   └── libkrun-sys (C FFI)  →  libkrun (C library)
│
├── VmmKind::Libwkrun   (Windows WHPX)
│   └── libwkrun-sys (Rust)  →  libwkrun (Rust library)
│
└── (future engines: Firecracker, etc.)
```

The integration touches BoxLite at three levels:

1. **Engine layer** — `vmm/wkrun/` module: `WkrunContext`, `Wkrun` engine, `WkrunFactory`
2. **Platform adaptation** — `#[cfg(unix)]` / `#[cfg(windows)]` gating across 40+ files
3. **OCI image pipeline** — Builder VM to create ext4 images on Windows (no native ext4 tools)

### 3.2 Integration Phases

The integration was done in 8 phases over 7 days:

#### Phase M2: Engine Layer (2026-04-10)

Added the core libwkrun engine to BoxLite:

| Component | Files | Description |
|-----------|-------|-------------|
| `libwkrun-sys` | 3 new | Thin Rust wrapper re-exporting libwkrun's API |
| `WkrunContext` | `vmm/wkrun/context.rs` | Safe wrapper around libwkrun context (no unsafe) |
| `Wkrun` engine | `vmm/wkrun/engine.rs` | `Vmm` trait impl — configures and enters VM |
| `WkrunFactory` | `vmm/wkrun/factory.rs` | Auto-registration via `inventory::submit!` |
| `VmmKind::Libwkrun` | `vmm/mod.rs` | Enum variant + FromStr + serde |
| `WhpxProbe` | `system_check.rs` | Windows hypervisor availability check |

Key difference from libkrun integration: `WkrunVmmInstance::enter()` **returns** when the
VM exits (unlike `KrunVmmInstance::enter()` which never returns — process takeover).

#### Phase M2.5: Transport & Platform Gating (2026-04-10)

Cross-platform infrastructure enabling TCP transport alongside Unix sockets:

- **TCP port allocation** (`net/port.rs`) — `allocate_free_port()` for Windows transport
- **Dual-channel guest_connect** — `race_ready_accept()` works with both TCP and Unix
- **Engine-aware transport** — wkrun→TCP, krun→Unix socket (auto-detected)
- **`#[cfg(unix)]` gating** — shim watchdog, jailer FD preservation, signal handling

**20 files changed, +515/-94 lines, 8 new tests**

#### Phase 2b: Windows-Specific Implementations (2026-04-11)

| Sub-phase | Scope | Windows Implementation |
|-----------|-------|----------------------|
| 2b-1 Foundation | Process utilities, file locking | `WaitForSingleObject`, `LockFileEx` |
| 2b-2 Shim lifecycle | Crash capture, signal handling, parent death detection | SEH (`SetUnhandledExceptionFilter`), `SetConsoleCtrlHandler`, `BOXLITE_PARENT_PID` env var |
| 2b-3 Network | Network backend endpoint | `NetworkBackendEndpoint::TcpSocket` variant |
| 2b-4 Jailer | Process isolation | `PostSpawnGuard` + `JobObjectSandbox` via Windows Job Objects |

#### Code Quality Debt Fix (2026-04-11)

Fixed 5 issues identified during code review:

| ID | Fix | Impact |
|----|-----|--------|
| H-1 | `vmm/guest_args.rs` shared module | Eliminated DRY violation between krun and wkrun engines |
| H-2 | `VmmKind::default()` platform-conditional | Windows→Libwkrun, Unix→Libkrun automatically |
| H-3 | `HypervisorProbe` wired into wkrun engine | Post-failure VM diagnostics now work |
| M-1 | `WkrunContext::ctx_id` is `Option<u32>` | No more `mem::forget` pattern |
| M-5 | `DEFAULT_GUEST_RLIMITS` in `runtime/constants.rs` | Shared between both engines |

#### Phase 3b: Platform Adaptation (2026-04-11)

Ported remaining Unix-specific code to compile on Windows:

- `libc::kill()` → `#[cfg(unix)]` gated
- `MetadataExt` (UID/GID) → `#[cfg(unix)]` + `#[cfg(not(unix))]` defaults
- `LibraryLoadPath` → `windows-sys` (`GetModuleFileNameW`/`GetModuleHandleExW`)
- `binary_finder.rs` → `.exe` suffix, `;` PATH separator, Windows search paths
- `disk/ext4.rs` → `#[cfg(unix)]` module-level gating

#### Phase 3a: OCI Image Pipeline — Builder VM (2026-04-12)

On Windows, native ext4 tools (`mke2fs`, `debugfs`) are unavailable. The builder VM
boots a temporary Alpine Linux VM via libwkrun to perform these operations — same
approach as Docker Desktop (LinuxKit VM).

**Three builder VM modes:**

| Mode | Purpose | Guest Operation |
|------|---------|----------------|
| `build_ext4` | Create ext4 from OCI layers | Extract tarballs → `mke2fs -t ext4 -d` |
| `inject_file` | Write file into ext4 | `debugfs -w -R "write ..."` |
| `task_vm` | Execute command in rootfs | Mount `/dev/vda` → chroot → run command |

**Implementation:**
- `ImageBuilder` struct with `build_ext4()`, `inject_file()`, `run_command()` methods
- Init script (`scripts/builder-vm/init`) with three modes
- Initramfs with Alpine busybox + e2fsprogs + 11 kernel modules (9P, virtio_blk, ext4, jbd2, etc.)
- Non-blocking VM API: `start()` + poll `.complete` file + `stop()` + `wait()`

#### Phase 3a-3: Unix-only Code Gating (2026-04-12)

Gated remaining Unix-only modules to compile cleanly on Windows:

- `images/archive/` (tar, override_stat, time) → `#[cfg(unix)]`
- `images/blob_source.rs` extract functions → `#[cfg(unix)]` + `#[cfg(not(unix))]` error stubs
- `rootfs/` (builder, copy_mount, operations) → `#[cfg(unix)]`

#### Win10/Win11 Compilation & Testing (2026-04-12 - 2026-04-13)

Final cross-platform verification and platform-specific test fixes:

- Moved `nix` crate to `[target.'cfg(target_os = "linux")'.dependencies]`
- 12 test files with `#[cfg(unix)]` annotations for Unix-only tests
- `spawn.rs` fix: explicitly set `jailer_enabled: true` instead of relying on `BoxOptions::default()`
- Feature-gated `builder_vm` references with `#[cfg(all(not(unix), feature = "wkrun"))]`

### 3.3 Files Changed Summary

The integration touched **50+ files** across BoxLite:

| Category | Files | Examples |
|----------|-------|---------|
| New (wkrun engine) | 7 | `vmm/wkrun/{context,engine,factory,mod}.rs`, `libwkrun-sys/`, `net/port.rs` |
| New (builder VM) | 3 | `images/builder_vm.rs`, `jailer/sandbox/job_object.rs`, `vmm/guest_args.rs` |
| New (scripts) | 2 | `scripts/builder-vm/{init,build-initramfs.sh}` |
| Modified (platform gating) | 25+ | `shim/`, `jailer/`, `runtime/`, `litebox/`, `vmm/`, `util/`, `db/`, `images/`, `rootfs/` |
| Modified (transport) | 8 | `litebox/config.rs`, `init/tasks/guest_connect.rs`, `init/tasks/vmm_spawn.rs`, etc. |
| Modified (workspace) | 3 | `Cargo.toml`, `Cargo.lock`, `src/boxlite/Cargo.toml` |

### 3.4 What Stays Unchanged

These layers are **platform-agnostic** and required NO changes:

- `LiteBox` API (`start`, `exec`, `stop`, `metrics`, `copy_into`, `copy_out`)
- `BoxCommand` / `Execution` / `ExecResult`
- gRPC protocol definitions (host-guest communication)
- SQLite persistence layer
- Python / Node.js / C SDK API surfaces
- OCI image registry/download/caching
- `InstanceSpec` structure (engine-agnostic VM specification)

---

## 4. Overall Status

### 4.1 libwkrun Library — COMPLETE

| Metric | Value |
|--------|-------|
| Repository | `github.com/lilongen/libwkrun` |
| Source | 16,842 lines Rust (33 files) |
| Tests | 415 macOS / 415 Win10 (unit tests, clippy clean) |
| API | 26 functions (libkrun-compatible) |
| Devices | PIC, PIT, Serial, virtio-blk (raw+qcow2), virtio-9p, virtio-net, virtio-vsock |
| Boot | Linux bzImage direct boot + initramfs support |
| Status | **Production-ready for BoxLite integration** |

**Implementation phases (all complete):**

| Phase | Components |
|-------|-----------|
| 1. Legacy Devices | PIC (8259), PIT (8254), Serial (8250 UART), CMOS/RTC |
| 2. Virtio-blk | DiskBackend trait, raw + qcow2 backends, MMIO transport, virtqueue |
| 3a. Virtio-vsock | Host TCP ↔ guest AF_VSOCK bridge, connection management |
| 3b. Virtio-9p | 9P2000.L filesystem server (28 message types), host directory sharing |
| 4. Virtio-net | NetTransport trait, UnixStream + TCP backends |
| 5. VM Lifecycle | Runner, C API, command line builder, device setup |
| 6. Async Lifecycle | VmHandle, RUNNING_VMS registry, non-blocking start/stop/wait |
| Gap-closing | qcow2 support, rlimits, console output capture, logging |

### 4.2 BoxLite Engine Integration — COMPLETE

| Metric | Value |
|--------|-------|
| Files changed | 50+ |
| New code | ~3,000 lines |
| Modified code | ~2,000 lines |
| New tests | ~40 |
| Status | **All platforms compile and pass** |

### 4.3 Test Counts (All Platforms)

| Platform | no-default-features | wkrun feature | E2E (ignored) |
|----------|--------------------:|-------------:|-------------:|
| **macOS ARM64** | 634 | 670 | — |
| **Linux (Lima)** | 620 + 24 pre-existing* | 656 + 24 pre-existing* | — |
| **Win10 (WHPX)** | 512 | 548 | 2 (build_ext4, task_vm) |
| **Win11 (WHPX)** | 512 | 547 | — |

\* 24 pre-existing failures: `RuntimeImpl::new()` calls `check_virtualization_support()`
which requires `/dev/kvm` — Lima VM uses macOS vz driver, no nested KVM.

### 4.4 E2E Timing Results (Win10 via WHPX)

| Operation | Time | Description |
|-----------|------|-------------|
| `build_ext4()` | **3.76s** | Boot builder VM → extract OCI layers → create ext4 via mke2fs |
| `inject_file()` | **~5s** | Boot builder VM → write file into ext4 via debugfs |
| `run_command()` | **1.68s** | Boot task VM → load modules → mount ext4 → chroot → execute |
| **Total first-run** | **~5.4s** | build_ext4 + run_command (rootfs cached after first build) |

For comparison, macOS (libkrun):
- Cold start + first exec: **2.33s**
- Warm exec (VM persisted): **~0ms** (millisecond level)

### 4.5 Remaining Work

| Phase | Status | Description |
|-------|--------|-------------|
| M1: libwkrun library | DONE | 16.8K lines, 415 tests |
| M2: Engine layer | DONE | WkrunContext + Wkrun engine + factory |
| M2.5: Transport + platform gating | DONE | TCP port alloc, dual-channel, #[cfg(unix)] |
| Code quality debt | DONE | 5 issues fixed (DRY, defaults, probes, etc.) |
| Phase 2b: Windows-specific | DONE | Locks, shim lifecycle, network, jailer |
| Phase 3b: Platform adaptation | DONE | Binary paths, library loading, ext4 gating |
| Phase 3a: OCI image pipeline | DONE | Builder VM with 3 modes + initramfs |
| Phase 3a-3: Unix-only gating | DONE | Archive, blob_source, rootfs gating |
| Win10/11 compilation + tests | DONE | 548 tests passing, 0 failures |
| Win10 E2E testing | DONE | Builder VM + Task VM, verified timing |
| **Phase 3c: VM persistence** | **TODO** | Keep VM running across exec calls (like libkrun) |
| **Phase 3c: Guest agent** | **TODO** | Port boxlite-guest to work with TCP transport |
| **Phase 3c: SDK support** | **TODO** | Python/Node.js SDK cross-compile for Windows |
| **Phase 3c: CLI** | **TODO** | `boxlite run` on Windows |
| **Phase 4: CI/CD** | **TODO** | GitHub Actions Windows runner pipeline |
| **Phase 4: Performance** | **TODO** | virtiofs (replace 9P), optimization |

### 4.6 Architecture Diagram (Current State)

```
                    macOS / Linux                              Windows
                    ─────────────                              ───────
User Code           Python/Node/C SDK                          Python/Node/C SDK
                         │                                          │
BoxLite Runtime     ┌────▼────────────────┐                   ┌────▼────────────────┐
                    │  BoxliteRuntime     │                   │  BoxliteRuntime     │
                    │  ├── LiteBox        │                   │  ├── LiteBox        │
                    │  ├── ImageManager   │                   │  ├── ImageManager   │
                    │  └── Portal (gRPC)  │                   │  └── Portal (gRPC)  │
                    └────┬────────────────┘                   └────┬────────────────┘
                         │                                          │
Engine              ┌────▼──────────┐                         ┌────▼──────────┐
                    │ VmmKind::     │                         │ VmmKind::     │
                    │ Libkrun       │                         │ Libwkrun      │
                    │               │                         │               │
                    │ libkrun-sys   │                         │ libwkrun-sys  │
                    │ (C FFI)       │                         │ (Rust API)    │
                    └────┬──────────┘                         └────┬──────────┘
                         │                                          │
VMM Library         ┌────▼──────────┐                         ┌────▼──────────┐
                    │   libkrun     │                         │   libwkrun    │
                    │               │                         │               │
                    │ KVM / HVF     │                         │ WHPX          │
                    │ virtiofs      │                         │ 9P filesystem │
                    │ vsock→Unix    │                         │ vsock→TCP     │
                    │ process       │                         │ thread-based  │
                    │ takeover      │                         │ VM loop       │
                    └───────────────┘                         └───────────────┘

Transport           Unix sockets                               TCP loopback
                    /tmp/box/{id}/grpc.sock                    127.0.0.1:{port}

Sandbox             Linux: bubblewrap + seccomp                Windows: Job Objects
                    macOS: sandbox-exec (SBPL)                 (+ future: AppContainer)

OCI Pipeline        Native: mke2fs, debugfs                    Builder VM: Alpine Linux
                    (ext4 tools run on host)                   (ext4 tools run in VM)
```

### 4.7 Key Learnings

**WHPX-specific:**
- Timer thread is mandatory for kernel boot (PIT interrupt delivery for BogoMIPS calibration)
- MMIO exits don't provide write data — custom x86 instruction decoder needed
- `WHV_REGISTER_VALUE` arrays must be heap-allocated (Vec, not stack arrays — alignment issue on Win10)
- APIC emulation (`WHvX64LocalApicEmulationModeXApic`) crashes on older Win10 hardware — avoid for now
- `poweroff -f` enters HLT loop (no ACPI) — use non-blocking VM API, not `start_enter()`

**Builder VM / E2E:**
- Alpine `linux-virt` kernel has VIRTIO_MMIO=y built-in but ext4/9P/virtio_blk as modules
- Initramfs must include matching kernel modules (6.12.81-0-virt) — version mismatch = silent failure
- `ln -s` over existing directory creates symlink INSIDE the dir — must `rm -rf` first
- `debugfs` is in `e2fsprogs-extra`, not `e2fsprogs`
- `docker export` is the simplest way to create an Alpine rootfs tarball for testing

**Cross-platform Rust:**
- `BoxOptions::default()` varies by platform (jailer_enabled is `true` only on macOS) — tests must set values explicitly
- `#[cfg(not(unix))]` blocks referencing `builder_vm` must also require `feature = "wkrun"`
- `nix` crate must be `[target.'cfg(target_os = "linux")'.dependencies]` (not unconditional)
- Windows `set` command: NO trailing spaces before `&&` (`set VAR=val&&` not `set VAR=val &&`)
