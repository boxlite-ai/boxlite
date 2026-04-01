//! Blob source abstraction for OCI image blobs.
//!
//! This module provides `BlobSource`, an enum that abstracts where image blobs
//! (layer tarballs, config files) are stored and how they are cached.
//!
//! ## Security Model
//!
//! Each variant controls its own caching strategy to ensure security isolation:
//! - `Store`: Trusted blobs from registry, cached in `~/.boxlite/images/`
//! - `LocalBundle`: External blobs, cached in namespaced `~/.boxlite/images/local/{hash}/`
//!
//! This prevents cache poisoning attacks where a malicious local bundle could
//! contaminate the trusted store cache.

use std::path::{Path, PathBuf};

use crate::images::archive::extract_layer_tarball_streaming;
use crate::images::storage::ImageStorage;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

// ============================================================================
// BLOB SOURCE ENUM
// ============================================================================

/// Source of OCI image blobs with source-specific caching.
///
/// Each variant controls its own security boundary:
/// - `Store`: cache to trusted locations (`~/.boxlite/images/`)
/// - `LocalBundle`: namespaced cache (`~/.boxlite/images/local/{hash}/`)
#[derive(Clone, Debug)]
pub enum BlobSource {
    /// Blobs from image store (pulled/cached images)
    Store(StoreBlobSource),
    /// Blobs from local OCI bundle
    LocalBundle(LocalBundleBlobSource),
}

impl BlobSource {
    /// Get path to layer tarball for given digest.
    pub fn layer_tarball_path(&self, digest: &str) -> PathBuf {
        match self {
            Self::Store(s) => s.layer_tarball_path(digest),
            Self::LocalBundle(l) => l.layer_tarball_path(digest),
        }
    }

    /// Get path to config blob for given digest.
    pub fn config_path(&self, digest: &str) -> PathBuf {
        match self {
            Self::Store(s) => s.config_path(digest),
            Self::LocalBundle(l) => l.config_path(digest),
        }
    }

    /// Load config JSON content.
    #[allow(dead_code)]
    pub fn load_config(&self, digest: &str) -> BoxliteResult<String> {
        let path = self.config_path(digest);
        std::fs::read_to_string(&path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read config from {}: {}",
                path.display(),
                e
            ))
        })
    }

    /// Get extracted layer paths, extracting if needed.
    ///
    /// Each source controls its own caching strategy:
    /// - Store: caches to `~/.boxlite/images/extracted/`
    /// - LocalBundle: caches to `~/.boxlite/images/local/{hash}/extracted/`
    ///
    /// This method is async because layer extraction uses `rayon::par_iter()` for
    /// parallel CPU-bound work, which can block for seconds. Using `spawn_blocking`
    /// moves this work to a dedicated thread pool, freeing the Tokio executor.
    pub async fn extract_layers(&self, digests: &[String]) -> BoxliteResult<Vec<PathBuf>> {
        let source = self.clone();
        let digests = digests.to_vec();
        tokio::task::spawn_blocking(move || match &source {
            Self::Store(s) => s.extract_layers(&digests),
            Self::LocalBundle(l) => l.extract_layers(&digests),
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("Extract layers task failed: {}", e)))?
    }
}

// ============================================================================
// STORE BLOB SOURCE (trusted, pulled images)
// ============================================================================

/// Blob source for pulled/cached images from registries.
///
/// Uses the standard image store layout:
/// - Layers: `~/.boxlite/images/layers/sha256-{hash}.tar.gz`
/// - Configs: `~/.boxlite/images/configs/sha256-{hash}.json`
/// - Extracted: `~/.boxlite/images/extracted/sha256-{hash}/`
#[derive(Clone, Debug)]
pub struct StoreBlobSource {
    /// Shared reference to image storage
    storage: std::sync::Arc<ImageStorage>,
}

impl StoreBlobSource {
    /// Create a new store blob source.
    pub fn new(storage: std::sync::Arc<ImageStorage>) -> Self {
        Self { storage }
    }

    /// Get path to layer tarball.
    pub fn layer_tarball_path(&self, digest: &str) -> PathBuf {
        self.storage.layer_tarball_path(digest)
    }

    /// Get path to config blob.
    pub fn config_path(&self, digest: &str) -> PathBuf {
        self.storage.config_path(digest)
    }

    /// Get extracted layer paths, extracting if needed.
    pub fn extract_layers(&self, digests: &[String]) -> BoxliteResult<Vec<PathBuf>> {
        use rayon::prelude::*;

        digests
            .par_iter()
            .map(|digest| {
                let tarball_path = self.storage.layer_tarball_path(digest);
                let extracted_path = self.storage.layer_extracted_path(digest);

                // Check if already extracted
                if extracted_path.exists() {
                    tracing::debug!("Using cached extracted layer: {}", digest);
                    return Ok(extracted_path);
                }

                // Extract layer
                tracing::debug!("Extracting layer: {}", digest);
                self.storage.extract_layer(digest, &tarball_path)?;
                Ok(extracted_path)
            })
            .collect()
    }
}

// ============================================================================
// LOCAL BUNDLE BLOB SOURCE (external, namespaced cache)
// ============================================================================

/// Blob source for local OCI bundles.
///
/// Reads blobs directly from the bundle directory and caches extracted
/// layers in a namespaced directory to prevent cache contamination
/// with trusted store sources.
///
/// Cache layout:
/// - Extracted: `~/.boxlite/images/local/{bundle_hash}/extracted/sha256-{hash}/`
#[derive(Clone, Debug)]
pub struct LocalBundleBlobSource {
    /// Path to the OCI bundle directory
    bundle_path: PathBuf,
    /// Path to namespaced cache directory
    cache_dir: PathBuf,
}

impl LocalBundleBlobSource {
    /// Create a new local bundle blob source.
    ///
    /// # Arguments
    /// * `bundle_path` - Path to the OCI bundle directory
    /// * `cache_dir` - Pre-computed cache directory from `ImageFilesystemLayout::local_bundle_cache_dir`
    pub fn new(bundle_path: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            bundle_path,
            cache_dir,
        }
    }

    /// Get path to layer tarball (reads from bundle).
    pub fn layer_tarball_path(&self, digest: &str) -> PathBuf {
        // OCI layout: {bundle}/blobs/sha256/{hash}
        self.bundle_path
            .join("blobs")
            .join(digest.replace(':', "/"))
    }

    /// Get path to config blob (reads from bundle).
    pub fn config_path(&self, digest: &str) -> PathBuf {
        // OCI layout: {bundle}/blobs/sha256/{hash}
        self.bundle_path
            .join("blobs")
            .join(digest.replace(':', "/"))
    }

    /// Get path to extracted layer in cache.
    fn extracted_path(&self, digest: &str) -> PathBuf {
        let filename = digest.replace(':', "-");
        self.cache_dir.join("extracted").join(filename)
    }

    /// Get extracted layer paths, extracting if needed.
    pub fn extract_layers(&self, digests: &[String]) -> BoxliteResult<Vec<PathBuf>> {
        use rayon::prelude::*;

        // Ensure cache directory exists
        let extracted_dir = self.cache_dir.join("extracted");
        std::fs::create_dir_all(&extracted_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create local cache directory {}: {}",
                extracted_dir.display(),
                e
            ))
        })?;

        digests
            .par_iter()
            .map(|digest| {
                let tarball_path = self.layer_tarball_path(digest);
                let extracted_path = self.extracted_path(digest);

                // Check if already extracted
                if extracted_path.exists() {
                    tracing::debug!("Using cached extracted layer (local): {}", digest);
                    return Ok(extracted_path);
                }

                // Extract layer using atomic temp directory pattern
                tracing::debug!("Extracting layer (local bundle): {}", digest);
                self.extract_layer_atomic(digest, &tarball_path, &extracted_path)?;
                Ok(extracted_path)
            })
            .collect()
    }

    /// Extract layer with atomic temp directory pattern.
    fn extract_layer_atomic(
        &self,
        digest: &str,
        tarball_path: &Path,
        extracted_path: &Path,
    ) -> BoxliteResult<()> {
        // Extract to unique temp directory
        let temp_suffix = format!("{}.extracting", uuid::Uuid::new_v4().simple());
        let temp_path = extracted_path.with_extension(temp_suffix);

        std::fs::create_dir_all(&temp_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp extraction directory {}: {}",
                temp_path.display(),
                e
            ))
        })?;

        // Extract tarball
        if let Err(e) = extract_layer_tarball_streaming(tarball_path, &temp_path) {
            let _ = std::fs::remove_dir_all(&temp_path);
            return Err(e);
        }

        // Atomic rename
        match std::fs::rename(&temp_path, extracted_path) {
            Ok(()) => {
                tracing::debug!("Extracted layer (local): {}", digest);
            }
            Err(_) => {
                // Another thread won - clean up
                let _ = std::fs::remove_dir_all(&temp_path);
                if !extracted_path.exists() {
                    return Err(BoxliteError::Storage(format!(
                        "Failed to extract layer: {}",
                        digest
                    )));
                }
            }
        }

        Ok(())
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_bundle_layer_path() {
        // cache_dir is now passed directly (computed by ImageFilesystemLayout)
        let source = LocalBundleBlobSource::new(
            PathBuf::from("/my/bundle"),
            PathBuf::from("/images/local/abc12345-def67890"),
        );

        let path = source.layer_tarball_path("sha256:abc123def456");
        assert_eq!(path, PathBuf::from("/my/bundle/blobs/sha256/abc123def456"));
    }

    #[test]
    fn test_local_bundle_config_path() {
        let source = LocalBundleBlobSource::new(
            PathBuf::from("/my/bundle"),
            PathBuf::from("/images/local/abc12345-def67890"),
        );

        let path = source.config_path("sha256:config789");
        assert_eq!(path, PathBuf::from("/my/bundle/blobs/sha256/config789"));
    }

    #[test]
    fn test_local_bundle_cache_dir_used() {
        // Different cache_dirs result in different extracted paths
        let source1 = LocalBundleBlobSource::new(
            PathBuf::from("/bundle"),
            PathBuf::from("/images/local/path1-manifest1"),
        );
        let source2 = LocalBundleBlobSource::new(
            PathBuf::from("/bundle"),
            PathBuf::from("/images/local/path1-manifest2"),
        );

        // Different cache dirs (different manifest digests)
        assert_ne!(source1.cache_dir, source2.cache_dir);
    }

    #[test]
    fn test_local_bundle_extracted_path() {
        let source = LocalBundleBlobSource::new(
            PathBuf::from("/my/bundle"),
            PathBuf::from("/images/local/abc12345-def67890"),
        );

        let path = source.extracted_path("sha256:layer123");
        assert!(path.starts_with("/images/local/abc12345-def67890"));
        assert!(path.to_string_lossy().contains("extracted"));
        assert!(path.to_string_lossy().contains("sha256-layer123"));
    }

    #[test]
    fn test_blob_source_enum_dispatch() {
        // Test that BlobSource enum correctly delegates to variants
        let temp_dir = tempfile::tempdir().unwrap();
        let images_dir = temp_dir.path().to_path_buf();

        // Create storage for StoreBlobSource
        let storage = std::sync::Arc::new(
            crate::images::storage::ImageStorage::new(images_dir.clone()).unwrap(),
        );
        let store_source = BlobSource::Store(StoreBlobSource::new(storage));

        // Create LocalBundleBlobSource with explicit cache_dir
        let bundle_dir = temp_dir.path().join("bundle");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        let cache_dir = images_dir.join("local").join("test-cache");
        let local_source =
            BlobSource::LocalBundle(LocalBundleBlobSource::new(bundle_dir.clone(), cache_dir));

        // Test layer_tarball_path returns different paths for different sources
        let store_path = store_source.layer_tarball_path("sha256:abc123");
        let local_path = local_source.layer_tarball_path("sha256:abc123");

        // Store uses storage layout
        assert!(store_path.to_string_lossy().contains("layers"));
        // Local reads from bundle
        assert!(local_path.starts_with(&bundle_dir));
        assert!(local_path.to_string_lossy().contains("blobs"));
    }

    /// Helper to create a minimal OCI bundle for testing
    mod test_fixtures {
        use super::*;
        use sha2::{Digest, Sha256};

        /// Create a minimal OCI bundle with a single layer
        pub fn create_test_oci_bundle(bundle_dir: &Path) -> (String, String) {
            // Create OCI layout
            std::fs::create_dir_all(bundle_dir.join("blobs/sha256")).unwrap();

            let oci_layout = r#"{"imageLayoutVersion": "1.0.0"}"#;
            std::fs::write(bundle_dir.join("oci-layout"), oci_layout).unwrap();

            // Create a minimal layer tarball with a single file
            let layer_content = create_minimal_tarball();
            let layer_digest = format!(
                "sha256:{}",
                Sha256::digest(&layer_content)
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<String>()
            );
            let layer_path = bundle_dir.join("blobs/sha256").join(&layer_digest[7..]);
            std::fs::write(&layer_path, &layer_content).unwrap();

            // Create config
            let config = r#"{
                "architecture": "amd64",
                "os": "linux",
                "config": {
                    "Env": ["PATH=/usr/local/bin:/usr/bin:/bin"],
                    "WorkingDir": "/"
                },
                "rootfs": {
                    "type": "layers",
                    "diff_ids": []
                }
            }"#;
            let config_bytes = config.as_bytes();
            let config_digest = format!(
                "sha256:{}",
                Sha256::digest(config_bytes)
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<String>()
            );
            let config_path = bundle_dir.join("blobs/sha256").join(&config_digest[7..]);
            std::fs::write(&config_path, config_bytes).unwrap();

            // Create manifest
            let manifest = format!(
                r#"{{
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {{
                    "mediaType": "application/vnd.oci.image.config.v1+json",
                    "digest": "{}",
                    "size": {}
                }},
                "layers": [
                    {{
                        "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                        "digest": "{}",
                        "size": {}
                    }}
                ]
            }}"#,
                config_digest,
                config_bytes.len(),
                layer_digest,
                layer_content.len()
            );
            let manifest_bytes = manifest.as_bytes();
            let manifest_digest = format!(
                "sha256:{}",
                Sha256::digest(manifest_bytes)
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<String>()
            );
            let manifest_path = bundle_dir.join("blobs/sha256").join(&manifest_digest[7..]);
            std::fs::write(&manifest_path, manifest_bytes).unwrap();

            // Create index.json
            let index = format!(
                r#"{{
                "schemaVersion": 2,
                "manifests": [
                    {{
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "digest": "{}",
                        "size": {}
                    }}
                ]
            }}"#,
                manifest_digest,
                manifest_bytes.len()
            );
            std::fs::write(bundle_dir.join("index.json"), index).unwrap();

            (layer_digest, config_digest)
        }

        /// Create a minimal tar archive with a single file
        fn create_minimal_tarball() -> Vec<u8> {
            let mut builder = tar::Builder::new(Vec::new());

            // Add a simple file
            let content = b"Hello from test layer!";
            let mut header = tar::Header::new_gnu();
            header.set_path("test.txt").unwrap();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &content[..]).unwrap();

            builder.into_inner().unwrap()
        }
    }

    #[test]
    fn test_local_bundle_load_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let cache_dir = temp_dir.path().join("cache/local/test-cache");

        let (_layer_digest, config_digest) = test_fixtures::create_test_oci_bundle(&bundle_dir);

        let source = LocalBundleBlobSource::new(bundle_dir, cache_dir);

        // Test loading config
        let config_json = std::fs::read_to_string(source.config_path(&config_digest)).unwrap();
        assert!(config_json.contains("amd64"));
        assert!(config_json.contains("linux"));
    }

    #[test]
    fn test_local_bundle_extract_layers() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let cache_dir = temp_dir.path().join("images/local/test-cache");

        let (layer_digest, _config_digest) = test_fixtures::create_test_oci_bundle(&bundle_dir);

        let source = LocalBundleBlobSource::new(bundle_dir.clone(), cache_dir.clone());

        // Extract layers
        let digests = vec![layer_digest.clone()];
        let extracted = source.extract_layers(&digests).unwrap();

        assert_eq!(extracted.len(), 1);
        assert!(extracted[0].exists());

        // Verify the extracted content
        let test_file = extracted[0].join("test.txt");
        assert!(test_file.exists());
        let content = std::fs::read_to_string(&test_file).unwrap();
        assert_eq!(content, "Hello from test layer!");

        // Verify cache is under provided cache_dir
        assert!(extracted[0].starts_with(&cache_dir));
        assert!(extracted[0].to_string_lossy().contains("extracted"));
    }

    #[test]
    fn test_local_bundle_extract_layers_cached() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let cache_dir = temp_dir.path().join("images/local/test-cache");

        let (layer_digest, _config_digest) = test_fixtures::create_test_oci_bundle(&bundle_dir);

        let source = LocalBundleBlobSource::new(bundle_dir.clone(), cache_dir);

        // Extract layers twice
        let digests = vec![layer_digest.clone()];
        let extracted1 = source.extract_layers(&digests).unwrap();
        let extracted2 = source.extract_layers(&digests).unwrap();

        // Should return same paths (cached)
        assert_eq!(extracted1, extracted2);
    }

    #[test]
    fn test_store_and_local_cache_isolation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let images_dir = temp_dir.path().join("images");
        let bundle_dir = temp_dir.path().join("bundle");
        let local_cache_dir = images_dir.join("local/test-cache");

        // Create storage for store source
        let storage = std::sync::Arc::new(
            crate::images::storage::ImageStorage::new(images_dir.clone()).unwrap(),
        );

        // Create test bundle
        let (layer_digest, _config_digest) = test_fixtures::create_test_oci_bundle(&bundle_dir);

        // Create both sources
        let _store_source = StoreBlobSource::new(storage.clone());
        let local_source = LocalBundleBlobSource::new(bundle_dir.clone(), local_cache_dir);

        // Get extracted paths for same digest
        let store_extracted = storage.layer_extracted_path(&layer_digest);
        let local_extracted = local_source.extracted_path(&layer_digest);

        // Paths should be DIFFERENT (security isolation)
        assert_ne!(store_extracted, local_extracted);

        // Store goes to images/extracted/
        assert!(store_extracted.to_string_lossy().contains("extracted"));
        assert!(!store_extracted.to_string_lossy().contains("local"));

        // Local goes to images/local/{hash}/extracted/
        assert!(local_extracted.to_string_lossy().contains("local"));
        assert!(local_extracted.to_string_lossy().contains("extracted"));
    }

    #[test]
    fn test_different_cache_dirs_are_isolated() {
        let temp_dir = tempfile::tempdir().unwrap();
        let images_dir = temp_dir.path().join("images");
        let bundle1_dir = temp_dir.path().join("bundle1");
        let bundle2_dir = temp_dir.path().join("bundle2");

        std::fs::create_dir_all(&images_dir).unwrap();

        // Create two different bundles
        test_fixtures::create_test_oci_bundle(&bundle1_dir);
        test_fixtures::create_test_oci_bundle(&bundle2_dir);

        // Different cache dirs (as would be computed by ImageFilesystemLayout)
        let cache_dir1 = images_dir.join("local/path1hash-manifest1");
        let cache_dir2 = images_dir.join("local/path2hash-manifest2");

        let source1 = LocalBundleBlobSource::new(bundle1_dir, cache_dir1.clone());
        let source2 = LocalBundleBlobSource::new(bundle2_dir, cache_dir2.clone());

        // Should have different cache directories
        assert_ne!(source1.cache_dir, source2.cache_dir);
        assert_eq!(source1.cache_dir, cache_dir1);
        assert_eq!(source2.cache_dir, cache_dir2);
    }

    #[test]
    fn test_same_bundle_content_change_uses_new_cache() {
        // Simulates: user modifies a local bundle, rebuilds it
        // The bundle path stays the same, but manifest digest changes
        // BoxLite should use a NEW cache, not stale data
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let images_dir = temp_dir.path().join("images");

        // Create initial bundle (v1)
        let (layer_digest_v1, _) = test_fixtures::create_test_oci_bundle(&bundle_dir);

        // Cache dir for v1 (path_hash + manifest_digest_v1)
        let cache_dir_v1 = images_dir.join("local/bundlehash-manifestv1");
        let source_v1 = LocalBundleBlobSource::new(bundle_dir.clone(), cache_dir_v1.clone());

        // Extract layers for v1
        let extracted_v1 = source_v1
            .extract_layers(std::slice::from_ref(&layer_digest_v1))
            .unwrap();
        assert!(extracted_v1[0].exists());

        // Verify v1 cache location
        assert!(extracted_v1[0].starts_with(&cache_dir_v1));

        // --- User rebuilds bundle (content change) ---
        // Same bundle path, but different manifest = different cache_dir

        // Cache dir for v2 (same path_hash + NEW manifest_digest_v2)
        let cache_dir_v2 = images_dir.join("local/bundlehash-manifestv2");
        let source_v2 = LocalBundleBlobSource::new(bundle_dir.clone(), cache_dir_v2.clone());

        // Extract layers for v2 (same layer digest for this test, but different cache)
        let extracted_v2 = source_v2
            .extract_layers(std::slice::from_ref(&layer_digest_v1))
            .unwrap();
        assert!(extracted_v2[0].exists());

        // CRITICAL: v2 should use NEW cache location, not v1's stale cache
        assert_ne!(
            extracted_v1[0], extracted_v2[0],
            "Changed content (different manifest) should use NEW cache, not stale v1 cache"
        );

        // Verify v2 cache is under v2's cache_dir
        assert!(extracted_v2[0].starts_with(&cache_dir_v2));

        // Both caches exist independently
        assert!(extracted_v1[0].exists(), "v1 cache should still exist");
        assert!(extracted_v2[0].exists(), "v2 cache should exist separately");
    }
}
