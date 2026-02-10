//! Box clone operations.
//!
//! Clone creates a new box from an existing stopped box.
//! COW (copy-on-write) by default for fast, space-efficient clones.
//! Full-copy mode available for independent lifecycle.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;

use crate::disk::constants::dirs as disk_dirs;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::qemu_img;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::litebox::snapshot_types::CloneOptions;
use crate::runtime::constants::filenames as rt_filenames;
use crate::runtime::types::{BoxID, BoxState, BoxStatus, ContainerID};
use crate::vmm::VmmKind;

use super::LiteBox;

impl LiteBox {
    /// Clone this box, creating a new box with a copy of its disks.
    ///
    /// By default uses COW (copy-on-write) for fast, space-efficient clones.
    /// The source box must be stopped.
    ///
    /// # Arguments
    ///
    /// * `name` - Name for the new box
    /// * `opts` - Clone options (COW, start after clone, from snapshot)
    ///
    /// # Returns
    ///
    /// A LiteBox handle for the newly created clone.
    pub async fn clone(&self, name: &str, opts: CloneOptions) -> BoxliteResult<LiteBox> {
        // Verify stopped
        {
            let state = self.inner.state.read();
            if !state.status.is_stopped() {
                return Err(BoxliteError::InvalidState(format!(
                    "box '{}' must be stopped for clone (current status: {})",
                    self.id(),
                    state.status
                )));
            }
        }

        let rt = &self.inner.runtime;
        let src_home = &self.inner.config.box_home;

        // Determine source disks (current state or from a named snapshot)
        let (src_container, src_guest) = if let Some(ref snap_name) = opts.from_snapshot {
            let snap_dir = src_home.join(disk_dirs::SNAPSHOTS_DIR).join(snap_name);
            if !snap_dir.exists() {
                return Err(BoxliteError::NotFound(format!(
                    "snapshot '{}' not found for box '{}'",
                    snap_name,
                    self.id()
                )));
            }
            (
                snap_dir.join(disk_filenames::CONTAINER_DISK),
                snap_dir.join(disk_filenames::GUEST_ROOTFS_DISK),
            )
        } else {
            (
                src_home.join(disk_filenames::CONTAINER_DISK),
                src_home.join(disk_filenames::GUEST_ROOTFS_DISK),
            )
        };

        if !src_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                src_container.display()
            )));
        }

        // Generate new box identity
        let box_id = BoxID::new();
        let container_id = ContainerID::new();
        let now = Utc::now();

        let box_home = rt.layout.boxes_dir().join(box_id.as_str());
        let socket_path = rt_filenames::unix_socket_path(rt.layout.home_dir(), box_id.as_str());
        let ready_socket_path = box_home.join("sockets").join("ready.sock");

        // Create box directory
        std::fs::create_dir_all(&box_home).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create box directory {}: {}",
                box_home.display(),
                e
            ))
        })?;

        // Clone disks
        let dst_container = box_home.join(disk_filenames::CONTAINER_DISK);
        let clone_result = if opts.cow {
            self.clone_cow(&src_container, &dst_container, &src_guest, &box_home)
        } else {
            self.clone_full_copy(&src_container, &dst_container, &src_guest, &box_home)
        };

        if let Err(e) = clone_result {
            let _ = std::fs::remove_dir_all(&box_home);
            return Err(e);
        }

        // Build config for the cloned box
        let config = BoxConfig {
            id: box_id.clone(),
            name: Some(name.to_string()),
            created_at: now,
            container: ContainerRuntimeConfig { id: container_id },
            options: self.inner.config.options.clone(),
            engine_kind: VmmKind::Libkrun,
            transport: boxlite_shared::Transport::unix(socket_path),
            box_home,
            ready_socket_path,
        };

        // Create state as Stopped
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Stopped);

        // Allocate lock
        let lock_id = rt.lock_manager.allocate()?;
        state.set_lock_id(lock_id);

        // Persist to database
        if let Err(e) = rt.box_manager.add_box(&config, &state) {
            let _ = rt.lock_manager.free(lock_id);
            let _ = std::fs::remove_dir_all(&config.box_home);
            return Err(e);
        }

        tracing::info!(
            box_id = %config.id,
            source_id = %self.id(),
            cow = %opts.cow,
            "Cloned box"
        );

        // Get handle
        let litebox = rt.get(box_id.as_str()).await?.ok_or_else(|| {
            BoxliteError::Internal("Cloned box not found after persist".to_string())
        })?;

        // Optionally start the clone
        if opts.start_after_clone {
            litebox.start().await?;
        }

        Ok(litebox)
    }

    /// COW clone: create child disks backed by source disks.
    fn clone_cow(
        &self,
        src_container: &std::path::Path,
        dst_container: &std::path::Path,
        src_guest: &std::path::Path,
        box_home: &std::path::Path,
    ) -> BoxliteResult<()> {
        let qcow2 = Qcow2Helper::new();
        let container_size = Qcow2Helper::qcow2_virtual_size(src_container)?;

        qcow2.create_cow_child_disk(
            src_container,
            BackingFormat::Qcow2,
            dst_container,
            container_size,
        )?;

        if src_guest.exists() {
            let guest_size = Qcow2Helper::qcow2_virtual_size(src_guest)?;
            let dst_guest = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);
            qcow2.create_cow_child_disk(src_guest, BackingFormat::Qcow2, &dst_guest, guest_size)?;
        }

        Ok(())
    }

    /// Full-copy clone: flatten COW chains into standalone disks.
    fn clone_full_copy(
        &self,
        src_container: &std::path::Path,
        dst_container: &std::path::Path,
        src_guest: &std::path::Path,
        box_home: &std::path::Path,
    ) -> BoxliteResult<()> {
        qemu_img::full_copy(src_container, dst_container)?;

        if src_guest.exists() {
            let dst_guest = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);
            qemu_img::full_copy(src_guest, &dst_guest)?;
        }

        Ok(())
    }
}
