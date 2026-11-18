## TL;DR

AWS runners use retained gp3 data disks and SSM updates with a canary, bounded batches, and explicit recovery.

## Details

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

Use shared [artifact build/promotion](../runners.md#build-and-promote),
[release update](../runners.md#upgrade-or-roll-back-a-release) and [scaling](../runners.md#scale-out) commands.
Development binaries live in the stage's S3 artifact bucket.

### Migration archives

The Runner can read and write `checkpoints/`, `box-migrations/` and the configured migration prefix inside the stage archive bucket. If `BOX_MIGRATION_ARCHIVE_PREFIX` names a different bucket, its owner must authorize access to that bucket and prefix before moving Boxes.

### Data disks

Each host receives an encrypted, independently retained gp3 volume mounted at `/var/lib/boxlite`.
Configure `deploy.runners.dataDiskGb`; its default is 200 GiB, while `rootDiskGb` sizes the operating-system disk.

Bootstrap identifies the assigned volume by its NVMe serial and records the ext4 UUID in fstab. For expansion and rollout checks, the Runner resolves the per-volume Nitro link that udev recreates at boot, such as `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0`.
Unexpected signatures, root-device selection or an existing unmounted data directory fail closed.

Existing hosts retain instance sizing, boot settings and data-disk performance settings.
Migrating root-disk state requires an explicit maintenance operation; see [SST adoption](migration.md#move-existing-runner-data).

The API validates account, region, zone, volume type and app/stage/Runner tags before requesting EBS growth.
AWS allows at most four accepted expansions per rolling 24 hours, subject to a smaller configured budget.

The Runner expands ext4 after block capacity increases.
EBS acceptance alone does not complete the operation; the control plane also waits for reported filesystem capacity.

### Deployment rollout

All hosts pass readiness before one canary updates.
The canary must stay healthy for 300 seconds, then each batch waits for the preceding batch.

Batch size is `min(4, max(1, floor(hostCount / 4)))`.
A host lock prevents overlapping payloads, and a failed batch stops scheduling later batches.

SSM execution is capped at 30 minutes; supervision allows 35 minutes.
The AWS engine operation is capped at 120 minutes and shortened when credentials expire sooner.

Before submitting, the transport inventories active Runner commands and resumes an identical accepted payload.
A different payload must settle before another invocation can submit its replacement.

Updates verify checksums, target identity, managed environment and the assigned mount.
Already-converged hosts need no restart; process restarts can interrupt running boxes, so arrange draining or maintenance.

### Operator updates and recovery

`runner:update --host <name>[,<name>...]` selects hosts and processes them serially.
Intentional release rollback requires `--allow-downgrade`.

Read each selected host's SSM command result and perform the shared
[registration, identity and box checks](../runners.md#verify-and-recover).
A bootstrapping host is not proof of the requested version.

Timeouts retain command IDs because accepted SSM work can outlive its supervisor.
Reconcile those commands before retrying or recovering an expired deployment lease.

Sources: [AWS provider](../../mdeploy/stack/providers/aws/runners.ts),
[SSM transport](../../mdeploy/src/upgrade-runners.ts), [mount contract](../../mdeploy/stack/providers/aws/data-disk.ts).
