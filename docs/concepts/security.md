# Security

Defense-in-depth security layer that sandboxes the shim process, inspired by Firecracker's jailer.
Provides OS-level isolation on top of hardware virtualization.

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

**Seccomp coverage (Linux):** with `seccomp_enabled`, the shim installs one VMM filter on all of
its threads (TSYNC), including the in-process gvproxy network backend. Anything outside the
allowlist raises `SIGSYS` and ends the box.

| Architecture | Networked boxes | Boxes without network |
|---|---|---|
| x86_64 | filtered; verified on KVM | filtered |
| aarch64 | **not filtered**: the aarch64 profile is unverified with gvproxy, and the shim logs a warning | filtered; **UNVERIFIED** |

For networking and guest storage, the x86_64 filter allows two syscalls beyond the VMM core:

- `getpeername`: Go's network dial calls it after every connect.
- `fallocate`, modes 0, 1, 3, 16 and 17 only: virtio-blk discards and virtio-fs passes on the
  guest's `fallocate`, and these are the only modes a stock guest kernel sends. Collapse, insert
  and unshare trap.

**macOS:**
- sandbox-exec (Seatbelt) for kernel-enforced sandboxing
- rlimits for resource constraints

**Architecture:**

```text
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
use boxlite::{AdvancedBoxOptions, BoxOptions, SecurityOptions};

// Most users don't need to configure security — defaults prioritize compatibility
// For advanced users who need maximum isolation:
let opts = BoxOptions {
    advanced: AdvancedBoxOptions {
        security: SecurityOptions::enabled(),
        ..Default::default()
    },
    ..Default::default()
};
```

The complete threat model is in
[`THREAT_MODEL.md`](../../src/boxlite/src/jailer/THREAT_MODEL.md). How the jailer grants
guest networking and host access is in
[Jailer network permissions](../contributing/architecture/jailer-network-permissions.md).
