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
| **virtiofs**   | Host directory mount     | Sharing files with Box               |
| **QCOW2 disk** | Copy-on-write disk image | Box files, kept while the Box exists |

**QCOW2 features:**

- Thin provisioning (allocate on write)
- Snapshot support
- Shared base images across Boxes

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
