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

The native deployer and `runner:update` reserve a per-instance operation in the regional state bucket before sending a mutating command. S3 stores the operation ID, payload digest, binary identity, status and SSM command ID when known. The deployer conditionally writes each revision against its previous ETag.

A retry resumes the recorded command. If the response was lost, the deployer searches that instance’s SSM history for the operation ID, including completed commands. While a command remains invisible the reservation stays active and a retry cannot submit a duplicate.

| Event | S3 record | Next action |
| --- | --- | --- |
| Before dispatch | `submitting` with a unique operation ID | Send once with that ID in the SSM comment |
| Acceptance is uncertain | Keep `submitting` | Search the instance’s command history on retry |
| SSM explicitly denies access | `failed` | Retry after correcting credentials |
| Command ID found | `submitted` with the command ID | Poll that command to its terminal result |
| Two supervisors observe completion | Same operation and terminal state | Both report the recorded result |
| Operator releases the active ID | `superseded` with actor and reason | A new operation can claim the instance |

Updates verify checksums, target identity, managed environment and the assigned mount.
Already-converged hosts need no restart; process restarts can interrupt running boxes, so arrange draining or maintenance.

### Operator updates and recovery

`runner:update --host <name>[,<name>...]` selects hosts and processes them serially.
Intentional release rollback requires `--allow-downgrade`.

Read each selected host's SSM command result and perform the shared
[registration, identity and box checks](../runners.md#verify-and-recover).
A bootstrapping host is not proof of the requested version.

#### Emergency replacement

The regional state bucket comes from the `state` field of the SSM parameter `/boxlite/pulumi/bootstrap`. The key is `rollouts/aws/<app>/<stage>/<region>/<ec2-instance-id>.json`. A new EC2 instance ID can roll immediately, even when the old instance is offline.

From `apps/infra`, inspect the old instance before deciding whether to release its reservation:

```sh
npm run runner:update -- --stage dev --host "$INSTANCE_ID" --rollout-status
npm run runner:update -- --stage dev --host "$INSTANCE_ID" --force-unlock "$OPERATION_ID" --reason "Failed instance isolated for replacement" --confirm
```

Force unlock marks only the exact active operation as superseded and records the caller ARN, timestamp and reason in the versioned object. It needs AWS access to the state bucket and works while the Runner is unreachable. A stale supervisor cannot overwrite a newer operation.

SSM can still deliver an accepted command to the original instance. Before reusing that instance, stop the previous submitters, then reconcile outstanding commands and verify the serving binary. Keep the old host isolated if its submitters or commands cannot be accounted for.


Sources: [AWS provider](../../mdeploy/stack/providers/aws/runners.ts),
[SSM transport](../../mdeploy/src/upgrade-runners.ts), [mount contract](../../mdeploy/stack/providers/aws/data-disk.ts).
