//! Disk image operations.
//!
//! This module provides disk image creation and management:
//! - `Disk` - RAII wrapper for disk image files
//! - `DiskFormat` - Disk format types (Ext4, Qcow2)
//! - `create_ext4_from_dir` - Create ext4 filesystem from directory
//! - `Qcow2Helper` - QCOW2 copy-on-write disk creation
//! - `fork_qcow2` - Atomic fork: rename + COW child creation

use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

pub(crate) mod base_disk;
pub mod constants;
pub(crate) mod ext4;
mod image;
pub(crate) mod qcow2;

pub(crate) use base_disk::{BaseDisk, BaseDiskKind, BaseDiskManager};
pub use ext4::{create_ext4_from_dir, inject_file_into_ext4};
pub use image::{Disk, DiskFormat};
pub use qcow2::{BackingFormat, Qcow2Helper, read_backing_chain, read_backing_file_path};

// ============================================================================
// DiskInfo — serde DTO for disk path + size metadata
// ============================================================================

/// Serializable disk path + size metadata.
///
/// Field names match the existing JSON schema (`base_path`, `container_disk_bytes`,
/// `size_bytes`) so that `#[serde(flatten)]` produces backward-compatible JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskInfo {
    /// Path to the disk file on the host filesystem.
    pub base_path: String,
    /// Logical capacity in bytes (e.g., qcow2 virtual size).
    pub container_disk_bytes: u64,
    /// Actual bytes on disk.
    pub size_bytes: u64,
}

impl DiskInfo {
    /// Borrow the path as a `&Path`.
    pub fn as_path(&self) -> &Path {
        Path::new(&self.base_path)
    }

    /// Clone the path as a `PathBuf`.
    pub fn to_path_buf(&self) -> PathBuf {
        PathBuf::from(&self.base_path)
    }

    /// Check if the disk file exists on the filesystem.
    pub fn exists(&self) -> bool {
        self.as_path().exists()
    }

    /// Convert to an RAII `Disk` with the given format and persistence flag.
    pub fn to_disk(&self, format: DiskFormat, persistent: bool) -> Disk {
        Disk::with_sizes(
            self.to_path_buf(),
            format,
            persistent,
            self.container_disk_bytes,
            self.size_bytes,
        )
    }
}

impl From<&Disk> for DiskInfo {
    fn from(disk: &Disk) -> Self {
        Self {
            base_path: disk.path().to_string_lossy().to_string(),
            container_disk_bytes: disk.virtual_size(),
            size_bytes: disk.on_disk_size(),
        }
    }
}

/// Fork a qcow2 disk: move original to a new location, create COW child at the original path.
///
/// This is the atomic "make immutable base + keep running" operation:
/// 1. Read qcow2 virtual size from `source`
/// 2. Rename `source` → `dest` (makes it immutable)
/// 3. Create COW child at `source` path (so the original path stays usable)
/// 4. Measure on-disk size of the file at `dest`
///
/// Returns a persistent `Disk` at `dest` carrying size metadata.
pub(crate) fn fork_qcow2(source: &Path, dest: &Path) -> BoxliteResult<Disk> {
    // Read virtual size BEFORE moving (file won't exist at old path after rename)
    let virtual_size = Qcow2Helper::qcow2_virtual_size(source)?;

    // Move disk → destination (makes it immutable)
    std::fs::rename(source, dest).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to move disk {} to {}: {}",
            source.display(),
            dest.display(),
            e
        ))
    })?;

    // Create COW child at original path (keeps the original path usable).
    // leak() prevents the Disk RAII guard from deleting the file on drop.
    Qcow2Helper::create_cow_child_disk(dest, BackingFormat::Qcow2, source, virtual_size)?.leak();

    // Measure on-disk size of the base file
    let on_disk_size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);

    Ok(Disk::with_sizes(
        dest.to_path_buf(),
        DiskFormat::Qcow2,
        true,
        virtual_size,
        on_disk_size,
    ))
}
