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
