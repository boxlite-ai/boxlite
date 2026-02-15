//! Disk image operations.
//!
//! This module provides disk image creation and management:
//! - `Disk` - RAII wrapper for disk image files
//! - `DiskFormat` - Disk format types (Ext4, Qcow2)
//! - `create_ext4_from_dir` - Create ext4 filesystem from directory
//! - `Qcow2Helper` - QCOW2 copy-on-write disk creation

pub mod constants;
pub(crate) mod ext4;
mod image;
mod qcow2;

pub use ext4::{create_ext4_from_dir, inject_file_into_ext4};
pub use image::{Disk, DiskFormat};
pub use qcow2::{BackingFormat, Qcow2Helper, read_backing_file_path};
