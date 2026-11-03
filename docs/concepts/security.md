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

## GNU ARM64 VMM policy

Network-disabled GNU ARM64 boxes retain VMM seccomp filtering during startup,
execution and shutdown. The target policy permits the libc, Go and libkrun calls
needed for thread initialization, firmware mappings, Unix control sockets, KVM
setup and unprivileged filesystem identity queries.

KVM requests and supported scalar arguments remain restricted; unlisted calls
still trap. `clone3` matches the x86 GNU allowance because classic seccomp cannot
inspect its pointed-to arguments. The jailer and VM remain separate isolation
layers. This policy does not resolve static-glibc firmware-loading compatibility.

On Linux ARM64 with KVM, verify guest execution and live VMM thread filtering with:

```sh
make test:integration:python FILTER=network_disabled_arm64_guest_keeps_seccomp
```
