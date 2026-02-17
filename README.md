# BoxLite [![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://go.boxlite.ai/discord)

[![GitHub stars](https://img.shields.io/github/stars/boxlite-ai/boxlite?style=social)](https://github.com/boxlite-ai/boxlite)
[![Build](https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml/badge.svg)](https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml)
[![Lint](https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml/badge.svg)](https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**The SQLite of sandboxing** — embeddable, stateful micro-VMs with snapshots and hardware isolation.
Boot in milliseconds. Just `import` and run.


## Why BoxLite?

- **Embeddable** — Single importable library. No cloud accounts, no daemons, no root access.
- **Stateful** — Environments persist across sessions. Packages and files survive restarts.
- **Snapshots** — Checkpoint before risky operations and instantly rollback. Fork environments for parallel work.
- **Hardware Isolation** — Each sandbox runs in its own micro-VM with a dedicated Linux kernel via KVM or Hypervisor.framework.

| | BoxLite | Cloud Sandboxes |
|---|---|---|
| Boot time | Sub-50ms | Seconds |
| State | Persistent | Ephemeral |
| Snapshots | Built-in | Limited |
| Isolation | Hardware VM | Container/VM |
| Cost | Free & open source | Per-minute billing |
| Data | Stays on your machine | Sent to cloud |

## Quick Start

```bash
pip install boxlite
```

```python
import asyncio
import boxlite


async def main():
    async with boxlite.SimpleBox(image="python:slim") as box:
        # Install packages — they persist across sessions
        await box.exec("pip", "install", "requests")

        result = await box.exec("python", "-c", "import requests; print(requests.__version__)")
        print(result.stdout)


asyncio.run(main())
```

Also available for **Node.js**, **Rust**, and **C** — see [SDK Quick Starts](#sdk-quick-starts) below.


## Use Cases

- **AI Agent Sandboxing** — Safe execution of untrusted AI-generated code
- **Code Execution** — Multi-tenant isolated environments for running user code
- **Browser Automation** — Headless browsers in isolated VMs for web scraping and testing

## SDK Quick Starts

<details>
<summary>Node.js</summary>

```bash
npm install @boxlite-ai/boxlite
```

```javascript
import { SimpleBox } from '@boxlite-ai/boxlite';

async function main() {
  const box = new SimpleBox({ image: 'python:slim' });
  try {
    const result = await box.exec('python', '-c', "print('Hello from BoxLite!')");
    console.log(result.stdout);
  } finally {
    await box.stop();
  }
}

main();
```

</details>

<details>
<summary>Rust</summary>

```toml
[dependencies]
boxlite = { git = "https://github.com/boxlite-ai/boxlite" }
```

```rust
use boxlite::{BoxCommand, BoxOptions, BoxliteRuntime, RootfsSpec};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = BoxliteRuntime::default_runtime();
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        ..Default::default()
    };

    let litebox = runtime.create(options, None).await?;
    let mut execution = litebox
        .exec(BoxCommand::new("echo").arg("Hello from BoxLite!"))
        .await?;

    let mut stdout = execution.stdout().unwrap();
    while let Some(line) = stdout.next().await {
        println!("{}", line);
    }

    Ok(())
}
```

</details>

## Next Steps

- [Examples](./examples/) — Real-world scenarios and sample code
- [Architecture](./docs/architecture/) — How images, disks, networking, and isolation work

## Features

- **Compute** — CPU/memory limits, async-first API, streaming stdout/stderr, metrics
- **Storage** — Volume mounts (ro/rw), persistent disks (QCOW2), copy-on-write
- **Networking** — Outbound internet, port forwarding (TCP/UDP), network metrics
- **Images** — OCI pull + caching, custom rootfs, [custom registries](./docs/guides/image-registry-configuration.md)
- **Security** — Hardware isolation (KVM/HVF), OS sandboxing (seccomp/sandbox-exec), resource limits
- **SDKs** — Python (stable), Node.js (v0.1.6), Rust, C

## Architecture

High-level overview of how BoxLite embeds a runtime and runs OCI containers inside micro-VMs.
For details, see [Architecture](./docs/architecture/).

<details>
<summary>Show diagram</summary>

```
┌──────────────────────────────────────────────────────────────┐
│  Your Application                                            │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  BoxLite Runtime (embedded library)                   │   │
│  │                                                        │   │
│  │  ╔════════════════════════════════════════════════╗   │   │
│  │  ║ Jailer (OS-level sandbox)                      ║   │   │
│  │  ║  ┌──────────┐  ┌──────────┐  ┌──────────┐      ║   │   │
│  │  ║  │  Box A   │  │  Box B   │  │  Box C   │      ║   │   │
│  │  ║  │ (VM+Shim)│  │ (VM+Shim)│  │ (VM+Shim)│      ║   │   │
│  │  ║  │┌────────┐│  │┌────────┐│  │┌────────┐│      ║   │   │
│  │  ║  ││Container││  ││Container││  ││Container││      ║   │   │
│  │  ║  │└────────┘│  │└────────┘│  │└────────┘│      ║   │   │
│  │  ║  └──────────┘  └──────────┘  └──────────┘      ║   │   │
│  │  ╚════════════════════════════════════════════════╝   │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                              │
              Hardware Virtualization + OS Sandboxing
             (KVM/Hypervisor.framework + seccomp/sandbox-exec)
```

**Security Layers:**
- Hardware isolation (KVM/Hypervisor.framework)
- OS-level sandboxing (seccomp on Linux, sandbox-exec on macOS)
- Resource limits (cgroups, rlimits)
- Environment sanitization

</details>

## Documentation

- API Reference — Coming soon
- [Examples](./examples/) — Sample code for common use cases
- [Architecture](./docs/architecture/) — How BoxLite works under the hood

## Supported Platforms

| Platform       | Architecture          | Status           |
|----------------|-----------------------|------------------|
| macOS          | Apple Silicon (ARM64) | ✅ Supported     |
| Linux          | x86_64                | ✅ Supported     |
| Linux          | ARM64                 | ✅ Supported     |
| Windows (WSL2) | x86_64                | ✅ Supported     |
| macOS          | Intel (x86_64)        | ❌ Not supported |

## System Requirements

| Platform       | Requirements                                   |
|----------------|------------------------------------------------|
| macOS          | Apple Silicon, macOS 12+                       |
| Linux          | KVM enabled (`/dev/kvm` accessible)            |
| Windows (WSL2) | WSL2 with KVM support, user in `kvm` group     |
| Python         | 3.10+                                          |

## Getting Help

- [GitHub Issues](https://github.com/boxlite-ai/boxlite/issues) — Bug reports and feature requests
- [Discord](https://discord.gg/bCmaK4Ce) — Questions and community support

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
