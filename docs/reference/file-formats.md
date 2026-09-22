# File formats

## QCOW2 disk images

BoxLite uses QCOW2 (QEMU Copy-On-Write version 2) for persistent disks.

**Location:** `~/.boxlite/boxes/{box-id}/disk.qcow2`

**Format:** QCOW2 (copy-on-write image format)

**Features:**
- Thin provisioning (sparse allocation)
- Copy-on-write snapshots
- Compression support

**Size:** Specified by `disk_size_gb` parameter

**Lifecycle:**
- Created on first box start (if `disk_size_gb` set)
- Persists across stop/restart
- Deleted when box is removed

**Tools:**
```bash
# Inspect QCOW2 image
qemu-img info ~/.boxlite/boxes/{box-id}/disk.qcow2

# Convert to raw (if needed)
qemu-img convert -f qcow2 -O raw disk.qcow2 disk.raw
```

## OCI image cache

BoxLite caches OCI images at the layer level for fast starts.

**Location:** `~/.boxlite/images/`

**Structure:**
```
~/.boxlite/images/
├── blobs/
│   └── sha256/
│       ├── abc123...  # Layer blob
│       ├── def456...  # Layer blob
│       └── ...
└── index.json         # Image index
```

**Format:** OCI Image Layout Specification

**Caching:**
- Blob-level deduplication across images
- Shared base layers (e.g., `python:3.11` and `python:3.12` share layers)
- Automatic garbage collection (future feature)

**Clearing Cache:**
```bash
# Clear all cached images
rm -rf ~/.boxlite/images/*

# Images will be re-pulled on next use
```

## Box configuration

Box metadata and state are stored as JSON.

**Location:** `~/.boxlite/boxes/{box-id}/config.json`

**Format:** JSON

**Contents:**
- Box ID (ULID)
- Image specification
- Resource limits (CPUs, memory)
- Volume mounts
- Port forwarding
- Environment variables
- Creation timestamp
- Status (running, stopped, etc.)

**Example:**
```json
{
  "id": "01JJNH8...",
  "image": "python:slim",
  "cpus": 2,
  "memory_mib": 1024,
  "volumes": [
    {
      "host_path": "/host/data",
      "guest_path": "/mnt/data",
      "read_only": true
    }
  ],
  "ports": [
    {
      "host_port": 8080,
      "guest_port": 80,
      "protocol": "tcp"
    }
  ],
  "created_at": "2025-01-15T10:30:00Z",
  "status": "running"
}
```

**Notes:**
- Do not manually edit (managed by BoxLite)
- Used for box persistence and recovery
- Deleted when box is removed

## SQLite databases

BoxLite uses SQLite for metadata persistence.

**Locations:**
- `~/.boxlite/db/boxes.db` - Box registry and metadata
- `~/.boxlite/db/images.db` - Image cache index

**Schema:**
- Follows Podman-style pattern: immutable config + mutable state
- Box config stored as JSON blob
- Box state tracked separately
- Image layers indexed by digest

**Tools:**
```bash
# Inspect database
sqlite3 ~/.boxlite/db/boxes.db ".tables"
sqlite3 ~/.boxlite/db/boxes.db "SELECT * FROM boxes;"

# Backup
cp ~/.boxlite/db/boxes.db ~/backup/boxes.db.backup
```

**Notes:**
- Do not manually modify (data corruption risk)
- Backed up automatically on box operations
- Corruption recovery: Delete and recreate from box config files
