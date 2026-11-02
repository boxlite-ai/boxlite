# Docker inside a Box

Run Docker Engine inside a privileged guest with Docker-capable firmware.
Guest privilege enables container mounts and capabilities while retaining the
runner's VM sandbox. Docker's data lives on the guest writable ext4 disk.

## Runner kernel selection

Cloud deployment installs the standalone DinD ELF and selects it through the
runner's `BOXLITE_KERNEL_PATH`. Self-hosted operators can set the same variable
to an absolute readable kernel file. Newly created Boxes use that kernel;
existing Boxes retain their staged kernel across restarts. Guest privilege
remains an independent per-Box option.

See [runner operations](../../apps/infra/docs/runners.md#cloud-kernel) for
installation and updates. Package builds retain ordinary firmware defaults;
the explicit build-time selection below is useful for local SDK deployments.

## Linux x86_64 firmware

The [libkrunfw v5.4.0 release](https://github.com/boxlite-ai/libkrunfw/releases/tag/v5.4.0)
provides `libkrunfw-kernel-dind-x86_64.bin`. It includes bridge, overlayfs,
netfilter, IPVS and VXLAN support. Ordinary firmware is a separate asset.

Prepare and select this kernel before building the native runtime and SDKs:

```sh
make kernel:dind DIND_FIRMWARE_DIR=/path/to/firmware-dind
export BOXLITE_LIBKRUNFW_SOURCE=/path/to/firmware-dind
make dev:python
make dev:go
```

The helper verifies the release ELF and packages it with the vendored firmware
ABI generator. Keep the override set for subsequent native builds. Removing it
restores ordinary firmware. Rebuild and restart the consuming runtime to load
new firmware; a running VM retains its booted kernel.

## Apple Silicon firmware

On macOS arm64, `make kernel:dind` builds Linux 6.12.87 inside a native BoxLite
guest. Bootstrap the Python SDK with ordinary firmware first:

```sh
make dev:python
make kernel:dind DIND_FIRMWARE_DIR="/path/to/firmware dind" \
  DIND_BUILD_ARGS="--home '/path/to/builder home' --jobs 2"
export BOXLITE_LIBKRUNFW_SOURCE="/path/to/firmware dind"
make dev:python
```

The builder uses two CPUs, 3072 MiB memory and an 8 GiB writable disk. It compiles
on that guest disk with the vendored firmware patches and built-in DinD/Swarm
features, including IPVS and VXLAN. The source checkout is mounted read-only.
The output contains the ARM `Image`, effective `kernel.config`, ABI 5 `kernel.c`
and a Makefile for the host dylib build.

`--home` defaults to `DIND_FIRMWARE_DIR/builder-home`; `--jobs` defaults to two
and must be positive. Set the output and home on external storage when needed.
The output and builder home accept spaces.

For guest downloads, add `--download-proxy URL` to `DIND_BUILD_ARGS`, or set
HTTP(S) proxy environment variables before launching the builder. Its ID is
recorded in `builder-id`, with output in `builder-ID.log`. Success removes the
builder Box; failure stops it and preserves its disk and logs for inspection.

Keep `BOXLITE_LIBKRUNFW_SOURCE` set for subsequent native builds. Removing it
restores ordinary firmware. The build command uses the existing native SDK;
it does not require Docker Desktop or the local cloud stack.

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
await box.start()  # Local runtime; REST creation starts the Box.
```

The image's official `dockerd-entrypoint.sh` initializes DinD mounts and starts
the daemon. Keep its normal bridge, DNS and firewall behavior. A Docker host
network refers to the guest's network namespace.

`advanced.privileged` defaults to false. Python and Node expose that option;
Go provides `AdvancedBoxOptions.SetPrivileged`, and C provides
`boxlite_advanced_options_set_privileged`. Explicit capability overrides
conflict with privilege unless they match the runtime's canonical full policy.
That policy adds only `ALL` (case-insensitive, with an optional `CAP_` prefix)
and drops nothing; C and Go accept it before or after enabling privilege.

REST checks `privileged_enabled` before each privileged creation. Privilege
persists across Box starts. Host security options remain local to the runner.
The capability advertisement describes guest privilege; operators must also
install a Docker-capable kernel. See the [API contract](../../apps/api/README.md#guest-docker-privilege)
for persistence and warm-pool behavior.

Box metadata reports the persisted `privileged` value. Named `get_or_create`
reuses a Box only when that value matches the requested mode, including false.
A mismatch requires another name or recreating the Box. Older REST servers
that omit the field still support ordinary reads; named reuse requires a
server upgrade because an omitted value does not establish the Box's mode.

Cloud runners advertise `supportsPrivileged` in their health reports. Privileged
creation and migration select only runners that explicitly report support.
Recovery keeps the Box's current runner and fails if that runner does not report
support. Ordinary Boxes can continue using older runners during a rolling upgrade.

## Acceptance

`make test:docker:dind` runs D1/D2 against a real Box runtime. Select an SSH
Linux worker or `--runner-a local` for the current Apple Silicon host, with
the built SDK, checkout and evidence directory:

```sh
make test:docker:dind DOCKER_ACCEPTANCE_ARGS="--runner-a local --root '$PWD' --state-root '/path/to/acceptance state' --output '/path/to/evidence'"
```

Use `--python` to select another installed SDK and `--runtime-dir` to select
its native runtime. See [the acceptance harness](../../tests/docker/README.md)
for remote workers and evidence layout.

The test requires successful `docker info`, image pull, a build containing a
unique marker, execution with `--pull=never`, and a two-service Compose app.
The Compose client requests its backend by service name and asserts HTTP 200
and the marker. Commands, exit codes and output are retained. Successful runs
remove their Boxes; failures retain their disks and daemon diagnostics.

The Runner tests below use the pinned Linux x86_64 DinD ELF prepared above and
optionally `BOXLITE_TEST_KERNEL_HOME`:

```bash
BOXLITE_TEST_KERNEL=/path/to/firmware-dind/libkrunfw-kernel-dind-x86_64.bin \
  make test:apps:runner FILTER='TestIntegrationRunner(ExternalKernel|Docker)'
```

Both Runner tests log their home directories and retain failed Boxes and their
homes, including when no home was supplied. A successful run removes only its
own temporary home. Shutdown has a fresh deadline separate from test operations
and Docker failure diagnostics; the log records the stop result.
External-kernel checks use fresh Box names on every run, including with a
persistent home. Ordinary and privileged subtests each have a five-minute budget.

## Limitations

This guide uses Docker 27.5.1 with classic overlay2 on Linux x86_64 and
Apple Silicon.
Deleting the Box deletes its Docker data. REST capability advertisement alone
does not certify an arbitrary runner's kernel or Docker image.
