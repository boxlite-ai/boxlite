# Contributing

Documentation for people working on BoxLite itself. The contribution process, from setup and pull
requests to commit messages and where each doc goes, is in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Architecture

How the code fits together.

- [Architecture](architecture/README.md): components, the VMM abstraction, host-guest RPC,
  concurrency, and error handling.
- [Hosted platform](architecture/platform/README.md): how the `apps/` services fit together,
  their interfaces, and their data model.
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
- [REST API testing](development/rest-api-testing.md): API-key and OIDC coverage across the SDK, CLI, API, runner, and VM.
- [macOS sandbox debugging](development/macos-sandbox-debugging.md): find and fix Seatbelt denials.

## Investigations

Dated root-cause analyses and design studies, newest first.

- 2026-11-11 · [CI resource labels](investigations/2026-11-11-ci-resource-labels.md): job-selected Box resources, quota enforcement and original-operation recovery.
- 2026-11-10 · [Desktop left navigation](investigations/2026-11-10-desktop-left-navigation.md): sidebar layout, hover preview and navigation behavior.
- 2026-11-10 · [Desktop visual refinement](investigations/2026-11-10-desktop-visual-refinement.md): resource view consistency and desktop review findings.
- 2026-11-09 · [Desktop dashboard consistency](investigations/2026-11-09-desktop-review-corrections.md): shared resource presentation, compact usage summaries and desktop screenshot evidence.
- 2026-11-06 · [CI capacity summary](investigations/2026-11-06-ci-capacity-meter.md): inline slot occupancy and owner capacity editing beside the runner filter.
- 2026-11-06 · [SSH connection dialog](investigations/ssh-connection-dialog.md): progressive connection steps, saved-key recovery, and backend-compatible SSH controls.
- 2026-11-06 · [Registration email policy](investigations/2026-11-06-registration-email-policy.md): disposable-domain rejection at platform account creation with existing-user access preserved.
- 2026-11-04 · [CLI-managed SSH setup](investigations/ssh-quick-configuration.md): historical credential and printed-command design, superseded by direct OpenSSH login.
- 2026-11-03 · [Tunnel custom domains](investigations/2026-11-03-tunnel-custom-domains.md): subscription-gated Dashboard setup and DNS challenges, preserved binding fields with new subscription/readiness failures, suffix-based persistence, and platform-only allowance; the first release uses GCP managed certificates and the existing certificate map.
- 2026-11-02 · [VMM virtio-net device](investigations/2026-11-02-vmm-virtio-net.md): guest queue framing, gvproxy stream backpressure, event contracts and device-only qualification.
- 2026-10-28 · [Agent REST API design](investigations/2026-10-28-agent-rest-api-design.md): nine HTTP operations for agents, turns and interaction, with snapshot, retry and event-recovery contracts.
- 2026-10-23 · [Organization activity facts](investigations/organization-activation-facts.md): lifecycle timestamps, transaction boundaries, and migration availability.
- 2026-10-08 · [CLI device authorization discovery](investigations/cli-device-authorization.md)
- 2026-09-18 · [Main command exit codes](investigations/box-exit-code-on-box-info.md): runner-backed reads, absent values, and notification-path boundaries.
- 2026-07-19 · [Reaper: one wait, one place](investigations/reaper-exit-slot.md)
- 2026-07-15 · [Collapse `start_attached` into `attach` and `start`](investigations/collapse-start-attached.md)
- 2026-07-14 · [Container init creation via the zygote](investigations/init-build-via-zygote.md)
- 2026-07-14 · [SDK API for run-command semantics](investigations/sdk-run-semantics-api.md)
- 2026-07-14 · [`boxlite run` command: Docker semantics fix](investigations/run-command-semantics-fix.md)
- 2026-03-10 · [Concurrent exec deadlock](investigations/concurrent-exec-deadlock.md)
- 2026-02-22 · [Boot latency analysis](investigations/boot-latency-analysis.md)
