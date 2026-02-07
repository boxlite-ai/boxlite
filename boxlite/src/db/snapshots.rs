//! Snapshot metadata persistence.
//!
//! Stores snapshot metadata in SQLite. Each snapshot records a point-in-time
//! capture of a box's disk state (taken while the box is stopped).

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::{Database, db_err};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Snapshot metadata stored in database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRecord {
    /// Unique snapshot ID (ULID).
    pub id: String,
    /// ID of the box this snapshot belongs to.
    pub box_id: String,
    /// User-provided snapshot name (unique per box).
    pub name: String,
    /// Optional description.
    pub description: String,
    /// ISO 8601 creation timestamp.
    pub created_at: String,
}

/// Store for snapshot metadata operations.
pub struct SnapshotStore {
    db: Database,
}

impl SnapshotStore {
    /// Create a new SnapshotStore wrapping the given database.
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Save a snapshot record to the database.
    pub fn save(&self, record: &SnapshotRecord) -> BoxliteResult<()> {
        let conn = self.db.conn();
        db_err!(conn.execute(
            "INSERT INTO snapshots (id, box_id, name, description, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                record.id,
                record.box_id,
                record.name,
                record.description,
                record.created_at,
            ],
        ))?;
        Ok(())
    }

    /// List all snapshots for a given box, ordered by creation time (newest first).
    pub fn list(&self, box_id: &str) -> BoxliteResult<Vec<SnapshotRecord>> {
        let conn = self.db.conn();
        let mut stmt = db_err!(conn.prepare(
            "SELECT id, box_id, name, description, created_at \
             FROM snapshots WHERE box_id = ?1 ORDER BY created_at DESC"
        ))?;

        let rows = db_err!(stmt.query_map(rusqlite::params![box_id], |row| {
            Ok(SnapshotRecord {
                id: row.get(0)?,
                box_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                created_at: row.get(4)?,
            })
        }))?;

        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(db_err!(row)?);
        }
        Ok(snapshots)
    }

    /// Get a snapshot by box ID and snapshot name.
    pub fn get_by_name(&self, box_id: &str, name: &str) -> BoxliteResult<Option<SnapshotRecord>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT id, box_id, name, description, created_at \
                 FROM snapshots WHERE box_id = ?1 AND name = ?2",
                rusqlite::params![box_id, name],
                |row| {
                    Ok(SnapshotRecord {
                        id: row.get(0)?,
                        box_id: row.get(1)?,
                        name: row.get(2)?,
                        description: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()
        )?;
        Ok(result)
    }

    /// Get a snapshot by its ID.
    pub fn get(&self, snapshot_id: &str) -> BoxliteResult<Option<SnapshotRecord>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT id, box_id, name, description, created_at \
                 FROM snapshots WHERE id = ?1",
                rusqlite::params![snapshot_id],
                |row| {
                    Ok(SnapshotRecord {
                        id: row.get(0)?,
                        box_id: row.get(1)?,
                        name: row.get(2)?,
                        description: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()
        )?;
        Ok(result)
    }

    /// Delete a snapshot by box ID and snapshot name.
    pub fn delete_by_name(&self, box_id: &str, name: &str) -> BoxliteResult<bool> {
        let conn = self.db.conn();
        let rows_affected = db_err!(conn.execute(
            "DELETE FROM snapshots WHERE box_id = ?1 AND name = ?2",
            rusqlite::params![box_id, name],
        ))?;
        Ok(rows_affected > 0)
    }

    /// Delete all snapshots for a given box.
    pub fn delete_all(&self, box_id: &str) -> BoxliteResult<u64> {
        let conn = self.db.conn();
        let rows_affected = db_err!(conn.execute(
            "DELETE FROM snapshots WHERE box_id = ?1",
            rusqlite::params![box_id],
        ))?;
        Ok(rows_affected as u64)
    }

    /// Create a new snapshot record with auto-generated ID and timestamp.
    pub fn create_record(box_id: &str, name: &str, description: &str) -> SnapshotRecord {
        SnapshotRecord {
            id: ulid::Ulid::new().to_string(),
            box_id: box_id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            created_at: Utc::now().to_rfc3339(),
        }
    }
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_db() -> Database {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        Database::open(&db_path).unwrap()
    }

    #[test]
    fn test_snapshot_save_and_list() {
        let db = test_db();

        // Create a box first (needed for foreign key)
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["box1", "test-box", 0, "{}"],
            )
            .unwrap();
        }

        let store = SnapshotStore::new(db);

        let record = SnapshotStore::create_record("box1", "snap1", "first snapshot");
        store.save(&record).unwrap();

        let snapshots = store.list("box1").unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].name, "snap1");
        assert_eq!(snapshots[0].description, "first snapshot");
    }

    #[test]
    fn test_snapshot_get_by_name() {
        let db = test_db();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["box1", "test-box", 0, "{}"],
            )
            .unwrap();
        }

        let store = SnapshotStore::new(db);

        let record = SnapshotStore::create_record("box1", "snap1", "");
        store.save(&record).unwrap();

        let found = store.get_by_name("box1", "snap1").unwrap();
        assert!(found.is_some());

        let not_found = store.get_by_name("box1", "nonexistent").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn test_snapshot_unique_name_per_box() {
        let db = test_db();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["box1", "test-box", 0, "{}"],
            )
            .unwrap();
        }

        let store = SnapshotStore::new(db);

        let r1 = SnapshotStore::create_record("box1", "snap1", "");
        store.save(&r1).unwrap();

        // Same name for same box should fail
        let r2 = SnapshotStore::create_record("box1", "snap1", "duplicate");
        let result = store.save(&r2);
        assert!(result.is_err(), "duplicate snapshot name should fail");
    }

    #[test]
    fn test_snapshot_delete() {
        let db = test_db();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["box1", "test-box", 0, "{}"],
            )
            .unwrap();
        }

        let store = SnapshotStore::new(db);

        let r1 = SnapshotStore::create_record("box1", "snap1", "");
        let r2 = SnapshotStore::create_record("box1", "snap2", "");
        store.save(&r1).unwrap();
        store.save(&r2).unwrap();

        assert!(store.delete_by_name("box1", "snap1").unwrap());
        assert_eq!(store.list("box1").unwrap().len(), 1);

        assert_eq!(store.delete_all("box1").unwrap(), 1);
        assert_eq!(store.list("box1").unwrap().len(), 0);
    }
}
