<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/boxlite-banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/boxlite-banner-light.png">
    <img alt="BoxLite" src=".github/assets/boxlite-banner-light.png" width="560">
  </picture>
</h1>

<p align="center">
  <a href="https://pypi.org/project/boxlite/"><img alt="PyPI" src="https://img.shields.io/pypi/v/boxlite?logo=pypi&amp;logoColor=white&amp;label=pip"></a>
  <a href="https://www.npmjs.com/package/@boxlite-ai/boxlite"><img alt="npm" src="https://img.shields.io/npm/v/@boxlite-ai/boxlite?logo=npm&amp;label=npm"></a>
  <a href="https://crates.io/crates/boxlite"><img alt="crates.io" src="https://img.shields.io/crates/v/boxlite?logo=rust&amp;logoColor=white&amp;label=crates"></a>
  <a href="https://codecov.io/gh/boxlite-ai/boxlite"><img alt="codecov" src="https://codecov.io/gh/boxlite-ai/boxlite/branch/main/graph/badge.svg"></a>
  <a href="https://go.boxlite.ai/discord"><img alt="Discord" src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&amp;logoColor=white"></a>
  <a href="https://github.com/boxlite-ai/boxlite"><img alt="GitHub stars" src="https://img.shields.io/github/stars/boxlite-ai/boxlite?style=social"></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
</p>

<p align="center">
  <strong>The compute substrate for AI agents</strong> — light enough to embed on your laptop, elastic enough to power an agentic cloud.
</p>


## What is BoxLite?

A **Box** is a hardware-isolated micro-VM that runs any OCI image — and it persists. Agents install packages, write files, and resume across turns, never from cold.

**Why BoxLite**

- **Real isolation**: its own kernel — stronger than a container, lighter than a full VM. Small footprint, async-first for fleets.
- **Daemonless**: embed as a library — no root, no background service. *(optional server mode)*
- **OCI-native**: run any Docker image unchanged (`python:slim`, `node:alpine`, …).
- **Controlled networking**: restrict egress with `allow_net`; inject real secrets via placeholders.
- **Embed → cloud**: one engine, from your laptop to a multi-tenant cloud.

## Get started

One engine. Embed it, run it, deploy it, distribute it.

### 1 · Embed it — a library in your app

Import BoxLite and give your agent an isolated VM to run code — no daemon, no binary. *(Python 3.10+)*

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
ctx := context.Background()
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


No code needed — one install, then run any OCI image from your terminal.

```console
curl -fsSL https://sh.boxlite.ai | sh
boxlite run python:slim python -c "print('Hello from BoxLite!')"
```

Installs to `$HOME/.local/bin/boxlite`, runtime embedded — no extra setup. Alternatives (`cargo install boxlite-cli`, version pinning, verification) → [CLI reference](./docs/reference/cli/README.md#installation--verification).

### 3 · Deploy it — a standalone server

<details>
<summary>Run BoxLite as a REST service; drive it from anything that speaks HTTP.</summary>

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

</details>

### 4 · Distribute it — your own agentic cloud

<details>
<summary>Deploy the control plane into your own AWS account (GCP on the way) — multi-tenant, autoscaling boxes for a fleet of agents. The substrate at full scale.</summary>

```bash
git clone https://github.com/boxlite-ai/boxlite && cd boxlite/apps/infra
npm install
npm run deploy -- --stage production
```

Needs an AWS account, a Cloudflare-managed domain, and Docker. Full guide → [`apps/infra/README.md`](./apps/infra/README.md).

</details>


## Next steps

- More real-world scenarios → [Examples](./examples/)
- How images, disks, networking, and isolation work → [Architecture](./docs/architecture/)

## Features

| Area | Capabilities |
|------|--------------|
| **Execution** | run any OCI image · async exec with streamed stdout/stderr + exit codes · interactive PTY with live resize · per-command timeout, workdir, env, run-as-user · entrypoint/cmd override |
| **Isolation & security** | a hardware-virtualized VM per box (KVM / Hypervisor.framework) · OS sandbox (seccomp / sandbox-exec) · CPU, memory & resource limits · egress allow-list (`allow_net`) · secret injection — real values never enter the VM · env sanitization |
| **Storage & state** | persists across stop/restart · volume mounts (ro/rw) · per-box QCOW2 disk with copy-on-write · bidirectional file copy · clone, or export/import as `.boxlite` archives · detached boxes that outlive the parent process |
| **Networking** | outbound internet · TCP/UDP port forwarding · network I/O metrics |
| **Images** | pull + cache any OCI image · custom & private [registries](./docs/guides/image-registry-configuration.md) · custom rootfs |
| **Observability** | per-box & runtime metrics — CPU, memory, network, boot time, commands · console logs · live `stats` |
| **Interfaces** | Python · Node.js · Go · Rust · C SDKs · the `boxlite` CLI · a REST API (WebSocket exec, optional auth) |

## Ecosystem

Agent frameworks run on BoxLite:

- **[Databricks Omnigent](https://github.com/omnigent-ai/omnigent)** — sandbox option in their agent meta-harness
- **[Alibaba AgentScope Runtime](https://runtime.agentscope.io/en/sandbox/sandbox.html)** — sandbox backend (`CONTAINER_DEPLOYMENT=boxlite`)
- **[ByteDance deer-flow](https://github.com/bytedance/deer-flow/tree/main/backend/packages/harness/deerflow/community/boxlite)** — sandbox provider in their research agent

## Architecture

How BoxLite embeds a runtime and runs OCI containers inside micro-VMs. Details → [Architecture](./docs/architecture/).

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
- [Using BoxLite with AI agents](./docs/guides/ai-agent-integration.md) — concurrency, timeouts, security, file transfer
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
