//! Database schema definitions.
//!
//! Uses Podman-style pattern:
//! - BoxConfig: Immutable configuration (set at creation)
//! - BoxState: Mutable state (changes during lifecycle)
//!
//! Each table has queryable columns for efficient filtering + JSON blob for full data.

/// Current schema version.
pub const SCHEMA_VERSION: i32 = 8;

/// Schema version tracking table.
pub const SCHEMA_VERSION_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
"#;

/// BoxConfig table schema.
///
/// Stores immutable box configuration. JSON blob contains full BoxConfig struct.
/// Queryable columns: id, name, created_at (for sorting/filtering).
/// Name is UNIQUE but allows NULL (multiple unnamed boxes are allowed).
pub const BOX_CONFIG_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS box_config (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_box_config_created_at ON box_config(created_at);
CREATE INDEX IF NOT EXISTS idx_box_config_name ON box_config(name);
"#;

/// BoxState table schema.
///
/// Stores mutable box state. JSON blob contains full BoxState struct.
/// Queryable columns: id, status, pid (for filtering active boxes).
pub const BOX_STATE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS box_state (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    pid INTEGER,
    json TEXT NOT NULL,
    FOREIGN KEY (id) REFERENCES box_config(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_box_state_status ON box_state(status);
CREATE INDEX IF NOT EXISTS idx_box_state_pid ON box_state(pid);
"#;

/// Alive file table schema.
///
/// Tracks runtime instance. If stale on startup, indicates reboot.
pub const ALIVE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS alive (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    boot_id TEXT NOT NULL,
    started_at INTEGER NOT NULL
);
"#;

/// Image index table schema.
///
/// Stores cached image metadata. Maps image references to their cached metadata.
/// Queryable columns for efficient lookup + layers stored as JSON array.
pub const IMAGE_INDEX_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS image_index (
    reference TEXT PRIMARY KEY NOT NULL,
    manifest_digest TEXT NOT NULL,
    config_digest TEXT NOT NULL,
    layers TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_image_index_manifest_digest ON image_index(manifest_digest);
"#;

/// Box snapshot table schema (added in v6, replaces v5 `snapshots`).
///
/// Stores snapshot metadata for box state persistence.
/// Each snapshot captures the disk state of a stopped box at a point in time
/// using external COW files stored in the snapshot directory.
pub const BOX_SNAPSHOT_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS box_snapshot (
    id TEXT PRIMARY KEY NOT NULL,
    box_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    snapshot_dir TEXT NOT NULL,
    guest_disk_bytes INTEGER NOT NULL,
    container_disk_bytes INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (box_id) REFERENCES box_config(id) ON DELETE CASCADE,
    UNIQUE(box_id, name)
);
"#;

/// Base disk table (added in v7).
///
/// Stores immutable COW fork points (clone bases, snapshots, rootfs cache).
/// Queryable columns for indexed lookups + JSON blob for full `BaseDisk` struct.
/// `UNIQUE(source_box_id, name)` enforces one snapshot name per box;
/// SQLite treats NULLs as distinct so clone bases (name=NULL) don't collide.
pub const BASE_DISK_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS base_disk (
    id TEXT PRIMARY KEY NOT NULL,
    source_box_id TEXT NOT NULL,
    name TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('snapshot', 'clone_base', 'rootfs')),
    base_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL,
    UNIQUE(source_box_id, name)
);
CREATE INDEX IF NOT EXISTS idx_base_disk_source ON base_disk(source_box_id);
CREATE INDEX IF NOT EXISTS idx_base_disk_kind ON base_disk(kind);
CREATE INDEX IF NOT EXISTS idx_base_disk_path ON base_disk(base_path);
"#;

/// Base disk reference table (added in v7).
///
/// Tracks box→base_disk dependencies for GC.
/// When no rows reference a base_disk, it can be garbage-collected.
pub const BASE_DISK_REF_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS base_disk_ref (
    base_disk_id TEXT NOT NULL,
    box_id TEXT NOT NULL,
    PRIMARY KEY (base_disk_id, box_id)
);
"#;

/// Snapshot table with JSON blob pattern (added in v7, replaces box_snapshot).
///
/// Per-box snapshots stored as JSON blobs (like BoxConfig pattern).
/// Queryable columns: id, box_id, name, created_at.
pub const SNAPSHOT_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS snapshot (
    id TEXT PRIMARY KEY NOT NULL,
    box_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL,
    UNIQUE(box_id, name)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_box ON snapshot(box_id);
"#;

/// Get all schema creation statements.
pub fn all_schemas() -> Vec<&'static str> {
    vec![
        SCHEMA_VERSION_TABLE,
        BOX_CONFIG_TABLE,
        BOX_STATE_TABLE,
        ALIVE_TABLE,
        IMAGE_INDEX_TABLE,
        BASE_DISK_TABLE,
        BASE_DISK_REF_TABLE,
        SNAPSHOT_TABLE,
    ]
}
