//! Database layer for boxlite.
//!
//! Provides SQLite-based persistence using Podman-style pattern:
//! - BoxConfig: Immutable configuration (stored once at creation)
//! - BoxState: Mutable state (updated during lifecycle)
//!
//! Uses JSON blob pattern for flexibility with queryable columns for performance.

pub(crate) mod base_disk;
mod boxes;
mod images;
pub(crate) mod migration;
mod schema;
pub(crate) mod snapshot;

use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::{Mutex, MutexGuard};
use rusqlite::{Connection, OptionalExtension};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub(crate) use base_disk::BaseDiskStore;
pub use boxes::BoxStore;
pub use images::{CachedImage, ImageIndexStore};
pub(crate) use snapshot::SnapshotStore;

/// Helper macro to convert rusqlite errors to BoxliteError.
///
/// Usage:
/// - `db_err!(result)` — basic, no context
/// - `db_err!(result, "operation name")` — includes operation context
/// - `db_err!(result, "op(box={})", id)` — with format arguments
macro_rules! db_err {
    ($result:expr) => {
        $result.map_err(|e| BoxliteError::Database(e.to_string()))
    };
    ($result:expr, $ctx:expr) => {
        $result.map_err(|e| BoxliteError::Database(format!("{}: {}", $ctx, e)))
    };
    ($result:expr, $fmt:expr, $($args:tt)*) => {
        $result.map_err(|e| BoxliteError::Database(format!("{}: {}", format!($fmt, $($args)*), e)))
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
    ///
    /// `db_path` is the path to the SQLite file. The `home_dir` (e.g., `~/.boxlite`)
    /// is derived from the DB path for migrations that need filesystem access.
    pub fn open(db_path: &Path) -> BoxliteResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = db_err!(Connection::open(db_path))?;

        // SQLite configuration (matches Podman patterns)
        // - WAL mode: Better concurrent read performance
        // - NORMAL sync: WAL-recommended — fsync only at checkpoint, not per
        //   transaction. The only risk is losing the last committed transaction
        //   on power loss, which is acceptable for box state (recovered on
        //   restart via reconcile/reboot detection). FULL gave negligible extra
        //   durability at 2-5x write cost.
        // - Foreign keys: Referential integrity
        // - Busy timeout: 100s to handle long operations (Podman uses 100s)
        // - mmap_size: Memory-map up to 256 MB of the database file for faster
        //   reads (avoids user-space buffer copies on large JSON blobs).
        db_err!(conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=100000;
            PRAGMA mmap_size=268435456;
            "
        ))?;

        Self::init_schema(&conn, db_path)?;

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
    fn init_schema(conn: &Connection, db_path: &Path) -> BoxliteResult<()> {
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
                // Derive home_dir from db_path: ~/.boxlite/db/boxlite.db → ~/.boxlite/
                let home_dir = db_path.parent().and_then(|db_dir| db_dir.parent());
                migration::run_migrations(conn, v, home_dir)?;
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
        assert!(tables.contains(&"base_disk".to_string()));
        assert!(tables.contains(&"base_disk_ref".to_string()));
        assert!(tables.contains(&"snapshot".to_string()));
    }

    #[test]
    fn test_db_migration_v4_to_v7() {
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

        // Open with current code - should auto-migrate to v7
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
        assert_eq!(version, schema::SCHEMA_VERSION);

        // Verify v7 tables exist
        for table in ["base_disk", "base_disk_ref", "snapshot"] {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1",
                    rusqlite::params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "{table} table should exist after migration");
        }

        // box_snapshot should be dropped by v6→v7 migration
        let old_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='box_snapshot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !old_exists,
            "box_snapshot table should be dropped after v6→v7 migration"
        );
    }

    #[test]
    fn test_db_migration_v5_to_v7() {
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

        // Open with current code - should auto-migrate to v7
        let db = Database::open(&db_path).unwrap();
        let conn = db.conn();

        let version: i32 = conn
            .query_row(
                "SELECT version FROM schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, schema::SCHEMA_VERSION);

        // v7 tables should exist
        for table in ["base_disk", "base_disk_ref", "snapshot"] {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1",
                    rusqlite::params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "{table} table should exist after migration");
        }
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

    #[test]
    fn test_migration_rollback_on_failure() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        // Create a fully-migrated database, then roll version back to v8
        // and inject invalid JSON so the v8→v9 migration fails.
        {
            let db = Database::open(&db_path).unwrap();
            let conn = db.conn();
            // Roll back to v8 to trigger v8→v9 on next open
            conn.execute(
                "UPDATE schema_version SET version = 8 WHERE id = 1",
                [],
            )
            .unwrap();
            // Insert a row with invalid JSON that will make v8→v9 fail
            conn.execute(
                "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, NULL, 0, ?2)",
                rusqlite::params!["bad-box", "this is not valid json"],
            )
            .unwrap();
        }

        // Re-open — migration should fail
        let result = Database::open(&db_path);
        assert!(result.is_err(), "expected migration to fail on invalid JSON");

        // Verify schema_version is still 8 (transaction rolled back)
        {
            let conn = Connection::open(&db_path).unwrap();
            let version: i32 = conn
                .query_row(
                    "SELECT version FROM schema_version WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                version, 8,
                "schema_version should be unchanged after failed migration"
            );
        }
    }

    #[test]
    fn test_db_err_macro_includes_context() {
        let result: Result<(), rusqlite::Error> = Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            Some("database is locked".to_string()),
        ));

        let err = db_err!(result, "test_operation").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("test_operation"),
            "error should include context: {msg}"
        );
        assert!(
            msg.contains("database is locked"),
            "error should include original message: {msg}"
        );
    }

    #[test]
    fn test_db_err_macro_with_format_args() {
        let result: Result<i64, rusqlite::Error> = Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some("UNIQUE constraint failed".to_string()),
        ));

        let err = db_err!(result, "insert box={}", "box-123").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("insert box=box-123"),
            "error should include formatted context: {msg}"
        );
    }
}
