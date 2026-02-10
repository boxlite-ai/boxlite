//! Box export to portable archive.
//!
//! Creates a `.boxsnap` archive containing flattened disk images,
//! optionally compressed with zstd, with SHA-256 checksums.

use std::io::Write;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::disk::constants::filenames as disk_filenames;
use crate::disk::qemu_img;
use crate::litebox::snapshot_types::ExportOptions;
use crate::litebox::state::BoxStatus;
use crate::runtime::portability::ArchiveManifest;

use super::LiteBox;

const ARCHIVE_VERSION: u32 = 2;
const MANIFEST_FILENAME: &str = "manifest.json";

impl LiteBox {
    /// Export this box as a portable `.boxsnap` archive.
    ///
    /// The archive contains flattened disk images (no backing file references)
    /// and box configuration metadata. Compressed with zstd by default.
    ///
    /// Returns the path to the created archive.
    pub async fn export(&self, dest: &Path, opts: ExportOptions) -> BoxliteResult<PathBuf> {
        // Verify stopped
        {
            let state = self.inner.state.read();
            if !state.status.is_stopped() {
                return Err(BoxliteError::InvalidState(format!(
                    "box '{}' must be stopped for export (current status: {})",
                    self.id(),
                    state.status
                )));
            }
        }

        // Transition to Exporting
        {
            let mut state = self.inner.state.write();
            state.transition_to(BoxStatus::Exporting)?;
            self.inner
                .runtime
                .box_manager
                .save_box(self.inner.id(), &state)?;
        }

        let result = self.do_export(dest, &opts);

        // Transition back to Stopped
        {
            let mut state = self.inner.state.write();
            state.force_status(BoxStatus::Stopped);
            let _ = self
                .inner
                .runtime
                .box_manager
                .save_box(self.inner.id(), &state);
        }

        result
    }

    fn do_export(&self, dest: &Path, opts: &ExportOptions) -> BoxliteResult<PathBuf> {
        let box_home = &self.inner.config.box_home;
        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        if !container_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                container_disk.display()
            )));
        }

        // Determine output path
        let output_path = if dest.is_dir() {
            let name = self.name().unwrap_or("box");
            dest.join(format!("{}.boxsnap", name))
        } else {
            dest.to_path_buf()
        };

        // Create temp directory for flattened disks
        let temp_dir = tempfile::tempdir_in(self.inner.runtime.layout.temp_dir()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create temp directory: {}", e))
        })?;

        // Flatten COW disks to standalone images
        let flat_container = temp_dir.path().join(disk_filenames::CONTAINER_DISK);
        qemu_img::convert(&container_disk, &flat_container)?;

        let flat_guest = if guest_disk.exists() {
            let flat = temp_dir.path().join(disk_filenames::GUEST_ROOTFS_DISK);
            qemu_img::convert(&guest_disk, &flat)?;
            Some(flat)
        } else {
            None
        };

        // Compute checksums
        let container_disk_checksum = sha256_file(&flat_container)?;
        let guest_disk_checksum = match flat_guest {
            Some(ref fg) => sha256_file(fg)?,
            None => String::new(),
        };

        // Extract image reference from rootfs spec
        let image = match &self.inner.config.options.rootfs {
            crate::runtime::options::RootfsSpec::Image(img) => img.clone(),
            crate::runtime::options::RootfsSpec::RootfsPath(path) => path.clone(),
        };

        // Create manifest
        let manifest = ArchiveManifest {
            version: ARCHIVE_VERSION,
            box_name: self.inner.config.name.clone(),
            image,
            guest_disk_checksum,
            container_disk_checksum,
            exported_at: Utc::now().to_rfc3339(),
        };

        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| BoxliteError::Internal(format!("Failed to serialize manifest: {}", e)))?;
        let manifest_path = temp_dir.path().join(MANIFEST_FILENAME);
        std::fs::write(&manifest_path, manifest_json)?;

        // Build archive
        if opts.compress {
            build_zstd_tar_archive(
                &output_path,
                &manifest_path,
                &flat_container,
                flat_guest.as_deref(),
                opts.compression_level,
            )?;
        } else {
            build_tar_archive(
                &output_path,
                &manifest_path,
                &flat_container,
                flat_guest.as_deref(),
            )?;
        }

        tracing::info!(
            box_id = %self.id(),
            output = %output_path.display(),
            compressed = %opts.compress,
            "Exported box to archive"
        );

        Ok(output_path)
    }
}

/// Build a plain tar archive.
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
    append_archive_files(&mut builder, manifest_path, container_disk, guest_disk)?;
    builder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finalize archive: {}", e)))?;

    Ok(())
}

/// Build a zstd-compressed tar archive.
fn build_zstd_tar_archive(
    output_path: &Path,
    manifest_path: &Path,
    container_disk: &Path,
    guest_disk: Option<&Path>,
    compression_level: i32,
) -> BoxliteResult<()> {
    let file = std::fs::File::create(output_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create archive file {}: {}",
            output_path.display(),
            e
        ))
    })?;

    let encoder = zstd::Encoder::new(file, compression_level)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create zstd encoder: {}", e)))?;

    let mut builder = tar::Builder::new(encoder);
    append_archive_files(&mut builder, manifest_path, container_disk, guest_disk)?;

    let encoder = builder
        .into_inner()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finalize tar: {}", e)))?;
    encoder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finish zstd compression: {}", e)))?;

    Ok(())
}

/// Append standard files to a tar builder.
fn append_archive_files<W: Write>(
    builder: &mut tar::Builder<W>,
    manifest_path: &Path,
    container_disk: &Path,
    guest_disk: Option<&Path>,
) -> BoxliteResult<()> {
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

    Ok(())
}

/// Compute SHA-256 of a file, returning hex string.
fn sha256_file(path: &Path) -> BoxliteResult<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open {} for checksum: {}",
            path.display(),
            e
        ))
    })?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read {} for checksum: {}",
                path.display(),
                e
            ))
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(format!("sha256:{:x}", hasher.finalize()))
}
