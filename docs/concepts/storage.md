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

## Reclaiming deleted space

Deleting files inside a Box shrinks its `disk.qcow2` on the host:

1. The guest mounts the container disk with `discard`, so ext4 tells the disk which blocks it
   freed.
2. The disk passes the discard to the qcow2 layer, which marks the clusters as zero and punches
   holes for them in the host file (`fallocate(PUNCH_HOLE)`), returning the space to the host
   filesystem.

The host file's apparent size (`ls -l`) does not shrink; its allocated size (`du`) does.

Space held by a snapshot or clone base is not reclaimed: those disks are read-only backing files,
and deleting their data in the Box only records zero clusters in the Box's own overlay.

## Home directory

BoxLite keeps boxes, images, and its database under `~/.boxlite` by default. The directory's
layout is in [File formats](../reference/file-formats.md#home-directory).
