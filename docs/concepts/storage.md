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

Protected host copy-out resolves trusted host parents through filesystem path
resolution, retaining `..` and symlink semantics. A trailing `/` requests a
destination directory independently of the resolved path. This preparation does
not enable merging protected copies into existing directories: the existing
extraction policy still rejects that operation.

Shared extraction also exposes report-preserving variants for staged archives
and streams. They return both paths reached and the extraction result, allowing
future callers to finalize partial writes without losing the original error.
The reports describe reached paths; they do not prove inode ownership. Existing
callers retain their result-only APIs and existing ownership behavior.

## Home directory

BoxLite keeps boxes, images, and its database under `~/.boxlite` by default. The directory's
layout is in [File formats](../reference/file-formats.md#home-directory).
