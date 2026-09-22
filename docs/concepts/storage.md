# Storage

## Rootfs preparation

The rootfs builder assembles a container filesystem from OCI image layers:

```
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

| Type           | Description              | Use Case               |
|----------------|--------------------------|------------------------|
| **virtiofs**   | Host directory mount     | Sharing files with Box |
| **QCOW2 disk** | Copy-on-write disk image | Persistent storage     |

**QCOW2 features:**

- Thin provisioning (allocate on write)
- Snapshot support
- Shared base images across Boxes

## Home directory

Default home directory: `~/.boxlite`

```
~/.boxlite/
├── boxes/              # Per-Box runtime data
│   └── {box-id}/
│       ├── rootfs/     # Container rootfs
│       └── config.json
├── images/             # OCI image cache
│   ├── blobs/          # Image layer blobs (by digest)
│   └── index.json      # Image index
├── init/               # Shared init rootfs
│   └── rootfs/
├── logs/               # Runtime logs
│   └── boxlite.log     # Daily rotating log
└── boxlite.lock        # Runtime lock file (prevents multiple instances)
```
