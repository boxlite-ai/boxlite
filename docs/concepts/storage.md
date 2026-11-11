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

Guest extraction rejects symlink ancestors, including ancestors omitted from
archive headers. Protected copy-out resolves trusted host parents first, leaving
the destination leaf protected. Missing host parents use filesystem resolution
for `..` and symlinks; a trailing `/` requests a destination directory.

REST runtimes retain their refusal of protected copies when runner support cannot
be established. This prevents older runners from silently replacing files.

## Home directory

BoxLite keeps boxes, images, and its database under `~/.boxlite` by default. The directory's
layout is in [File formats](../reference/file-formats.md#home-directory).
