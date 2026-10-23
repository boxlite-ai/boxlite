//! Snapshot domain type and manager.
//!
//! `SnapshotInfo` is the public-facing snapshot metadata type (like `BoxConfig`
//! for boxes). `SnapshotManager` orchestrates snapshot creation, removal, and
//! restore operations using per-box snapshot directories.
//!
//! # Storage Layout
//!
//! ```text
//! ~/.boxlite/boxes/{box_id}/
//! ├── disks/
//! │   ├── disk.qcow2              # Live container disk (COW child)
//! │   └── guest-rootfs.qcow2
//! └── snapshots/
//!     ├── snap-1/
//!     │   └── disk.qcow2          # Snapshot container disk (immutable)
//!     └── snap-2/
//!         └── disk.qcow2
//! ```
//!
//! # Relationship to `BaseDiskManager`
//!
//! Clone bases remain in flat `bases/` dir, managed by `BaseDiskManager`.
//! Snapshots have their own per-box directories and dedicated `snapshot` table.
//! The only interaction is that snapshot files may reference clone bases in
//! `bases/` via qcow2 backing chains, which index-find GC accounts for.

use std::path::Path;

use serde::{Deserialize, Serialize};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::db::snapshot::SnapshotStore;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::{BackingFormat, Qcow2Helper};

// ============================================================================
// Domain Type
// ============================================================================

/// Public-facing snapshot metadata.
///
/// Serialized to JSON blob in the `snapshot` table. Follows the same pattern
/// as `BoxConfig` — domain type in `litebox/`, stored via `db/` layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    /// Unique snapshot ID (nanoid).
    pub id: String,
    /// ID of the box this snapshot belongs to.
    pub box_id: String,
    /// User-provided snapshot name (unique per box).
    pub name: String,
    /// Unix timestamp (seconds since epoch) when the snapshot was created.
    pub created_at: i64,
    /// Disk path and size metadata.
    #[serde(flatten)]
    pub disk_info: crate::disk::DiskInfo,
}

// ============================================================================
// Name Validation
// ============================================================================

/// Validate that a snapshot name is safe (no path traversal, no special chars).
pub(crate) fn validate_snapshot_name(name: &str) -> BoxliteResult<()> {
    if name.is_empty() {
        return Err(BoxliteError::InvalidArgument(
            "Snapshot name cannot be empty".into(),
        ));
    }
    if name.len() > 255 {
        return Err(BoxliteError::InvalidArgument(format!(
            "Snapshot name too long ({} chars, max 255)",
            name.len()
        )));
    }
    if name == "." || name == ".." {
        return Err(BoxliteError::InvalidArgument(format!(
            "Snapshot name '{}' is not allowed",
            name
        )));
    }
    if name.starts_with('.') {
        return Err(BoxliteError::InvalidArgument(
            "Snapshot name cannot start with '.'".into(),
        ));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(BoxliteError::InvalidArgument(
            "Snapshot name contains invalid characters (/, \\, or null byte)".into(),
        ));
    }
    Ok(())
}

// ============================================================================
// Manager
// ============================================================================

/// Snapshot business logic: creation, lookup, removal, restore, cleanup.
///
/// VM-agnostic — no quiescing, no locking. `LocalSnapshotBackend` orchestrates
/// those concerns and delegates the disk + DB operations here.
///
/// Snapshots are stored in per-box directories:
///   `boxes/{box_id}/snapshots/{name}/disk.qcow2`
#[derive(Clone)]
pub(crate) struct SnapshotManager {
    store: SnapshotStore,
}

impl SnapshotManager {
    pub(crate) fn new(store: SnapshotStore) -> Self {
        Self { store }
    }

    /// Expose the underlying store for direct queries.
    #[allow(dead_code)] // reserved for future use
    pub(crate) fn store(&self) -> &SnapshotStore {
        &self.store
    }

    /// Check if a snapshot with the given name exists for a box.
    pub(crate) fn exists(&self, box_id: &str, name: &str) -> BoxliteResult<bool> {
        Ok(self.store.find(box_id, name)?.is_some())
    }

    /// List all snapshots for a box. Newest first.
    pub(crate) fn list(&self, box_id: &str) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.store.list(box_id)
    }

    /// Get a single snapshot by box ID and name.
    pub(crate) fn get(&self, box_id: &str, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        self.store.find(box_id, name)
    }

    /// Create a snapshot from a box's live container disk.
    ///
    /// 1. Create `box_home/snapshots/{name}/` directory
    /// 2. Read virtual size from container disk
    /// 3. Rename container disk → `snapshots/{name}/disk.qcow2`
    /// 4. Create COW child at original path (box keeps running)
    /// 5. Insert DB record via `SnapshotStore`
    pub(crate) fn create(
        &self,
        box_home: &Path,
        name: &str,
        box_id: &str,
    ) -> BoxliteResult<SnapshotInfo> {
        let disks_dir = box_home.join("disks");
        let container_disk = disks_dir.join(disk_filenames::CONTAINER_DISK);

        if !container_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                container_disk.display()
            )));
        }

        // 1. Create snapshot directory
        let snapshot_dir = box_home.join("snapshots").join(name);
        std::fs::create_dir_all(&snapshot_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create snapshot directory {}: {}",
                snapshot_dir.display(),
                e
            ))
        })?;

        // 2-4. Fork: move container → snapshot dir, create COW child at original path
        let snap_disk = snapshot_dir.join(disk_filenames::CONTAINER_DISK);
        let forked = crate::disk::fork_qcow2(&container_disk, &snap_disk)?;
        let disk_info = crate::disk::DiskInfo::from(&forked);
        // forked is persistent (won't be deleted on drop)

        // 5. Insert DB record
        let snapshot_id = nanoid::nanoid!(8);
        let now = chrono::Utc::now().timestamp();
        let info = SnapshotInfo {
            id: snapshot_id,
            box_id: box_id.to_string(),
            name: name.to_string(),
            created_at: now,
            disk_info,
        };
        self.store.save(&info)?;

        Ok(info)
    }

    /// Remove a snapshot. Refuses if any disk in the system depends on it.
    ///
    /// Walks full qcow2 backing chains to detect dependencies:
    /// 1. Box's current container disk
    /// 2. Other snapshot disks for this box
    /// 3. Clone base disks in `bases/`
    pub(crate) fn remove(
        &self,
        box_id: &str,
        name: &str,
        container_disk: &Path,
        bases_dir: &Path,
    ) -> BoxliteResult<()> {
        let info = self.store.find(box_id, name)?.ok_or_else(|| {
            BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                name, box_id
            ))
        })?;

        let snap_disk = info.disk_info.to_path_buf();
        if !snap_disk.exists() {
            // Snapshot disk already gone — just clean up DB record.
            self.store.delete(&info.id)?;
            return Ok(());
        }

        // Check 1: Box's current container disk depends on this snapshot.
        if container_disk.exists() && crate::disk::is_backing_dependency(&snap_disk, container_disk)
        {
            return Err(BoxliteError::InvalidState(
                "Cannot remove snapshot: current disk depends on this snapshot. \
                 Restore a different snapshot first."
                    .to_string(),
            ));
        }

        // Check 2: Other snapshot disks for this box depend on this snapshot.
        let all_snapshots = self.store.list(box_id)?;
        for other in &all_snapshots {
            if other.id == info.id {
                continue; // Skip self.
            }
            let other_disk = other.disk_info.to_path_buf();
            if other_disk.exists() && crate::disk::is_backing_dependency(&snap_disk, &other_disk) {
                return Err(BoxliteError::InvalidState(format!(
                    "Cannot remove snapshot '{}': snapshot '{}' depends on it via backing chain",
                    name, other.name
                )));
            }
        }

        // Check 3: Clone base disks in bases/ depend on this snapshot.
        if bases_dir.exists()
            && let Ok(entries) = std::fs::read_dir(bases_dir)
        {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "qcow2")
                    && crate::disk::is_backing_dependency(&snap_disk, &path)
                {
                    return Err(BoxliteError::InvalidState(format!(
                        "Cannot remove snapshot '{}': a clone base disk ({}) depends on it",
                        name,
                        path.file_name().unwrap_or_default().to_string_lossy()
                    )));
                }
            }
        }

        // All checks passed — safe to delete.
        // Delete DB record first (authoritative metadata), then filesystem.
        // If crash occurs between the two, orphaned files are harmless and
        // cleaned up by remove_all_for_box() during box deletion.
        self.store.delete(&info.id)?;

        let snap_dir = snap_disk.parent().unwrap_or(Path::new(""));
        if snap_dir.exists()
            && let Err(e) = std::fs::remove_dir_all(snap_dir)
        {
            tracing::warn!(
                snapshot = %name,
                dir = %snap_dir.display(),
                error = %e,
                "Failed to remove snapshot directory (DB record already deleted)"
            );
        }

        Ok(())
    }

    /// Restore disks from a snapshot (COW child of snapshot file).
    pub(crate) fn restore_disks(
        &self,
        box_id: &str,
        name: &str,
        disks_dir: &Path,
    ) -> BoxliteResult<()> {
        let info = self.store.find(box_id, name)?.ok_or_else(|| {
            BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                name, box_id
            ))
        })?;

        let snap_disk = info.disk_info.to_path_buf();
        if !snap_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Snapshot container disk not found at {}",
                snap_disk.display()
            )));
        }

        // Replace current container disk with a COW child of the snapshot.
        let container_disk = disks_dir.join(disk_filenames::CONTAINER_DISK);
        if container_disk.exists() {
            std::fs::remove_file(&container_disk).map_err(|e| {
                BoxliteError::Storage(format!("Failed to remove current container disk: {}", e))
            })?;
        }

        Qcow2Helper::create_cow_child_disk(
            &snap_disk,
            BackingFormat::Qcow2,
            &container_disk,
            info.disk_info.container_disk_bytes,
        )?
        .leak();

        // Delete guest-rootfs.qcow2 so next start recreates it fresh from cache.
        let guest_disk = disks_dir.join(disk_filenames::GUEST_ROOTFS_DISK);
        if guest_disk.exists() {
            let _ = std::fs::remove_file(&guest_disk);
        }

        Ok(())
    }

    /// Remove all snapshots for a box (files + DB records).
    ///
    /// Best-effort: logs errors but doesn't fail. Used during box deletion.
    pub(crate) fn remove_all_for_box(&self, box_id: &str, box_home: &Path) {
        // Delete snapshot directory tree.
        let snapshots_dir = box_home.join("snapshots");
        if snapshots_dir.exists()
            && let Err(e) = std::fs::remove_dir_all(&snapshots_dir)
        {
            tracing::warn!(
                box_id = %box_id,
                error = %e,
                "Failed to remove snapshots directory"
            );
        }

        // Delete all DB records for this box.
        if let Err(e) = self.store.delete_all_for_box(box_id) {
            tracing::warn!(
                box_id = %box_id,
                error = %e,
                "Failed to delete snapshot DB records"
            );
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_snapshot_name tests ──────────────────────────────────

    #[test]
    fn test_validate_snapshot_name_rejects_path_traversal() {
        assert!(validate_snapshot_name("../etc").is_err());
        assert!(validate_snapshot_name("../../root").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_absolute() {
        assert!(validate_snapshot_name("/etc/shadow").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_backslash() {
        assert!(validate_snapshot_name("foo\\bar").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_null_byte() {
        assert!(validate_snapshot_name("foo\0bar").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_dot_prefix() {
        assert!(validate_snapshot_name(".hidden").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_empty() {
        assert!(validate_snapshot_name("").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_long() {
        let long_name = "a".repeat(256);
        assert!(validate_snapshot_name(&long_name).is_err());
    }

    #[test]
    fn test_validate_snapshot_name_accepts_valid() {
        assert!(validate_snapshot_name("my-snap_v2.1").is_ok());
        assert!(validate_snapshot_name("UPPER").is_ok());
        assert!(validate_snapshot_name("123").is_ok());
        assert!(validate_snapshot_name(&"a".repeat(255)).is_ok());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_dot_and_dotdot() {
        assert!(validate_snapshot_name(".").is_err());
        assert!(validate_snapshot_name("..").is_err());
    }
}
