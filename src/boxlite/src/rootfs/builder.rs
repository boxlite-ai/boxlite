//! Unified rootfs builder for all preparation needs.

use crate::images::{ImageObject, LayerExtractor};
use crate::rootfs::{CopyMode, CopyMountOptions, copy_based_mount};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::{Path, PathBuf};

/// Unified builder for all rootfs preparation needs
pub struct RootfsBuilder;

impl RootfsBuilder {
    /// Create a new rootfs builder
    pub fn new() -> Self {
        Self
    }

    /// Prepare rootfs from an OCI images with copy-based mount and fallback
    ///
    /// This implementation uses a two-tier approach:
    /// 1. **Try copy-based mount** (VFS-style with layer caching)
    ///    - Extract each layer to cache once
    ///    - Stack layers using copy-based mounts
    ///    - Fast for repeated builds (cached layers)
    /// 2. **Fallback to extraction-based mount** (original approach)
    ///    - Extract all layers directly to destination
    ///    - Slower but more robust
    ///
    /// # Arguments
    /// * `dest` - Destination directory for the prepared rootfs
    /// * `images` - OCI images object containing layers
    ///
    /// # Returns
    /// * `PreparedRootfs` - Path to prepared rootfs (no cleanup responsibility)
    ///
    /// # Idempotency
    /// If `dest` already exists and contains a valid rootfs, this method skips
    /// preparation and ensures metadata consistency.
    pub async fn prepare(
        &self,
        dest: PathBuf,
        image: &ImageObject,
    ) -> BoxliteResult<PreparedRootfs> {
        tracing::info!("Preparing rootfs at {}", dest.display());

        // Try copy-based mount first (VFS-style with caching)
        let prepared = match self.prepare_copy_based(&dest, image).await {
            Ok(prepared) => {
                tracing::info!("✅ Rootfs prepared using copy-based mount");
                prepared
            }
            Err(e) => {
                tracing::warn!(
                    "Copy-based mount failed: {}, falling back to extraction-based mount",
                    e
                );

                // Clean up partially created destination directory
                if dest.exists() {
                    tracing::debug!(
                        "Cleaning up partially created destination: {}",
                        dest.display()
                    );
                    if let Err(cleanup_err) = std::fs::remove_dir_all(&dest) {
                        tracing::warn!(
                            "Failed to clean up destination during fallback: {}",
                            cleanup_err
                        );
                        // Continue anyway - extraction-based mount will overwrite
                    }
                }

                // Fallback to extraction-based mount (original approach)
                self.prepare_extraction_based(&dest, image).await?
            }
        };

        Ok(prepared)
    }

    /// Prepare rootfs using VFS-style copy-based mount with layer caching
    ///
    /// This is the preferred method as it caches extracted layers for reuse.
    async fn prepare_copy_based(
        &self,
        dest: &Path,
        image: &ImageObject,
    ) -> BoxliteResult<PreparedRootfs> {
        tracing::info!("Attempting copy-based mount with layer caching");

        // Get extracted layer directories (with caching)
        let extracted_layers = image.layer_extracted().await?;

        if extracted_layers.is_empty() {
            return Err(BoxliteError::Storage(
                "Cannot prepare rootfs with no layers".into(),
            ));
        }

        tracing::info!(
            "Stacking {} cached layers directly to destination",
            extracted_layers.len()
        );

        // Stack layers directly to destination
        // IMPORTANT: Whiteouts are processed INLINE during copy (not as separate phase)
        // When copying a layer, .wh.* files delete corresponding files from destination
        for (idx, layer_dir) in extracted_layers.iter().enumerate() {
            if idx == 0 {
                // First layer: copy to dest
                tracing::debug!(
                    "Copying base layer {}/{}: {} -> {}",
                    idx + 1,
                    extracted_layers.len(),
                    layer_dir.display(),
                    dest.display()
                );

                let mount = copy_based_mount(
                    layer_dir,
                    dest,
                    CopyMountOptions {
                        copy_xattrs: true,
                        copy_mode: CopyMode::Content,
                        ignore_chown_errors: false,
                    },
                )?;

                // Unmount (no-op)
                mount.unmount()?;
            } else {
                // Subsequent layers: copy on top, processing whiteouts inline
                tracing::debug!(
                    "Overlaying layer {}/{}: {} (whiteouts processed inline)",
                    idx + 1,
                    extracted_layers.len(),
                    layer_dir.display()
                );

                // Copy this layer on top, whiteouts handled during copy
                copy_directory_overlay(layer_dir, dest)?;
            }
        }

        tracing::info!("✅ Rootfs prepared at {}", dest.display());
        Ok(PreparedRootfs {
            path: dest.to_path_buf(),
        })
    }

    /// Prepare rootfs using extraction-based mount (original approach)
    ///
    /// This is the fallback method that extracts all layers directly to destination.
    async fn prepare_extraction_based(
        &self,
        dest: &PathBuf,
        image: &ImageObject,
    ) -> BoxliteResult<PreparedRootfs> {
        tracing::info!("Using extraction-based mount (fallback)");

        std::fs::create_dir_all(dest).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create rootfs directory {}: {}",
                dest.display(),
                e
            ))
        })?;

        let layer_tarballs = image.layer_tarballs();
        if layer_tarballs.is_empty() {
            return Err(BoxliteError::Storage(
                "Cannot prepare rootfs with no layers".into(),
            ));
        }

        // One extractor across all layers — directory mode metadata is
        // deferred until finalize(), so a restrictive parent (e.g. RHEL UBI's
        // `/usr/bin` 0o555) doesn't get chmod'd narrow between layers and
        // block the next layer's unlink. See the regression test
        // `cross_layer_overwrite_through_readonly_parent_dir`.
        let mut extractor = LayerExtractor::new(dest);
        for (idx, tarball) in layer_tarballs.iter().enumerate() {
            tracing::debug!(
                "Extracting layer {}/{}: {}",
                idx + 1,
                layer_tarballs.len(),
                tarball.display()
            );
            extractor.extract_tarball(tarball)?;
        }
        extractor.finalize()?;

        // Fix permissions (runs after extractor.finalize so the xattr
        // sync at operations.rs:236 sees the finalized on-disk modes).
        crate::rootfs::operations::fix_rootfs_permissions(dest)?;

        tracing::info!("✅ Rootfs prepared using extraction-based mount");
        Ok(PreparedRootfs { path: dest.clone() })
    }
}

impl Default for RootfsBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Simple data holder for prepared rootfs path (no cleanup responsibility)
pub struct PreparedRootfs {
    pub path: PathBuf,
}

/// Check if a symlink is circular (points to itself)
fn is_symlink_loop(path: &Path) -> bool {
    let link_name = match path.file_name() {
        Some(n) => n.to_string_lossy(),
        None => return false,
    };

    let target = match std::fs::read_link(path) {
        Ok(t) => t,
        Err(_) => return false,
    };

    let target_str = target.to_string_lossy();

    // Check 1: Exact self-reference (thunar -> thunar)
    if target_str == link_name {
        return true;
    }

    // Check 2: Case-insensitive match for macOS (Thunar -> thunar)
    #[cfg(target_os = "macos")]
    if target_str.eq_ignore_ascii_case(&link_name) {
        return true;
    }

    false
}

/// Execute cp command with metadata preservation and CoW support
///
/// Platform-specific behavior:
/// - macOS: Tries `cp -ac` (clonefile) first, falls back to `cp -a` on cross-device errors
/// - Linux: Uses `cp -a --reflink=auto` (auto-fallback built-in)
fn execute_copy_with_metadata(src: &Path, dst: &Path) -> BoxliteResult<()> {
    use std::process::Command;

    std::fs::create_dir_all(dst).map_err(|e| {
        BoxliteError::Storage(format!("Failed to create dst dir {}: {}", dst.display(), e))
    })?;

    #[cfg(target_os = "macos")]
    {
        // Try with clonefile first
        let output = Command::new("cp")
            .args(["-ac", "--"])
            .arg(format!("{}/.", src.display()))
            .arg(dst)
            .output()
            .map_err(|e| BoxliteError::Storage(format!("Failed to execute cp: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);

            // If clonefile fails due to cross-device link, retry with regular copy
            if stderr.contains("clonefile failed") && stderr.contains("Cross-device link") {
                tracing::debug!(
                    "clonefile failed with cross-device error, retrying with regular copy"
                );

                let output_retry = Command::new("cp")
                    .args(["-a", "--"])
                    .arg(format!("{}/.", src.display()))
                    .arg(dst)
                    .output()
                    .map_err(|e| BoxliteError::Storage(format!("Failed to execute cp: {}", e)))?;

                if !output_retry.status.success() {
                    let stderr_retry = String::from_utf8_lossy(&output_retry.stderr);
                    return Err(BoxliteError::Storage(format!(
                        "cp -a {} -> {} failed: {}",
                        src.display(),
                        dst.display(),
                        stderr_retry.trim()
                    )));
                }
            } else {
                return Err(BoxliteError::Storage(format!(
                    "cp -a {} -> {} failed: {}",
                    src.display(),
                    dst.display(),
                    stderr.trim()
                )));
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let output = Command::new("cp")
            .args(["-a", "--reflink=auto", "--"])
            .arg(format!("{}/.", src.display()))
            .arg(dst)
            .output()
            .map_err(|e| BoxliteError::Storage(format!("Failed to execute cp: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(BoxliteError::Storage(format!(
                "cp -a {} -> {} failed: {}",
                src.display(),
                dst.display(),
                stderr.trim()
            )));
        }
    }

    Ok(())
}

/// Copy a directory on top of another, overlaying files and processing whiteouts
///
/// This simulates overlay filesystem behavior with OCI whiteout support:
/// - Files in src overwrite files in dst
/// - Directories are merged
/// - Metadata preserved via `cp -a`: permissions, timestamps, xattrs, ownership
/// - Whiteouts processed before copy:
///   - `.wh.filename` → delete `filename` from dst
///   - `.wh..wh..opq` → opaque directory, remove entire dst dir
/// - Circular symlinks in dst are removed where src replaces them (else `cp -a`
///   fails with ELOOP); ones src never writes to are left untouched
fn copy_directory_overlay(src: &Path, dst: &Path) -> BoxliteResult<()> {
    use std::collections::HashSet;
    use std::time::Instant;
    use walkdir::WalkDir;

    let total_start = Instant::now();

    // Step 1: Process whiteouts in src, clear blocking circular symlinks in dst,
    // and collect marker paths
    let step1_start = Instant::now();
    let mut markers: HashSet<PathBuf> = HashSet::new();

    for entry in WalkDir::new(src).follow_links(false) {
        let entry = entry.map_err(|e| {
            BoxliteError::Storage(format!("Failed to walk source directory: {}", e))
        })?;

        let src_path = entry.path();

        // A self-referential symlink in dst makes `cp -a` fail with ELOOP when it
        // writes onto that path. Only paths present in src are written, so the
        // check belongs here — on the src entry — rather than in a separate walk
        // of the whole accumulated dst tree. Loops dst holds at paths src never
        // touches are left alone; nothing will write to them.
        if let Ok(rel_path) = src_path.strip_prefix(src)
            && !rel_path.as_os_str().is_empty()
        {
            let dst_path = dst.join(rel_path);
            if let Ok(meta) = std::fs::symlink_metadata(&dst_path)
                && meta.is_symlink()
                && is_symlink_loop(&dst_path)
            {
                if let Err(e) = std::fs::remove_file(&dst_path) {
                    tracing::warn!(
                        "Failed to remove circular symlink {}: {}",
                        dst_path.display(),
                        e
                    );
                } else {
                    tracing::debug!(
                        "Removed circular symlink: {} (src has replacement)",
                        dst_path.display()
                    );
                }
            }
        }

        if let Some(filename) = src_path.file_name() {
            let filename_str = filename.to_string_lossy();

            if let Some(target_name) = filename_str.strip_prefix(".wh.") {
                let rel_path = src_path
                    .strip_prefix(src)
                    .map_err(|e| BoxliteError::Storage(format!("Strip prefix: {}", e)))?;

                // Store marker for later removal
                markers.insert(dst.join(rel_path));

                if target_name == ".wh..opq" {
                    // Opaque: remove entire directory in dst
                    if let Some(parent) = src_path.parent() {
                        let rel_parent = parent.strip_prefix(src).unwrap_or(Path::new(""));
                        let dst_dir = dst.join(rel_parent);
                        if dst_dir.exists() {
                            std::fs::remove_dir_all(&dst_dir).map_err(|e| {
                                BoxliteError::Storage(format!(
                                    "Failed to remove opaque dir {}: {}",
                                    dst_dir.display(),
                                    e
                                ))
                            })?;
                            tracing::debug!("Opaque: removed {}", dst_dir.display());
                        }
                    }
                } else {
                    // Regular whiteout: delete target in dst
                    if let Some(parent) = src_path.parent() {
                        let rel_parent = parent.strip_prefix(src).unwrap_or(Path::new(""));
                        let target_path = dst.join(rel_parent).join(target_name);

                        if let Ok(meta) = std::fs::symlink_metadata(&target_path) {
                            if meta.is_dir() {
                                std::fs::remove_dir_all(&target_path).ok();
                            } else {
                                std::fs::remove_file(&target_path).ok();
                            }
                            tracing::debug!("Whiteout: removed {}", target_path.display());
                        }
                    }
                }
            }
        }
    }

    tracing::debug!(
        "Step 1 (whiteouts + loop symlinks): {:?}, markers={}",
        step1_start.elapsed(),
        markers.len()
    );

    // Step 2: Copy with full metadata preservation using cp -a with CoW
    let step2_start = Instant::now();
    execute_copy_with_metadata(src, dst)?;
    tracing::debug!("Step 2 (cp -a): {:?}", step2_start.elapsed());

    // Step 3: Remove whiteout markers (just cleanup, no processing)
    let step3_start = Instant::now();
    for marker in &markers {
        if marker.exists() {
            std::fs::remove_file(marker).ok();
            tracing::trace!("Removed marker: {}", marker.display());
        }
    }
    tracing::debug!(
        "Step 3 (remove markers): {:?}, total: {:?}",
        step3_start.elapsed(),
        total_start.elapsed()
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_directory_overlay_processes_regular_whiteout_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");

        std::fs::create_dir_all(src.join("bin")).unwrap();
        std::fs::create_dir_all(dst.join("bin")).unwrap();
        std::fs::write(src.join("bin/.wh.sh"), b"").unwrap();
        std::fs::write(src.join("bin/new-tool"), b"new").unwrap();
        std::fs::write(dst.join("bin/sh"), b"old").unwrap();
        std::fs::write(dst.join("bin/bash"), b"keep").unwrap();

        copy_directory_overlay(&src, &dst).unwrap();

        assert!(!dst.join("bin/sh").exists());
        assert!(!dst.join("bin/.wh.sh").exists());
        assert_eq!(std::fs::read(dst.join("bin/bash")).unwrap(), b"keep");
        assert_eq!(std::fs::read(dst.join("bin/new-tool")).unwrap(), b"new");
    }

    /// A circular symlink in dst at a path the upper layer replaces must end up
    /// as the upper layer's entry.
    ///
    /// `cp -a` fails with ELOOP when it has to write onto a self-referential
    /// symlink, so the loop has to be removed before the copy.
    #[test]
    fn copy_directory_overlay_replaces_circular_symlink_when_src_has_entry() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");

        std::fs::create_dir_all(src.join("bin")).unwrap();
        std::fs::create_dir_all(dst.join("bin")).unwrap();
        std::fs::write(src.join("bin/sh"), b"upper").unwrap();
        symlink("sh", dst.join("bin/sh")).unwrap();

        copy_directory_overlay(&src, &dst).unwrap();

        let meta = std::fs::symlink_metadata(dst.join("bin/sh")).unwrap();
        assert!(
            meta.is_file(),
            "upper layer's regular file must replace the circular symlink"
        );
        assert_eq!(std::fs::read(dst.join("bin/sh")).unwrap(), b"upper");
    }

    /// A circular symlink in dst that the upper layer does *not* touch must
    /// survive the overlay unchanged — `cp -a` never writes to that path, so
    /// there is nothing to work around.
    #[test]
    fn copy_directory_overlay_keeps_unrelated_circular_symlink() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");

        std::fs::create_dir_all(src.join("bin")).unwrap();
        std::fs::create_dir_all(dst.join("bin")).unwrap();
        std::fs::write(src.join("bin/other"), b"upper").unwrap();
        symlink("selfloop", dst.join("bin/selfloop")).unwrap();

        copy_directory_overlay(&src, &dst).unwrap();

        let meta = std::fs::symlink_metadata(dst.join("bin/selfloop")).unwrap();
        assert!(
            meta.is_symlink(),
            "an untouched circular symlink must remain a symlink"
        );
        assert_eq!(
            std::fs::read_link(dst.join("bin/selfloop")).unwrap(),
            std::path::Path::new("selfloop"),
            "its target must be unchanged"
        );
        assert_eq!(std::fs::read(dst.join("bin/other")).unwrap(), b"upper");
    }

    #[test]
    fn copy_directory_overlay_processes_opaque_whiteout_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");

        std::fs::create_dir_all(src.join("etc")).unwrap();
        std::fs::create_dir_all(dst.join("etc/subdir")).unwrap();
        std::fs::write(src.join("etc/.wh..wh..opq"), b"").unwrap();
        std::fs::write(src.join("etc/upper"), b"upper").unwrap();
        std::fs::write(dst.join("etc/lower"), b"lower").unwrap();
        std::fs::write(dst.join("etc/subdir/lower"), b"lower").unwrap();

        copy_directory_overlay(&src, &dst).unwrap();

        assert_eq!(std::fs::read(dst.join("etc/upper")).unwrap(), b"upper");
        assert!(!dst.join("etc/lower").exists());
        assert!(!dst.join("etc/subdir").exists());
        assert!(!dst.join("etc/.wh..wh..opq").exists());
    }
}
