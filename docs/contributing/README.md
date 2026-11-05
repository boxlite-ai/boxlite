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

- 2026-11-05 · [Dashboard creation after a startup timeout](investigations/2026-11-05-dashboard-create-timeout.md): follows the created Box by ID when image preparation outlasts the startup wait.
- 2026-11-05 · [Dashboard page width](investigations/2026-11-05-dashboard-page-width.md): shared full-width dashboard layout, measurements, and checks.
- 2026-11-05 · [ASCII action buttons](investigations/2026-11-05-ascii-buttons.md): shared console button styles, native interactions, and rendered comparisons.
- 2026-11-04 · [CLI-managed SSH setup](investigations/ssh-quick-configuration.md): managed SSH credentials and the printed SSH connection command.
- 2026-11-03 · [Quickstart code readability](investigations/2026-11-03-quickstart-code-readability.md): SDK/CLI code typography and unpinned installation commands.
- 2026-11-03 · [Images catalog membership](investigations/2026-11-03-images-catalog-membership.md): keeps Quickstart recommendations out of the API-backed image list.
- 2026-10-28 · [Agent REST API design](investigations/2026-10-28-agent-rest-api-design.md): nine HTTP operations for agents, turns and interaction, with snapshot, retry and event-recovery contracts.
- 2026-10-28 · [Agent CLI simplification](investigations/2026-10-28-agent-cli-simplification.md): compares command hierarchies and named runtime targets for agent instances and turns.
- 2026-10-27 · [CLI guest SSH commands](investigations/cli-ssh-commands.md)
- 2026-10-08 · [BoxLite skills in Claude Code](investigations/claude-code-plugin.md): describes the Claude adapter, shared package layout, and installation/acceptance checks.
- 2026-10-08 · [CLI device authorization discovery](investigations/cli-device-authorization.md)
- 2026-07-19 · [Reaper: one wait, one place](investigations/reaper-exit-slot.md)
- 2026-07-15 · [Collapse `start_attached` into `attach` and `start`](investigations/collapse-start-attached.md)
- 2026-07-14 · [Container init creation via the zygote](investigations/init-build-via-zygote.md)
- 2026-07-14 · [SDK API for run-command semantics](investigations/sdk-run-semantics-api.md)
- 2026-07-14 · [`boxlite run` command: Docker semantics fix](investigations/run-command-semantics-fix.md)
- 2026-03-10 · [Concurrent exec deadlock](investigations/concurrent-exec-deadlock.md)
- 2026-02-22 · [Boot latency analysis](investigations/boot-latency-analysis.md)
