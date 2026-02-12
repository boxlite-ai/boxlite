# BoxLite [![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://go.boxlite.ai/discord)

[![GitHub stars](https://img.shields.io/github/stars/boxlite-ai/boxlite?style=social)](https://github.com/boxlite-ai/boxlite)
[![Build](https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml/badge.svg)](https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml)
[![Lint](https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml/badge.svg)](https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Embedded, lightweight** micro-VM runtime for **AI agents** running OCI containers with
hardware-level isolation — built for **high concurrency**, **no daemon required**.


## What is BoxLite?

BoxLite lets you spin up **lightweight VMs** ("Boxes") and run **OCI containers inside them**. It's
designed for use cases like **AI agent sandboxes** and **multi-tenant code execution**, where Docker
alone isn't enough and full VM infrastructure is too heavy.

**Why BoxLite**

- **Lightweight**: small footprint, fast-starting Boxes, minimal operational overhead.
- **High concurrency**: async-first API designed to run many Boxes in parallel; stream stdout/stderr.
- **Hardware isolation**: each Box has its own kernel (not just namespaces).
- **Embeddable**: link a library; no root; no background service to manage.
- **OCI compatible**: use Docker/OCI images (`python:slim`, `node:alpine`, `alpine:latest`).

## Python Quick Start

<details>
<summary>View guide</summary>

### Install

```bash
pip install boxlite
```

Requires Python 3.10+.

### Run

```python
import asyncio
import boxlite


async def main():
    async with boxlite.SimpleBox(image="python:slim") as box:
        result = await box.exec("python", "-c", "print('Hello from BoxLite!')")
        print(result.stdout)


asyncio.run(main())
```

</details>


## Node.js Quick Start

<details>
<summary>View guide</summary>

### Install

```bash
npm install @boxlite-ai/boxlite
```

Requires Node.js 18+.

### Run

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


## Rust Quick Start

<details>
<summary>View guide</summary>

### Install

```toml
[dependencies]
boxlite = { git = "https://github.com/boxlite-ai/boxlite" }
```

### Run

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


## Next steps

- Run more real-world scenarios in [Examples](./examples/)
- Learn how images, disks, networking, and isolation work in [Architecture](./docs/architecture/)

## Features

- **Compute**: CPU/memory limits, async-first API, streaming stdout/stderr, metrics
- **Storage**: volume mounts (ro/rw), persistent disks (QCOW2), copy-on-write
- **Networking**: outbound internet, port forwarding (TCP/UDP), network metrics
- **Images**: OCI pull + caching, custom rootfs support
- **Security**: hardware isolation (KVM/HVF), OS sandboxing (seccomp/sandbox-exec), resource limits
- **Image Registry Configuration**: Configure custom registries via config file (`--config`), CLI flags (`--registry`), or SDK options. See the [configuration guide](./docs/guides/image-registry-configuration.md).
- **SDKs**: Python (stable), Node.js (v0.1.6); Go coming soon

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
