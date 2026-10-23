## TL;DR

Run Docker inside a privileged Box guest using firmware built with Docker's
networking features; the runner's host sandbox remains enabled.

## Build the runtime

On Linux x86_64, `make kernel:dind` prepares the checksum-pinned
[`v5.4.0` DinD ELF release](https://github.com/boxlite-ai/libkrunfw/releases/tag/v5.4.0)
with the vendored firmware ABI generator. Run `make _ensure-python-deps` first.
This packages the downloaded kernel without rebuilding or modifying it.

The x86_64 release asset was replaced on 2026-10-23 with a kernel containing
built-in IPVS and VXLAN. When upgrading an existing checkout, move its
`.apps-local/runner-acceptance/firmware` directory aside before preparing the
firmware again. A cached file with the previous checksum is rejected; the helper
does not automatically replace it. Rebuild the runtime and restart its runners
and Boxes to use the replacement kernel.

On Apple Silicon macOS, the DinD firmware build uses a pinned
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
The macOS-built guest reports `6.12.87-boxlite-dind`; the published x86_64
kernel reports `6.12.87`. Verify the packaged kernel's checksum and runtime
behavior before qualifying Docker. The refreshed x86_64 DinD kernel includes
Swarm's IPVS/VXLAN features; the [Swarm guide](docker-swarm.md) covers the required
network setup and separate runtime checks.
This does not enable user-supplied kernel paths in REST.

The macOS builder explicitly starts its Box, bounds execution, retains failed disks
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
For Swarm kernel requirements and cross-Box overlay setup, use the separate
[Swarm guide](docker-swarm.md).

## Real acceptance

Run each command separately. The isolated stack uses API port 13001 and runner
ports 13003/13004; both local runners reside on the same physical host.

```sh
make test:runner-ci:infra
# If this stack already exists, use ACTION=restart instead of starting again.
make test:runner-ci:dind
```

On rootless Linux, start the isolated stack from a delegated user scope:
`systemd-run --user --scope --quiet make test:runner-ci:infra`
(add `ACTION=restart` for an existing stack). A writable target cgroup alone
does not establish migration permission from a login-session cgroup. Confirm
the actual VM PID belongs to its Box cgroup. On the validated host, launching
from the login session left orphan VMs after force removal; the delegated
scope avoids that condition. The runtime's silent handling of migration errors
is a remaining defect, documented in the
[Linux investigation](../contributing/investigations/2026-10-22-linux-dind-swarm-validation.md).

If this machine requires a proxy for registry/package downloads, set
`BOXLITE_ACCEPTANCE_DOWNLOAD_PROXY` to a proxy URL reachable from the guest.
The harness explicitly passes it to guest package tools and dockerd; Compose
and Swarm service containers do not inherit it, and their HTTP tests assert
that proxy variables are absent. This does not provide overlay connectivity.
The isolated PostgreSQL/Redis fixtures keep their data on guest disks, avoiding
host shared-directory ownership requirements; deleting those fixtures resets
their state.

D1 asserts guest dockerd, `docker info`, pinned-image pull, a build containing a
unique marker and execution with `--pull=never`. D2 starts a two-service Compose
application and requires HTTP 200 plus that marker through its service name.
Readiness has deadlines. Normal completion removes the Compose application and
Box; failure retains the Box, daemon log and guest command log under
`.apps-local/runner-acceptance/`. These logs can contain private runtime details;
publish only a reviewed, redacted summary.

A cold image can exceed the API's 30-second synchronous startup wait while
creation continues in the runner. The acceptance helper recognizes that exact
timeout, retrieves the accepted Box by its unique name, verifies the returned
ID and waits within its overall deadline. It never repeats the create request.
