//! Snapshot metadata persistence.
//!
//! Stores snapshot metadata in SQLite. Each snapshot records a point-in-time
//! capture of a box's disk state using external COW files.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::{Database, db_err};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Snapshot metadata stored in database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    /// Unique snapshot ID (ULID).
    pub id: String,
    /// ID of the box this snapshot belongs to.
    pub box_id: String,
    /// User-provided snapshot name (unique per box).
    pub name: String,
    /// Unix timestamp (seconds since epoch) when the snapshot was created.
    pub created_at: i64,
    /// Path to the snapshot directory containing disk files.
    pub snapshot_dir: String,
    /// Virtual size in bytes of the guest rootfs disk (0 if not present).
    pub guest_disk_bytes: u64,
    /// Virtual size in bytes of the container disk.
    pub container_disk_bytes: u64,
    /// Total on-disk size in bytes of all snapshot files.
    pub size_bytes: u64,
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
    pub fn save(&self, record: &SnapshotInfo) -> BoxliteResult<()> {
        let conn = self.db.conn();
        db_err!(conn.execute(
            "INSERT INTO box_snapshot (id, box_id, name, created_at, snapshot_dir, \
             guest_disk_bytes, container_disk_bytes, size_bytes) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                record.id,
                record.box_id,
                record.name,
                record.created_at,
                record.snapshot_dir,
                record.guest_disk_bytes as i64,
                record.container_disk_bytes as i64,
                record.size_bytes as i64,
            ],
        ))?;
        Ok(())
    }

    /// List all snapshots for a given box, ordered by creation time (newest first).
    pub fn list(&self, box_id: &str) -> BoxliteResult<Vec<SnapshotInfo>> {
        let conn = self.db.conn();
        let mut stmt = db_err!(conn.prepare(
            "SELECT id, box_id, name, created_at, snapshot_dir, \
             guest_disk_bytes, container_disk_bytes, size_bytes \
             FROM box_snapshot WHERE box_id = ?1 ORDER BY created_at DESC"
        ))?;

        let rows = db_err!(stmt.query_map(rusqlite::params![box_id], |row| {
            Ok(SnapshotInfo {
                id: row.get(0)?,
                box_id: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
                snapshot_dir: row.get(4)?,
                guest_disk_bytes: row.get::<_, i64>(5)? as u64,
                container_disk_bytes: row.get::<_, i64>(6)? as u64,
                size_bytes: row.get::<_, i64>(7)? as u64,
            })
        }))?;

        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(db_err!(row)?);
        }
        Ok(snapshots)
    }

    /// Get a snapshot by box ID and snapshot name.
    pub fn get_by_name(&self, box_id: &str, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT id, box_id, name, created_at, snapshot_dir, \
                 guest_disk_bytes, container_disk_bytes, size_bytes \
                 FROM box_snapshot WHERE box_id = ?1 AND name = ?2",
                rusqlite::params![box_id, name],
                |row| {
                    Ok(SnapshotInfo {
                        id: row.get(0)?,
                        box_id: row.get(1)?,
                        name: row.get(2)?,
                        created_at: row.get(3)?,
                        snapshot_dir: row.get(4)?,
                        guest_disk_bytes: row.get::<_, i64>(5)? as u64,
                        container_disk_bytes: row.get::<_, i64>(6)? as u64,
                        size_bytes: row.get::<_, i64>(7)? as u64,
                    })
                },
            )
            .optional()
        )?;
        Ok(result)
    }

    /// Get a snapshot by its ID.
    #[allow(dead_code)]
    pub fn get(&self, snapshot_id: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT id, box_id, name, created_at, snapshot_dir, \
                 guest_disk_bytes, container_disk_bytes, size_bytes \
                 FROM box_snapshot WHERE id = ?1",
                rusqlite::params![snapshot_id],
                |row| {
                    Ok(SnapshotInfo {
                        id: row.get(0)?,
                        box_id: row.get(1)?,
                        name: row.get(2)?,
                        created_at: row.get(3)?,
                        snapshot_dir: row.get(4)?,
                        guest_disk_bytes: row.get::<_, i64>(5)? as u64,
                        container_disk_bytes: row.get::<_, i64>(6)? as u64,
                        size_bytes: row.get::<_, i64>(7)? as u64,
                    })
                },
            )
            .optional()
        )?;
        Ok(result)
    }

    /// Remove a snapshot by box ID and snapshot name.
    pub fn remove_by_name(&self, box_id: &str, name: &str) -> BoxliteResult<bool> {
        let conn = self.db.conn();
        let rows_affected = db_err!(conn.execute(
            "DELETE FROM box_snapshot WHERE box_id = ?1 AND name = ?2",
            rusqlite::params![box_id, name],
        ))?;
        Ok(rows_affected > 0)
    }

    /// Remove all snapshots for a given box.
    #[allow(dead_code)]
    pub fn remove_all(&self, box_id: &str) -> BoxliteResult<u64> {
        let conn = self.db.conn();
        let rows_affected = db_err!(conn.execute(
            "DELETE FROM box_snapshot WHERE box_id = ?1",
            rusqlite::params![box_id],
        ))?;
        Ok(rows_affected as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use tempfile::TempDir;

    fn test_db() -> Database {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        Database::open(&db_path).unwrap()
    }

    fn make_snapshot(box_id: &str, name: &str) -> SnapshotInfo {
        SnapshotInfo {
            id: ulid::Ulid::new().to_string(),
            box_id: box_id.to_string(),
            name: name.to_string(),
            created_at: Utc::now().timestamp(),
            snapshot_dir: format!("/snapshots/{}", name),
            guest_disk_bytes: 1024,
            container_disk_bytes: 10 * 1024 * 1024 * 1024,
            size_bytes: 512,
        }
    }

    fn insert_box(db: &Database, box_id: &str) {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![box_id, format!("test-{}", box_id), 0, "{}"],
        )
        .unwrap();
    }

    #[test]
    fn test_snapshot_save_and_list() {
        let db = test_db();
        insert_box(&db, "box1");

        let store = SnapshotStore::new(db);

        let record = make_snapshot("box1", "snap1");
        store.save(&record).unwrap();

        let snapshots = store.list("box1").unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].name, "snap1");
        assert_eq!(snapshots[0].container_disk_bytes, 10 * 1024 * 1024 * 1024);
    }

    #[test]
    fn test_snapshot_get_by_name() {
        let db = test_db();
        insert_box(&db, "box1");

        let store = SnapshotStore::new(db);

        let record = make_snapshot("box1", "snap1");
        store.save(&record).unwrap();

        let found = store.get_by_name("box1", "snap1").unwrap();
        assert!(found.is_some());

        let not_found = store.get_by_name("box1", "nonexistent").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn test_snapshot_unique_name_per_box() {
        let db = test_db();
        insert_box(&db, "box1");

        let store = SnapshotStore::new(db);

        let r1 = make_snapshot("box1", "snap1");
        store.save(&r1).unwrap();

        // Same name for same box should fail
        let r2 = make_snapshot("box1", "snap1");
        let result = store.save(&r2);
        assert!(result.is_err(), "duplicate snapshot name should fail");
    }

    #[test]
    fn test_snapshot_remove() {
        let db = test_db();
        insert_box(&db, "box1");

        let store = SnapshotStore::new(db);

        let r1 = make_snapshot("box1", "snap1");
        let r2 = make_snapshot("box1", "snap2");
        store.save(&r1).unwrap();
        store.save(&r2).unwrap();

        assert!(store.remove_by_name("box1", "snap1").unwrap());
        assert_eq!(store.list("box1").unwrap().len(), 1);

        assert_eq!(store.remove_all("box1").unwrap(), 1);
        assert_eq!(store.list("box1").unwrap().len(), 0);
    }
}
