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

## Image disk cache

The image disk cache stores one pure ext4 disk per OCI image under
`~/.boxlite/images/disk-images/`. The filename records the image digest, the
ext4 builder format version, and the headroom budget:

```text
{digest}-b{version}-r{reserve_bytes}.ext4
```

`EXT4_BUILDER_FORMAT_VERSION` lives in `src/boxlite/src/disk/constants.rs`.
Bump it when `create_ext4_from_dir` writes different bytes or metadata for
identical inputs, such as ownership stamping, sizing, or `mke2fs` arguments.
Do not bump it for refactors, comments, or logging that leave the output
identical.

The same version is part of the guest rootfs keys: `{digest12}-b{version}-{guest12}`
for OCI images and `b{version}-{artifact-id}` for the minimal rootfs. A builder
change therefore misses both stale image disks and stale guest disks. The image
disk cache has no garbage collector, so a bump leaves the previous files in
place until you remove them.

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

## Home directory

BoxLite keeps boxes, images, and its database under `~/.boxlite` by default. The directory's
layout is in [File formats](../reference/file-formats.md#home-directory).
