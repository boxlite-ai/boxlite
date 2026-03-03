//! Snapshot storage using JSON blob pattern.
//!
//! Follows the same pattern as `BoxStore` for `BoxConfig`:
//! - Domain type (`SnapshotInfo`) defined in `litebox/snapshot_mgr.rs`
//! - This store serializes/deserializes to the `snapshot` table
//! - Queryable columns for indexed lookups + JSON blob for full struct

use rusqlite::OptionalExtension;

use super::{Database, db_err};
use crate::litebox::snapshot_mgr::SnapshotInfo;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Snapshot storage wrapping Database.
///
/// Manages the `snapshot` table with JSON blob pattern (like `BoxStore`).
#[derive(Clone)]
pub(crate) struct SnapshotStore {
    db: Database,
}

impl SnapshotStore {
    pub(crate) fn new(db: Database) -> Self {
        Self { db }
    }

    /// Insert a new snapshot record.
    pub(crate) fn save(&self, info: &SnapshotInfo) -> BoxliteResult<()> {
        let json = serde_json::to_string(info).map_err(|e| {
            BoxliteError::Database(format!("Failed to serialize SnapshotInfo: {}", e))
        })?;
        let conn = self.db.conn();
        db_err!(conn.execute(
            "INSERT INTO snapshot (id, box_id, name, created_at, json) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![info.id, info.box_id, info.name, info.created_at, json],
        ))?;
        Ok(())
    }

    /// Find a snapshot by box ID and name.
    pub(crate) fn find(&self, box_id: &str, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        let conn = self.db.conn();
        let json: Option<String> = db_err!(
            conn.query_row(
                "SELECT json FROM snapshot WHERE box_id = ?1 AND name = ?2",
                rusqlite::params![box_id, name],
                |row| row.get(0),
            )
            .optional()
        )?;
        deserialize_optional(json)
    }

    /// List all snapshots for a box. Newest first.
    pub(crate) fn list(&self, box_id: &str) -> BoxliteResult<Vec<SnapshotInfo>> {
        let conn = self.db.conn();
        let mut stmt = db_err!(
            conn.prepare("SELECT json FROM snapshot WHERE box_id = ?1 ORDER BY created_at DESC")
        )?;
        let rows =
            db_err!(stmt.query_map(rusqlite::params![box_id], |row| { row.get::<_, String>(0) }))?;

        let mut results = Vec::new();
        for row in rows {
            let json_str = db_err!(row)?;
            let info: SnapshotInfo = serde_json::from_str(&json_str).map_err(|e| {
                BoxliteError::Database(format!("Failed to deserialize SnapshotInfo: {}", e))
            })?;
            results.push(info);
        }
        Ok(results)
    }

    /// Delete a snapshot record by ID.
    pub(crate) fn delete(&self, id: &str) -> BoxliteResult<()> {
        let conn = self.db.conn();
        db_err!(conn.execute("DELETE FROM snapshot WHERE id = ?1", rusqlite::params![id],))?;
        Ok(())
    }

    /// Delete all snapshot records for a box.
    pub(crate) fn delete_all_for_box(&self, box_id: &str) -> BoxliteResult<u64> {
        let conn = self.db.conn();
        let rows = db_err!(conn.execute(
            "DELETE FROM snapshot WHERE box_id = ?1",
            rusqlite::params![box_id],
        ))?;
        Ok(rows as u64)
    }
}

/// Deserialize an optional JSON string into an optional `SnapshotInfo`.
fn deserialize_optional(json: Option<String>) -> BoxliteResult<Option<SnapshotInfo>> {
    match json {
        Some(j) => {
            let info: SnapshotInfo = serde_json::from_str(&j).map_err(|e| {
                BoxliteError::Database(format!("Failed to deserialize SnapshotInfo: {}", e))
            })?;
            Ok(Some(info))
        }
        None => Ok(None),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_db() -> Database {
        let dir = TempDir::new().unwrap();
        let db_path = dir.keep().join("test.db");
        Database::open(&db_path).unwrap()
    }

    fn make_snapshot(id: &str, box_id: &str, name: &str) -> SnapshotInfo {
        SnapshotInfo {
            id: id.to_string(),
            box_id: box_id.to_string(),
            name: name.to_string(),
            created_at: chrono::Utc::now().timestamp(),
            disk_info: crate::disk::DiskInfo {
                base_path: format!("/boxes/{}/snapshots/{}/disk.qcow2", box_id, name),
                container_disk_bytes: 10 * 1024 * 1024 * 1024,
                size_bytes: 512,
            },
        }
    }

    #[test]
    fn test_save_and_find() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        let snap = make_snapshot("s1", "box-1", "my-snap");
        store.save(&snap).unwrap();

        let found = store.find("box-1", "my-snap").unwrap().unwrap();
        assert_eq!(found.id, "s1");
        assert_eq!(found.box_id, "box-1");
        assert_eq!(found.name, "my-snap");
        assert_eq!(
            found.disk_info.container_disk_bytes,
            10 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn test_find_nonexistent() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        assert!(store.find("box-1", "nope").unwrap().is_none());
    }

    #[test]
    fn test_list_ordered_by_created_at() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        let mut s1 = make_snapshot("s1", "box-1", "snap-a");
        s1.created_at = 1000;
        let mut s2 = make_snapshot("s2", "box-1", "snap-b");
        s2.created_at = 2000;
        let mut s3 = make_snapshot("s3", "box-1", "snap-c");
        s3.created_at = 3000;

        store.save(&s1).unwrap();
        store.save(&s2).unwrap();
        store.save(&s3).unwrap();

        let list = store.list("box-1").unwrap();
        assert_eq!(list.len(), 3);
        // Newest first
        assert_eq!(list[0].name, "snap-c");
        assert_eq!(list[1].name, "snap-b");
        assert_eq!(list[2].name, "snap-a");
    }

    #[test]
    fn test_list_filters_by_box() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        store.save(&make_snapshot("s1", "box-1", "snap-a")).unwrap();
        store.save(&make_snapshot("s2", "box-2", "snap-b")).unwrap();

        let list = store.list("box-1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].box_id, "box-1");
    }

    #[test]
    fn test_delete() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        store.save(&make_snapshot("s1", "box-1", "snap")).unwrap();
        assert!(store.find("box-1", "snap").unwrap().is_some());

        store.delete("s1").unwrap();
        assert!(store.find("box-1", "snap").unwrap().is_none());
    }

    #[test]
    fn test_delete_all_for_box() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        store.save(&make_snapshot("s1", "box-1", "snap-a")).unwrap();
        store.save(&make_snapshot("s2", "box-1", "snap-b")).unwrap();
        store.save(&make_snapshot("s3", "box-2", "snap-c")).unwrap();

        let removed = store.delete_all_for_box("box-1").unwrap();
        assert_eq!(removed, 2);

        assert!(store.list("box-1").unwrap().is_empty());
        assert_eq!(store.list("box-2").unwrap().len(), 1);
    }

    #[test]
    fn test_unique_name_per_box() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        store.save(&make_snapshot("s1", "box-1", "snap-a")).unwrap();

        // Same name for same box should fail.
        let dup = make_snapshot("s2", "box-1", "snap-a");
        assert!(store.save(&dup).is_err(), "duplicate name should fail");

        // Same name for different box should succeed.
        store.save(&make_snapshot("s3", "box-2", "snap-a")).unwrap();
    }

    #[test]
    fn test_json_roundtrip() {
        let db = test_db();
        let store = SnapshotStore::new(db);

        let snap = SnapshotInfo {
            id: "rt-1".to_string(),
            box_id: "box-99".to_string(),
            name: "roundtrip-test".to_string(),
            created_at: 1700000000,
            disk_info: crate::disk::DiskInfo {
                base_path: "/boxes/box-99/snapshots/roundtrip-test/disk.qcow2".to_string(),
                container_disk_bytes: 42 * 1024 * 1024 * 1024,
                size_bytes: 1024,
            },
        };
        store.save(&snap).unwrap();

        let found = store.find("box-99", "roundtrip-test").unwrap().unwrap();
        assert_eq!(found.id, "rt-1");
        assert_eq!(found.box_id, "box-99");
        assert_eq!(found.name, "roundtrip-test");
        assert_eq!(
            found.disk_info.base_path,
            "/boxes/box-99/snapshots/roundtrip-test/disk.qcow2"
        );
        assert_eq!(
            found.disk_info.container_disk_bytes,
            42 * 1024 * 1024 * 1024
        );
        assert_eq!(found.disk_info.size_bytes, 1024);
        assert_eq!(found.created_at, 1700000000);
    }
}
