//! Box duplication (full-copy clone).
//!
//! Creates an independent copy of a stopped box with new identity.
//! Uses full disk copy (not COW) to avoid lifecycle coupling between
//! the original and the clone.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;

use crate::disk::constants::filenames as disk_filenames;
use crate::disk::qemu_img;
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::runtime::constants::filenames as rt_filenames;
use crate::runtime::portability::resolve_stopped_box;
use crate::runtime::types::{BoxID, BoxInfo, BoxState, BoxStatus, ContainerID};
use crate::vmm::VmmKind;

impl super::BoxliteRuntime {
    /// Create an independent copy of a stopped box.
    ///
    /// The new box gets a fresh ID and optionally a new name. Disk images
    /// are fully copied (not COW-linked), so the clone is completely
    /// independent of the original.
    ///
    /// # Arguments
    ///
    /// * `id_or_name` - ID or name of the box to duplicate
    /// * `new_name` - Optional name for the new box
    ///
    /// # Returns
    ///
    /// Information about the newly created box.
    ///
    /// # Errors
    ///
    /// Returns error if:
    /// - Source box is not found
    /// - Source box is not stopped
    /// - `qemu-img` is not installed
    /// - I/O errors during disk copy
    pub async fn duplicate(
        &self,
        id_or_name: &str,
        new_name: Option<String>,
    ) -> BoxliteResult<BoxInfo> {
        let rt = &self.rt_impl;

        let (src_config, _state) = resolve_stopped_box(rt, id_or_name)?;

        let src_home = &src_config.box_home;
        let src_container_disk = src_home.join(disk_filenames::CONTAINER_DISK);
        let src_guest_disk = src_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        if !src_container_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                src_container_disk.display()
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

        // Full-copy disks (flattens any COW chains)
        let dst_container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        if let Err(e) = qemu_img::full_copy(&src_container_disk, &dst_container_disk) {
            let _ = std::fs::remove_dir_all(&box_home);
            return Err(e);
        }

        if src_guest_disk.exists() {
            let dst_guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);
            if let Err(e) = qemu_img::full_copy(&src_guest_disk, &dst_guest_disk) {
                let _ = std::fs::remove_dir_all(&box_home);
                return Err(e);
            }
        }

        // Build config for the cloned box
        let config = BoxConfig {
            id: box_id.clone(),
            name: new_name,
            created_at: now,
            container: ContainerRuntimeConfig { id: container_id },
            options: src_config.options.clone(),
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

        let info = BoxInfo::new(&config, &state);

        tracing::info!(
            box_id = %config.id,
            source_id = %src_config.id,
            "Duplicated box"
        );

        Ok(info)
    }
}
