# Images

BoxLite uses OCI-compatible container images with intelligent caching.

## Image pull flow

```text
Registry (Docker Hub, GHCR, ECR, etc.)
           │
           ▼
┌─────────────────────┐
│   OCI Client        │  Pull manifest and layers
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   ImageStore        │  Store layers in ~/.boxlite/images/layers/
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Layer Extraction  │  Extract to cached layer directories
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Rootfs Assembly   │  Combine layers for Box rootfs
└─────────────────────┘
```

## Caching strategy

- **Blob-level caching**: Image layers stored by digest, shared across images
- **Layer deduplication**: Common base layers (e.g., debian:slim) extracted once
- **Copy-on-write**: Boxes share base layers, only modifications are per-Box

## Shared ext4

Installing an image's ext4 under `images/disk-images/` writes two database rows:

- `image` maps the image reference to a `disk_key`
- `image_disk` stores that ext4's path, `state=ready`, and the guest image config
  (entrypoint, command, env, user, working directory, exposed ports)

Layer diff IDs are not stored in `image_disk.config`. After the row is ready, BoxLite
deletes that image's layer tarballs, extracted directories, manifest, and config blob.
A path another in-progress build still names is left in place until that build
finishes. The ext4 is the only cache file left for that image once nothing else
needs those blobs.

A new box, while `image_disk` is ready and the ext4 file is present, reads
`image_disk.path` and `image_disk.config` for that image name. Restart reads the same
row through `disk.root`. Neither stats layer tarballs, rereads the manifest, rehashes
the config blob, or requires `image_index.complete`. Box options still override
entrypoint, command, user, and working directory.

A box records `disk(id, root, parent)` in the same statement that confirms
`image_disk` is still `ready`, and only then writes its qcow2. With no snapshot,
`parent` and `root` are both the ext4 `disk_key`. A snapshot or clone records the
previous parent on the new qcow2 and points the container disk's `parent` at that
new qcow2; `root` stays the ext4. Restart reads `disk.root`, so a later retag does
not change an existing box.

If the ext4 file is missing while any `disk.root` points at it, start and restart
fail and do not rebuild that path. `rmi` refuses in that case too, and `--force`
does not override it. `--force` on a live build's last name reads the names and
`disk.root` again before it unlinks. A second name or a `disk.root` that appears
leaves the file and every name in place. A create that has already passed the
failure check and then loses the race to that stop fails immediately and does not
leave its image row behind. A `building` row left by a dead process fails the same way
when a `disk.root` points at it, even if the ext4 file is still there: start does
not pull, delete, or rebuild that path. `rmi IMAGE` on a ready ext4 that another name still uses
deletes only that name. The last name is claimed with one conditional update that
also excludes `disk.root` and a second name. Zero rows leaves the file in
place and `rmi` fails; it does not report success. `rmi --disk-key` and `rmi --unused` use the same kind of conditional update
and also finish a `deleting` ext4 that no name and no disk root still use.

`pull` is still the command name.
