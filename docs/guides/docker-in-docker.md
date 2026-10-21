## TL;DR

Run Docker inside a privileged Box guest using firmware built with Docker's
networking features; the runner's host sandbox remains enabled.

## Build the runtime

The DinD firmware build currently targets Apple Silicon macOS. It uses a pinned
Ubuntu builder image, checksum-verified Linux 6.12.87 and the vendored libkrunfw
patches. Netfilter, bridge, cgroups and overlay support are built into the kernel;
the guest does not need a host module directory. The ordinary prebuilt firmware
does not include all these features.

From the repository root, with the local Python SDK already installed:

```sh
make kernel:dind
export BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware"
make dev:runner-ci
```

Keep `BOXLITE_LIBKRUNFW_SOURCE` set for subsequent native builds and regression
tests. The native build compiles that directory's kernel.c into libkrunfw and
packages it through the normal runtime build. Removing the override selects the
ordinary prebuilt firmware again. `SHA256SUMS` identifies the generated inputs.
The actual guest reports `6.12.87-boxlite-dind`; verify that identity before
qualifying Docker. This does not enable user-supplied kernel paths in REST.

The builder explicitly starts its Box, bounds execution, retains failed disks
and streams build diagnostics. A successful build removes its builder Box.

## Create a Docker guest

```python
options = boxlite.BoxOptions(
    image="docker:27.5.1-dind",
    cpus=2,
    memory_mib=2048,
    disk_size_gb=10,
    advanced=boxlite.AdvancedBoxOptions(privileged=True),
    env=[("DOCKER_TLS_CERTDIR", "")],
    cmd=["--storage-driver=overlay2", "--data-root=/var/lib/docker"],
)
box = await runtime.create(options)
```

Use a configured `Boxlite.rest(...)` runtime for the API/runner path. A local
runtime additionally requires `await box.start()` after creation. Docker Engine
runs in the guest; no runner Docker socket or host module directory is mounted.

`advanced.privileged` defaults to false. REST requires the server's
`privileged_enabled` advertisement and rechecks it before privileged creation.
The field describes guest privilege, not a guarantee about an arbitrary runner's
kernel or Docker installation. Deploy the matching runtime on eligible runners.
The API persists the option across starts and excludes privileged requests from
warm-pool reuse. Explicit host security options remain rejected by REST; cloud
capability add/drop policies remain unsupported.

The corresponding Node option is `advanced.privileged`; Go exposes
`AdvancedBoxOptions.SetPrivileged`, and C exposes
`boxlite_advanced_options_set_privileged`. The reference server and `boxlite serve`
accept the same guest option. Conflicting explicit capability overrides fail.

## Storage, networking and lifecycle

This configuration uses Docker 27.5.1, classic `overlay2`, and
`/var/lib/docker` on the guest writable ext4 disk. Daemon-managed containerd data
is within Docker's data root; the containerd image store is not enabled.
Deleting the Box deletes that writable disk. Cache reuse belongs to the separate
[runner cache contract](runner-local-cache.md) and needs its own qualification.

Keep Docker bridge networking, DNS, IP forwarding and firewall rules enabled.
Do not use `--iptables=false` to work around missing kernel support. The
Docker host is the guest, so Docker's host networking also refers to the guest.
This guide does not qualify Swarm or cross-Box overlay networks.

## Real acceptance

Run each command separately. The isolated stack uses API port 13001 and runner
ports 13003/13004; both local runners reside on the same physical Mac.

```sh
make test:runner-ci:infra
# If this stack already exists, use ACTION=restart instead of starting again.
make test:runner-ci:dind
```

D1 asserts guest dockerd, `docker info`, pinned-image pull, a build containing a
unique marker and execution with `--pull=never`. D2 starts a two-service Compose
application and requires HTTP 200 plus that marker through its service name.
Readiness has deadlines. Normal completion removes the Compose application and
Box; failure retains the Box, daemon log and guest command log under
`.apps-local/runner-acceptance/`. These logs can contain private runtime details;
publish only a reviewed, redacted summary.
