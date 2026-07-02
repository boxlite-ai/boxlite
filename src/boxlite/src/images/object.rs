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
        // Reject a malformed/tampered manifest (empty-on-Store / count mismatch)
        // before doing any extraction work or writing to the layer cache.
        self.validate_diff_id_count()?;

        let digests: Vec<String> = self
            .manifest
            .layers
            .iter()
            .map(|l| l.digest.clone())
            .collect();

        let extracted = self.blob_source.extract_layers(&digests).await?;

        // Full per-layer DiffID hashing (re-runs the cheap count check).
        self.verify_diff_ids()?;

        Ok(extracted)
    }

    /// Cheap structural check of `rootfs.diff_ids` against the layer list — no
    /// I/O. Run before layer extraction so a malformed/tampered manifest is
    /// rejected before any layer is decompressed or written to the cache, and
    /// again inside [`verify_diff_ids`](Self::verify_diff_ids) for direct callers.
    fn validate_diff_id_count(&self) -> BoxliteResult<()> {
        use crate::images::blob_source::BlobSource;

        let diff_ids = &self.manifest.diff_ids;

        // Empty diff_ids is only legitimate for the LocalBundle path —
        // local OCI bundles can be loaded without a config.json and so
        // carry no diff_ids list. A remote (Store) pull resolves its
        // diff_ids from a digest-verified config, and the loader
        // (`load_diff_ids_from_config`) errors instead of yielding an empty
        // list when that config can't be read, verified, or parsed — so an
        // empty list here means the config genuinely declared no DiffIDs,
        // leaving the layers unverifiable. Fail closed in the Store case;
        // keep the LocalBundle skip.
        if diff_ids.is_empty() {
            return match &self.blob_source {
                BlobSource::LocalBundle(_) => Ok(()),
                BlobSource::Store(_) => Err(BoxliteError::Image(
                    "rootfs.diff_ids is empty for a remote-pulled image; refusing to use image \
                     without DiffID verification (config declared no DiffIDs)"
                        .to_string(),
                )),
            };
        }

        // OCI requires exactly one diff_id per layer. A non-matching count is a
        // malformed or tampered manifest, so fail closed instead of silently
        // skipping verification (which would let an attacker disable DiffID
        // checks by supplying a short list).
        let layers = &self.manifest.layers;
        if diff_ids.len() != layers.len() {
            return Err(BoxliteError::Image(format!(
                "DiffID count ({}) does not match layer count ({}); refusing to use image with inconsistent rootfs.diff_ids",
                diff_ids.len(),
                layers.len()
            )));
        }

        Ok(())
    }

    /// Verify layer DiffIDs against the image config's rootfs.diff_ids.
    ///
    /// DiffIDs are SHA256 hashes of the uncompressed layer tar content.
    /// This ensures the decompressed filesystem content matches what the
    /// image author intended.
    fn verify_diff_ids(&self) -> BoxliteResult<()> {
        use crate::images::archive::LayerVerifier;

        self.validate_diff_id_count()?;

        // Empty diff_ids (LocalBundle) returned Ok above, so this zip runs zero
        // times; otherwise the counts are equal and every layer is checked.
        let diff_ids = &self.manifest.diff_ids;
        let layers = &self.manifest.layers;
        for (i, (layer, diff_id)) in layers.iter().zip(diff_ids.iter()).enumerate() {
            let tarball_path = self.blob_source.layer_tarball_path(&layer.digest);
            // A malformed diff_id in the list (wrong algorithm prefix,
            // empty hash, etc.) means the config is tampered or
            // malformed. Skipping that one layer's verification turned
            // into a targetable per-layer bypass — fail closed.
            let verifier = LayerVerifier::new(diff_id).map_err(|e| {
                BoxliteError::Image(format!(
                    "DiffID parse error for layer {} ({}): {}",
                    i, layer.digest, e
                ))
            })?;
            match verifier.verify_tarball(&tarball_path) {
                Ok(true) => {
                    tracing::debug!("DiffID verified for layer {}: {}", i, layer.digest);
                }
                Ok(false) => {
                    return Err(BoxliteError::Image(format!(
                        "DiffID verification failed for layer {} ({}): \
                         uncompressed content does not match expected diff_id {}",
                        i, layer.digest, diff_id
                    )));
                }
                Err(e) => {
                    // The historical comment here claimed this branch
                    // existed for "unsupported format" — but TarballReader
                    // only distinguishes gzip vs raw (treats anything
                    // that isn't gzip magic as raw tar), so an
                    // unsupported compression format surfaces as
                    // Ok(false) hash mismatch, not Err. The Err variants
                    // are real IO failures (file missing, mid-stream
                    // read error) — that's a verification gap, not an
                    // unverifiable layer. Fail closed.
                    return Err(BoxliteError::Image(format!(
                        "DiffID verification IO error for layer {} ({}): {}",
                        i, layer.digest, e
                    )));
                }
            }
        }

        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::blob_source::{BlobSource, LocalBundleBlobSource, StoreBlobSource};
    use crate::images::manager::{ImageManifest, LayerInfo};
    use crate::images::storage::ImageStorage;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn layer(digest: &str) -> LayerInfo {
        LayerInfo {
            digest: digest.to_string(),
            media_type: "application/vnd.oci.image.layer.v1.tar+gzip".to_string(),
            size: 1,
        }
    }

    fn local_bundle_blob_source() -> BlobSource {
        // Dummy paths — the branches under test reject the manifest
        // before any blob is read, so nothing actually touches them.
        BlobSource::LocalBundle(LocalBundleBlobSource::new(
            PathBuf::from("/nonexistent/bundle"),
            PathBuf::from("/nonexistent/cache"),
        ))
    }

    fn store_blob_source(_tmp: &TempDir) -> BlobSource {
        // A real ImageStorage rooted at a tmpdir so the BlobSource::Store
        // discriminant is exercised. Empty-diff_ids and parse-error
        // branches fire before any blob path is dereferenced.
        let storage = Arc::new(ImageStorage::new(_tmp.path().to_path_buf()).unwrap());
        BlobSource::Store(StoreBlobSource::new(storage))
    }

    fn object_with(
        layers: Vec<LayerInfo>,
        diff_ids: Vec<String>,
        blob_source: BlobSource,
    ) -> ImageObject {
        let manifest = ImageManifest {
            manifest_digest:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
            layers,
            config_digest:
                "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                    .to_string(),
            diff_ids,
        };
        ImageObject::new("test:image".to_string(), manifest, blob_source)
    }

    // A config that declares a different number of diff_ids than there are layers
    // is malformed/tampered; verification must fail closed rather than silently
    // skip (which would let an attacker disable DiffID checks). With the fix
    // reverted this returns Ok and the assertion fails.
    #[test]
    fn verify_diff_ids_rejects_count_mismatch() {
        let obj = object_with(
            vec![layer(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )],
            vec![
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_string(),
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .to_string(),
            ],
            local_bundle_blob_source(),
        );
        assert!(
            obj.verify_diff_ids().is_err(),
            "expected count-mismatch diff_ids to be rejected"
        );

        // Inverse direction: a SHORT diff_ids list (fewer entries than layers)
        // must also be rejected — otherwise an attacker could disable the check
        // for the unlisted layers by truncating rootfs.diff_ids.
        let obj = object_with(
            vec![
                layer("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                layer("sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"),
            ],
            vec![
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_string(),
            ],
            local_bundle_blob_source(),
        );
        assert!(
            obj.verify_diff_ids().is_err(),
            "expected short diff_ids list to be rejected"
        );
    }

    // Local bundles can legitimately load without a config.json (no diff_ids
    // available), so an empty list on the LocalBundle path stays a skip —
    // matches docker save / OCI bundle ergonomics and is the only path
    // intentionally left lenient by the audit.
    #[test]
    fn verify_diff_ids_allows_empty_for_local_bundle() {
        let obj = object_with(
            vec![layer(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )],
            vec![],
            local_bundle_blob_source(),
        );
        assert!(
            obj.verify_diff_ids().is_ok(),
            "empty diff_ids on a local bundle should skip verification"
        );
    }

    // A remote-pulled image ALWAYS goes through a config-download step that
    // populates rootfs.diff_ids; an empty list there is tampering or a parse
    // failure, and the previous "skip on empty" branch was a global bypass.
    // With the fix reverted to `Ok(())` for the empty case, this returns Ok
    // and the assertion fails.
    #[test]
    fn verify_diff_ids_rejects_empty_for_remote_store_source() {
        let tmp = TempDir::new().unwrap();
        let obj = object_with(
            vec![layer(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )],
            vec![],
            store_blob_source(&tmp),
        );
        let err = obj
            .verify_diff_ids()
            .expect_err("empty diff_ids on a remote-pulled (Store) image must fail closed");
        let msg = format!("{}", err);
        assert!(
            msg.contains("empty"),
            "error should explain the empty-diff_ids cause, got: {msg}",
        );
    }

    // A malformed diff_id in the list (wrong algorithm prefix, empty hash, etc.)
    // is a tampered/malformed manifest. The previous `continue` swallowed the
    // parse error and skipped that one layer's verification — turning into a
    // targetable per-layer bypass. With the fix reverted to `continue`, this
    // returns Ok and the assertion fails.
    #[test]
    fn verify_diff_ids_rejects_malformed_diff_id_in_list() {
        let tmp = TempDir::new().unwrap();
        // Put the malformed entry FIRST so LayerVerifier::new fires before
        // verify_diff_ids walks past it to read any layer tarball from
        // disk — otherwise the test would race with the (also-correct)
        // IO-error fail-closed branch on a missing layer file.
        let obj = object_with(
            vec![
                layer("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                layer("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            ],
            vec![
                // Wrong algorithm prefix — LayerVerifier::new returns Err.
                "md5:dddddddddddddddddddddddddddddddd".to_string(),
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .to_string(),
            ],
            store_blob_source(&tmp),
        );
        let err = obj
            .verify_diff_ids()
            .expect_err("malformed diff_id must fail closed (was: silently `continue`)");
        let msg = format!("{}", err);
        assert!(
            msg.contains("parse error") || msg.contains("Invalid diff_id"),
            "error should explain the parse failure, got: {msg}",
        );
    }

    // A real IO error during verify_tarball (e.g. the layer tarball doesn't
    // exist on disk) is a verification gap, not an unverifiable layer — the
    // historical "skip on Err" branch claimed to be for "unsupported format",
    // but TarballReader treats anything that isn't gzip magic as raw tar
    // (unsupported-compression surfaces as Ok(false) hash mismatch). With the
    // fix reverted to skip-on-Err, this returns Ok and the assertion fails.
    #[test]
    fn verify_diff_ids_rejects_io_error_during_verify() {
        let tmp = TempDir::new().unwrap();
        // diff_id well-formed → parse step succeeds → verify_tarball gets
        // called on a path the BlobSource resolves to but no file exists.
        let obj = object_with(
            vec![layer(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )],
            vec![
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_string(),
            ],
            store_blob_source(&tmp),
        );
        let err = obj
            .verify_diff_ids()
            .expect_err("IO error during verify must fail closed (was: silently warn-and-pass)");
        let msg = format!("{}", err);
        assert!(
            msg.contains("IO error") || msg.contains("Failed to open"),
            "error should surface the IO cause, got: {msg}",
        );
    }
}
