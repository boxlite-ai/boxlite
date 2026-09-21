# Local OverlayBD acceptance (PR3)

This opt-in connects a verified local converted image to a shared read-only
UBLK device, with an independent writable qcow2 for each box. It does not fetch
OverlayBD layers from registries or convert images during box creation.
Ordinary SDK `NewRuntime`, CLI and `boxlite serve` keep the OCI pipeline even
when the environment variable is set. Only the explicit cloud runner constructor
can enable this backend; compile its native library with `CLOUD_RUNNER=1`.

## Fixture

Prepare a **native OverlayBD 0.1.0, single-platform Linux image** using the
[upstream converter](https://github.com/containerd/accelerated-container-image/tree/main/cmd/convertor).
Match the runner architecture. TurboOCI, tar layers, and image indexes are not
supported. A converter working directory alone is not an OCI layout: the input
must contain the converted manifest, OCI image configuration and every layer
under `blobs/sha256/<hex>`.

For an already converted registry image, export on any machine with registry
access using [skopeo copy](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md):

```sh
# Replace the reference with the converted single-platform manifest digest.
export OVERLAYBD_TEST_IMAGE='registry.example.com/team/alpine-obd@sha256:CONVERTED_MANIFEST_DIGEST'
export BOXLITE_OVERLAYBD_IMAGE_DIR="$PWD/overlaybd-fixture"
skopeo copy --preserve-digests --dest-oci-accept-uncompressed-layers \
  "docker://$OVERLAYBD_TEST_IMAGE" "oci:$BOXLITE_OVERLAYBD_IMAGE_DIR:fixture"
```

Do not use the original OCI image digest. The converter changes its manifest.
Export must preserve native layer bytes and descriptor annotations; import
rejects missing annotations, wrong hashes, sizes, architecture or OS.
Transfer the entire layout to the test Linux machine. EC2 access is not needed
to prepare it; Linux VM/runner access is needed for the device/VM acceptance.

## Linux host and build

Use a kernel with `ublk_drv` (mainline Linux 6.0+ or a backport), KVM, and the
normal BoxLite runtime prerequisites. Install the upstream daemon and its
dependencies separately. This implementation targets the `/v1/list`, `/v1/add`
and `/v1/del` API at OverlayBD commit
[`29ace5a7f78be6eeab79fd0bac1b74d3445f4b89`](https://github.com/containerd/overlaybd/blob/29ace5a7f78be6eeab79fd0bac1b74d3445f4b89/src/ublk/ublkd_main.cpp#L173);
do not assume older release packages contain this daemon.

```sh
sudo modprobe ublk_drv
sudo systemctl start overlaybd-ublkd  # install the upstream unit first
make dev:go CLOUD_RUNNER=1
```

Run the cloud runner/test with access to the root-only daemon socket
`/var/run/overlaybd-ublk/ublkd.sock`, its `/dev/ublkbN` nodes, and `/usr/bin/curl`.
The daemon and runner must see the same absolute runtime-home paths and device
namespace. A container deployment must provide these explicitly; this PR does
not modify deployment privileges or install/start the daemon automatically.
Set `BOXLITE_OVERLAYBD_ENABLED=true` and `BOXLITE_OVERLAYBD_IMAGE_DIR` for the
runner. Production native packaging also accepts `make dist:go CLOUD_RUNNER=1`.

## Acceptance

Use a disposable Linux host with a converted image containing `/bin/sh`, `cat`
and `sleep`. Build the Go native library above, then run with the same operator
permissions as the runner:

```sh
make test:integration:overlaybd
```

The test creates its own runtime home and two boxes. It verifies one shared
device, independent writable files, continued I/O after one box stops, device
release after both stop, and preserved writes after restart/rebinding. It cleans
up its own boxes only. The target fails on non-Linux or missing fixture settings.

Unit tests exercise real Unix-socket HTTP with a simulated daemon, blob import,
backend selection and qcow2 headers. They do **not** establish kernel/device,
bubblewrap/Landlock or libkrun compatibility. Real Linux acceptance is required
before enabling this in a deployed runner.

## Lifetime and limits

Verified blobs are cached under `<home>/overlaybd/blobs`; source layout removal
does not invalidate an existing box, including after runtime restart. The source
directory is required only when importing a new image. Each image's device config
is local-only, with no writable upper layer. The kernel read-only flag and capacity are checked
before using a node as backing. Box stops release references; the last reference
deletes the device. Runtime recovery retains devices owned by surviving shims
and reclaims only its own unused device configs. If reconciliation fails,
runtime initialization fails without stopping recovered shims; restore daemon
access and retry initialization. Keep the daemon alive while
boxes run; a vanished device is an error, not a transparent replacement.

Clone, export and snapshot mutations remain rejected for OverlayBD boxes.
Disabled/local runtimes cannot freshly start them. Keep a cloud build available
to reclaim devices after disabling the opt-in. Blob cache GC, remote lazy pulls
and automatic daemon recovery are deferred. A changed device number requires
an atomic qcow2 copy/rebind; filesystems without reflink may incur a disk copy.
