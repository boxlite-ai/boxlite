# GitHub Actions runner integration

BoxLite provides native support for executing GitHub Actions workflows inside
ephemeral, hardware-isolated micro-VMs with warm instance reuse.

## Overview

Standard GitHub Actions runners either lack virtualization isolation or incur
repeated cold-boot delays when launching separate virtual machines for each job.
The `boxlite actions-runner` (aliased as `boxlite runner`) integration solves this:

1. **Hardware-isolated micro-VMs**: Each workflow job executes inside an isolated
   Linux micro-VM (`/dev/kvm` nested virtualization enabled), protecting the host
   from untrusted CI dependencies or build scripts.
2. **5-minute warm reuse window**: Upon job completion, the micro-VM is kept alive
   in an idle-warm state for up to 300 seconds (configurable via `--idle-timeout`).
   If a new job arrives during this window, it executes immediately without a cold
   boot, smoothing out bursty CI traffic.
3. **Clean teardown**: If no job arrives before the idle timeout expires, the
   runner cleanly terminates and reaps the micro-VM.

## Quickstart: Connect in 2 Steps

### 1. Connect runner to local repository

Run inside your git repository:

```bash
boxlite actions-runner connect
```

This auto-discovers your repository remote, fetches a runner token via `gh`, and boots a warm micro-VM.

### 2. Update your workflow

In `.github/workflows/ci.yml`:

```yaml
jobs:
  test:
    runs-on: boxlite
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

## Runner Sizing and Slash Options

BoxLite supports sizing tiers and slash-delimited options in `runs-on`:

```yaml
runs-on: boxlite-large/from=custom-ci:latest/debug
```

| Option | Effect |
| :--- | :--- |
| `boxlite-small` | 2 vCPU, 4 GB RAM |
| `boxlite` *(default)* | 4 vCPU, 8 GB RAM |
| `boxlite-large` | 8 vCPU, 16 GB RAM |
| `boxlite-xlarge` | 16 vCPU, 32 GB RAM |
| `/from=<image>` | Boot from a pre-hydrated container image or snapshot |
| `/debug` | Keep micro-VM alive for 30 minutes on job failure for post-mortem inspection |

## Standalone Local Test Execution

You can run test commands directly inside an isolated micro-VM without committing or pushing:

```bash
boxlite actions-runner run --push . -- cargo test --all
```

## CLI Usage

### Start an ephemeral runner with warm reuse

```bash
boxlite actions-runner start \
  --url "https://github.com/my-org/my-repo" \
  --token "$GITHUB_RUNNER_TOKEN" \
  --labels "boxlite,self-hosted,linux" \
  --idle-timeout 300
```

### Options

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--url <URL>` | GitHub repository or organization URL | *(Required)* |
| `--token <TOKEN>` | Registration token from GitHub (or `GITHUB_RUNNER_TOKEN`) | *(Required)* |
| `--name <NAME>` | Unique runner instance name | `boxlite-runner-<id>` |
| `--labels <LABELS>` | Comma-separated runner labels advertised to GitHub | `boxlite,self-hosted,linux` |
| `--image <IMAGE>` | Base OCI image for the micro-VM | `ubuntu:22.04` |
| `--idle-timeout <SECS>` | Warm idle window before terminating the micro-VM | `300` (5 minutes) |
| `--ephemeral` | Run in single-job ephemeral mode | `true` |

### Check runner status

```bash
boxlite actions-runner status
```

