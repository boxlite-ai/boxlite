//! Box export and import operations.
//!
//! Export creates a portable `.boxlite` archive from a stopped box.
//! Import recreates a box from a `.boxlite` archive.
//!
//! Archive format (tar):
//! ```text
//! archive.boxlite/
//! ├── manifest.json       # Archive metadata and box config
//! ├── disk.qcow2          # Container rootfs (flattened, standalone)
//! └── guest-rootfs.qcow2  # Guest rootfs (flattened, standalone)
//! ```

use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::disk::constants::filenames as disk_filenames;
use crate::disk::qemu_img;
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::runtime::constants::filenames as rt_filenames;
use crate::runtime::options::BoxOptions;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::types::{BoxID, BoxInfo, BoxState, BoxStatus, ContainerID};
use crate::vmm::VmmKind;

/// Archive manifest stored as `manifest.json` inside the `.boxlite` archive.
#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveManifest {
    /// Archive format version (for forward compatibility).
    pub version: u32,
    /// Original box options (used to recreate the box on import).
    pub options: BoxOptions,
    /// Original box name (optional, may be renamed on import).
    pub original_name: Option<String>,
    /// Timestamp when the archive was created.
    pub exported_at: String,
    /// Files included in the archive.
    pub files: Vec<String>,
}

const ARCHIVE_VERSION: u32 = 1;
const MANIFEST_FILENAME: &str = "manifest.json";

impl super::BoxliteRuntime {
    /// Export a stopped box as a portable `.boxlite` archive.
    ///
    /// The archive contains flattened disk images (no backing file references)
    /// and box configuration metadata. The exported archive can be imported
    /// on any compatible BoxLite installation.
    ///
    /// # Arguments
    ///
    /// * `id_or_name` - Box ID or name to export
    /// * `output_path` - Path where the `.boxlite` archive will be written
    ///
    /// # Errors
    ///
    /// Returns error if:
    /// - Box is not found
    /// - Box is not in Stopped state
    /// - `qemu-img` is not installed (needed to flatten COW chains)
    /// - I/O errors during archive creation
    pub async fn export(
        &self,
        id_or_name: &str,
        output_path: &Path,
    ) -> BoxliteResult<()> {
        let rt = &self.rt_impl;

        // Resolve box and verify it's stopped
        let (config, _state) = resolve_stopped_box(rt, id_or_name)?;

        let box_home = &config.box_home;
        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        // Validate disks exist
        if !container_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                container_disk.display()
            )));
        }

        // Create temp directory for flattened disks (same filesystem for efficiency)
        let temp_dir = tempfile::tempdir_in(rt.layout.temp_dir()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create temp directory: {}", e))
        })?;

        // Flatten COW disks to standalone images
        let flat_container = temp_dir.path().join(disk_filenames::CONTAINER_DISK);
        qemu_img::convert(&container_disk, &flat_container)?;

        let mut archive_files = vec![
            MANIFEST_FILENAME.to_string(),
            disk_filenames::CONTAINER_DISK.to_string(),
        ];

        let flat_guest = if guest_disk.exists() {
            let flat = temp_dir.path().join(disk_filenames::GUEST_ROOTFS_DISK);
            qemu_img::convert(&guest_disk, &flat)?;
            archive_files.push(disk_filenames::GUEST_ROOTFS_DISK.to_string());
            Some(flat)
        } else {
            None
        };

        // Create manifest
        let manifest = ArchiveManifest {
            version: ARCHIVE_VERSION,
            options: config.options.clone(),
            original_name: config.name.clone(),
            exported_at: Utc::now().to_rfc3339(),
            files: archive_files,
        };

        let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| {
            BoxliteError::Internal(format!("Failed to serialize manifest: {}", e))
        })?;
        let manifest_path = temp_dir.path().join(MANIFEST_FILENAME);
        std::fs::write(&manifest_path, manifest_json)?;

        // Build tar archive
        build_tar_archive(output_path, &manifest_path, &flat_container, flat_guest.as_deref())?;

        tracing::info!(
            box_id = %config.id,
            output = %output_path.display(),
            "Exported box to archive"
        );

        Ok(())
    }

    /// Import a box from a `.boxlite` archive.
    ///
    /// Creates a new box with a new ID from the archived disk images and
    /// configuration. The imported box starts in `Stopped` state and can
    /// be started normally.
    ///
    /// # Arguments
    ///
    /// * `archive_path` - Path to the `.boxlite` archive
    /// * `name` - Optional name for the imported box (overrides archived name)
    ///
    /// # Returns
    ///
    /// Information about the newly created box.
    ///
    /// # Errors
    ///
    /// Returns error if:
    /// - Archive is invalid or corrupt
    /// - Manifest version is unsupported
    /// - I/O errors during extraction
    pub async fn import(
        &self,
        archive_path: &Path,
        name: Option<String>,
    ) -> BoxliteResult<BoxInfo> {
        let rt = &self.rt_impl;

        if !archive_path.exists() {
            return Err(BoxliteError::NotFound(format!(
                "Archive not found: {}",
                archive_path.display()
            )));
        }

        // Extract archive to temp directory
        let temp_dir = tempfile::tempdir_in(rt.layout.temp_dir()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create temp directory: {}", e))
        })?;

        extract_tar_archive(archive_path, temp_dir.path())?;

        // Read and validate manifest
        let manifest_path = temp_dir.path().join(MANIFEST_FILENAME);
        if !manifest_path.exists() {
            return Err(BoxliteError::Storage(
                "Invalid archive: manifest.json not found".to_string(),
            ));
        }

        let manifest_json = std::fs::read_to_string(&manifest_path)?;
        let manifest: ArchiveManifest = serde_json::from_str(&manifest_json).map_err(|e| {
            BoxliteError::Storage(format!("Invalid manifest: {}", e))
        })?;

        if manifest.version > ARCHIVE_VERSION {
            return Err(BoxliteError::Storage(format!(
                "Unsupported archive version {} (max supported: {}). Upgrade boxlite.",
                manifest.version, ARCHIVE_VERSION
            )));
        }

        // Validate required files exist in extracted archive
        let extracted_container = temp_dir.path().join(disk_filenames::CONTAINER_DISK);
        if !extracted_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Invalid archive: {} not found",
                disk_filenames::CONTAINER_DISK
            )));
        }

        // Generate new box identity
        let box_id = BoxID::new();
        let container_id = ContainerID::new();
        let now = Utc::now();
        let import_name = name.or(manifest.original_name);

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

        // Move disk files into box directory
        std::fs::rename(&extracted_container, box_home.join(disk_filenames::CONTAINER_DISK))
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to install container disk: {}", e))
            })?;

        let extracted_guest = temp_dir.path().join(disk_filenames::GUEST_ROOTFS_DISK);
        if extracted_guest.exists() {
            std::fs::rename(&extracted_guest, box_home.join(disk_filenames::GUEST_ROOTFS_DISK))
                .map_err(|e| {
                    BoxliteError::Storage(format!("Failed to install guest rootfs disk: {}", e))
                })?;
        }

        // Build config for the imported box
        let config = BoxConfig {
            id: box_id.clone(),
            name: import_name,
            created_at: now,
            container: ContainerRuntimeConfig { id: container_id },
            options: manifest.options,
            engine_kind: VmmKind::Libkrun,
            transport: boxlite_shared::Transport::unix(socket_path),
            box_home,
            ready_socket_path,
        };

        // Create state as Stopped (box has disk state, just needs VM start)
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Stopped);

        // Allocate lock
        let lock_id = rt.lock_manager.allocate()?;
        state.set_lock_id(lock_id);

        // Persist to database
        if let Err(e) = rt.box_manager.add_box(&config, &state) {
            // Clean up on failure
            let _ = rt.lock_manager.free(lock_id);
            let _ = std::fs::remove_dir_all(&config.box_home);
            return Err(e);
        }

        let info = BoxInfo::new(&config, &state);

        tracing::info!(
            box_id = %config.id,
            archive = %archive_path.display(),
            "Imported box from archive"
        );

        Ok(info)
    }
}

/// Resolve a box by ID or name and verify it's in Stopped state.
pub(crate) fn resolve_stopped_box(
    rt: &SharedRuntimeImpl,
    id_or_name: &str,
) -> BoxliteResult<(BoxConfig, BoxState)> {
    let (config, state) = rt
        .box_manager
        .lookup_box(id_or_name)?
        .ok_or_else(|| BoxliteError::NotFound(format!("box '{}' not found", id_or_name)))?;

    if state.status != BoxStatus::Stopped {
        return Err(BoxliteError::InvalidState(format!(
            "box '{}' must be stopped for this operation (current status: {:?})",
            id_or_name, state.status
        )));
    }

    Ok((config, state))
}

/// Build a tar archive from the given files.
fn build_tar_archive(
    output_path: &Path,
    manifest_path: &Path,
    container_disk: &Path,
    guest_disk: Option<&Path>,
) -> BoxliteResult<()> {
    let file = std::fs::File::create(output_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create archive file {}: {}",
            output_path.display(),
            e
        ))
    })?;

    let mut builder = tar::Builder::new(file);

    builder
        .append_path_with_name(manifest_path, MANIFEST_FILENAME)
        .map_err(|e| BoxliteError::Storage(format!("Failed to add manifest to archive: {}", e)))?;

    builder
        .append_path_with_name(container_disk, disk_filenames::CONTAINER_DISK)
        .map_err(|e| {
            BoxliteError::Storage(format!("Failed to add container disk to archive: {}", e))
        })?;

    if let Some(guest) = guest_disk {
        builder
            .append_path_with_name(guest, disk_filenames::GUEST_ROOTFS_DISK)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to add guest rootfs disk to archive: {}", e))
            })?;
    }

    builder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finalize archive: {}", e)))?;

    Ok(())
}

/// Extract a tar archive to the given directory.
fn extract_tar_archive(archive_path: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    let file = std::fs::File::open(archive_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open archive {}: {}",
            archive_path.display(),
            e
        ))
    })?;

    let mut archive = tar::Archive::new(file);
    archive.unpack(dest_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to extract archive {}: {}",
            archive_path.display(),
            e
        ))
    })?;

    Ok(())
}
