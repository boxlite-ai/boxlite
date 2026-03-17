//! SQLite schema definitions for the coordinator state store.

/// Current schema version.
pub const SCHEMA_VERSION: i32 = 2;

pub const SCHEMA_VERSION_TABLE: &str = r"
CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
";

pub const WORKER_TABLE: &str = r"
CREATE TABLE IF NOT EXISTS worker (
    id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL UNIQUE,
    labels TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    capacity TEXT NOT NULL DEFAULT '{}',
    json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_status ON worker(status);
CREATE INDEX IF NOT EXISTS idx_worker_url ON worker(url);
";

pub const BOX_MAPPING_TABLE: &str = r"
CREATE TABLE IF NOT EXISTS box_mapping (
    box_id TEXT PRIMARY KEY NOT NULL,
    worker_id TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    FOREIGN KEY (worker_id) REFERENCES worker(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_box_mapping_worker ON box_mapping(worker_id);
CREATE INDEX IF NOT EXISTS idx_box_mapping_namespace ON box_mapping(namespace);
";

/// All schema DDL in dependency order.
pub fn all_schemas() -> Vec<&'static str> {
    vec![SCHEMA_VERSION_TABLE, WORKER_TABLE, BOX_MAPPING_TABLE]
}
