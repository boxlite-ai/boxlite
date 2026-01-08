# BoxLite Jailer Threat Model

This document describes the security design and threat model for BoxLite's jailer
module, which provides defense-in-depth isolation for the shim process.

## Overview

BoxLite runs untrusted code inside lightweight virtual machines. The **jailer**
provides OS-level process isolation for the shim process (which manages the VM),
adding security layers beyond hardware virtualization.

```
┌─────────────────────────────────────────────────────────────────────┐
│                              HOST OS                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                         JAILER BOUNDARY                       │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │                     SHIM PROCESS                        │  │  │
│  │  │  ┌───────────────────────────────────────────────────┐  │  │  │
│  │  │  │                 VM (libkrun/KVM)                  │  │  │  │
│  │  │  │  ┌─────────────────────────────────────────────┐  │  │  │  │
│  │  │  │  │              GUEST (untrusted)              │  │  │  │  │
│  │  │  │  │         User code runs here                 │  │  │  │  │
│  │  │  │  └─────────────────────────────────────────────┘  │  │  │  │
│  │  │  └───────────────────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Threat Actors

### Primary Threat: Malicious Guest Code

**Assumption**: All guest code is considered malicious from the moment it starts.

This is the core security assumption. BoxLite is designed for:
- AI agent sandboxes executing untrusted LLM-generated code
- Multi-tenant environments running customer workloads
- Regulated environments requiring strong isolation

We assume an attacker has:
- Full control of code running inside the guest VM
- Knowledge of BoxLite internals and isolation mechanisms
- Ability to attempt any guest-accessible operation

### Secondary Threats

| Threat Actor | Description | Mitigation |
|--------------|-------------|------------|
| Malicious volumes | Attacker-controlled host paths mounted into guest | Sandbox restricts file access to explicit paths |
| Resource exhaustion | Guest attempting to consume host resources | cgroups (Linux) and rlimits limit resources |
| Information leakage | Guest attempting to read host secrets | Environment sanitization, FD cleanup |
| Privilege escalation | Guest/shim attempting to gain root | Privilege dropping, seccomp filtering |

## Trust Zones

BoxLite defines four trust zones, from least to most trusted:

```
┌─────────────────────────────────────────────────────────────────────┐
│  LEAST TRUSTED                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Zone 0: Guest VM                                             │  │
│  │  - All guest code assumed malicious                           │  │
│  │  - Isolated by hardware virtualization (KVM/HVF)              │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  Zone 1: Shim Process (jailed)                          │  │  │
│  │  │  - Manages VM lifecycle                                  │  │  │
│  │  │  - Constrained by jailer (sandbox, rlimits, etc.)        │  │  │
│  │  │  ┌───────────────────────────────────────────────────┐  │  │  │
│  │  │  │  Zone 2: BoxLite Runtime                          │  │  │  │
│  │  │  │  - Spawns and manages shim processes              │  │  │  │
│  │  │  │  - Runs with user privileges                      │  │  │  │
│  │  │  │  ┌─────────────────────────────────────────────┐  │  │  │  │
│  │  │  │  │  Zone 3: Host OS / Kernel                   │  │  │  │  │
│  │  │  │  │  - Most trusted                             │  │  │  │  │
│  │  │  │  │  - Enforces all isolation                   │  │  │  │  │
│  │  │  │  └─────────────────────────────────────────────┘  │  │  │  │
│  │  │  └───────────────────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│  MOST TRUSTED                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Zone Transitions

| From | To | Boundary | Enforcement |
|------|-----|----------|-------------|
| Guest | Shim | VM exit | KVM/Hypervisor.framework |
| Shim | Runtime | IPC | gRPC over vsock |
| Shim | Host | Syscalls | Seccomp (Linux), Sandbox (macOS) |
| Runtime | Host | Syscalls | Normal process isolation |

## Defense in Depth

The jailer implements multiple independent isolation layers. If one layer fails,
others continue to provide protection.

### Layer 1: Hardware Virtualization

**Mechanism**: KVM (Linux) / Hypervisor.framework (macOS)

| Property | Description |
|----------|-------------|
| Memory isolation | Guest cannot access host memory |
| CPU isolation | Guest runs in non-root VMX mode |
| Device isolation | Paravirtualized devices only |
| Instruction filtering | Privileged instructions trap to hypervisor |

**Limitations**: Hypervisor vulnerabilities can allow guest escape.

### Layer 2: Process Isolation (Jailer)

**Mechanism**: OS-level sandboxing applied to shim process

#### Linux Implementation

| Mechanism | Purpose |
|-----------|---------|
| Namespaces | Isolate mount, PID, network, IPC, UTS |
| Chroot/pivot_root | Restrict filesystem view |
| Seccomp | Whitelist allowed syscalls |
| Privilege dropping | Run as unprivileged uid/gid |
| cgroups v2 | Limit CPU, memory, PIDs |

#### macOS Implementation

| Mechanism | Purpose |
|-----------|---------|
| sandbox-exec (Seatbelt) | Kernel-enforced sandbox profile |
| rlimits | Limit file descriptors, memory, CPU |

**Note**: macOS provides weaker isolation than Linux. Production deployments
requiring maximum security should use Linux.

### Layer 3: Resource Limits

**Mechanism**: cgroups (Linux), rlimits (both platforms)

| Resource | Limit Type | Purpose |
|----------|------------|---------|
| Open files | RLIMIT_NOFILE | Prevent FD exhaustion |
| File size | RLIMIT_FSIZE | Prevent disk filling |
| Processes | RLIMIT_NPROC | Prevent fork bombs |
| Memory | RLIMIT_AS | Prevent OOM |
| CPU time | RLIMIT_CPU | Prevent CPU monopolization |

### Layer 4: Environment Sanitization

**Mechanism**: Clear environment variables, close inherited FDs

| Operation | Purpose |
|-----------|---------|
| Close FDs > 2 | Prevent leaking credentials, sockets |
| Clear environment | Prevent leaking API keys, secrets |
| Allowlist env vars | Keep only necessary vars (PATH, RUST_LOG) |

## Platform Comparison

| Feature | Linux | macOS |
|---------|-------|-------|
| Hardware virtualization | KVM | Hypervisor.framework |
| Syscall filtering | Seccomp (BPF) | Sandbox (SBPL) |
| Filesystem isolation | pivot_root + namespaces | Sandbox file rules |
| Network isolation | Network namespace | Sandbox network rules |
| Privilege dropping | setuid/setgid | Not supported |
| cgroups | v2 | Not available |
| Resource limits | rlimits + cgroups | rlimits only |

### Security Implications

**Linux**: Full defense-in-depth with multiple independent layers.

**macOS**: Relies primarily on sandbox-exec. Limitations:
- No privilege dropping (sandbox runs as current user)
- No network namespace (sandbox rules less granular)
- No cgroups (rlimits only resource control)
- Hypervisor.framework may be less hardened than KVM

## Attack Vectors and Mitigations

### Guest VM Escape

**Attack**: Exploit hypervisor vulnerability to execute code on host.

**Mitigations**:
1. KVM/HVF provides hardware-enforced isolation
2. Shim process runs in jail (even if escaped, still sandboxed)
3. Seccomp limits syscalls available to escaped code
4. Privilege dropping limits damage from successful escape

### Shim Process Compromise

**Attack**: Exploit bug in shim to gain code execution.

**Mitigations**:
1. Shim written in Rust (memory safety)
2. Seccomp filters limit available syscalls
3. Chroot/sandbox limits filesystem access
4. Privilege dropping limits capabilities

### Resource Exhaustion (DoS)

**Attack**: Guest or shim consumes excessive host resources.

**Mitigations**:
1. cgroups limit CPU, memory, PIDs (Linux)
2. rlimits limit FDs, file size, CPU time
3. VM memory limits enforced by libkrun

### Information Disclosure

**Attack**: Guest reads sensitive host data.

**Mitigations**:
1. Environment sanitized (secrets removed)
2. Inherited FDs closed (no leaked handles)
3. Sandbox restricts file read paths
4. Only explicit volume mounts accessible

### Privilege Escalation

**Attack**: Shim attempts to gain root privileges.

**Mitigations**:
1. Seccomp blocks setuid/setgid syscalls
2. Privilege already dropped to unprivileged user
3. Capabilities dropped (Linux)
4. Sandbox blocks privileged operations (macOS)

### Filesystem Escape

**Attack**: Access files outside allowed paths.

**Mitigations**:
1. pivot_root changes filesystem root (Linux)
2. Sandbox enforces path whitelist (macOS)
3. Only explicit volume paths accessible
4. Symlink attacks prevented by canonicalization

## Security Properties

### Guaranteed Properties

| Property | Description | Enforcement |
|----------|-------------|-------------|
| Guest isolation | Guests cannot access each other | Separate VMs, separate jails |
| Host protection | Guest cannot directly access host | Virtualization + sandbox |
| Resource fairness | One guest cannot starve others | cgroups, rlimits |
| Minimal privileges | Shim runs with minimal capabilities | Privilege dropping |

### Best-Effort Properties

| Property | Description | Limitation |
|----------|-------------|------------|
| Side-channel resistance | Timing attacks mitigated | Hardware-dependent |
| Hypervisor hardening | VM escape prevented | Depends on KVM/HVF security |

## Assumptions

### Trusted Components

1. **Host kernel**: Assumed to correctly enforce isolation
2. **KVM/Hypervisor.framework**: Assumed to correctly virtualize
3. **libkrun**: Assumed to correctly implement VMM
4. **BoxLite runtime**: Assumed to correctly spawn jailed processes

### Untrusted Components

1. **Guest code**: Assumed malicious from start
2. **Guest filesystem**: Assumed to contain malicious data
3. **Volume contents**: Assumed potentially malicious

## Non-Goals

The jailer does **not** protect against:

1. **Host kernel vulnerabilities**: Kernel bugs can bypass all isolation
2. **Hardware attacks**: Spectre/Meltdown-class side channels
3. **Physical access**: Attacker with physical host access
4. **Supply chain attacks**: Compromised BoxLite binaries
5. **Operator error**: Misconfigured security options

## Operational Security

### Recommended Configuration

```rust
// Maximum security for untrusted workloads
let security = SecurityOptions::maximum();

// This enables:
// - jailer_enabled: true
// - seccomp_enabled: true (Linux)
// - chroot_enabled: true (Linux)
// - close_fds: true
// - sanitize_env: true
// - resource_limits: restrictive defaults
```

### Debugging Sandbox Issues

#### Linux
```bash
# Check seccomp denials
dmesg | grep -i seccomp

# Check namespace isolation
ls -la /proc/<pid>/ns/
```

#### macOS
```bash
# Check sandbox violations
log show --predicate 'subsystem == "com.apple.sandbox"' --last 5m
```

## References

- [Firecracker Design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [Firecracker Jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)
- [Apple Sandbox Guide](https://reverse.put.as/wp-content/uploads/2011/09/Apple-Sandbox-Guide-v1.0.pdf)
- [Linux Namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [Seccomp BPF](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html)
