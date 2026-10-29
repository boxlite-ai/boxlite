## TL;DR

GCP observes the first runner for five minutes, then updates the remaining runners in parallel through OS Config.

# GCP runner operations

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

Use the shared [artifact build/promotion](../runners.md#build-and-promote),
[release update](../runners.md#upgrade-or-roll-back-a-release) and [scaling](../runners.md#scale-out) commands.
Development binaries live in the stage's GCS artifact bucket.

## Rollout behavior

Each stage requires its own GCP project. Runner labels intentionally identify logical runners
without a stage suffix; OS Config selects them within the configured project and zone.
Sharing a project between stages is unsupported because matching labels can select another stage's hosts.

mdeploy splits the fleet into two disjoint OS Config assignments:

| Assignment | Hosts | Rollout |
| --- | --- | --- |
| `<app>-<stage>-runner-binary` | First runner | One host, 300-second observation window |
| `<app>-<stage>-runner-binary-fleet` | All remaining runners | 100% parallel, no additional observation window |

Pulumi waits for the first assignment's rollout before starting the second, and waits for both to finish.
A single-runner stage has only the first assignment. For four runners, the configured observation time
falls from four five-minute windows to one; agent execution and reporting still take additional time.

Each assignment has a 40-minute create/update timeout, covering convergence and observation, including
the initial migration from a whole-fleet assignment. This is an upper bound, not an added wait:
completed operations proceed immediately. Deletion keeps the provider's default timeout.

Each assignment carries both binary and unit-environment policies, so an update also converges the API
address, volume backend and registry proxy host. Existing hosts retain their disks, image caches and
local box state; boot-image/startup changes do not replace them.

`runner:update` checks both assignments before writing, then updates them in the same order. It waits
for each rollout and verifies that every policy on each targeted host reports compliant with the updated
revision. A failed update, missing report or stale revision stops progression. The first runner must be
running, and runner labels must be unique after normalization. The command refuses `--host`;
the next mdeploy reasserts the checkout's policy target. Both paths verify binary checksums and readiness.
Already-converged hosts need no restart. Release downgrades require the explicit `--allow-downgrade` update command.
IAP/OS Login remains available for authorized administration, but normal updates do not require per-user SSH.

For an existing deployment, run mdeploy once to narrow the original assignment to the first runner and
create the fleet assignment. `runner:update` refuses the old whole-fleet layout before changing either
assignment. If an earlier rollout is still in progress, let it finish or investigate it before retrying.
The five-minute window controls rollout pacing; it does not continuously test box creation or tunnel health.

## Data disk

Each host gets its own Hyperdisk Balanced disk, `<app>-<stage>-runner-data[-N]`, attached as `boxlite-data`:
200 GiB at 3,600 IOPS and 290 MiB/s (240 MiB/s on `small`, the n4-standard-4 limit). Box state lives on it:
the boot script formats a blank disk once and mounts it at `/var/lib/boxlite` with `nofail`, so `rootDiskGb`
sizes only the boot disk. The runner unit requires that mount: a host whose disk does not mount still boots
and stays reachable, with the runner stopped: `systemctl status var-lib-boxlite.mount` says why, or
`/var/log/runner-setup.log` when the boot script refused a disk that was missing, not blank, or would hide data.
A deploy sets size and performance only at creation and never
changes them back, so grow the disk online; the disk is protected, so a deploy that would replace it fails.
The attachment is fixed at creation too: a host that existed before its disk does not get it attached,
and that disk stays unattached, and billed, until the host is destroyed and recreated; a `--replace`
would carry the ignored attachment over.

## Verify and recover

Inspect both assignments (only the first for a single-runner stage), including every binary and
unit-environment policy after mdeploy:

```bash
gcloud compute os-config os-policy-assignment-reports list \
  --project=<project> --location=<zone> --assignment-id=<assignment-name>
gcloud compute os-config os-policy-assignment-reports describe <assignment-name> \
  --project=<project> --location=<zone> --instance=<runner-name> --format=json
```

Then perform the shared [registration, identity and box checks](../runners.md#verify-and-recover).
If convergence fails, inspect the host's OS Config result and service logs before retrying.
After a deployment timeout, check the assignment's current rollout state and reports: the cloud
operation may complete after Pulumi stops waiting, while the dependent fleet update remains pending.
A compliant policy alone does not prove box creation or tunnel health.

Source: [GCP runner provider](../../mdeploy/stack/providers/gcp/runners.ts),
[operator updater](../../mdeploy/src/runner-update.ts).
