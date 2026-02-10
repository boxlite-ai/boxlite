//! Database layer for boxlite.
//!
//! Provides SQLite-based persistence using Podman-style pattern:
//! - BoxConfig: Immutable configuration (stored once at creation)
//! - BoxState: Mutable state (updated during lifecycle)
//!
//! Uses JSON blob pattern for flexibility with queryable columns for performance.

mod boxes;
mod images;
mod schema;
pub(crate) mod snapshots;

use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::{Mutex, MutexGuard};
use rusqlite::{Connection, OptionalExtension};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub use boxes::BoxStore;
pub use images::{CachedImage, ImageIndexStore};
pub use snapshots::SnapshotStore;

/// Helper macro to convert rusqlite errors to BoxliteError.
macro_rules! db_err {
    ($result:expr) => {
        $result.map_err(|e| BoxliteError::Database(e.to_string()))
    };
}

pub(crate) use db_err;

/// SQLite database handle.
///
/// Thread-safe via `parking_lot::Mutex`. Domain-specific stores
/// wrap this to provide their APIs (e.g., `BoxMetadataStore`).
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Open or create the database.
    pub fn open(db_path: &Path) -> BoxliteResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = db_err!(Connection::open(db_path))?;

        // SQLite configuration (matches Podman patterns)
        // - WAL mode: Better concurrent read performance
        // - FULL sync: Maximum durability (fsync after each transaction)
        // - Foreign keys: Referential integrity
        // - Busy timeout: 100s to handle long operations (Podman uses 100s)
        db_err!(conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=100000;
            "
        ))?;

        Self::init_schema(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Acquire the database connection.
    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock()
    }

    /// Initialize database schema.
    ///
    /// Order of operations:
    /// 1. Create schema_version table (safe, no dependencies)
    /// 2. Check current version
    /// 3. New DB: apply full schema
    ///    Existing DB with older version: run migrations automatically
    ///    Existing DB with newer version: error (need newer boxlite)
    ///    Existing DB with same version: nothing to do
    fn init_schema(conn: &Connection) -> BoxliteResult<()> {
        // Step 1: Create schema_version table first (always safe)
        db_err!(conn.execute_batch(schema::SCHEMA_VERSION_TABLE))?;

        // Step 2: Check current version
        let current_version: Option<i32> = db_err!(
            conn.query_row(
                "SELECT version FROM schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
        )?;

        match current_version {
            None => {
                // New database - apply full latest schema
                Self::apply_full_schema(conn)?;
            }
            Some(v) if v == schema::SCHEMA_VERSION => {
                // Already at current version - nothing to do
            }
            Some(v) if v > schema::SCHEMA_VERSION => {
                // Database is newer than this process - user needs to upgrade boxlite
                return Err(BoxliteError::Database(format!(
                    "Schema version mismatch: database has v{}, process expects v{}. \
                     Upgrade boxlite to a newer version.",
                    v,
                    schema::SCHEMA_VERSION
                )));
            }
            Some(v) => {
                // Older database - run migrations automatically
                tracing::info!(
                    "Database schema v{} is older than expected v{}, running migrations",
                    v,
                    schema::SCHEMA_VERSION
                );
                Self::run_migrations(conn, v)?;
            }
        }

        Ok(())
    }

    /// Apply full schema for new database.
    fn apply_full_schema(conn: &Connection) -> BoxliteResult<()> {
        for sql in schema::all_schemas() {
            db_err!(conn.execute_batch(sql))?;
        }

        let now = Utc::now().to_rfc3339();
        db_err!(conn.execute(
            "INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?1, ?2)",
            rusqlite::params![schema::SCHEMA_VERSION, now],
        ))?;

        tracing::info!(
            "Initialized database schema version {}",
            schema::SCHEMA_VERSION
        );
        Ok(())
    }

    /// Run migrations from `from_version` to current schema version.
    fn run_migrations(conn: &Connection, from_version: i32) -> BoxliteResult<()> {
        let mut current = from_version;

        // Migration 2 -> 3: Add name column with UNIQUE constraint
        if current == 2 {
            tracing::info!("Running migration 2 -> 3: Adding name column to box_config");

            // Add name column
            db_err!(conn.execute_batch("ALTER TABLE box_config ADD COLUMN name TEXT;"))?;

            // Create unique index (enforces uniqueness, allows multiple NULLs)
            db_err!(conn.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_box_config_name_unique ON box_config(name);"
            ))?;

            // Populate name from JSON for existing rows
            db_err!(conn.execute_batch(
                "UPDATE box_config SET name = json_extract(json, '$.name') WHERE name IS NULL;"
            ))?;

            current = 3;
        }

        // Migration 3 -> 4: Add image_index table
        if current == 3 {
            tracing::info!("Running migration 3 -> 4: Adding image_index table");

            db_err!(conn.execute_batch(schema::IMAGE_INDEX_TABLE))?;

            current = 4;
        }

        // Migration 4 -> 5: Add snapshots table (legacy, now replaced by box_snapshot in v6)
        if current == 4 {
            tracing::info!("Running migration 4 -> 5: Adding snapshots table");

            // Create the old snapshots table so migration 5->6 can drop it
            db_err!(conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS snapshots (
                    id TEXT PRIMARY KEY NOT NULL,
                    box_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (box_id) REFERENCES box_config(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_snapshots_box_id ON snapshots(box_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_box_name ON snapshots(box_id, name);
                "#
            ))?;

            current = 5;
        }

        // Migration 5 -> 6: Replace snapshots table with box_snapshot
        if current == 5 {
            tracing::info!("Running migration 5 -> 6: Replacing snapshots with box_snapshot");

            db_err!(conn.execute_batch("DROP TABLE IF EXISTS snapshots;"))?;
            db_err!(conn.execute_batch(schema::BOX_SNAPSHOT_TABLE))?;

            current = 6;
        }

        // Update schema version
        let now = Utc::now().to_rfc3339();
        db_err!(conn.execute(
            "UPDATE schema_version SET version = ?1, updated_at = ?2 WHERE id = 1",
            rusqlite::params![current, now],
        ))?;

        tracing::info!("Database migration complete, now at version {}", current);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_db_open() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let _db = Database::open(&db_path).unwrap();
    }

    #[test]
    fn test_db_open_creates_all_tables() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();

        let conn = db.conn();

        // Verify all tables exist
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };

        assert!(tables.contains(&"schema_version".to_string()));
        assert!(tables.contains(&"box_config".to_string()));
        assert!(tables.contains(&"box_state".to_string()));
        assert!(tables.contains(&"alive".to_string()));
        assert!(tables.contains(&"image_index".to_string()));
        assert!(tables.contains(&"box_snapshot".to_string()));
    }

    #[test]
    fn test_db_migration_v4_to_v6() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        // Simulate a v4 database (without snapshots or box_snapshot table)
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(schema::SCHEMA_VERSION_TABLE).unwrap();
            conn.execute_batch(schema::BOX_CONFIG_TABLE).unwrap();
            conn.execute_batch(schema::BOX_STATE_TABLE).unwrap();
            conn.execute_batch(schema::ALIVE_TABLE).unwrap();
            conn.execute_batch(schema::IMAGE_INDEX_TABLE).unwrap();

            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 4, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
        }

        // Open with current code - should auto-migrate to v6
        let db = Database::open(&db_path).unwrap();
        let conn = db.conn();

        // Verify migration succeeded
        let version: i32 = conn
            .query_row(
                "SELECT version FROM schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 6);

        // Verify box_snapshot table exists
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='box_snapshot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            table_exists,
            "box_snapshot table should exist after migration"
        );

        // Verify old snapshots table is gone
        let old_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='snapshots'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !old_exists,
            "old snapshots table should be dropped after migration"
        );
    }

    #[test]
    fn test_db_migration_v5_to_v6() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        // Simulate a v5 database (with old snapshots table)
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(schema::SCHEMA_VERSION_TABLE).unwrap();
            conn.execute_batch(schema::BOX_CONFIG_TABLE).unwrap();
            conn.execute_batch(schema::BOX_STATE_TABLE).unwrap();
            conn.execute_batch(schema::ALIVE_TABLE).unwrap();
            conn.execute_batch(schema::IMAGE_INDEX_TABLE).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS snapshots (
                    id TEXT PRIMARY KEY NOT NULL,
                    box_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (box_id) REFERENCES box_config(id) ON DELETE CASCADE
                );
                "#,
            )
            .unwrap();

            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 5, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
        }

        // Open with current code - should auto-migrate to v6
        let db = Database::open(&db_path).unwrap();
        let conn = db.conn();

        let version: i32 = conn
            .query_row(
                "SELECT version FROM schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 6);

        // box_snapshot should exist
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='box_snapshot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(table_exists);
    }

    #[test]
    fn test_db_rejects_newer_version() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        // Create a database with a version higher than current
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(schema::SCHEMA_VERSION_TABLE).unwrap();
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO schema_version (id, version, updated_at) VALUES (1, 999, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
        }

        // Should fail with version mismatch
        let result = Database::open(&db_path);
        assert!(result.is_err());
        match result {
            Err(e) => {
                let err = e.to_string();
                assert!(err.contains("Schema version mismatch"));
                assert!(err.contains("Upgrade boxlite"));
            }
            Ok(_) => panic!("expected error"),
        }
    }
}
