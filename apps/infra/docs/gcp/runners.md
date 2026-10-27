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
A second policy converges the few unit-environment keys a deploy can move — the API address, the volume
backend and the registry proxy's host — onto hosts booted before them.
Pulumi completion means the policy exists; agents converge asynchronously.

`runner:update` rewrites the fleet policy and waits for reports. It refuses `--host`;
the next mdeploy reasserts the checkout's policy target. Both paths verify binary checksums and readiness.
Already-converged hosts need no restart. Release downgrades require the explicit `--allow-downgrade` update command.
IAP/OS Login remains available for authorized administration, but normal updates do not require per-user SSH.

## Data disk

Each host gets its own Hyperdisk Balanced disk, `<app>-<stage>-runner-data[-N]`, attached as `boxlite-data`:
200 GiB by default, with `deploy.runners.dataDiskGb` or a per-instance override selecting its initial capacity.
Performance stays at 3,600 IOPS and 290 MiB/s (240 MiB/s on `small`, the n4-standard-4 limit). Box state lives on it:
the boot script formats a blank disk once and mounts it at `/var/lib/boxlite` with `nofail`, so `rootDiskGb`
sizes only the boot disk. The runner unit requires that mount: a host whose disk does not mount still boots
and stays reachable, with the runner stopped: `systemctl status var-lib-boxlite.mount` says why, or
`/var/log/runner-setup.log` when the boot script refused a disk that was missing, not blank, or would hide data.
A deploy sets size and performance only at creation and never
changes them back, so grow the disk online; the disk is protected, so a deploy that would replace it fails.
The attachment is fixed at creation too: a host that existed before its disk does not get it attached,
and that disk stays unattached, and billed, until the host is destroyed and recreated; a `--replace`
would carry the ignored attachment over.

## Replace two runners with one larger host

Use the [explicit fleet example](../configuration.md#runner-fleet-sizing) to add slot 3 as `large`
with `dataDiskGb: 2048` and a 100 GiB boot disk. GCP `large` is `n4-standard-16`: 16 vCPU and 64 GiB RAM.
2048 GiB is 2 TiB. Preserve the existing slots' names, defaults, tokens and protection.

### Add and verify

1. Deploy the API drain/retirement changes before starting drain. Check regional CPU/Hyperdisk quota,
   snapshot storage access, and aggregate workload capacity, including export/import staging space.
   The scheduler does not reserve the total requested resources for this replacement.
2. Publish the updated stage declaration to its CI configuration when using CI. Keep `primary: "default"`
   initially. Preview the [selected artifacts](../deployment.md#deploy-an-existing-stack); expect only slot 3's
   VM/data disk, its token, registration and fleet-policy updates. Stop on any replacement of old hosts or disks.
3. Apply the reviewed addition. Wait for registration, health and OS Config convergence. Verify on the new host:

   ```bash
   nproc
   free -h
   lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS
   findmnt -T /var/lib/boxlite
   df -h /var/lib/boxlite
   systemctl is-active boxlite-runner
   ```

   Require a separate data filesystem mounted at `/var/lib/boxlite`, approximately 2 TiB capacity,
   and a working `/dev/kvm`. A 100 GiB root filesystem at that path means verification failed.
4. Create, execute in, stop and restart a test box on the new host. Include tunnel and managed-volume
   checks used by this stage. Verify one stopped box can migrate from an old host and retain its data
   before draining the second old host.

### Drain

Use [runner-drain in GitHub Actions](../runners.md#request-drain-through-github-actions) with the
old control-plane names (for example `default,runner-2`). It sets the drain flags and exits after
API acceptance. Continue inspecting progress separately; CI success does not mean the hosts are empty.

List `/api/admin/runners` to map names to UUIDs. Use an administrator credential from the stage's
secret store; keep it out of logs. For each old UUID, request drain directly if not using CI, then inspect progress:

```bash
curl --fail-with-body -X PATCH "$API_URL/api/admin/runners/$OLD_RUNNER_ID/draining" \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  --data '{"draining":true}'
curl --fail-with-body "$API_URL/api/admin/runners/$OLD_RUNNER_ID/draining" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Keep both old hosts online while boxes stop and migrate. Do not force-stop user workloads.
Require `decommissioned` and zero assigned boxes, active migrations and pending jobs on each old host.
Investigate stalled migration/job work before proceeding; an empty dashboard box list is insufficient.
Before decommissioning, cancellation uses `{"draining":false}` and leaves all instances declared.

### Retire

1. While all three slots remain declared, change `primary` to `runner-3` and deploy. Verify the API's
   default registration now names the survivor and uses its existing token. This prevents a future API
   restart from recreating the old default registration.
2. Recheck both old drain statuses and the new host's workload health. Record exact cloud names and
   state URNs. Inventory old boot/data disks, including unattached data disks created after the old VMs;
   confirm required data is migrated or retained before approving deletion.
3. Set the final declaration to the following, preserving slot 3 exactly:

   ```json
   {
     "size": "small", "rootDiskGb": 100, "primary": "runner-3",
     "instances": [{ "slot": 3, "name": "runner-3", "size": "large", "dataDiskGb": 2048 }]
   }
   ```

4. Preview removal. Protected-resource errors are expected until the reviewed retirement is authorized.
   Freeze concurrent deployments. Disable GCP deletion protection only on the two retired VMs, refresh
   state, then use [mstage state edit](../../mstage/README.md#state-recovery) to clear `protect` only on
   their VM/data-disk records (`Runner`, `Runner-runner-2`, `RunnerData`, `RunnerData-runner-2`).
   Preserve every record and all other protection. Never use whole-stage `--remove` for this operation.
5. Preview again and approve the exact removals. Slot 3, its disk and token must have no replacement or
   deletion. Apply the final declaration; check old boot disks' auto-delete settings and separately
   review any retained/unattached disks before cleanup. Confirm slot 3 still serves migrated boxes.
6. Mark each old registration unschedulable through `PATCH /api/admin/runners/<id>/scheduling`
   (`{"unschedulable":true}`), then `DELETE /api/admin/runners/<id>`. The API rechecks outstanding work.
   Keep the final declaration synchronized locally and in CI so a later deploy cannot recreate old slots.

After cloud removal, restoring an old host requires retained data/backups and a new deployment;
clearing the drain flag is no longer a rollback. Keep deletion separate from the initial addition.

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
