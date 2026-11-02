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
- Standalone disk snapshot capture; copy-on-write disk restoration

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

## Disk capture and restoration

Local disk snapshots, clones and disk exports capture a standalone copy of the
source's filesystem contents. Running capture flushes/freezes the guest before
pausing, copies the frozen disk view, then resumes/thaws the source. The live disk
is not renamed or replaced. Stopped sources need no guest RPC; Paused sources
refuse disk capture. Large captures keep execution paused while the copy runs.

Creating a snapshot does not make the live disk depend on it. Restoring one while
Stopped replaces the live disk with a COW child backed by that snapshot, so the
snapshot cannot be deleted until its backing dependencies are removed. Batch
clones share a copied base independent of their source. Memory and device state
require a [checkpoint](../guides/checkpoints.md#support-and-lifecycle).
Serialize lifecycle/storage calls per source; the guide describes the unresolved
concurrency windows.

## Home directory


BoxLite keeps boxes, images, and its database under `~/.boxlite` by default. The directory's
layout is in [File formats](../reference/file-formats.md#home-directory).
