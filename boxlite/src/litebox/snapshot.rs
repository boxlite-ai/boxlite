//! Snapshot sub-resource on LiteBox.
//!
//! Provides create, list, get, remove, and restore operations using
//! external COW files instead of QCOW2 internal snapshots.
//!
//! Snapshot mechanics:
//! - Create: move current disks → snapshot dir, create COW children at original paths
//! - Restore: delete current COW children, create new ones pointing at snapshot's disks
//! - Remove: delete snapshot directory and DB record (error if current disk depends on it)

use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;

use crate::db::SnapshotStore;
use crate::db::snapshots::SnapshotInfo;
use crate::disk::constants::dirs as disk_dirs;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::snapshot_types::SnapshotOptions;
use crate::litebox::state::BoxStatus;

use super::LiteBox;

/// Handle for snapshot operations on a LiteBox.
///
/// Obtained via `litebox.snapshot()`. Borrows the LiteBox for the
/// duration of snapshot operations.
pub struct SnapshotHandle<'a> {
    litebox: &'a LiteBox,
}

impl<'a> SnapshotHandle<'a> {
    pub(crate) fn new(litebox: &'a LiteBox) -> Self {
        Self { litebox }
    }

    /// Create a snapshot of the box's current disk state.
    ///
    /// The box must be stopped. Disks are atomically moved to the snapshot
    /// directory and COW children are created at the original paths.
    pub async fn create(&self, name: &str, _opts: SnapshotOptions) -> BoxliteResult<SnapshotInfo> {
        self.require_stopped()?;

        let box_home = self.box_home();
        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        // Validate container disk exists
        if !container_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                container_disk.display()
            )));
        }

        // Check for duplicate snapshot name
        let store = self.snapshot_store();
        let box_id = self.litebox.id().as_str();
        if store.get_by_name(box_id, name)?.is_some() {
            return Err(BoxliteError::AlreadyExists(format!(
                "snapshot '{}' already exists for box '{}'",
                name, box_id
            )));
        }

        // Transition to Snapshotting
        {
            let inner = &self.litebox.inner;
            let mut state = inner.state.write();
            state.transition_to(BoxStatus::Snapshotting)?;
            inner.runtime.box_manager.save_box(inner.id(), &state)?;
        }

        let result = self.do_create(name, &box_home, &container_disk, &guest_disk);

        // Transition back to Stopped regardless of outcome
        {
            let inner = &self.litebox.inner;
            let mut state = inner.state.write();
            state.force_status(BoxStatus::Stopped);
            let _ = inner.runtime.box_manager.save_box(inner.id(), &state);
        }

        result
    }

    fn do_create(
        &self,
        name: &str,
        box_home: &Path,
        container_disk: &Path,
        guest_disk: &Path,
    ) -> BoxliteResult<SnapshotInfo> {
        let snapshot_dir = self.snapshot_dir(box_home, name);
        std::fs::create_dir_all(&snapshot_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create snapshot directory {}: {}",
                snapshot_dir.display(),
                e
            ))
        })?;

        let qcow2 = Qcow2Helper::new();

        // Get virtual sizes before moving
        let container_virtual_size = Qcow2Helper::qcow2_virtual_size(container_disk)?;
        let guest_virtual_size = if guest_disk.exists() {
            Qcow2Helper::qcow2_virtual_size(guest_disk)?
        } else {
            0
        };

        // Move container disk → snapshot dir
        let snap_container = snapshot_dir.join(disk_filenames::CONTAINER_DISK);
        std::fs::rename(container_disk, &snap_container).map_err(|e| {
            BoxliteError::Storage(format!("Failed to move container disk to snapshot: {}", e))
        })?;

        // Create COW child at original path, backed by snapshot's copy
        if let Err(e) = qcow2.create_cow_child_disk(
            &snap_container,
            BackingFormat::Qcow2,
            container_disk,
            container_virtual_size,
        ) {
            // Rollback: move snapshot disk back
            let _ = std::fs::rename(&snap_container, container_disk);
            let _ = std::fs::remove_dir_all(&snapshot_dir);
            return Err(e);
        }

        // Move guest disk → snapshot dir (if exists)
        if guest_disk.exists() {
            let snap_guest = snapshot_dir.join(disk_filenames::GUEST_ROOTFS_DISK);
            std::fs::rename(guest_disk, &snap_guest).map_err(|e| {
                BoxliteError::Storage(format!("Failed to move guest disk to snapshot: {}", e))
            })?;

            if let Err(e) = qcow2.create_cow_child_disk(
                &snap_guest,
                BackingFormat::Qcow2,
                guest_disk,
                guest_virtual_size,
            ) {
                // Rollback: move disks back, delete COW children
                let _ = std::fs::remove_file(container_disk);
                let _ = std::fs::rename(&snap_container, container_disk);
                let _ = std::fs::rename(&snap_guest, guest_disk);
                let _ = std::fs::remove_dir_all(&snapshot_dir);
                return Err(e);
            }
        }

        // Calculate on-disk size
        let size_bytes = dir_size(&snapshot_dir);

        // Record in database
        let record = SnapshotInfo {
            id: ulid::Ulid::new().to_string(),
            box_id: self.litebox.id().as_str().to_string(),
            name: name.to_string(),
            created_at: Utc::now().timestamp(),
            snapshot_dir: snapshot_dir.to_string_lossy().to_string(),
            guest_disk_bytes: guest_virtual_size,
            container_disk_bytes: container_virtual_size,
            size_bytes,
        };
        self.snapshot_store().save(&record)?;

        tracing::info!(
            box_id = %self.litebox.id(),
            snapshot = %name,
            "Created external COW snapshot"
        );

        Ok(record)
    }

    /// List all snapshots for this box.
    pub async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.snapshot_store().list(self.litebox.id().as_str())
    }

    /// Get a snapshot by name.
    pub async fn get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        self.snapshot_store()
            .get_by_name(self.litebox.id().as_str(), name)
    }

    /// Remove a snapshot by name.
    ///
    /// Errors if the current disk's backing file is this snapshot
    /// (restore a different snapshot first).
    pub async fn remove(&self, name: &str) -> BoxliteResult<()> {
        self.require_stopped()?;

        let box_id = self.litebox.id().as_str();
        let store = self.snapshot_store();

        let info = store.get_by_name(box_id, name)?.ok_or_else(|| {
            BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                name, box_id
            ))
        })?;

        // Check if current disk depends on this snapshot
        let snapshot_dir = PathBuf::from(&info.snapshot_dir);
        let snap_container = snapshot_dir.join(disk_filenames::CONTAINER_DISK);
        let container_disk = self.box_home().join(disk_filenames::CONTAINER_DISK);

        if container_disk.exists() && snap_container.exists() {
            // Read backing file from current disk to see if it points to this snapshot
            if let (Ok(backing), Ok(snap_canonical)) = (
                read_backing_file(&container_disk),
                snap_container.canonicalize(),
            ) && backing == snap_canonical
            {
                return Err(BoxliteError::InvalidState(
                    "Cannot remove snapshot: current disk depends on this snapshot. \
                     Restore a different snapshot first."
                        .to_string(),
                ));
            }
        }

        // Delete snapshot directory
        if snapshot_dir.exists() {
            std::fs::remove_dir_all(&snapshot_dir).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to remove snapshot directory {}: {}",
                    snapshot_dir.display(),
                    e
                ))
            })?;
        }

        // Remove DB record
        store.remove_by_name(box_id, name)?;

        tracing::info!(
            box_id = %self.litebox.id(),
            snapshot = %name,
            "Removed snapshot"
        );

        Ok(())
    }

    /// Restore box disks from a snapshot.
    ///
    /// Deletes current COW child disks and creates new ones pointing at
    /// the snapshot's disks. Box stays stopped after restore.
    pub async fn restore(&self, name: &str) -> BoxliteResult<()> {
        self.require_stopped()?;

        let box_id = self.litebox.id().as_str();
        let store = self.snapshot_store();

        let info = store.get_by_name(box_id, name)?.ok_or_else(|| {
            BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                name, box_id
            ))
        })?;

        // Transition to Restoring
        {
            let inner = &self.litebox.inner;
            let mut state = inner.state.write();
            state.transition_to(BoxStatus::Restoring)?;
            inner.runtime.box_manager.save_box(inner.id(), &state)?;
        }

        let result = self.do_restore(&info);

        // Transition back to Stopped
        {
            let inner = &self.litebox.inner;
            let mut state = inner.state.write();
            state.force_status(BoxStatus::Stopped);
            let _ = inner.runtime.box_manager.save_box(inner.id(), &state);
        }

        result
    }

    fn do_restore(&self, info: &SnapshotInfo) -> BoxliteResult<()> {
        let box_home = self.box_home();
        let snapshot_dir = PathBuf::from(&info.snapshot_dir);
        let qcow2 = Qcow2Helper::new();

        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let snap_container = snapshot_dir.join(disk_filenames::CONTAINER_DISK);

        if !snap_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Snapshot container disk not found at {}",
                snap_container.display()
            )));
        }

        // Delete current COW child and create new one
        if container_disk.exists() {
            std::fs::remove_file(&container_disk).map_err(|e| {
                BoxliteError::Storage(format!("Failed to remove current container disk: {}", e))
            })?;
        }

        qcow2.create_cow_child_disk(
            &snap_container,
            BackingFormat::Qcow2,
            &container_disk,
            info.container_disk_bytes,
        )?;

        // Handle guest disk
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);
        let snap_guest = snapshot_dir.join(disk_filenames::GUEST_ROOTFS_DISK);

        if snap_guest.exists() {
            if guest_disk.exists() {
                std::fs::remove_file(&guest_disk).map_err(|e| {
                    BoxliteError::Storage(format!("Failed to remove current guest disk: {}", e))
                })?;
            }

            qcow2.create_cow_child_disk(
                &snap_guest,
                BackingFormat::Qcow2,
                &guest_disk,
                info.guest_disk_bytes,
            )?;
        }

        tracing::info!(
            box_id = %self.litebox.id(),
            snapshot = %info.name,
            "Restored snapshot"
        );

        Ok(())
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    fn require_stopped(&self) -> BoxliteResult<()> {
        let state = self.litebox.inner.state.read();
        if !state.status.is_stopped() {
            return Err(BoxliteError::InvalidState(format!(
                "box '{}' must be stopped for this operation (current status: {})",
                self.litebox.id(),
                state.status
            )));
        }
        Ok(())
    }

    fn box_home(&self) -> PathBuf {
        self.litebox.inner.config.box_home.clone()
    }

    fn snapshot_dir(&self, box_home: &Path, name: &str) -> PathBuf {
        box_home.join(disk_dirs::SNAPSHOTS_DIR).join(name)
    }

    fn snapshot_store(&self) -> SnapshotStore {
        SnapshotStore::new(self.litebox.inner.runtime.box_manager.db())
    }
}

/// Calculate total size of files in a directory.
fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Read the backing file path from a QCOW2 disk header.
fn read_backing_file(disk_path: &Path) -> BoxliteResult<PathBuf> {
    use std::io::Read;

    let mut file = std::fs::File::open(disk_path).map_err(|e| {
        BoxliteError::Storage(format!("Failed to open {}: {}", disk_path.display(), e))
    })?;

    let mut header = [0u8; 32];
    file.read_exact(&mut header).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read header from {}: {}",
            disk_path.display(),
            e
        ))
    })?;

    // Parse backing_file_offset (bytes 8-15) and backing_file_size (bytes 16-19)
    let backing_offset = u64::from_be_bytes([
        header[8], header[9], header[10], header[11], header[12], header[13], header[14],
        header[15],
    ]);
    let backing_size = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);

    if backing_offset == 0 || backing_size == 0 {
        return Err(BoxliteError::Storage(format!(
            "No backing file in {}",
            disk_path.display()
        )));
    }

    // Read backing file path
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(backing_offset))
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to seek to backing file path in {}: {}",
                disk_path.display(),
                e
            ))
        })?;

    let mut buf = vec![0u8; backing_size as usize];
    file.read_exact(&mut buf).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read backing file path from {}: {}",
            disk_path.display(),
            e
        ))
    })?;

    let path_str = String::from_utf8(buf).map_err(|e| {
        BoxliteError::Storage(format!(
            "Invalid backing file path in {}: {}",
            disk_path.display(),
            e
        ))
    })?;

    Ok(PathBuf::from(path_str))
}
