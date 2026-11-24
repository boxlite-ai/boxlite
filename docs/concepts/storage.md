# Storage

## Rootfs preparation

The rootfs builder assembles a container filesystem from OCI image layers:

```text
Image Layers          Rootfs Builder              Box Rootfs
┌─────────┐          ┌─────────────┐          ┌─────────────┐
│ Layer 1 │────┐     │             │          │ /bin        │
├─────────┤    │     │  Extract &  │          │ /etc        │
│ Layer 2 │────┼────▶│   Overlay   │─────────▶│ /usr        │
├─────────┤    │     │             │          │ /var        │
│ Layer N │────┘     └─────────────┘          │ ...         │
└─────────┘                                   └─────────────┘
```

**Key operations:**

- Layer extraction and overlay mounting
- DNS configuration injection
- Copy-on-write snapshot creation

## Volume management

**Supported volume types:**

| Type           | Description              | Use Case                             |
|----------------|--------------------------|--------------------------------------|
| **virtiofs bind** | Caller-selected host directory or file | Sharing a specific host path with a box |
| **Named local volume** | BoxLite-managed directory shared over virtio-fs | Persistent data shared independently of box lifecycle |
| **QCOW2 disk** | Copy-on-write disk image | Box-private root filesystem, kept while the box exists |

Named volume identity and payload are separate: `{volume-id}/.metadata.json` stores id, name, and
creation time, while only `{volume-id}/_data/` is exposed to the guest. Box configuration stores the
canonical id rather than the host path. Volume removal is blocked while any persisted box
configuration references that id. See [Mounting volumes](../guides/volumes.md).

**QCOW2 features:**

- Thin provisioning (allocate on write)
- Snapshot support
- Shared base images across Boxes

## Disk snapshots

On a running local libkrun box, snapshot creation drains and flushes the container disk
and switches future writes to a new QCOW2 layer. The guest keeps running in the same VM
with its RAM. The snapshot captures the disk at a crash-consistent point.

For example, write and sync a file, create a snapshot, then overwrite the file. Stop
the box before restoring the snapshot. The next boot reads the original contents.

Online creation requires a supported shim and a single filesystem with exclusive
renames. If a backing chain may have another writer or the layout is unsupported,
stop the box before creating the snapshot.

The runtime journal records which layer to use if creation is interrupted. If
recovery cannot finish, the runtime rejects execution access and stop requests
before altering the VM lifecycle. Preserve the box directory and its snapshot files.

For database compatibility and journal locations, see [File formats](../reference/file-formats.md#home-directory).

## File copy conflicts

With `CopyOptions::no_overwrite()`, local copies add new files into existing
directories and reject existing files, symlinks, and incompatible entry types.
Existing bytes and directory metadata are preserved. Entries written before a
later conflict remain; extraction does not roll back the archive. Directories
created during extraction still receive permissions from later directory headers.

Guest extraction hands each object this copy creates to the box user the moment
it is created, by path. Objects that predate the copy keep their owner; existing
directories retain their ownership, and with `overwrite=false` their permissions
too. An archive's `./` header preserves an existing destination's permissions
when overwrite is false. A failed creation never changes ownership of the object
that occupied the name.

The upload trusts the box's own workload: ownership and permissions are applied
by path at creation, the way GNU tar and `docker cp` extract. A workload that
concurrently replaces a directory on the upload path can therefore redirect a
late metadata update onto its own replacement; uploads keep earlier writes after
a conflict. Request paths follow image directory symlinks such as
`/lib -> /usr/lib`.

REST runtimes refuse copy-in with `overwrite=false` when runner support cannot
be established. This prevents older runners from silently replacing files.
REST copy-out currently extracts with overwrite enabled and does not enforce
`CopyOptions::no_overwrite()`.

## Home directory

BoxLite keeps boxes, images, and its database under `~/.boxlite` by default. The directory's
layout is in [File formats](../reference/file-formats.md#home-directory).
