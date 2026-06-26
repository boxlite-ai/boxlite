<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/boxlite-banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/boxlite-banner-light.png">
    <img alt="BoxLite" src=".github/assets/boxlite-banner-light.png" width="560">
  </picture>
</h1>

<p align="center">
  <a href="https://go.boxlite.ai/discord"><img alt="Discord" src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&amp;logoColor=white"></a>
  <a href="https://github.com/boxlite-ai/boxlite"><img alt="GitHub stars" src="https://img.shields.io/github/stars/boxlite-ai/boxlite?style=social"></a>
  <a href="https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml"><img alt="Build" src="https://github.com/boxlite-ai/boxlite/actions/workflows/build-wheels.yml/badge.svg"></a>
  <a href="https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml"><img alt="Lint" src="https://github.com/boxlite-ai/boxlite/actions/workflows/lint.yml/badge.svg"></a>
  <a href="https://codecov.io/gh/boxlite-ai/boxlite"><img alt="codecov" src="https://codecov.io/gh/boxlite-ai/boxlite/branch/main/graph/badge.svg"></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
</p>

<p align="center">
  <strong>The compute substrate for AI agents</strong> — light enough to embed on your laptop, elastic enough to power an agentic cloud.
</p>


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

## Get started

One engine. Embed it, run it, deploy it, distribute it.

### 1 · Embed it — a library in your app

Import BoxLite and give your agent an isolated VM to run code in — in-process, no daemon, no binary. *(Python 3.10+)*

```bash
pip install boxlite
```

```python
import asyncio
import boxlite

async def main():
    async with boxlite.SimpleBox(image="python:slim") as box:
        result = await box.exec("python", "-c", "print('Hello from BoxLite!')")
        print(result.stdout)

asyncio.run(main())
```

<details>
<summary>Other languages — Node.js, Go, Rust (and the C SDK)</summary>

**Node.js** (`npm install @boxlite-ai/boxlite`, Node 18+)

```javascript
import { SimpleBox } from '@boxlite-ai/boxlite';

const box = new SimpleBox({ image: 'python:slim' });
try {
  const result = await box.exec('python', '-c', "print('Hello from BoxLite!')");
  console.log(result.stdout);
} finally {
  await box.stop();
}
```

**Go** (`go get github.com/boxlite-ai/boxlite/sdks/go`, Go 1.24+ with CGO)

```go
rt, _ := boxlite.NewRuntime()
defer rt.Close()
box, _ := rt.Create(ctx, "alpine:latest")
defer box.Close()
result, _ := box.Exec(ctx, "echo", "Hello from BoxLite!")
fmt.Print(result.Stdout)
```

**Rust** (`cargo add boxlite tokio futures --features tokio/macros,tokio/rt-multi-thread`)

```rust
let runtime = BoxliteRuntime::default_runtime();
let litebox = runtime.create(BoxOptions {
    rootfs: RootfsSpec::Image("alpine:latest".into()),
    ..Default::default()
}, None).await?;
let mut execution = litebox.exec(BoxCommand::new("echo").arg("Hello from BoxLite!")).await?;
let mut stdout = execution.stdout().unwrap();
while let Some(line) = stdout.next().await { println!("{}", line); }
```

Full runnable versions: [Python](./sdks/python/), [Node](./sdks/node/), [Go](./sdks/go/), [Rust](./docs/reference/rust/), [C](./sdks/c/).

</details>

### 2 · Run it — the binary, one command

Don't want to write code? One install, then run any OCI image straight from your terminal.

```bash
curl -fsSL https://sh.boxlite.ai | sh
boxlite run python:slim python -c "print('Hello from BoxLite!')"
```

Installs to `$HOME/.local/bin/boxlite`, runtime embedded — no extra setup. Alternatives (`cargo install boxlite-cli`, version pinning, verification) → [CLI reference](./docs/reference/cli/README.md#installation--verification).

### 3 · Deploy it — a standalone server

Run BoxLite as a long-lived REST service and drive it from anything that speaks HTTP.

```bash
boxlite serve
# Listening on 0.0.0.0:8100
```

```bash
curl -s -X POST http://localhost:8100/v1/boxes \
  -H 'Content-Type: application/json' \
  -d '{"image": "alpine:latest"}'
```

Every CLI command also works against a running server with `--url`: `boxlite --url http://localhost:8100 list`.

### 4 · Distribute it — your own agentic cloud

Deploy the BoxLite control plane into your own AWS account — REST-compatible, multi-tenant, autoscaling boxes for a fleet of agents. The substrate at full scale.

```bash
git clone https://github.com/boxlite-ai/boxlite && cd boxlite/apps/infra
npm install
npm run deploy -- --stage production
```

Needs an AWS account, a Cloudflare-managed domain, and Docker. Full guide → [`apps/infra/README.md`](./apps/infra/README.md).


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
