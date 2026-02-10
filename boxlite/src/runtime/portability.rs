//! Box import operations.
//!
//! Import recreates a box from a `.boxsnap` or `.boxlite` archive.
//!
//! Supports two archive formats:
//! - v2 (`.boxsnap`): tar.zst compressed with SHA-256 checksums
//! - v1 (`.boxlite`): plain tar (legacy, backward compatible)

use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::disk::constants::filenames as disk_filenames;
use crate::litebox::LiteBox;
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::runtime::constants::filenames as rt_filenames;
use crate::runtime::options::{BoxOptions, RootfsSpec};
use crate::runtime::types::{BoxID, BoxState, BoxStatus, ContainerID};
use crate::vmm::VmmKind;

/// Archive manifest stored as `manifest.json` inside the archive.
///
/// Compatible with both v1 (plain tar) and v2 (tar.zst with checksums).
#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveManifest {
    /// Archive format version (1 or 2).
    pub version: u32,
    /// Original box name (optional, may be renamed on import).
    pub box_name: Option<String>,
    /// Image reference used to create the box (e.g. "alpine:latest").
    pub image: String,
    /// SHA-256 checksum of the guest rootfs disk.
    pub guest_disk_checksum: String,
    /// SHA-256 checksum of the container disk.
    pub container_disk_checksum: String,
    /// Timestamp when the archive was created.
    pub exported_at: String,
}

const MAX_SUPPORTED_VERSION: u32 = 2;
const MANIFEST_FILENAME: &str = "manifest.json";

impl super::BoxliteRuntime {
    /// Import a box from a `.boxsnap` or `.boxlite` archive.
    ///
    /// Creates a new box with a new ID from the archived disk images and
    /// configuration. The imported box starts in `Stopped` state and can
    /// be started normally.
    ///
    /// Supports both v1 (plain tar) and v2 (tar.zst) archive formats.
    ///
    /// # Returns
    ///
    /// A LiteBox handle for the newly created box.
    pub async fn import(&self, archive_path: &Path, name: &str) -> BoxliteResult<LiteBox> {
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

        // Try zstd decompression first, fall back to plain tar
        extract_archive(archive_path, temp_dir.path())?;

        // Read and validate manifest
        let manifest_path = temp_dir.path().join(MANIFEST_FILENAME);
        if !manifest_path.exists() {
            return Err(BoxliteError::Storage(
                "Invalid archive: manifest.json not found".to_string(),
            ));
        }

        let manifest_json = std::fs::read_to_string(&manifest_path)?;
        let manifest: ArchiveManifest = serde_json::from_str(&manifest_json)
            .map_err(|e| BoxliteError::Storage(format!("Invalid manifest: {}", e)))?;

        if manifest.version > MAX_SUPPORTED_VERSION {
            return Err(BoxliteError::Storage(format!(
                "Unsupported archive version {} (max supported: {}). Upgrade boxlite.",
                manifest.version, MAX_SUPPORTED_VERSION
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
        let import_name = Some(name.to_string());

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
        std::fs::rename(
            &extracted_container,
            box_home.join(disk_filenames::CONTAINER_DISK),
        )
        .map_err(|e| BoxliteError::Storage(format!("Failed to install container disk: {}", e)))?;

        let extracted_guest = temp_dir.path().join(disk_filenames::GUEST_ROOTFS_DISK);
        if extracted_guest.exists() {
            std::fs::rename(
                &extracted_guest,
                box_home.join(disk_filenames::GUEST_ROOTFS_DISK),
            )
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to install guest rootfs disk: {}", e))
            })?;
        }

        // Reconstruct BoxOptions from the image reference.
        // Imported boxes use default runtime config; disk state is fully preserved.
        let options = BoxOptions {
            rootfs: RootfsSpec::Image(manifest.image),
            ..Default::default()
        };

        // Build config for the imported box
        let config = BoxConfig {
            id: box_id.clone(),
            name: import_name,
            created_at: now,
            container: ContainerRuntimeConfig { id: container_id },
            options,
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
            let _ = rt.lock_manager.free(lock_id);
            let _ = std::fs::remove_dir_all(&config.box_home);
            return Err(e);
        }

        tracing::info!(
            box_id = %config.id,
            archive = %archive_path.display(),
            "Imported box from archive"
        );

        // Return a LiteBox handle
        rt.get(box_id.as_str()).await?.ok_or_else(|| {
            BoxliteError::Internal("Imported box not found after persist".to_string())
        })
    }
}

/// Extract an archive, auto-detecting format (try zstd first, then plain tar).
fn extract_archive(archive_path: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    let file = std::fs::File::open(archive_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open archive {}: {}",
            archive_path.display(),
            e
        ))
    })?;

    // Try zstd-compressed tar first
    match try_extract_zstd_tar(file, dest_dir) {
        Ok(()) => return Ok(()),
        Err(_) => {
            // Fall back to plain tar
            let file = std::fs::File::open(archive_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to reopen archive {}: {}",
                    archive_path.display(),
                    e
                ))
            })?;
            extract_plain_tar(file, dest_dir)?;
        }
    }

    Ok(())
}

/// Try to extract a zstd-compressed tar archive.
fn try_extract_zstd_tar(file: std::fs::File, dest_dir: &Path) -> BoxliteResult<()> {
    let decoder = zstd::Decoder::new(file)
        .map_err(|e| BoxliteError::Storage(format!("Not a zstd archive: {}", e)))?;
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(dest_dir)
        .map_err(|e| BoxliteError::Storage(format!("Failed to extract zstd tar: {}", e)))?;
    Ok(())
}

/// Extract a plain tar archive.
fn extract_plain_tar(file: std::fs::File, dest_dir: &Path) -> BoxliteResult<()> {
    let mut archive = tar::Archive::new(file);
    archive
        .unpack(dest_dir)
        .map_err(|e| BoxliteError::Storage(format!("Failed to extract archive: {}", e)))?;
    Ok(())
}
