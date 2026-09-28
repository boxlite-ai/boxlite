## TL;DR

AWS installs runner binaries through serial SSM commands and supports explicit host selection for operator updates.

# AWS runner operations

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

Use the shared [artifact build/promotion](../runners.md#build-and-promote),
[release update](../runners.md#upgrade-or-roll-back-a-release) and [scaling](../runners.md#scale-out) commands.
Development binaries live in the stage's S3 artifact bucket.

## Rollout behavior

mdeploy chains per-host SSM commands in the resource graph. Each command polls for completion
before the next host. `runner:update --host <name>[,<name>...]` can select hosts;
a failure stops subsequent updates. Updates verify artifact checksums and readiness,
and already-converged hosts need no restart. Intentional release rollback needs `--allow-downgrade`.
Hosts retain their disks and local box state and are protected against replacement/deletion.

## Verify and recover

Read each selected host's SSM command result, then perform the shared
[registration, identity and box checks](../runners.md#verify-and-recover).
A skipped or bootstrapping host is not proof that it serves the target version.
Inspect SSM output and runner service logs before retrying a failed update.

Sources: [AWS runner provider](../../mdeploy/stack/providers/aws/runners.ts),
[operator updater](../../mdeploy/src/runner-update.ts), [legacy update launcher](../../scripts/runner-update-binary.mjs).
