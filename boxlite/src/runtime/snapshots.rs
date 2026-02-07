//! Box snapshot operations.
//!
//! Snapshots capture the disk state of a stopped box at a point in time.
//! They use QCOW2 internal snapshots for the disk data and SQLite for metadata.
//!
//! Constraints:
//! - Only stopped boxes can be snapshotted (no live/quiesce support in v1)
//! - Snapshot names must be unique per box
//! - Restore only works on stopped boxes

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::db::SnapshotStore;
use crate::db::snapshots::SnapshotRecord;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::qemu_img;
use crate::runtime::portability::resolve_stopped_box;

impl super::BoxliteRuntime {
    /// Create a snapshot of a stopped box.
    ///
    /// Captures the current disk state using QCOW2 internal snapshots and
    /// stores metadata in the database. The box must be stopped.
    ///
    /// # Arguments
    ///
    /// * `id_or_name` - Box ID or name
    /// * `snapshot_name` - Name for the snapshot (unique per box)
    /// * `description` - Optional description
    pub async fn snapshot(
        &self,
        id_or_name: &str,
        snapshot_name: &str,
        description: &str,
    ) -> BoxliteResult<SnapshotRecord> {
        let rt = &self.rt_impl;

        let (config, _state) = resolve_stopped_box(rt, id_or_name)?;

        let box_home = &config.box_home;
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
        let snapshot_store = SnapshotStore::new(rt.box_manager.db());
        if snapshot_store
            .get_by_name(config.id.as_str(), snapshot_name)?
            .is_some()
        {
            return Err(BoxliteError::AlreadyExists(format!(
                "snapshot '{}' already exists for box '{}'",
                snapshot_name, id_or_name
            )));
        }

        // Create QCOW2 internal snapshots on both disks
        qemu_img::snapshot_create(&container_disk, snapshot_name)?;

        if guest_disk.exists() {
            qemu_img::snapshot_create(&guest_disk, snapshot_name)?;
        }

        // Store metadata in database
        let record = SnapshotStore::create_record(
            config.id.as_str(),
            snapshot_name,
            description,
        );
        snapshot_store.save(&record)?;

        tracing::info!(
            box_id = %config.id,
            snapshot = %snapshot_name,
            "Created snapshot"
        );

        Ok(record)
    }

    /// Restore a box to a previous snapshot.
    ///
    /// Reverts the disk state to the snapshot's point in time.
    /// The box must be stopped.
    ///
    /// # Arguments
    ///
    /// * `id_or_name` - Box ID or name
    /// * `snapshot_name` - Name of the snapshot to restore
    pub async fn restore(
        &self,
        id_or_name: &str,
        snapshot_name: &str,
    ) -> BoxliteResult<()> {
        let rt = &self.rt_impl;

        let (config, _state) = resolve_stopped_box(rt, id_or_name)?;

        let box_home = &config.box_home;
        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        // Verify snapshot exists in database
        let snapshot_store = SnapshotStore::new(rt.box_manager.db());
        if snapshot_store
            .get_by_name(config.id.as_str(), snapshot_name)?
            .is_none()
        {
            return Err(BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                snapshot_name, id_or_name
            )));
        }

        // Apply QCOW2 internal snapshots
        qemu_img::snapshot_apply(&container_disk, snapshot_name)?;

        if guest_disk.exists() {
            qemu_img::snapshot_apply(&guest_disk, snapshot_name)?;
        }

        tracing::info!(
            box_id = %config.id,
            snapshot = %snapshot_name,
            "Restored snapshot"
        );

        Ok(())
    }

    /// List all snapshots for a box.
    ///
    /// Returns snapshots ordered by creation time (newest first).
    pub async fn list_snapshots(
        &self,
        id_or_name: &str,
    ) -> BoxliteResult<Vec<SnapshotRecord>> {
        let rt = &self.rt_impl;

        // Resolve box (any status is fine for listing)
        let (config, _state) = rt
            .box_manager
            .lookup_box(id_or_name)?
            .ok_or_else(|| BoxliteError::NotFound(format!("box '{}' not found", id_or_name)))?;

        let snapshot_store = SnapshotStore::new(rt.box_manager.db());
        snapshot_store.list(config.id.as_str())
    }

    /// Delete a snapshot.
    ///
    /// Removes the QCOW2 internal snapshot and database metadata.
    /// The box must be stopped.
    ///
    /// # Arguments
    ///
    /// * `id_or_name` - Box ID or name
    /// * `snapshot_name` - Name of the snapshot to delete
    pub async fn delete_snapshot(
        &self,
        id_or_name: &str,
        snapshot_name: &str,
    ) -> BoxliteResult<()> {
        let rt = &self.rt_impl;

        let (config, _state) = resolve_stopped_box(rt, id_or_name)?;

        let box_home = &config.box_home;
        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        // Verify snapshot exists
        let snapshot_store = SnapshotStore::new(rt.box_manager.db());
        if snapshot_store
            .get_by_name(config.id.as_str(), snapshot_name)?
            .is_none()
        {
            return Err(BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                snapshot_name, id_or_name
            )));
        }

        // Delete QCOW2 internal snapshots
        if container_disk.exists() {
            qemu_img::snapshot_delete(&container_disk, snapshot_name)?;
        }

        if guest_disk.exists() {
            qemu_img::snapshot_delete(&guest_disk, snapshot_name)?;
        }

        // Remove from database
        snapshot_store.delete_by_name(config.id.as_str(), snapshot_name)?;

        tracing::info!(
            box_id = %config.id,
            snapshot = %snapshot_name,
            "Deleted snapshot"
        );

        Ok(())
    }
}
