# Contributing

Documentation for people working on BoxLite itself. The contribution process, from setup and pull
requests to commit messages and where each doc goes, is in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Architecture

How the code fits together.

- [Architecture](architecture/README.md): components, the VMM abstraction, host-guest RPC,
  concurrency, and error handling.
- [VMM design](architecture/vmm/README.md): BoxLite's own VMM, which is replacing libkrun, with
  background on [Hypervisor.framework](architecture/vmm/hvf.md), [KVM](architecture/vmm/kvm.md),
  the [Windows Hypervisor Platform](architecture/vmm/whp.md), and
  [guest memory](architecture/vmm/memory.md).
- [Jailer network permissions](architecture/jailer-network-permissions.md): guest networking, host
  IP grants, and the AF_UNIX control plane.
- [Container capabilities](architecture/container-capabilities.md): the Linux capability API.

## Development

How to build, test, and change the code.

- [Building from source](development/building.md): prerequisites and build commands.
- [Rust style guide](development/rust-style.md): conventions for Rust code.
- [CLI development](development/cli.md): building, testing, and extending the `boxlite` CLI.
- [E2E local CI runbook](development/e2e-local.md): the self-hosted runner behind `e2e-local.yml`.
- [macOS sandbox debugging](development/macos-sandbox-debugging.md): find and fix Seatbelt denials.

## Investigations

Dated root-cause analyses and design studies, newest first.

- 2026-07-19 · [Reaper: one wait, one place](investigations/reaper-exit-slot.md)
- 2026-07-15 · [Collapse `start_attached` into `attach` and `start`](investigations/collapse-start-attached.md)
- 2026-07-14 · [Container init creation via the zygote](investigations/init-build-via-zygote.md)
- 2026-07-14 · [SDK API for run-command semantics](investigations/sdk-run-semantics-api.md)
- 2026-07-14 · [`boxlite run` command: Docker semantics fix](investigations/run-command-semantics-fix.md)
- 2026-03-10 · [Concurrent exec deadlock](investigations/concurrent-exec-deadlock.md)
- 2026-02-22 · [Boot latency analysis](investigations/boot-latency-analysis.md)
