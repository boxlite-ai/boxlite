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

