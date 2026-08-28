//! Unified rootfs builder for all preparation needs.

use crate::images::{ImageObject, LayerExtractor};
use crate::rootfs::overlay_merge::OverlayMerge;
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

                // Copy this layer on top; whiteouts and containment handled
                // by OverlayMerge (every destination path goes through SafeRoot).
                OverlayMerge::new(layer_dir, dest)?.apply()?;
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
