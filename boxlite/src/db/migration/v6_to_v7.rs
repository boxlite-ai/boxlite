//! Migration v6 → v7: Move disk files into disks/ subdirectory, add base_disk table,
//! and add snapshot table.
//!
//! Migrates existing box_snapshot records into the new `snapshot` table
//! (with JSON blob pattern). Moves per-box rootfs-base files into the shared
//! `bases/` directory and rebases guest-rootfs.qcow2 backing references.

use std::path::Path;

use rusqlite::Connection;
use serde_json::json;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};
use crate::db::schema;

pub(crate) struct MoveDisksAndAddBaseDisk;

impl Migration for MoveDisksAndAddBaseDisk {
    fn source_version(&self) -> i32 {
        6
    }
    fn target_version(&self) -> i32 {
        7
    }
    fn description(&self) -> &str {
        "Move disk files into disks/ subdirectory, add base_disk and snapshot tables"
    }

    fn run(&self, conn: &Connection, home_dir: Option<&Path>) -> BoxliteResult<()> {
        // 1. Create base_disk table (for clone bases and rootfs cache).
        db_err!(conn.execute_batch(schema::BASE_DISK_TABLE))?;

        // 2. Create snapshot table (for per-box snapshots).
        db_err!(conn.execute_batch(schema::SNAPSHOT_TABLE))?;

        // 3. Create base_disk_ref table (for DB-based ref tracking / GC).
        db_err!(conn.execute_batch(schema::BASE_DISK_REF_TABLE))?;

        // 4. Migrate existing box_snapshot records into the new snapshot table.
        migrate_snapshots(conn)?;

        // 5. Drop the old box_snapshot table.
        db_err!(conn.execute_batch("DROP TABLE IF EXISTS box_snapshot;"))?;

        // 6. Move disk files for existing boxes and migrate rootfs-base files.
        if let Some(home) = home_dir {
            let bases_dir = home.join("bases");
            std::fs::create_dir_all(&bases_dir).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create bases directory {}: {}",
                    bases_dir.display(),
                    e
                ))
            })?;
            migrate_box_disk_files(&home.join("boxes"), &bases_dir, conn)?;
        }

        Ok(())
    }
}

/// Migrate box_snapshot rows into the new `snapshot` table.
///
/// Each row is serialized to a JSON blob following the SnapshotInfo pattern.
fn migrate_snapshots(conn: &Connection) -> BoxliteResult<()> {
    // Check if box_snapshot table exists (it may not on fresh installs that jumped versions).
    let table_exists: bool = db_err!(conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='box_snapshot'",
        [],
        |row| row.get(0),
    ))?;

    if !table_exists {
        return Ok(());
    }

    // Read all existing snapshots and insert with JSON blob.
    let mut stmt = db_err!(conn.prepare(
        "SELECT id, box_id, name, snapshot_dir, container_disk_bytes, size_bytes, created_at \
         FROM box_snapshot"
    ))?;

    let rows = db_err!(stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
        ))
    }))?;

    for row in rows {
        let (id, box_id, name, snapshot_dir, container_disk_bytes, size_bytes, created_at) =
            db_err!(row)?;

        let json_blob = json!({
            "id": id,
            "box_id": box_id,
            "name": name,
            "base_path": snapshot_dir,
            "container_disk_bytes": container_disk_bytes as u64,
            "size_bytes": size_bytes as u64,
            "created_at": created_at,
        });

        db_err!(conn.execute(
            "INSERT INTO snapshot (id, box_id, name, created_at, json) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, box_id, name, created_at, json_blob.to_string()],
        ))?;
    }

    Ok(())
}

/// Move disk.qcow2 and guest-rootfs.qcow2 from box_dir/ into box_dir/disks/.
///
/// For boxes with a `rootfs-base` file (CoW filesystem reflink), moves the file
/// into `bases/` and rebases `guest-rootfs.qcow2` to point at the new location.
/// For boxes without `rootfs-base` (non-CoW fallback), validates the existing
/// backing chain and warns if broken.
fn migrate_box_disk_files(
    boxes_dir: &Path,
    bases_dir: &Path,
    conn: &Connection,
) -> BoxliteResult<()> {
    if !boxes_dir.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(boxes_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read boxes directory {}: {}",
            boxes_dir.display(),
            e
        ))
    })?;

    for entry in entries {
        let entry = entry
            .map_err(|e| BoxliteError::Storage(format!("Failed to read directory entry: {}", e)))?;
        let box_dir = entry.path();
        if !box_dir.is_dir() {
            continue;
        }

        // Recover any pending snapshot BEFORE moving disks.
        crate::litebox::local_snapshot::recover_pending_snapshot(&box_dir);

        let disks_dir = box_dir.join("disks");
        std::fs::create_dir_all(&disks_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create disks directory {}: {}",
                disks_dir.display(),
                e
            ))
        })?;

        // Move each disk file if it exists at the old location.
        for filename in ["disk.qcow2", "guest-rootfs.qcow2"] {
            let old_path = box_dir.join(filename);
            if old_path.exists() {
                let new_path = disks_dir.join(filename);
                std::fs::rename(&old_path, &new_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "Failed to move {} to {}: {}",
                        old_path.display(),
                        new_path.display(),
                        e
                    ))
                })?;
            }
        }

        // Migrate rootfs-base: move to bases/ and rebase guest-rootfs.qcow2.
        migrate_rootfs_base(&box_dir, &disks_dir, bases_dir, conn)?;
    }

    Ok(())
}

/// Migrate a box's rootfs-base file into the shared `bases/` directory.
///
/// On CoW filesystems (APFS, btrfs), v6 created a per-box `rootfs-base` reflink that
/// `guest-rootfs.qcow2` used as its backing file. We move this file to `bases/` (the
/// v7 standard location) and rebase the qcow2 header to point at the new path.
///
/// On non-CoW filesystems, `rootfs-base` was never created and `guest-rootfs.qcow2`
/// backed directly on the shared cache. We validate the backing chain is intact.
fn migrate_rootfs_base(
    box_dir: &Path,
    disks_dir: &Path,
    bases_dir: &Path,
    conn: &Connection,
) -> BoxliteResult<()> {
    // Find rootfs-base in either old or new location.
    let rootfs_base = if box_dir.join("rootfs-base").exists() {
        Some(box_dir.join("rootfs-base"))
    } else if disks_dir.join("rootfs-base").exists() {
        Some(disks_dir.join("rootfs-base"))
    } else {
        None
    };

    let guest_rootfs = disks_dir.join("guest-rootfs.qcow2");

    if let Some(rootfs_base_path) = rootfs_base {
        // CoW filesystem case: rootfs-base exists.
        // Move it to bases/{nanoid}.ext4 and rebase the qcow2.
        let base_id = nanoid::nanoid!(8);
        let new_path = bases_dir.join(format!("{}.ext4", base_id));

        if std::fs::rename(&rootfs_base_path, &new_path).is_err() {
            // Cross-filesystem fallback: copy + delete.
            std::fs::copy(&rootfs_base_path, &new_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to move rootfs-base {} to {}: {}",
                    rootfs_base_path.display(),
                    new_path.display(),
                    e
                ))
            })?;
            let _ = std::fs::remove_file(&rootfs_base_path);
        }

        // Rebase guest-rootfs.qcow2 to point at the new location.
        if guest_rootfs.exists()
            && let Err(e) = crate::disk::qcow2::set_backing_file_path(&guest_rootfs, &new_path)
        {
            tracing::warn!(
                box_dir = %box_dir.display(),
                error = %e,
                "Failed to rebase guest-rootfs.qcow2 (backing chain may be broken)"
            );
        }

        // Insert base_disk record for lifecycle tracking.
        let file_size = std::fs::metadata(&new_path).map(|m| m.len()).unwrap_or(0);
        let now = chrono::Utc::now().timestamp();
        let box_id = box_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let json_blob = json!({
            "id": base_id,
            "source_box_id": box_id,
            "kind": "rootfs",
            "base_path": new_path.to_string_lossy(),
            "container_disk_bytes": file_size,
            "size_bytes": file_size,
            "created_at": now,
        });

        db_err!(conn.execute(
            "INSERT INTO base_disk \
             (id, source_box_id, name, kind, base_path, created_at, json) \
             VALUES (?1, ?2, NULL, 'rootfs', ?3, ?4, ?5)",
            rusqlite::params![
                base_id,
                box_id,
                new_path.to_string_lossy().to_string(),
                now,
                json_blob.to_string(),
            ],
        ))?;

        tracing::info!(
            box_id = %box_id,
            old_path = %rootfs_base_path.display(),
            new_path = %new_path.display(),
            "Migrated rootfs-base to bases/ and rebased guest-rootfs.qcow2"
        );
    } else if guest_rootfs.exists() {
        // Non-CoW filesystem case: rootfs-base was never created.
        // guest-rootfs.qcow2 backs directly on the shared cache — validate it exists.
        if let Ok(Some(backing)) = crate::disk::qcow2::read_backing_file_path(&guest_rootfs)
            && !Path::new(&backing).exists()
        {
            tracing::warn!(
                box_dir = %box_dir.display(),
                backing = %backing,
                "guest-rootfs.qcow2 references missing backing file \
                 (shared rootfs cache may have been deleted)"
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::TempDir;

    /// Create an in-memory DB with the base_disk table for migration tests.
    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(schema::BASE_DISK_TABLE).unwrap();
        conn.execute_batch(schema::SNAPSHOT_TABLE).unwrap();
        conn.execute_batch(schema::BASE_DISK_REF_TABLE).unwrap();
        conn
    }

    #[test]
    fn test_migrate_moves_disk_files() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let bases_dir = dir.path().join("bases");
        let box_dir = boxes_dir.join("test-box-id");
        std::fs::create_dir_all(&box_dir).unwrap();
        std::fs::create_dir_all(&bases_dir).unwrap();
        let conn = test_db();

        // Create fake disk files at old locations.
        std::fs::write(box_dir.join("disk.qcow2"), b"container-disk").unwrap();
        std::fs::write(box_dir.join("guest-rootfs.qcow2"), b"guest-disk").unwrap();
        std::fs::write(box_dir.join("rootfs-base"), b"rootfs-base-data").unwrap();

        migrate_box_disk_files(&boxes_dir, &bases_dir, &conn).unwrap();

        // Old locations should be gone.
        assert!(!box_dir.join("disk.qcow2").exists());
        assert!(!box_dir.join("guest-rootfs.qcow2").exists());
        assert!(!box_dir.join("rootfs-base").exists());

        // Container disk should be moved to disks/.
        let disks_dir = box_dir.join("disks");
        assert_eq!(
            std::fs::read(disks_dir.join("disk.qcow2")).unwrap(),
            b"container-disk"
        );

        // guest-rootfs.qcow2 should be in disks/ (moved, not deleted).
        assert!(disks_dir.join("guest-rootfs.qcow2").exists());

        // rootfs-base should be in bases/ (moved, not deleted).
        assert!(!box_dir.join("rootfs-base").exists());
        assert!(!disks_dir.join("rootfs-base").exists());
        let bases_entries: Vec<_> = std::fs::read_dir(&bases_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(
            bases_entries.len(),
            1,
            "bases/ should have exactly one file"
        );
        let base_file = &bases_entries[0];
        assert!(
            base_file.file_name().to_string_lossy().ends_with(".ext4"),
            "base file should have .ext4 extension"
        );
        assert_eq!(
            std::fs::read(base_file.path()).unwrap(),
            b"rootfs-base-data"
        );
    }

    #[test]
    fn test_migrate_handles_missing_files_gracefully() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let bases_dir = dir.path().join("bases");
        let box_dir = boxes_dir.join("test-box-id");
        std::fs::create_dir_all(&box_dir).unwrap();
        std::fs::create_dir_all(&bases_dir).unwrap();
        let conn = test_db();

        // Only container disk exists — no rootfs-base, no guest-rootfs.
        std::fs::write(box_dir.join("disk.qcow2"), b"data").unwrap();

        migrate_box_disk_files(&boxes_dir, &bases_dir, &conn).unwrap();

        let disks_dir = box_dir.join("disks");
        assert!(disks_dir.join("disk.qcow2").exists());
        assert!(!disks_dir.join("guest-rootfs.qcow2").exists());

        // bases/ should be empty (no rootfs-base to migrate).
        let bases_entries: Vec<_> = std::fs::read_dir(&bases_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(bases_entries.len(), 0);
    }

    #[test]
    fn test_migrate_skips_nonexistent_boxes_dir() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("nonexistent");
        let bases_dir = dir.path().join("bases");
        std::fs::create_dir_all(&bases_dir).unwrap();
        let conn = test_db();

        // Should not error.
        migrate_box_disk_files(&boxes_dir, &bases_dir, &conn).unwrap();
    }

    #[test]
    fn test_migrate_moves_rootfs_base_from_disks_dir() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let bases_dir = dir.path().join("bases");
        let box_dir = boxes_dir.join("test-box");
        let disks_dir = box_dir.join("disks");
        std::fs::create_dir_all(&disks_dir).unwrap();
        std::fs::create_dir_all(&bases_dir).unwrap();
        let conn = test_db();

        // Simulate partially-migrated box with rootfs-base already in disks/.
        std::fs::write(disks_dir.join("disk.qcow2"), b"data").unwrap();
        std::fs::write(disks_dir.join("rootfs-base"), b"old-rootfs").unwrap();

        migrate_box_disk_files(&boxes_dir, &bases_dir, &conn).unwrap();

        // rootfs-base should be moved to bases/ (not deleted).
        assert!(!disks_dir.join("rootfs-base").exists());
        assert!(disks_dir.join("disk.qcow2").exists());

        let bases_entries: Vec<_> = std::fs::read_dir(&bases_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(bases_entries.len(), 1);
        assert_eq!(
            std::fs::read(bases_entries[0].path()).unwrap(),
            b"old-rootfs"
        );
    }

    #[test]
    fn test_migrate_creates_base_disk_record() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let bases_dir = dir.path().join("bases");
        let box_dir = boxes_dir.join("my-box-123");
        std::fs::create_dir_all(&box_dir).unwrap();
        std::fs::create_dir_all(&bases_dir).unwrap();
        let conn = test_db();

        std::fs::write(box_dir.join("rootfs-base"), b"rootfs-data").unwrap();

        migrate_box_disk_files(&boxes_dir, &bases_dir, &conn).unwrap();

        // Verify base_disk record was created.
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM base_disk", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let (kind, source_box_id): (String, String) = conn
            .query_row(
                "SELECT kind, source_box_id FROM base_disk LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(kind, "rootfs");
        assert_eq!(source_box_id, "my-box-123");

        // base_path should point to bases/ directory.
        let base_path: String = conn
            .query_row("SELECT base_path FROM base_disk LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(
            base_path.contains("bases/"),
            "base_path should be in bases/ directory: {}",
            base_path
        );
    }

    #[test]
    fn test_migrate_rebases_guest_rootfs_qcow2() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let bases_dir = dir.path().join("bases");
        let box_dir = boxes_dir.join("rebase-box");
        std::fs::create_dir_all(&box_dir).unwrap();
        std::fs::create_dir_all(&bases_dir).unwrap();
        let conn = test_db();

        // Create a real rootfs-base file.
        let rootfs_base = box_dir.join("rootfs-base");
        std::fs::write(&rootfs_base, vec![0u8; 4096]).unwrap();

        // Create a real qcow2 backed by rootfs-base.
        // leak() prevents the Disk RAII guard from deleting the file on drop.
        let guest_rootfs = box_dir.join("guest-rootfs.qcow2");
        crate::disk::Qcow2Helper::create_cow_child_disk(
            &rootfs_base,
            crate::disk::BackingFormat::Raw,
            &guest_rootfs,
            4096,
        )
        .unwrap()
        .leak();

        // Verify initial backing path points to rootfs-base.
        let initial_backing = crate::disk::qcow2::read_backing_file_path(&guest_rootfs).unwrap();
        assert!(initial_backing.is_some());
        assert!(
            initial_backing.unwrap().contains("rootfs-base"),
            "initial backing should reference rootfs-base"
        );

        migrate_box_disk_files(&boxes_dir, &bases_dir, &conn).unwrap();

        // After migration, guest-rootfs.qcow2 should be in disks/ and rebased to bases/.
        let new_guest_rootfs = box_dir.join("disks").join("guest-rootfs.qcow2");
        assert!(new_guest_rootfs.exists());

        let new_backing = crate::disk::qcow2::read_backing_file_path(&new_guest_rootfs)
            .unwrap()
            .unwrap();
        assert!(
            new_backing.contains("bases/"),
            "backing should now point to bases/: {}",
            new_backing
        );
        assert!(
            !new_backing.contains("rootfs-base"),
            "backing should no longer reference rootfs-base: {}",
            new_backing
        );

        // rootfs-base should be gone from box_dir.
        assert!(!rootfs_base.exists());
    }

    #[test]
    fn test_migrate_preserves_guest_rootfs_without_rootfs_base() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let bases_dir = dir.path().join("bases");
        let box_dir = boxes_dir.join("non-cow-box");
        std::fs::create_dir_all(&box_dir).unwrap();
        std::fs::create_dir_all(&bases_dir).unwrap();
        let conn = test_db();

        // Non-CoW case: guest-rootfs.qcow2 exists but NO rootfs-base.
        std::fs::write(box_dir.join("disk.qcow2"), b"container").unwrap();
        std::fs::write(box_dir.join("guest-rootfs.qcow2"), b"guest").unwrap();

        migrate_box_disk_files(&boxes_dir, &bases_dir, &conn).unwrap();

        // guest-rootfs.qcow2 should be moved to disks/ unchanged.
        let disks_dir = box_dir.join("disks");
        assert!(disks_dir.join("guest-rootfs.qcow2").exists());
        assert_eq!(
            std::fs::read(disks_dir.join("guest-rootfs.qcow2")).unwrap(),
            b"guest"
        );

        // No base_disk record (no rootfs-base to migrate).
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM base_disk", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);

        // bases/ should be empty.
        let bases_entries: Vec<_> = std::fs::read_dir(&bases_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(bases_entries.len(), 0);
    }
}
