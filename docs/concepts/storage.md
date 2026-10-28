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

Flattening copies the guest-visible contents of a quiesced disk chain into a
standalone QCOW2 image without changing its sources or creating a RAW intermediate.
Layers may use different cluster sizes. Explicit zero clusters hide backing data,
including when the zero cluster has preallocated host storage. For example, a zeroed
overlay cluster stays zero after flattening even if its base contains older data.

The copier supports unencrypted QCOW2 v2/v3 with standard, uncompressed L2 entries.
It rejects images marked corrupt and unsupported incompatible features, including external
data files and extended L2 entries. Dirty refcounts are accepted: the copy reads
active mappings and rebuilds its own refcounts. The capture caller must stop writers,
use a private destination, and handle cleanup and syncing before publication.
An Imago-written final data cluster may have an implicit zero tail beyond physical
EOF. Flatten preserves that guest-visible zero tail; truncated metadata and data
clusters whose starting offset lies outside the file are rejected.
These semantics follow the [QCOW2 header and cluster mapping specification](https://qemu.readthedocs.io/en/master/interop/qcow2.html).

## Home directory

BoxLite keeps boxes, images, and its database under `~/.boxlite` by default. The directory's
layout is in [File formats](../reference/file-formats.md#home-directory).
