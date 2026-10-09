## TL;DR

GCP updates runner hosts with OS Config policies; an infrastructure apply can finish before the fleet converges.

# GCP runner operations

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

Use the shared [artifact build/promotion](../runners.md#build-and-promote),
[release update](../runners.md#upgrade-or-roll-back-a-release) and [scaling](../runners.md#scale-out) commands.
Development binaries live in the stage's GCS artifact bucket.

## Rollout behavior

mdeploy creates an OS Config policy assignment with a one-host disruption budget. Existing hosts
retain their disks, image caches and local box state; boot-image/startup changes do not replace them.
Pulumi completion means the policy exists; agents converge asynchronously.

`runner:update` rewrites the fleet policy and waits for reports. It refuses `--host`;
the next mdeploy reasserts the checkout's policy target. Both paths verify binary checksums and readiness.
Already-converged hosts need no restart. Release downgrades require the explicit `--allow-downgrade` update command.
IAP/OS Login remains available for authorized administration, but normal updates do not require per-user SSH.

## Data disk

Each host gets its own Hyperdisk Balanced disk, `<app>-<stage>-runner-data[-N]`, attached as `boxlite-data`:
200 GiB at 3,600 IOPS and 290 MiB/s (240 MiB/s on `small`, the n4-standard-4 limit). It is not mounted yet,
so box state still lives on the boot disk. A deploy sets size and performance only at creation and never
changes them back, so grow the disk online; the disk is protected, so a deploy that would replace it fails.
The attachment is fixed at creation too: a host that existed before its disk does not get it attached,
and that disk stays unattached, and billed, until the host is destroyed and recreated; a `--replace`
would carry the ignored attachment over.

## Verify and recover

Inspect every host and every declared policy, including binary/unit-environment policies after mdeploy:

```bash
gcloud compute os-config os-policy-assignment-reports list   --project=<project> --location=<zone> --assignment=<assignment-name>
```

Then perform the shared [registration, identity and box checks](../runners.md#verify-and-recover).
If convergence fails, inspect the host's OS Config result and service logs before retrying.
A compliant policy alone does not prove box creation or tunnel health.

Source: [GCP runner provider](../../mdeploy/stack/providers/gcp/runners.ts),
[operator updater](../../mdeploy/src/runner-update.ts).
