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

To select a staged runner in a local deployment, set `RUNNER_ARTIFACT_SOURCE=build` and
`RUNNER_ARTIFACT_REF=<full-sha>` alongside a valid `BOXLITE_IMAGE_TAG`, then preview with mdeploy.
The [one-dispatch workflow](deployment.md#deploy-through-github-actions) prepares these values for you.

### Development firmware

`runner:build` uses `apps/runner/packaging/dev-artifact.Dockerfile` to embed the
checksum-pinned v5.4.0 DinD kernel. The shared
`scripts/build/prepare_dind_firmware.py` verifies both downloaded and cached
ELF bytes, packages them with the vendored ABI generator, and writes
`SHA256SUMS`. Local Linux acceptance uses the same helper and pin.

The Dockerfile keeps `BOXLITE_LIBKRUNFW_SOURCE` set through both runtime and
C SDK builds; a command-scoped override would let the second build restore
ordinary firmware. This choice is committed with the artifact identity, so
changing firmware requires a new commit rather than a deployment flag.

For dev, dispatch `mdeploy-all` from branch `x_features` with the `ref` input
empty. Do not enter `x_features` in `ref`: that input accepts a commit SHA,
PR number or release tag, and rejects branch names.

Every Box on the updated runner uses the DinD kernel on its next start.
Restart running Boxes after rollout; they retain their old kernel until then.
The runtime cache includes a hash of its embedded contents, so hosts need no
cache cleanup. Follow the [DinD guide](../../../docs/guides/docker-in-docker.md)
for guest options and acceptance checks. The published release runner still
links the prebuilt C SDK and keeps its existing firmware selection.

## Upgrade or roll back a release

```bash
npm run runner:update -- --stage dev --version <X.Y.Z>
npm run runner:update -- --stage prod --version <X.Y.Z> --confirm
npm run runner:update -- --stage dev --version <X.Y.Z> --allow-downgrade
```

Omitting `--version` selects the checkout's version. The release downgrade guard requires
`--allow-downgrade` for an intentional rollback. Commit builds are installed through deployment.
Read each host's outcome; a skipped or bootstrapping host is not proof it serves the target version.

The API places a box with a read-only managed volume only on a runner reporting version 0.10.8 or
later (`READ_ONLY_VOLUMES_MIN_RUNNER_VERSION` in `apps/api/src/box/utils/runner-version.util.ts`);
an older runner would bind the volume read-write. Until such a runner is up, those creates return
400, whatever order the API and runners deploy in.

## Scale out

`RUNNERS` controls the declared fleet count. Set it in the encrypted stage store, update the digest,
and preview the same artifact selection you intend to deploy:

```bash
npm run mstage env set -- RUNNERS=2 --stage dev --digest
```

Review that the diff creates the additional host without replacing existing hosts. Then apply and
check registration, target version, capacity and a test box on the new host. Extra runners have
individual registration tokens. Machine size and root disk size come from `deploy.runners` in the stage declaration;
a GCP host's data disk is sized by its machine size.

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
