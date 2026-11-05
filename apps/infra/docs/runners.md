## TL;DR

Build and select runner artifacts with shared commands, then follow the selected cloud’s rollout procedure.

# Shared runner operations

[Infrastructure index](../README.md)

| Cloud | Guide |
| --- | --- |
| AWS | [Serial SSM updates and host selection](aws/runners.md) |
| GCP | [OS Config policies and fleet convergence](gcp/runners.md) |

## Identity and lifecycle

Runners contain the Go service, Go SDK/FFI, Rust BoxLite runtime and nested-KVM box VMs.
Image caches and local box state live in `/var/lib/boxlite`: on the root disk on AWS, on a per-host
[data disk](gcp/runners.md#data-disk) on GCP. Hosts are protected resources;
changing the boot image or startup script does not replace an existing runner during ordinary deployment.

| Artifact | Identity | Location |
| --- | --- | --- |
| Published release | `X.Y.Z`, from workspace version or `VERSION` override | GitHub Release tarball and checksum |
| Development build | Version plus full commit SHA | Stage artifact bucket under `runner/<sha>/` |
| Container images | Commit SHA or `vX.Y.Z-<sha>` | Stage container registry; independent of runner binary |

Use new image tags or digests when box-image bytes change; a runner can retain an already-cached ref.

## Build and promote

Run from `apps/infra`. The checkout, including submodules, must be clean for a build.
Use the repository Make targets for ordinary runner development; these commands publish deployment artifacts.

```bash
npm run runner:build -- --stage dev --check --tag <full-commit-sha>
npm run runner:build -- --stage dev
npm run runner:promote -- --tag <full-commit-sha> --from dev --to prod
```

Build creates Linux AMD64 bytes and stages them in the selected cloud’s artifact bucket. Publication is write-once;
a modified binary needs a new commit identity. Promotion copies staged bytes between compatible stages.
The current production workflow still requires a release ref; staging a commit does not bypass that rule.

The development artifact Dockerfile copies Rust workspace members explicitly, including
`apps/e2e/sdks/rust`. When adding a workspace member, update
[`dev-artifact.Dockerfile`](../../runner/packaging/dev-artifact.Dockerfile) as needed:
Cargo loads every member's manifest even when building only the guest or runtime.

To select a staged runner in a local deployment, set `RUNNER_ARTIFACT_SOURCE=build` and
`RUNNER_ARTIFACT_REF=<full-sha>` alongside a valid `BOXLITE_IMAGE_TAG`, then preview with mdeploy.
The [one-dispatch workflow](deployment.md#deploy-through-github-actions) prepares these values for you.

## Cloud kernel

Cloud deployment installs the standalone
[`v5.4.0` DinD x86_64 kernel](https://github.com/boxlite-ai/libkrunfw/releases/tag/v5.4.0)
independently of the runner package. Its URL and expected SHA256 are declared in
[`mdeploy/stack/runner-kernel.ts`](../mdeploy/stack/runner-kernel.ts). Package builds
retain their ordinary firmware.

The host downloads and verifies the kernel before selecting it through
`BOXLITE_KERNEL_PATH` in `/etc/boxlite/kernel.env`. A systemd drop-in loads this file.
AWS updates and GCP policy enforcement also compare the kernel pin, so changing only
the kernel triggers convergence even when the runner identity is unchanged.

An unchanged healthy installation does not restart the runner. After a restart,
activation waits for the runner's loopback HTTP health endpoint to return its version
and `custom_kernel: "supported"`. Older binaries without this capability fail
kernel readiness even when their version is newer than the selected package.
The listening process must match the systemd unit's main process, so another service
on the same port cannot satisfy readiness. Boot installs `iproute2` for this check.
Convergence checks the complete environment file and the main process's startup
`BOXLITE_KERNEL_PATH`. Conflicting assignments or a process still using an older
path trigger a restart, even when the files already select the intended kernel.
The configured health port must be an integer from 1 to 65535; invalid ports fail
before script generation.

An installed runner remains eligible for convergence when it is active but disabled
for automatic startup. Kernel installation and convergence share a host lock;
an overlapping kernel operation fails without changing kernel configuration and
can be retried after the current operation finishes.

Kernel downloads retry transient failures up to five times, with a two-second retry
delay and a 120-second deadline across the complete download. Exhausted retries
leave configuration untouched. Failed initial backup copying removes its temporary
backup and leaves the running service and configuration untouched. Failed activation
attempts both configuration restores, a systemd reload and a restart, even if an earlier recovery
step fails. Incomplete recovery retains the backups and reports their location;
activation failure always reports failure to the rollout.
Refusing a runner binary downgrade still allows environment and kernel convergence.

Runner environment convergence retains the target stage settings once their rewrite
is verified. A restart failure reports failure and requires service-log diagnosis;
it does not restore previous endpoints that may no longer serve the stage.

New Boxes inherit this kernel, including ordinary unprivileged Boxes. Docker still
requires the separate guest privilege option. Each Box retains its prepared kernel
across stop/start; changing the runner setting affects subsequently created Boxes.
Runtime construction validates that the configured kernel is an absolute readable file.

For a self-hosted runner, set `BOXLITE_KERNEL_PATH` to an installed compatible kernel
before starting the service. Leaving it unset keeps the bundled firmware default.
Keep it configured while managing existing custom-kernel Boxes so their runtime
retains the feature opt-in required to restart them.
Custom-kernel selection is a local runtime capability; REST clients cannot supply
host kernel paths. See the [custom-kernel guide](../../../docs/guides/custom-kernel.md)
for SDK opt-in and kernel persistence.

## Upgrade or roll back a release

```bash
npm run runner:update -- --stage dev --version <X.Y.Z>
npm run runner:update -- --stage prod --version <X.Y.Z> --confirm
npm run runner:update -- --stage dev --version <X.Y.Z> --allow-downgrade
```

Omitting `--version` selects the checkout's version. The release downgrade guard requires
`--allow-downgrade` for an intentional rollback. Commit builds are installed through deployment.
Read each host's outcome; a skipped or bootstrapping host is not proof it serves the target version.

## Scale out

`RUNNERS` controls the declared fleet count. Set it in the encrypted stage store, update the digest,
and preview the same artifact selection you intend to deploy:

```bash
npm run mstage env set -- RUNNERS=2 --stage dev --digest
```

Review that the diff creates the additional host without replacing existing hosts. Then apply and
check registration, target version, capacity and a test box on the new host. Extra runners have
individual registration tokens. Machine size and root disk size come from `deploy.runners` in the stage declaration;
optional `dataDiskGb` selects a new GCP host's data disk capacity. Existing GCP hosts retain their machine types
and disk sizes. See [runner sizing](configuration.md#runner-sizing) for defaults and configuration ownership.

Scale-in is a separate retirement operation: reducing a count attempts to delete a protected host,
and on GCP its protected data disk.
Drain or migrate boxes and preserve required local data before designing a reviewed retirement.
Do not disable protection merely to make an unexpected diff pass.

## Verify and recover

1. Confirm each expected instance is running and registered with the control plane.
2. Inspect rollout results using the [GCP](gcp/runners.md#verify-and-recover) or [AWS](aws/runners.md#verify-and-recover) procedure.
3. Check runner health identity, then create, execute in and stop a test box.
4. Verify a preview/tunnel and any persistent-volume mount used by the stage.

A checksum/readiness failure differs from a registration failure. Use [state recovery](../mstage/README.md#state-recovery)
for locks or pending checkpoint operations. Infrastructure success, rollout results and working boxes are separate checks.

Sources: [binary identity](../mdeploy/stack/runner-binary.ts), [fleet](../mdeploy/stack/runners.ts),
[build](../mdeploy/src/runner-build.ts), [promotion](../mdeploy/src/runner-promote.ts),
[operator update](../mdeploy/src/runner-update.ts).
