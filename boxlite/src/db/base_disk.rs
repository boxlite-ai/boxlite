//! Base disk storage for clone bases and rootfs cache.
//!
//! All entries are immutable COW fork points with different lifecycle rules:
//! - `CloneBase`: unnamed, auto-deleted when no box references the base
//!   (tracked via `base_disk_ref` table)
//! - `Rootfs`: global guest rootfs cache (`source_box_id = "__global__"`)
//! - `Snapshot`: kept for backward compatibility in the DB CHECK constraint,
//!   but new snapshots use the dedicated `snapshot` table (see `db/snapshot.rs`).
//!
//! Uses the BoxConfig JSON blob pattern: queryable columns for indexed lookups +
//! JSON blob for full struct flexibility.

use rusqlite::OptionalExtension;

use super::{Database, db_err};
use crate::disk::base_disk::{BaseDisk, BaseDiskKind};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Full database record wrapping a `BaseDisk`.
///
/// On read: deserialize JSON → `BaseDisk`.
#[derive(Debug, Clone)]
pub struct BaseDiskInfo {
    pub disk: BaseDisk,
}

// Convenience accessors to avoid `.disk.field` everywhere.
#[allow(dead_code)]
impl BaseDiskInfo {
    pub fn id(&self) -> &str {
        &self.disk.id
    }
    pub fn source_box_id(&self) -> &str {
        &self.disk.source_box_id
    }
    pub fn name(&self) -> Option<&str> {
        self.disk.name.as_deref()
    }
    pub fn kind(&self) -> BaseDiskKind {
        self.disk.kind
    }
    pub fn base_path(&self) -> &str {
        &self.disk.disk_info.base_path
    }
    pub fn container_disk_bytes(&self) -> u64 {
        self.disk.disk_info.container_disk_bytes
    }
    pub fn size_bytes(&self) -> u64 {
        self.disk.disk_info.size_bytes
    }
    pub fn created_at(&self) -> i64 {
        self.disk.created_at
    }
    pub fn disk_info(&self) -> &crate::disk::DiskInfo {
        &self.disk.disk_info
    }
}

// ============================================================================
// Store
// ============================================================================

/// Map a database row to a `BaseDiskInfo`.
///
/// Expects columns: id, source_box_id, name, kind, base_path, created_at, json.
fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<BaseDiskInfo> {
    let json_str: String = row.get("json")?;
    let disk: BaseDisk = serde_json::from_str(&json_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            6, // json column index
            rusqlite::types::Type::Text,
            Box::new(e),
        )
    })?;
    Ok(BaseDiskInfo { disk })
}

/// Storage operations for the `base_disk` table.
#[derive(Clone)]
pub(crate) struct BaseDiskStore {
    db: Database,
}

impl BaseDiskStore {
    pub(crate) fn new(db: Database) -> Self {
        Self { db }
    }

    /// Insert a new base disk record.
    ///
    /// Serializes `BaseDisk` to JSON and extracts queryable columns.
    pub(crate) fn insert(&self, disk: &BaseDisk) -> BoxliteResult<()> {
        let json = serde_json::to_string(disk)
            .map_err(|e| BoxliteError::Database(format!("Failed to serialize BaseDisk: {}", e)))?;
        let conn = self.db.conn();
        db_err!(conn.execute(
            "INSERT INTO base_disk \
             (id, source_box_id, name, kind, base_path, created_at, json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                disk.id,
                disk.source_box_id,
                disk.name,
                disk.kind.as_str(),
                disk.disk_info.base_path,
                disk.created_at,
                json,
            ],
        ))?;
        Ok(())
    }

    /// Find a base disk by its ID.
    #[allow(dead_code)] // used in lineage.rs tests
    pub(crate) fn find_by_id(&self, id: &str) -> BoxliteResult<Option<BaseDiskInfo>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT id, source_box_id, name, kind, base_path, \
                 created_at, json FROM base_disk WHERE id = ?1",
                rusqlite::params![id],
                row_to_record,
            )
            .optional()
        )?;
        Ok(result)
    }

    /// Find a base disk by its file path.
    pub(crate) fn find_by_base_path(&self, base_path: &str) -> BoxliteResult<Option<BaseDiskInfo>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT id, source_box_id, name, kind, base_path, \
                 created_at, json FROM base_disk WHERE base_path = ?1",
                rusqlite::params![base_path],
                row_to_record,
            )
            .optional()
        )?;
        Ok(result)
    }

    /// Find a base disk by box ID and name.
    pub(crate) fn find_by_name(
        &self,
        source_box_id: &str,
        name: &str,
    ) -> BoxliteResult<Option<BaseDiskInfo>> {
        let conn = self.db.conn();
        let result = db_err!(
            conn.query_row(
                "SELECT id, source_box_id, name, kind, base_path, \
                 created_at, json FROM base_disk \
                 WHERE source_box_id = ?1 AND name = ?2",
                rusqlite::params![source_box_id, name],
                row_to_record,
            )
            .optional()
        )?;
        Ok(result)
    }

    /// List all base disks for a box, optionally filtered by kind. Newest first.
    pub(crate) fn list_by_box(
        &self,
        source_box_id: &str,
        kind: Option<BaseDiskKind>,
    ) -> BoxliteResult<Vec<BaseDiskInfo>> {
        let conn = self.db.conn();
        let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match kind {
            Some(k) => (
                "SELECT id, source_box_id, name, kind, base_path, \
                 created_at, json FROM base_disk \
                 WHERE source_box_id = ?1 AND kind = ?2 \
                 ORDER BY created_at DESC"
                    .to_string(),
                vec![
                    Box::new(source_box_id.to_string()),
                    Box::new(k.as_str().to_string()),
                ],
            ),
            None => (
                "SELECT id, source_box_id, name, kind, base_path, \
                 created_at, json FROM base_disk \
                 WHERE source_box_id = ?1 \
                 ORDER BY created_at DESC"
                    .to_string(),
                vec![Box::new(source_box_id.to_string())],
            ),
        };

        let mut stmt = db_err!(conn.prepare(&sql))?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let rows = db_err!(stmt.query_map(params_refs.as_slice(), row_to_record))?;

        let mut records = Vec::new();
        for row in rows {
            records.push(db_err!(row)?);
        }
        Ok(records)
    }

    /// Delete a base disk record by ID.
    pub(crate) fn delete(&self, id: &str) -> BoxliteResult<()> {
        let conn = self.db.conn();
        db_err!(conn.execute("DELETE FROM base_disk WHERE id = ?1", rusqlite::params![id],))?;
        Ok(())
    }

    /// Delete all base disks for a given box (used during box deletion).
    #[allow(dead_code)] // used in tests
    pub(crate) fn delete_all_for_box(&self, source_box_id: &str) -> BoxliteResult<u64> {
        let conn = self.db.conn();
        let rows = db_err!(conn.execute(
            "DELETE FROM base_disk WHERE source_box_id = ?1",
            rusqlite::params![source_box_id],
        ))?;
        Ok(rows as u64)
    }

    // ========================================================================
    // Base disk ref tracking (base_disk_ref table)
    // ========================================================================

    /// Record that `box_id` depends on `base_disk_id`.
    ///
    /// Idempotent: INSERT OR IGNORE on the composite primary key.
    pub(crate) fn add_ref(&self, base_disk_id: &str, box_id: &str) -> BoxliteResult<()> {
        let conn = self.db.conn();
        db_err!(conn.execute(
            "INSERT OR IGNORE INTO base_disk_ref (base_disk_id, box_id) VALUES (?1, ?2)",
            rusqlite::params![base_disk_id, box_id],
        ))?;
        Ok(())
    }

    /// Remove all refs for a box and return the affected base_disk_ids.
    ///
    /// Used during box deletion to know which bases may become orphaned.
    pub(crate) fn remove_all_refs_for_box(&self, box_id: &str) -> BoxliteResult<Vec<String>> {
        let conn = self.db.conn();

        // Collect affected base_disk_ids BEFORE deleting.
        let mut stmt =
            db_err!(conn.prepare("SELECT base_disk_id FROM base_disk_ref WHERE box_id = ?1"))?;
        let ids: Vec<String> =
            db_err!(stmt.query_map(rusqlite::params![box_id], |row| { row.get(0) }))?
                .filter_map(|r| r.ok())
                .collect();

        db_err!(conn.execute(
            "DELETE FROM base_disk_ref WHERE box_id = ?1",
            rusqlite::params![box_id],
        ))?;

        Ok(ids)
    }

    /// Check if any box depends on `base_disk_id`.
    pub(crate) fn has_dependents(&self, base_disk_id: &str) -> BoxliteResult<bool> {
        let conn = self.db.conn();
        let exists: bool = db_err!(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM base_disk_ref WHERE base_disk_id = ?1)",
            rusqlite::params![base_disk_id],
            |row| row.get(0),
        ))?;
        Ok(exists)
    }

    /// List all box IDs that depend on `base_disk_id`.
    pub(crate) fn dependent_boxes(&self, base_disk_id: &str) -> BoxliteResult<Vec<String>> {
        let conn = self.db.conn();
        let mut stmt =
            db_err!(conn.prepare("SELECT box_id FROM base_disk_ref WHERE base_disk_id = ?1"))?;
        let rows = db_err!(stmt.query_map(rusqlite::params![base_disk_id], |row| { row.get(0) }))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(db_err!(row)?);
        }
        Ok(result)
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

    fn make_disk(
        id: &str,
        source_box_id: &str,
        name: Option<&str>,
        kind: BaseDiskKind,
        base_path: &str,
    ) -> BaseDisk {
        BaseDisk {
            id: id.to_string(),
            source_box_id: source_box_id.to_string(),
            name: name.map(|s| s.to_string()),
            kind,
            disk_info: crate::disk::DiskInfo {
                base_path: base_path.to_string(),
                container_disk_bytes: 10 * 1024 * 1024 * 1024,
                size_bytes: 512,
            },
            created_at: chrono::Utc::now().timestamp(),
        }
    }

    #[test]
    fn test_insert_and_find_clone_base() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let disk = make_disk(
            "base-1",
            "src-box",
            None,
            BaseDiskKind::CloneBase,
            "/bases/base-1",
        );
        store.insert(&disk).unwrap();

        let found = store.find_by_base_path("/bases/base-1").unwrap().unwrap();
        assert_eq!(found.id(), "base-1");
        assert_eq!(found.source_box_id(), "src-box");
        assert_eq!(found.kind(), BaseDiskKind::CloneBase);
        assert!(found.name().is_none());
    }

    #[test]
    fn test_insert_and_find_snapshot() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let disk = make_disk(
            "snap-1",
            "box-1",
            Some("my-snap"),
            BaseDiskKind::Snapshot,
            "/bases/snap-1",
        );
        store.insert(&disk).unwrap();

        let found = store.find_by_name("box-1", "my-snap").unwrap().unwrap();
        assert_eq!(found.id(), "snap-1");
        assert_eq!(found.kind(), BaseDiskKind::Snapshot);
        assert_eq!(found.name(), Some("my-snap"));
    }

    #[test]
    fn test_find_by_id() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let disk = make_disk(
            "layer-42",
            "box-1",
            None,
            BaseDiskKind::CloneBase,
            "/bases/42",
        );
        store.insert(&disk).unwrap();

        let found = store.find_by_id("layer-42").unwrap().unwrap();
        assert_eq!(found.base_path(), "/bases/42");

        assert!(store.find_by_id("nonexistent").unwrap().is_none());
    }

    #[test]
    fn test_delete() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let disk = make_disk(
            "base-1",
            "src-box",
            None,
            BaseDiskKind::CloneBase,
            "/bases/base-1",
        );
        store.insert(&disk).unwrap();

        assert!(store.find_by_id("base-1").unwrap().is_some());
        store.delete("base-1").unwrap();
        assert!(store.find_by_id("base-1").unwrap().is_none());
    }

    #[test]
    fn test_list_by_box_filters_kind() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let snap = make_disk(
            "snap-1",
            "box-1",
            Some("snap-a"),
            BaseDiskKind::Snapshot,
            "/bases/s1",
        );
        let base = make_disk(
            "base-1",
            "box-1",
            None,
            BaseDiskKind::CloneBase,
            "/bases/b1",
        );
        store.insert(&snap).unwrap();
        store.insert(&base).unwrap();

        let snapshots = store
            .list_by_box("box-1", Some(BaseDiskKind::Snapshot))
            .unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].id(), "snap-1");

        let bases = store
            .list_by_box("box-1", Some(BaseDiskKind::CloneBase))
            .unwrap();
        assert_eq!(bases.len(), 1);
        assert_eq!(bases[0].id(), "base-1");

        let all = store.list_by_box("box-1", None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_delete_all_for_box() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let s1 = make_disk(
            "s1",
            "box-1",
            Some("snap-a"),
            BaseDiskKind::Snapshot,
            "/bases/s1",
        );
        let s2 = make_disk(
            "s2",
            "box-1",
            Some("snap-b"),
            BaseDiskKind::Snapshot,
            "/bases/s2",
        );
        let s3 = make_disk(
            "s3",
            "box-2",
            Some("snap-c"),
            BaseDiskKind::Snapshot,
            "/bases/s3",
        );
        store.insert(&s1).unwrap();
        store.insert(&s2).unwrap();
        store.insert(&s3).unwrap();

        let removed = store.delete_all_for_box("box-1").unwrap();
        assert_eq!(removed, 2);

        assert!(store.find_by_id("s1").unwrap().is_none());
        assert!(store.find_by_id("s2").unwrap().is_none());
        assert!(store.find_by_id("s3").unwrap().is_some()); // box-2's record preserved
    }

    #[test]
    fn test_rootfs_kind() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let disk = make_disk(
            "rf-1",
            "__global__",
            Some("alpine-3.19-abc123"),
            BaseDiskKind::Rootfs,
            "/bases/rf-1.ext4",
        );
        store.insert(&disk).unwrap();

        let found = store
            .find_by_name("__global__", "alpine-3.19-abc123")
            .unwrap()
            .unwrap();
        assert_eq!(found.id(), "rf-1");
        assert_eq!(found.kind(), BaseDiskKind::Rootfs);
        assert_eq!(found.base_path(), "/bases/rf-1.ext4");
    }

    #[test]
    fn test_unique_name_per_box() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let s1 = make_disk(
            "s1",
            "box-1",
            Some("snap-a"),
            BaseDiskKind::Snapshot,
            "/bases/s1",
        );
        store.insert(&s1).unwrap();

        // Same name for same box should fail
        let s2 = make_disk(
            "s2",
            "box-1",
            Some("snap-a"),
            BaseDiskKind::Snapshot,
            "/bases/s2",
        );
        let result = store.insert(&s2);
        assert!(result.is_err(), "duplicate snapshot name should fail");

        // Same name for different box should succeed
        let s3 = make_disk(
            "s3",
            "box-2",
            Some("snap-a"),
            BaseDiskKind::Snapshot,
            "/bases/s3",
        );
        store.insert(&s3).unwrap();
    }

    #[test]
    fn test_null_names_allowed() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        // Multiple clone_bases with NULL name for the same box should succeed.
        // SQLite treats NULLs as distinct in UNIQUE constraints.
        let b1 = make_disk("b1", "box-1", None, BaseDiskKind::CloneBase, "/bases/b1");
        let b2 = make_disk("b2", "box-1", None, BaseDiskKind::CloneBase, "/bases/b2");
        let b3 = make_disk("b3", "box-1", None, BaseDiskKind::CloneBase, "/bases/b3");

        store.insert(&b1).unwrap();
        store.insert(&b2).unwrap();
        store.insert(&b3).unwrap();

        let bases = store
            .list_by_box("box-1", Some(BaseDiskKind::CloneBase))
            .unwrap();
        assert_eq!(bases.len(), 3);
    }

    #[test]
    fn test_find_by_nonexistent() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        assert!(store.find_by_id("nope").unwrap().is_none());
        assert!(store.find_by_base_path("/nope").unwrap().is_none());
        assert!(store.find_by_name("box", "nope").unwrap().is_none());
    }

    // ====================================================================
    // base_disk_ref tests
    // ====================================================================

    #[test]
    fn test_add_ref_is_idempotent() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        store.add_ref("base-1", "box-1").unwrap();
        store.add_ref("base-1", "box-1").unwrap(); // duplicate — should not error
        let deps = store.dependent_boxes("base-1").unwrap();
        assert_eq!(deps, vec!["box-1"]);
    }

    #[test]
    fn test_has_dependents() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        assert!(!store.has_dependents("base-1").unwrap());

        store.add_ref("base-1", "box-1").unwrap();
        assert!(store.has_dependents("base-1").unwrap());
    }

    #[test]
    fn test_dependent_boxes_multiple() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        store.add_ref("base-1", "box-1").unwrap();
        store.add_ref("base-1", "box-2").unwrap();
        store.add_ref("base-2", "box-2").unwrap();

        let mut deps = store.dependent_boxes("base-1").unwrap();
        deps.sort();
        assert_eq!(deps, vec!["box-1", "box-2"]);

        let deps2 = store.dependent_boxes("base-2").unwrap();
        assert_eq!(deps2, vec!["box-2"]);
    }

    #[test]
    fn test_remove_all_refs_for_box() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        store.add_ref("base-1", "box-1").unwrap();
        store.add_ref("base-2", "box-1").unwrap();
        store.add_ref("base-1", "box-2").unwrap();

        let mut affected = store.remove_all_refs_for_box("box-1").unwrap();
        affected.sort();
        assert_eq!(affected, vec!["base-1", "base-2"]);

        // box-1 refs gone, box-2 ref remains
        assert!(store.has_dependents("base-1").unwrap());
        assert!(!store.has_dependents("base-2").unwrap());

        let deps = store.dependent_boxes("base-1").unwrap();
        assert_eq!(deps, vec!["box-2"]);
    }

    #[test]
    fn test_remove_all_refs_for_box_empty() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let affected = store.remove_all_refs_for_box("nonexistent").unwrap();
        assert!(affected.is_empty());
    }

    #[test]
    fn test_json_roundtrip() {
        let db = test_db();
        let store = BaseDiskStore::new(db);

        let disk = BaseDisk {
            id: "rt-1".to_string(),
            source_box_id: "box-99".to_string(),
            name: Some("roundtrip-test".to_string()),
            kind: BaseDiskKind::Snapshot,
            disk_info: crate::disk::DiskInfo {
                base_path: "/bases/rt-1.qcow2".to_string(),
                container_disk_bytes: 42 * 1024 * 1024 * 1024,
                size_bytes: 1024,
            },
            created_at: 1700000000,
        };
        store.insert(&disk).unwrap();

        let found = store.find_by_id("rt-1").unwrap().unwrap();
        assert_eq!(found.disk.id, "rt-1");
        assert_eq!(found.disk.source_box_id, "box-99");
        assert_eq!(found.disk.name.as_deref(), Some("roundtrip-test"));
        assert_eq!(found.disk.kind, BaseDiskKind::Snapshot);
        assert_eq!(found.disk.disk_info.base_path, "/bases/rt-1.qcow2");
        assert_eq!(
            found.disk.disk_info.container_disk_bytes,
            42 * 1024 * 1024 * 1024
        );
        assert_eq!(found.disk.disk_info.size_bytes, 1024);
        assert_eq!(found.disk.created_at, 1700000000);
    }
}
