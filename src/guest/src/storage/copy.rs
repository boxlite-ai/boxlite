//! Layer copy operations.
//!
//! Copies virtiofs layers to disk for proper UID ownership.

use std::os::unix::fs::symlink;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use rayon::prelude::*;

/// Copy layers from virtiofs to disk (parallelized for performance).
///
/// This is needed because virtiofs has UID mapping issues - files show host UIDs
/// instead of container UIDs. By copying to disk, the guest owns the files with
/// proper UIDs.
///
/// Uses rayon for parallel layer copying - each layer copied on separate thread.
///
/// # Arguments
/// * `lower_dirs` - Source layer paths (virtiofs mounts)
/// * `upper_dir` - Upper directory path (used to derive layers destination)
///
/// # Returns
/// New layer paths on disk
pub fn copy_layers_to_disk(lower_dirs: &[String], upper_dir: &str) -> BoxliteResult<Vec<String>> {
    // Create layers directory next to upper_dir
    let upper_path = Path::new(upper_dir);
    let layers_dir = upper_path
        .parent()
        .ok_or_else(|| BoxliteError::Storage("Invalid upper_dir path".to_string()))?
        .join("layers");

    std::fs::create_dir_all(&layers_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create layers directory {}: {}",
            layers_dir.display(),
            e
        ))
    })?;

    tracing::info!("Starting parallel copy of {} layers", lower_dirs.len());
    let start = std::time::Instant::now();

    // Track progress across threads
    let copied_count = AtomicUsize::new(0);

    // Copy layers in parallel using rayon
    let results: Vec<BoxliteResult<String>> = lower_dirs
        .par_iter()
        .enumerate()
        .map(|(i, src)| {
            let src_path = Path::new(src);
            let layer_name = src_path
                .file_name()
                .ok_or_else(|| {
                    BoxliteError::Storage(format!("Invalid source layer path: {}", src))
                })?
                .to_string_lossy()
                .to_string();
            let dst = layers_dir.join(layer_name);

            tracing::debug!("Copying layer {} from {} to {}", i, src, dst.display());

            // Check if source exists and is a directory
            if !src_path.exists() {
                tracing::error!("Source layer does not exist: {}", src);
                return Err(BoxliteError::Storage(format!(
                    "Source layer does not exist: {}",
                    src
                )));
            }

            if !src_path.is_dir() {
                tracing::error!("Source layer is not a directory: {}", src);
                return Err(BoxliteError::Storage(format!(
                    "Source layer is not a directory: {}",
                    src
                )));
            }

            // Create destination directory
            std::fs::create_dir_all(&dst).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create layer directory {}: {}",
                    dst.display(),
                    e
                ))
            })?;

            // Copy directory contents recursively
            copy_dir_recursive(src_path, &dst).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to copy layer from {} to {}: {}",
                    src,
                    dst.display(),
                    e
                ))
            })?;

            let count = copied_count.fetch_add(1, Ordering::Relaxed) + 1;
            tracing::info!("Copied layer {}/{} successfully", count, lower_dirs.len());
            Ok(dst.to_string_lossy().to_string())
        })
        .collect();

    // Check for errors and collect results
    let copied_dirs: Vec<String> = results.into_iter().collect::<BoxliteResult<Vec<_>>>()?;

    // Sync filesystem to ensure all data is flushed to disk before overlayfs mount
    tracing::debug!("Syncing filesystem to ensure layer data is persisted");
    sync_directory(&layers_dir)?;

    let elapsed = start.elapsed();
    tracing::info!(
        "Copied {} layers to disk in {:.2}s ({:.0} MB/s estimated)",
        copied_dirs.len(),
        elapsed.as_secs_f64(),
        // Rough estimate assuming ~50MB per layer average
        (copied_dirs.len() as f64 * 50.0) / elapsed.as_secs_f64()
    );

    Ok(copied_dirs)
}

/// Sync a directory to ensure all data is flushed to disk.
///
/// This opens the directory and calls fsync on it, which ensures that:
/// 1. All file data in the directory tree has been written to disk
/// 2. Directory entries are persisted
///
/// This is critical before mounting overlayfs on top of copied layers.
fn sync_directory(dir: &Path) -> BoxliteResult<()> {
    use std::fs::File;
    use std::os::unix::io::AsRawFd;

    // First, call sync() to flush all filesystem buffers
    // This is a system-wide sync but ensures all pending writes are flushed
    unsafe {
        nix::libc::sync();
    }

    // Then fsync the directory itself to ensure directory entries are persisted
    let dir_file = File::open(dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open directory {} for sync: {}",
            dir.display(),
            e
        ))
    })?;

    // fsync the directory
    let fd = dir_file.as_raw_fd();
    let ret = unsafe { nix::libc::fsync(fd) };
    if ret != 0 {
        let err = std::io::Error::last_os_error();
        return Err(BoxliteError::Storage(format!(
            "Failed to fsync directory {}: {}",
            dir.display(),
            err
        )));
    }

    tracing::debug!("Filesystem sync completed for {}", dir.display());
    Ok(())
}

/// Recursively copy directory contents (parallelized).
/// Handles files, directories, and symlinks properly.
///
/// Uses rayon to parallelize file/directory copying within each directory level.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    // Read all entries first (before parallel processing)
    let entries: Vec<_> = std::fs::read_dir(src)
        .map_err(|e| {
            tracing::error!("Failed to read directory {}: {}", src.display(), e);
            e
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            tracing::error!("Failed to read entry in {}: {}", src.display(), e);
            e
        })?;

    // Process entries in parallel
    entries
        .par_iter()
        .try_for_each(|entry| -> std::io::Result<()> {
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());
            let file_type = entry.file_type().map_err(|e| {
                tracing::error!("Failed to get file type for {}: {}", src_path.display(), e);
                e
            })?;

            if file_type.is_symlink() {
                // Copy symlink as symlink (preserve the link target)
                let link_target = std::fs::read_link(&src_path).map_err(|e| {
                    tracing::error!("Failed to read symlink {}: {}", src_path.display(), e);
                    e
                })?;
                // Remove destination if it exists
                let _ = std::fs::remove_file(&dst_path);
                symlink(&link_target, &dst_path).map_err(|e| {
                    tracing::error!(
                        "Failed to create symlink {} -> {}: {}",
                        dst_path.display(),
                        link_target.display(),
                        e
                    );
                    e
                })?;
                tracing::debug!(
                    "Copied symlink: {} -> {}",
                    dst_path.display(),
                    link_target.display()
                );
            } else if file_type.is_dir() {
                // Create directory and recurse
                std::fs::create_dir_all(&dst_path).map_err(|e| {
                    tracing::error!("Failed to create directory {}: {}", dst_path.display(), e);
                    e
                })?;
                copy_dir_recursive(&src_path, &dst_path)?;
            } else if file_type.is_file() {
                // Copy file (this is I/O bound, benefits from parallelization)
                std::fs::copy(&src_path, &dst_path).map_err(|e| {
                    tracing::error!(
                        "Failed to copy file {} -> {}: {}",
                        src_path.display(),
                        dst_path.display(),
                        e
                    );
                    e
                })?;
            }
            // Skip other file types (sockets, block devices, etc.)
            Ok(())
        })?;

    Ok(())
}
