# BoxLite

[![Build](https://github.com/boxlite-labs/boxlite/actions/workflows/build-wheels.yml/badge.svg)](https://github.com/boxlite-labs/boxlite/actions/workflows/build-wheels.yml)
[![Lint](https://github.com/boxlite-labs/boxlite/actions/workflows/lint.yml/badge.svg)](https://github.com/boxlite-labs/boxlite/actions/workflows/lint.yml)
[![PyPI](https://img.shields.io/pypi/v/boxlite.svg)](https://pypi.org/project/boxlite/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Embedded** micro-VM runtime for **AI agents** running OCI containers with
hardware-level isolation — **no daemon required**.


## What is BoxLite?

BoxLite lets you spin up **lightweight VMs** ("Boxes") and run **OCI containers inside them**. It's
designed for use cases like **AI agent sandboxes** and **multi-tenant code execution**, where Docker
alone isn't enough and full VM infrastructure is too heavy.

**Why BoxLite**

- **Hardware isolation**: each Box has its own kernel (not just namespaces).
- **Embeddable**: link a library; no root; no background service to manage.
- **OCI compatible**: use Docker/OCI images (`python:slim`, `node:alpine`, `alpine:latest`).
- **Async-first**: run many boxes concurrently; stream stdout/stderr.

## Python Quick Start

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

## Rust Quick Start

### Install

```toml
[dependencies]
boxlite = { git = "https://github.com/boxlite-labs/boxlite" }
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

    let (_, litebox) = runtime.create(options)?;
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

## Next steps

- Run more real-world scenarios in [Examples](./examples/)
- Learn how images, disks, networking, and isolation work in [Architecture](./docs/architecture/)

## Features

- **Compute**: CPU/memory limits, async-first API, streaming stdout/stderr, metrics
- **Storage**: volume mounts (ro/rw), persistent disks (QCOW2), copy-on-write
- **Networking**: outbound internet, port forwarding (TCP/UDP), network metrics
- **Images**: OCI pull + caching, custom rootfs support
- **SDKs**: Python available; Node.js / Go coming soon

## Architecture

High-level overview of how BoxLite embeds a runtime and runs OCI containers inside micro-VMs.
For details, see [Architecture](./docs/architecture/).

<details>
<summary>Show diagram</summary>

```
┌─────────────────────────────────────────────────────────────┐
│  Your Application                                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  BoxLite Runtime (embedded library)                  │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │   │
│  │  │   Box A     │  │   Box B     │  │   Box C     │   │   │
│  │  │  (micro-VM) │  │  (micro-VM) │  │  (micro-VM) │   │   │
│  │  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │   │   │
│  │  │ │Container│ │  │ │Container│ │  │ │Container│ │   │   │
│  │  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │   │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                    Hardware Virtualization
                      (KVM / Hypervisor.framework)
```

</details>

## Documentation

- API Reference — Coming soon
- [Examples](./examples/) — Sample code for common use cases
- [Architecture](./docs/architecture/) — How BoxLite works under the hood

## Supported Platforms

| Platform | Architecture          | Status          |
|----------|-----------------------|-----------------|
| macOS    | Apple Silicon (ARM64) | ✅ Supported     |
| Linux    | x86_64                | ✅ Supported     |
| Linux    | ARM64                 | ✅ Supported     |
| macOS    | Intel (x86_64)        | ❌ Not supported |
| Windows  | —                     | ❌ Not supported |

## System Requirements

| Platform | Requirements                        |
|----------|-------------------------------------|
| macOS    | Apple Silicon, macOS 12+            |
| Linux    | KVM enabled (`/dev/kvm` accessible) |
| Python   | 3.10+                               |

## Getting Help

- [GitHub Issues](https://github.com/boxlite-labs/boxlite/issues) — Bug reports and feature requests
- [Discussions](https://github.com/boxlite-labs/boxlite/discussions) — Questions and community
  support

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
