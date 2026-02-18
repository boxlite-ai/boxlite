//! OCI images object with encapsulated operations.
//!
//! This module provides `ImageObject`, a self-contained handle to a pulled
//! OCI image that encapsulates all image-related operations (config loading,
//! layer access, inspection).

use std::path::PathBuf;

use super::blob_source::BlobSource;
use super::manager::ImageManifest;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

// ============================================================================
// IMAGE OBJECT
// ============================================================================

/// A pulled OCI image with all associated operations.
///
/// This object represents a complete pulled image and provides access to:
/// - Image metadata (reference, layers, config)
/// - Container configuration
/// - Layer file paths
/// - Inspection operations
///
/// Created by `ImageManager::pull()` or `ImageManager::load_from_local()`.
///
/// Thread Safety: `BlobSource` variants handle their own caching strategies.
#[derive(Clone)]
pub struct ImageObject {
    /// Image reference (e.g., "python:alpine")
    reference: String,

    /// Manifest with layer information
    manifest: ImageManifest,

    /// Source of blobs with source-specific caching
    blob_source: BlobSource,
}

impl ImageObject {
    /// Create new ImageObject (internal use only)
    pub(super) fn new(reference: String, manifest: ImageManifest, blob_source: BlobSource) -> Self {
        Self {
            reference,
            manifest,
            blob_source,
        }
    }

    // ========================================================================
    // METADATA OPERATIONS
    // ========================================================================

    /// Get the image reference (e.g., "python:alpine")
    #[allow(dead_code)]
    pub fn reference(&self) -> &str {
        &self.reference
    }

    /// Get list of layer digests
    #[allow(dead_code)]
    pub fn layer_digests(&self) -> Vec<&str> {
        self.manifest
            .layers
            .iter()
            .map(|l| l.digest.as_str())
            .collect()
    }

    /// Get config digest
    #[allow(dead_code)]
    pub fn config_digest(&self) -> &str {
        &self.manifest.config_digest
    }

    /// Get number of layers
    #[allow(dead_code)]
    pub fn layer_count(&self) -> usize {
        self.manifest.layers.len()
    }

    // ========================================================================
    // CONFIG OPERATIONS
    // ========================================================================

    /// Load original OCI image configuration
    ///
    /// Returns the complete OCI ImageConfiguration structure as defined in the
    /// OCI image spec. This includes all fields from the image config.json.
    ///
    /// Use `ContainerConfig::from_oci_config()` if you need extracted container
    /// runtime configuration (entrypoint, env, workdir).
    pub async fn load_config(&self) -> BoxliteResult<oci_spec::image::ImageConfiguration> {
        let config_path = self.blob_source.config_path(&self.manifest.config_digest);
        let config_json = std::fs::read_to_string(&config_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read config from {}: {}",
                config_path.display(),
                e
            ))
        })?;

        serde_json::from_str(&config_json)
            .map_err(|e| BoxliteError::Storage(format!("Failed to parse image config: {}", e)))
    }

    // ========================================================================
    // LAYER OPERATIONS
    // ========================================================================

    /// Get path to a specific layer tarball
    ///
    /// Layers are indexed from 0 (base layer) to N-1 (top layer).
    #[allow(dead_code)]
    pub fn layer_tarball(&self, layer_index: usize) -> BoxliteResult<PathBuf> {
        let layer = self.manifest.layers.get(layer_index).ok_or_else(|| {
            BoxliteError::Storage(format!(
                "Layer index {} out of bounds (total layers: {})",
                layer_index,
                self.manifest.layers.len()
            ))
        })?;

        Ok(self.blob_source.layer_tarball_path(&layer.digest))
    }

    /// Get paths to all layer tarballs (ordered bottom to top)
    pub fn layer_tarballs(&self) -> Vec<PathBuf> {
        self.manifest
            .layers
            .iter()
            .map(|layer| self.blob_source.layer_tarball_path(&layer.digest))
            .collect()
    }

    /// Get paths to extracted layer directories (with caching)
    ///
    /// This method extracts each layer tarball to a separate directory and caches
    /// the result. Subsequent calls return the cached extracted directories.
    ///
    /// Uses rayon for parallel extraction of multiple layers.
    ///
    /// This is the VFS-style approach: each layer is extracted once and cached,
    /// then stacked using copy-based mounts.
    ///
    /// # Returns
    /// Vector of paths to extracted layer directories, ordered bottom to top.
    /// Each path is a directory containing the extracted layer contents.
    ///
    /// # Example
    /// ```ignore
    /// let extracted = image.layer_extracted().await?;
    /// // extracted[0] = /images/extracted/sha256:abc.../  (base layer)
    /// // extracted[1] = /images/extracted/sha256:def.../  (layer 1)
    /// // extracted[2] = /images/extracted/sha256:ghi.../  (layer 2)
    /// ```
    pub async fn layer_extracted(&self) -> BoxliteResult<Vec<PathBuf>> {
        let digests: Vec<String> = self
            .manifest
            .layers
            .iter()
            .map(|l| l.digest.clone())
            .collect();

        self.blob_source.extract_layers(&digests).await
    }

    /// Compute a stable digest for this image based on its layers.
    ///
    /// This is used as a cache key for base disks - same layers = same base disk.
    /// Uses SHA256 hash of concatenated layer digests.
    pub(crate) fn compute_image_digest(&self) -> String {
        use sha2::{Digest, Sha256};

        let mut hasher = Sha256::new();
        for layer in &self.manifest.layers {
            hasher.update(layer.digest.as_bytes());
        }
        format!("sha256:{:x}", hasher.finalize())
    }

    // ========================================================================
    // INSPECTION
    // ========================================================================

    /// Pretty-print image information
    #[allow(dead_code)]
    pub fn inspect(&self) -> String {
        let mut output = String::new();

        output.push_str(&format!("{}\n", self.reference));
        output.push_str(&format!("Config: {}\n", self.config_digest()));
        output.push_str(&format!("Layers ({}):\n", self.layer_count()));

        for (i, layer) in self.manifest.layers.iter().enumerate() {
            output.push_str(&format!("  {}. {}\n", i + 1, layer.digest));
        }

        output
    }
}

impl std::fmt::Debug for ImageObject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageObject")
            .field("reference", &self.reference)
            .field("layers", &self.manifest.layers.len())
            .field("config_digest", &self.manifest.config_digest)
            .finish()
    }
}

impl std::fmt::Display for ImageObject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} ({} layers)",
            self.reference,
            self.manifest.layers.len()
        )
    }
}
