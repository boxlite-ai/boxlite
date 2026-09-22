# Concepts

How BoxLite works, for people who use it. For the code behind each part, see
[Architecture](../contributing/architecture/README.md).

BoxLite is an embeddable virtual machine runtime that follows the SQLite philosophy: a library that
can be embedded directly into applications without requiring a daemon or external service.

> **Terminology**: Throughout this documentation, we use **"Box"** to refer to an isolated execution
> environment (the underlying implementation uses a lightweight VM). A Box provides hardware-level
> isolation while presenting a simple, container-like interface.

## Pages

- [Images](images.md): how BoxLite pulls, caches, and shares OCI images.
- [Storage](storage.md): a box's root filesystem and volumes.
- [Networking](networking.md): network backends, service access, and addressing.
- [Security](security.md): the isolation layers around every box.
- [Metrics](metrics.md): runtime-wide and per-box counters.

## How the parts fit

```text
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
