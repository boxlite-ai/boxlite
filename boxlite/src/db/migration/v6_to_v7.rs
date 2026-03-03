//! Migration v6 → v7: Move disk files into disks/ subdirectory, add base_disk table,
//! and add snapshot table.
//!
//! Migrates existing box_snapshot records into the new `snapshot` table
//! (with JSON blob pattern), and removes per-box rootfs-base files (no longer needed).

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

        // 6. Move disk files for existing boxes.
        if let Some(home) = home_dir {
            migrate_box_disk_files(&home.join("boxes"))?;
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
/// Also removes rootfs-base files (no longer needed).
fn migrate_box_disk_files(boxes_dir: &Path) -> BoxliteResult<()> {
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

        // Remove rootfs-base from both old and new locations (no longer needed).
        for rootfs_base in [box_dir.join("rootfs-base"), disks_dir.join("rootfs-base")] {
            if rootfs_base.exists() {
                let _ = std::fs::remove_file(&rootfs_base);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_migrate_moves_disk_files() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let box_dir = boxes_dir.join("test-box-id");
        std::fs::create_dir_all(&box_dir).unwrap();

        // Create fake disk files at old locations.
        std::fs::write(box_dir.join("disk.qcow2"), b"container-disk").unwrap();
        std::fs::write(box_dir.join("guest-rootfs.qcow2"), b"guest-disk").unwrap();
        std::fs::write(box_dir.join("rootfs-base"), b"rootfs-base-data").unwrap();

        migrate_box_disk_files(&boxes_dir).unwrap();

        // Old locations should be gone.
        assert!(!box_dir.join("disk.qcow2").exists());
        assert!(!box_dir.join("guest-rootfs.qcow2").exists());
        assert!(!box_dir.join("rootfs-base").exists());

        // New locations should exist with correct content.
        let disks_dir = box_dir.join("disks");
        assert_eq!(
            std::fs::read(disks_dir.join("disk.qcow2")).unwrap(),
            b"container-disk"
        );
        assert_eq!(
            std::fs::read(disks_dir.join("guest-rootfs.qcow2")).unwrap(),
            b"guest-disk"
        );
        // rootfs-base should NOT be in disks_dir (it was removed)
        assert!(!disks_dir.join("rootfs-base").exists());
    }

    #[test]
    fn test_migrate_handles_missing_files_gracefully() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let box_dir = boxes_dir.join("test-box-id");
        std::fs::create_dir_all(&box_dir).unwrap();

        // Only container disk exists.
        std::fs::write(box_dir.join("disk.qcow2"), b"data").unwrap();

        migrate_box_disk_files(&boxes_dir).unwrap();

        let disks_dir = box_dir.join("disks");
        assert!(disks_dir.join("disk.qcow2").exists());
        assert!(!disks_dir.join("guest-rootfs.qcow2").exists());
        assert!(!disks_dir.join("rootfs-base").exists());
    }

    #[test]
    fn test_migrate_skips_nonexistent_boxes_dir() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("nonexistent");

        // Should not error.
        migrate_box_disk_files(&boxes_dir).unwrap();
    }

    #[test]
    fn test_migrate_removes_rootfs_base_from_disks_dir() {
        let dir = TempDir::new().unwrap();
        let boxes_dir = dir.path().join("boxes");
        let box_dir = boxes_dir.join("test-box");
        let disks_dir = box_dir.join("disks");
        std::fs::create_dir_all(&disks_dir).unwrap();

        // Simulate box that already has disks/ dir with rootfs-base in it
        // (partially migrated or created during v6).
        std::fs::write(disks_dir.join("disk.qcow2"), b"data").unwrap();
        std::fs::write(disks_dir.join("rootfs-base"), b"old-rootfs").unwrap();

        migrate_box_disk_files(&boxes_dir).unwrap();

        // rootfs-base should be removed from disks/ dir
        assert!(!disks_dir.join("rootfs-base").exists());
        // Other disk files should remain
        assert!(disks_dir.join("disk.qcow2").exists());
    }
}
