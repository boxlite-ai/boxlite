# File formats

BoxLite keeps boxes, images, and its database under its home directory, `~/.boxlite` by default.

## Home directory

```text
~/.boxlite/
├── boxes/                     # Per-Box runtime data
│   └── {box-id}/
│       ├── disks/             # disk.qcow2 (container disk), guest-rootfs.qcow2
│       ├── snapshots/         # {name}/disk.qcow2 for each snapshot
│       ├── .snapshot_pending  # Crash-recovery marker while a snapshot runs
│       ├── sockets/           # Unix sockets: control, guest ready, network
│       ├── shared/            # Files shared with the guest over virtio-fs
│       ├── mounts/            # Host side of shared/ (isolate_mounts, Linux)
│       ├── bin/               # Shim binary and libraries the jailer copies in
│       ├── boot/              # Custom kernel and initramfs
│       ├── ca/                # CA for secret substitution, kept from the guest
│       ├── logs/              # Shim logs and console.log (kernel, init)
│       ├── tmp/               # Shim temporary files
│       ├── shim.pid           # Shim process ID
│       ├── shim.stderr        # Shim stderr, for crash diagnostics
│       ├── exit               # Shim exit record: exit code and error details
│       └── exit.previous      # Exit record from the previous run
├── bases/                     # Immutable clone bases and guest rootfs cache
├── images/                    # OCI image cache
│   ├── layers/                # Layer blobs
│   ├── manifests/             # Image manifests
│   ├── configs/               # Image configs
│   ├── extracted/             # Extracted layers
│   ├── disk-images/           # Ext4 disk images that box disks overlay
│   └── local/                 # Caches for images loaded from local OCI bundles
├── volumes/
│   └── anonymous/             # Anonymous volumes the CLI creates
├── db/
│   └── boxlite.db             # SQLite: boxes, images, base disks, snapshots
├── locks/                     # Per-box lock files
├── logs/                      # Daily logs: boxlite.log.*, serve.log.*
├── tmp/                       # Temporary files for disk images being built
├── credentials.toml           # Credentials from boxlite auth login
└── .lock                      # Runtime lock file (prevents multiple instances)
```

The embedded runtime lives outside the home directory, in `boxlite/runtimes/` under the platform's
local data directory: `~/Library/Application Support` on macOS, `~/.local/share` on Linux.

## QCOW2 disk images

BoxLite uses QCOW2 (QEMU Copy-On-Write version 2) for box disks.

**Locations:**
- `~/.boxlite/boxes/{box-id}/disks/disk.qcow2`: the container disk
- `~/.boxlite/boxes/{box-id}/disks/guest-rootfs.qcow2`: the guest root filesystem
- `~/.boxlite/boxes/{box-id}/snapshots/{name}/disk.qcow2`: a snapshot of the container disk,
  recorded in the snapshot table
- `~/.boxlite/bases/{id}.qcow2`: an immutable clone base, tracked in the `base_disk` table

**Format:** QCOW2, a copy-on-write image format with thin provisioning

**Size:** the container disk is never smaller than the image; `disk_size_gb` sets a larger size

**Tools:**
```bash
# Inspect a box's container disk
qemu-img info ~/.boxlite/boxes/{box-id}/disks/disk.qcow2
```

## Raw ext4 images

A box's disks are copy-on-write overlays on read-only ext4 images:

- `~/.boxlite/images/disk-images/*.ext4`: an image's root filesystem, built once from its
  layers, behind container disks
- `~/.boxlite/bases/{id}.ext4`: the guest root filesystem cache, behind guest root filesystem
  disks, tracked in the `base_disk` table

Deleting these files while boxes exist breaks those boxes.

## Checkpoint directories

A full checkpoint contains exactly `snapshot.mem` and `snapshot.qcow2`.
The container disk is standalone QCOW2; shares and the exact readonly boot disk
are external dependencies. Binding configuration is input, not a third artifact.

The memory file starts with a 160-byte little-endian version-9 header:

| Offset | Field |
| --- | --- |
| 0 / 8 / 12 | Eight-byte `KRUNVM\0\0` magic / u32 version 9 / u32 header length 160 |
| 16 / 24 / 32 / 40 | u64 total length / metadata length / payload length / physical QCOW2 length |
| 48 / 80 / 112 | SHA-256 of metadata / payload / full QCOW2 file |
| 144 | Sixteen reserved zero bytes |

Metadata is bounded to 16 MiB and records BoxLite application schema 1,
CPU/KVM/device layout, ordered disk dependencies, FUSE sessions and stable
external object references. Payload contains RAM, init.krun and anonymous DAX
pages; file-backed DAX stores mappings and references, not copied file contents.
Lengths, bounds, supported versions and checksums are validated before restore.
Checksums detect corruption; they do not authenticate a checkpoint.

The RAM region total is mapped memory, including copied kernel and boot regions.
It can exceed the application's configured memory MiB. Import requires matching CPU
counts and enough mapped RAM for that logical setting, while validating every saved
region and payload extent independently. Cold starts retain the configured setting.

Import copies/reflinks the container into box-owned writable QCOW2 and verifies
readonly boot content by full digest. It never modifies the original pair.
Older full formats are explicitly refused without upgrading or converting them.
Disk-only `.boxlite` archives retain their wire compatibility. See the
[checkpoints guide](../guides/checkpoints.md) for providers, publication and lifecycle.

## OCI image cache

BoxLite caches OCI images under `~/.boxlite/images/` at the layer level, so images that share
layers store them once. Missing layers, manifests, and configs are downloaded again on the next
pull.

## SQLite database

BoxLite keeps box configuration and state (`box_config`, `box_state`), the image index
(`image_index`), base disks (`base_disk`), and snapshots in one SQLite database. There are no
per-box configuration files.

**Location:** `~/.boxlite/db/boxlite.db`

**Tools:**
```bash
# List the tables
sqlite3 ~/.boxlite/db/boxlite.db ".tables"
```

Do not modify the database by hand: BoxLite owns its contents.
