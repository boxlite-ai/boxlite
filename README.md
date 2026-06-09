# BoxLite [![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://go.boxlite.ai/discord)

[![GitHub stars](https://img.shields.io/github/stars/boxlite-ai/boxlite?style=social)](https://github.com/boxlite-ai/boxlite)
[![Build](https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml/badge.svg)](https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml)
[![Lint](https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml/badge.svg)](https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml)
[![codecov](https://codecov.io/gh/boxlite-ai/boxlite/branch/main/graph/badge.svg)](https://codecov.io/gh/boxlite-ai/boxlite)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Compute substrate for AI agents: lightweight enough to live on your laptop, elastic enough to scale into the cloud and unleash unlimited resources.

## Dashboard Development

For day-to-day dashboard work, run the local frontend from the repository root:

```bash
npm run start
```

This starts the dashboard at `http://localhost:3000` and connects it to the dev Auth0/dev API environment by default.

| Command | Purpose |
| --- | --- |
| `npm run start` | Local dashboard on port 3000 with dev Auth0/dev API |
| `npm run start:dev` | Explicit alias for the default dev-backed dashboard |
| `npm run start:mock` | Local dashboard with the existing MSW billing mocks enabled |
| `npm run start:local` | Local dashboard through the Vite `/api` proxy; start the local API separately |
| `npm run start:dex` | Alias for local API/Dex-oriented development |
| `npm run start:storybook` | Component-level dashboard development |
| `npm run dev:dex` | Full local Dex development environment: Docker Postgres/Redis/Dex plus API, runner, proxy, and dashboard |
| `npm run e2e:local` | Local browser E2E entrypoint; starts the same Dex environment and prints the deterministic test login contract |

Use `npm run start` for quick dashboard work against the shared dev API. Use `npm run dev:dex` when you need the
local API to trust the local Dex issuer. Use `npm run e2e:local` as the only local browser E2E entrypoint; agents
and scripts should not choose between `start`, `start:dex`, or `serve-slim` for E2E.

The local Dex account is:

```text
admin@boxlite.dev / password
```

The E2E command deliberately does not depend on existing browser cookies. Browser login state is per profile, so
tests should open the dashboard, follow the Dex redirect if needed, fill the account above, and continue after the
dashboard loads. To run a one-shot test command after the environment is ready, pass it after `--`:

```bash
npm run e2e:local -- -- <your-e2e-command>
```

Both Dex commands require Docker Desktop. They create/reuse local containers named `boxlite-local-postgres`,
`boxlite-local-redis`, and `boxlite-local-dex`, plus local Docker volumes for persistent development data.

## What is BoxLite?

BoxLite lets you spin up **lightweight VMs** ("Boxes") and run **OCI containers inside them**. Unlike
ephemeral sandboxes that destroy state after each execution, BoxLite Boxes are **persistent workspaces** —
install packages, create files, build up environment state, then come back later and pick up where you left off.

**Why BoxLite**

- **Stateful**: Boxes retain packages, files, and environment across stop/restart. No rebuilding on every interaction.
- **Lightweight**: small footprint, fast boot, async-first API for high concurrency.
- **Hardware isolation**: each Box runs its own kernel — not just namespaces or containers.
- **No daemon**: embed as a library, no root, no background service.
- **OCI compatible**: use standard Docker images (`python:slim`, `node:alpine`, `alpine:latest`).
- **Network policy + secret placeholders**: restrict outbound access with `allow_net` and inject real HTTP(S) secrets from host-side `secrets`.
- **Local-first**: runs entirely on your machine — no cloud account needed. Scale out when ready.

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
    async with boxlite.SimpleBox(image="busybox:1.36.1") as box:
        result = await box.exec("echo", "Hello from BoxLite!")
        print(result.stdout, end="")


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
  const box = new SimpleBox({ image: 'busybox:1.36.1' });
  try {
    const result = await box.exec('echo', 'Hello from BoxLite!');
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

```bash
cargo add boxlite tokio futures --features tokio/macros,tokio/rt-multi-thread
```

### Run

```rust
use boxlite::{BoxCommand, BoxOptions, BoxliteRuntime, RootfsSpec};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = BoxliteRuntime::default_runtime();
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("busybox:1.36.1".into()),
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

    litebox.stop().await?;
    Ok(())
}
```

</details>


## Go Quick Start

<details>
<summary>View guide</summary>

### Install

```bash
go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup
```

Requires Go 1.24+ with CGO enabled. The setup step downloads the prebuilt native library (one-time).

### Run

```go
package main

import (
	"context"
	"fmt"
	"log"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func main() {
	rt, err := boxlite.NewRuntime()
	if err != nil {
		log.Fatal(err)
	}
	defer rt.Close()

	ctx := context.Background()
	box, err := rt.Create(ctx, "busybox:1.36.1", boxlite.WithName("my-box"))
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		_ = rt.ForceRemove(ctx, box.ID())
	}()

	if err := box.Start(ctx); err != nil {
		log.Fatal(err)
	}

	result, err := box.Exec(ctx, "echo", "Hello from BoxLite!")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(result.Stdout)
}
```

</details>


## CLI Quick Start

<details>
<summary>View guide</summary>

### Install

```bash
curl -fsSL https://sh.boxlite.ai | sh
```

Installs to `$HOME/.local/bin/boxlite`. The runtime is embedded in the
binary — no extra setup. For alternatives (`cargo install boxlite-cli`,
version pinning, custom install dir) and release-artifact verification,
see the [CLI Reference's Installation & Verification section](./docs/reference/cli/README.md#installation--verification).

### Run

```bash
boxlite run busybox:1.36.1 echo "Hello from BoxLite!"
```

</details>


## REST API Quick Start

<details>
<summary>View guide</summary>

### Install

Install the `boxlite` CLI — see [CLI Quick Start](#cli-quick-start). The
REST server ships with the same binary. For release-artifact verification,
see the [CLI Reference's Installation & Verification section](./docs/reference/cli/README.md#installation--verification).

### Start the server

```bash
boxlite serve
# Listening on 0.0.0.0:8100
```

### Use it

```bash
# Create a box
curl -s -X POST http://localhost:8100/v1/boxes \
  -H 'Content-Type: application/json' \
  -d '{"image": "busybox:1.36.1"}'

# Run a command (replace BOX_ID from the response above)
curl -s -X POST http://localhost:8100/v1/boxes/BOX_ID/exec \
  -H 'Content-Type: application/json' \
  -d '{"command": "echo", "args": ["Hello from BoxLite!"]}'
```

All CLI commands also work against a running server:

```bash
boxlite --url http://localhost:8100 list
boxlite --url http://localhost:8100 exec BOX_ID -- echo "Hello!"
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
- **SDKs**: Rust (Rust 1.88+), Python (Python 3.10+), C (C11-compatible compiler), Node.js (Node.js 18+), Go (Go 1.24+)
- **REST API**: built-in HTTP server (`boxlite serve`) — use BoxLite from any language or tool via curl

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

- [API & CLI Reference](./docs/reference/) — SDK API references (Python, Node.js, Rust, C) and the `boxlite` CLI reference
- [Examples](./examples/) — Sample code for common use cases
- [Architecture](./docs/architecture/) — How BoxLite works under the hood

## Supported Platforms

| Platform       | Architecture          | Status           |
|----------------|-----------------------|------------------|
| macOS          | Apple Silicon (ARM64) | ✅ Supported     |
| Linux          | x86_64                | ✅ Supported     |
| Linux          | ARM64                 | ✅ Supported     |
| Windows (WSL2) | x86_64                | ✅ Supported     |
| macOS          | Intel (x86_64)        | 🚀 Coming soon |

## System Requirements

| Platform       | Requirements                                   |
|----------------|------------------------------------------------|
| macOS          | Apple Silicon, macOS 12+                       |
| Linux          | KVM enabled (`/dev/kvm` accessible)            |
| Windows (WSL2) | WSL2 with KVM support, user in `kvm` group     |

## Getting Help

- [GitHub Issues](https://github.com/boxlite-ai/boxlite/issues) — Bug reports and feature requests
- [Discord](https://go.boxlite.ai/discord) — Questions and community support
- [Security Policy](./SECURITY.md) — How to privately report a vulnerability

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
