//! Archive operations for box export and import.
//!
//! Handles `.boxlite` archive files: zstd-compressed tarballs containing
//! disk images and a JSON manifest.

use std::io::Write;
use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::disk::constants::filenames as disk_filenames;

/// Manifest filename inside the archive.
pub(crate) const MANIFEST_FILENAME: &str = "manifest.json";

/// Current archive format version.
pub(crate) const ARCHIVE_VERSION: u32 = 3;

/// Maximum archive version this build can import.
pub(crate) const MAX_SUPPORTED_VERSION: u32 = 3;

/// Archive manifest stored as `manifest.json` inside exported archives.
///
/// v1: plain tar, no checksums
/// v2: tar.zst with checksums
/// v3: adds `box_options` for full configuration preservation
#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveManifest {
    /// Archive format version (1, 2, or 3).
    pub version: u32,
    /// Original box name (optional, may be renamed on import).
    pub box_name: Option<String>,
    /// Image reference used to create the box (e.g. "alpine:latest").
    pub image: String,
    /// Full box configuration (v3+). `None` for v1/v2 archives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_options: Option<crate::runtime::options::BoxOptions>,
    /// SHA-256 checksum of the guest rootfs disk.
    pub guest_disk_checksum: String,
    /// SHA-256 checksum of the container disk.
    pub container_disk_checksum: String,
    /// Timestamp when the archive was created.
    pub exported_at: String,
}

// ── Build ───────────────────────────────────────────────────────────────

/// Build a zstd-compressed tar archive.
pub(crate) fn build_zstd_tar_archive(
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

/// Build a plain (uncompressed) tar archive.
#[allow(dead_code)] // Kept for backward compatibility testing
pub(crate) fn build_tar_archive(
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

// ── Extract ─────────────────────────────────────────────────────────────

/// Zstd magic bytes: `0x28B52FFD` (little-endian in file).
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// Extract an archive, detecting format via magic bytes (zstd or plain tar).
pub(crate) fn extract_archive(archive_path: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    use std::io::Read;

    let mut file = std::fs::File::open(archive_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open archive {}: {}",
            archive_path.display(),
            e
        ))
    })?;

    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read archive header {}: {}",
            archive_path.display(),
            e
        ))
    })?;
    drop(file);

    // Re-open for extraction (tar/zstd need the file from the beginning).
    let file = std::fs::File::open(archive_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to reopen archive {}: {}",
            archive_path.display(),
            e
        ))
    })?;

    if magic == ZSTD_MAGIC {
        extract_zstd_tar(file, dest_dir)
    } else {
        extract_plain_tar(file, dest_dir)
    }
}

fn extract_zstd_tar(file: std::fs::File, dest_dir: &Path) -> BoxliteResult<()> {
    let decoder = zstd::Decoder::new(file)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create zstd decoder: {}", e)))?;
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(dest_dir)
        .map_err(|e| BoxliteError::Storage(format!("Failed to extract zstd tar: {}", e)))?;
    Ok(())
}

fn extract_plain_tar(file: std::fs::File, dest_dir: &Path) -> BoxliteResult<()> {
    let mut archive = tar::Archive::new(file);
    archive
        .unpack(dest_dir)
        .map_err(|e| BoxliteError::Storage(format!("Failed to extract archive: {}", e)))?;
    Ok(())
}

// ── File Operations ─────────────────────────────────────────────────────

/// Move a file, falling back to copy+remove if rename fails with EXDEV
/// (cross-device link error, i.e. source and destination on different filesystems).
pub(crate) fn move_file(src: &Path, dst: &Path) -> BoxliteResult<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            std::fs::copy(src, dst).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to copy {} to {}: {}",
                    src.display(),
                    dst.display(),
                    e
                ))
            })?;
            std::fs::remove_file(src).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to remove source after cross-fs copy {}: {}",
                    src.display(),
                    e
                ))
            })?;
            Ok(())
        }
        Err(e) => Err(BoxliteError::Storage(format!(
            "Failed to move {} to {}: {}",
            src.display(),
            dst.display(),
            e
        ))),
    }
}

// ── Checksums ───────────────────────────────────────────────────────────

/// Compute SHA-256 checksum of a file, returning "sha256:<hex>" string.
pub(crate) fn sha256_file(path: &Path) -> BoxliteResult<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_extract_zstd_archive_via_magic_bytes() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("test.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        // Create a small zstd-compressed tar with a test file.
        let test_content = b"hello from zstd archive";
        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, test_content).unwrap();

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let encoder = zstd::Encoder::new(file, 3).unwrap();
            let mut builder = tar::Builder::new(encoder);
            builder
                .append_path_with_name(&test_file, "test.txt")
                .unwrap();
            let encoder = builder.into_inner().unwrap();
            encoder.finish().unwrap();
        }

        // Verify magic bytes
        let header = std::fs::read(&archive_path).unwrap();
        assert_eq!(&header[..4], &ZSTD_MAGIC);

        // Extract and verify
        extract_archive(&archive_path, &extract_dir).unwrap();
        let content = std::fs::read_to_string(extract_dir.join("test.txt")).unwrap();
        assert_eq!(content, "hello from zstd archive");
    }

    #[test]
    fn test_extract_plain_tar_via_magic_bytes() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("test.tar");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, b"hello from plain tar").unwrap();

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut builder = tar::Builder::new(file);
            builder
                .append_path_with_name(&test_file, "test.txt")
                .unwrap();
            builder.finish().unwrap();
        }

        // Verify NOT zstd magic
        let header = std::fs::read(&archive_path).unwrap();
        assert_ne!(&header[..4], &ZSTD_MAGIC);

        extract_archive(&archive_path, &extract_dir).unwrap();
        let content = std::fs::read_to_string(extract_dir.join("test.txt")).unwrap();
        assert_eq!(content, "hello from plain tar");
    }

    #[test]
    fn test_move_file_same_filesystem() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.txt");
        let dst = dir.path().join("dst.txt");
        std::fs::write(&src, "move me").unwrap();

        move_file(&src, &dst).unwrap();

        assert!(!src.exists());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "move me");
    }

    #[test]
    fn test_move_file_nonexistent_source_errors() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("nonexistent.txt");
        let dst = dir.path().join("dst.txt");

        assert!(move_file(&src, &dst).is_err());
    }

    #[test]
    fn test_sha256_file_deterministic() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.bin");
        std::fs::write(&path, b"deterministic content").unwrap();

        let hash1 = sha256_file(&path).unwrap();
        let hash2 = sha256_file(&path).unwrap();
        assert_eq!(hash1, hash2);
        assert!(hash1.starts_with("sha256:"));
    }

    #[test]
    fn test_build_and_extract_roundtrip() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("roundtrip.boxlite");
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        // Create test files
        let manifest_path = dir.path().join(MANIFEST_FILENAME);
        let container_path = dir.path().join("container.qcow2");
        std::fs::write(&manifest_path, r#"{"version":2}"#).unwrap();
        std::fs::write(&container_path, "fake-container-disk").unwrap();

        build_zstd_tar_archive(&archive_path, &manifest_path, &container_path, None, 3).unwrap();
        extract_archive(&archive_path, &extract_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(extract_dir.join(MANIFEST_FILENAME)).unwrap(),
            r#"{"version":2}"#
        );
    }
}
