## TL;DR

GCP observes the first runner for five minutes, then updates the remaining runners in parallel through OS Config.

# GCP runner operations

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

Use the shared [artifact build/promotion](../runners.md#build-and-promote),
[release update](../runners.md#upgrade-or-roll-back-a-release) and [scaling](../runners.md#scale-out) commands.
Development binaries live in the stage's GCS artifact bucket.

## Rollout behavior

Runner VMs carry `boxlite-stage=<stage>` alongside their logical `boxlite-runner` label.
Every OS Config inclusion entry requires both labels, so dev and stage can share a project
and zone without selecting each other's runners. For example, a stage canary requires
`boxlite-stage=stage` AND `boxlite-runner=default`; the dev canary uses `boxlite-stage=dev`.
Separate inclusion entries are ORed, so the stage label must stay inside every runner entry.
These labels isolate policy targeting, not IAM permissions or other applications using the same stage name.

For existing shared-project hosts, narrow every dev/stage Runner assignment before adding stage labels
to VMs. Wait for each new narrowed revision to finish rollout and become the baseline, then add the
correct stage label while preserving existing labels. Changing labels is an in-place operation;
it does not replace VMs or disks. Preserve policy scripts, target versions and rollout settings.
Do not run an older deployment during or after migration: it can restore the unscoped selectors.
Inspect both environments afterward; narrowing selectors does not undo earlier wrong-environment execution.

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

Each assignment carries binary, unit-environment and NFS client package policies. An update converges
the API address, volume backend, registry proxy host and `nfs-common`; the package policy also covers
existing hosts whose startup script predates Filestore, without requiring SSH or a boot-script rerun.
`runner:update` preserves existing package policies but cannot add one to an older assignment; run
mdeploy first to add `runner-nfs-client`. New hosts install the same package from their boot script. Existing hosts retain their disks, image
caches and local box state; machine-type and boot-image/startup changes do not resize or replace them.
New hosts use the current [runner sizing settings](../configuration.md#runner-sizing).

`runner:update` checks host stage labels and both assignments' exact stage-and-runner selectors before
writing, refusing legacy or mismatched scopes, then updates them in the same order. It waits
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
200 GiB by default, with optional `deploy.runners.dataDiskGb` selecting its capacity at creation.
Performance stays at 3,600 IOPS and 290 MiB/s (240 MiB/s on `small`, the n4-standard-4 limit). Box state lives on it:
the boot script formats a blank disk once and mounts it at `/var/lib/boxlite` with `nofail`, so `rootDiskGb`
sizes only the boot disk. The runner unit requires that mount: a host whose disk does not mount still boots
and stays reachable, with the runner stopped: `systemctl status var-lib-boxlite.mount` says why, or
`/var/log/runner-setup.log` when the boot script refused a disk that was missing, not blank, or would hide data.
A deploy sets size and performance only at creation and never
changes them back, so grow the disk online; the disk is protected, so a deploy that would replace it fails.
Each host's unit environment names its own disk — `GCP_PROJECT_ID`, `GCP_ZONE` and `RUNNER_DATA_DISK_NAME`, converged by
the same OS policy as the rest of the unit environment, each host reading its own row of the fleet table — which is what the
control plane reads to grow the disk online without a deploy. The resize grant is the API's alone, bounded to this stage's
data-disk prefix in this zone.
The attachment is fixed at creation too: a host that existed before its disk does not get it attached,
and that disk stays unattached, and billed, until the host is destroyed and recreated; a `--replace`
would carry the ignored attachment over.

## Guarded Runner pool

Use a dedicated GCP Runner pool and qualify its exact image and running kernel
before opening placement. Verify active BPF LSM, cgroup v2, kernel BTF, bpffs,
and `bpftool` on the intended host.

Confirm the kernel can run the pinned lease renewal program.

Run `make test:platform-guard-bpf` on an isolated host with the same kernel.
On the target Runner, test Cloud launch, detached reattachment, and expiry.

Build with `make build:platform-guard` and install the artifacts on the Runner.

- Place the binary at `/usr/local/bin/boxlite-platform-guard`.
- Place the BPF object at `/usr/lib/boxlite/deadline.bpf.o`.
- Install the [systemd service unit](../../../runner/platform-guard/boxlite-platform-guard.service).

Enable the guard service and configure Runner to start after it.
The root service retains live pins and records across service restarts on the
same boot. It reclaims retired pins once the cgroup is confirmed empty.

Publish `/etc/boxlite/platform-guard/inventory.json` in a root-owned directory
outside Box mounts. Give only root write access and replace the file atomically.

Include all four protected network groups and approved IPv4 resolver endpoints
with explicit ports. Use an RFC 3339 expiry and an inventory revision independent
of Box rule revisions.

```json
{
  "version": 1,
  "revision": "canary-12",
  "expires_at": "2030-01-01T00:00:00Z",
  "protected_networks": {
    "node": ["192.0.2.0/25"],
    "control_plane": ["198.51.100.0/24"],
    "metadata": ["169.254.169.254/32"],
    "services": []
  },
  "resolver_endpoints": ["192.0.2.53:53"]
}
```

Set `BOXLITE_PLATFORM_GUARD_PROFILE=cloud` and `BOXLITE_REQUIRE_CLOUD_GUARD=1`
in the guarded Runner's service environment. Startup requires a valid
inventory, a successful kernel attachment probe, and proof for each running
networked Box. A Box without proof is stopped through its cgroup, and an
unconfirmed stop or populated untracked cgroup blocks Runner startup.

Check the private gvproxy control endpoint `GET /network/platform-guard/status`
for the active operator revision and digest. Record the GCP image and kernel
identifiers with positive and negative guard results before admitting work.
For binary rollback, drain the guarded pool and keep placement closed until
running and new Boxes have verified equivalent protection.

### Qualify a dual-stack pool

Deploy v2-capable API, Runner, Runtime, shim, and host guard readers before
switching inventory. Set the complete outbound release floor to the verified
release and renew the Runner enrollment against that floor.

Inventory v2 retains the v1 fields and adds `host` and `translation` to
`protected_networks`. List every empty group by name in `absent_groups` only
when the deployed topology confirms that the group is absent.

Use `topology_sha256` to pin the applied network state. The host guard reads the
Linux routes, policy rules, nftables ruleset, and legacy IPv4 and IPv6 NAT
tables. Route lifetimes and firewall packet and byte counts are excluded from
the fingerprint.

The operator attests that these sources cover the pool's routing and
translation and lists the affected CIDRs in the inventory. An unreadable
source, missing IPv6 uplink, or mismatched digest blocks qualification.

1. Call `pause-topology` on the root-only
   `/run/boxlite-platform-guard/control.sock` with an empty Box identity. This
   revokes running leases and succeeds after all guarded Boxes, including
   IPv4 Boxes, are drained.
2. Apply the managed topology change. Send
   `{"operation":"sample-topology"}` on the same socket and put the returned
   `topology_sha256` in the new inventory.
3. Publish the root-owned inventory atomically. Send
   `{"operation":"resume-topology"}` and keep placement closed until the guard
   and network-path checks pass. Use the same pause and drain sequence before
   reverting the pool to inventory v1.

An unexpected inventory swap or changed applied topology retires the live
epoch. Restart a drained IPv4 Box only after the current inventory and host
guard provide a fresh startup proof.

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
