//! Thread-safe OCI image store.
//!
//! This module provides `ImageStore`, a thread-safe facade over image storage
//! that handles locking internally. Users don't need to manage locks.
//!
//! Architecture:
//! - `ImageStoreInner`: Mutable state (index, storage) - no locking awareness
//! - `ImageStore`: Thread-safe wrapper with `RwLock<ImageStoreInner>`
//!
//! Public API (Option C - minimal, noun-ish):
//! - `pull()` - Pull image from registry (or return cached)
//! - `config()` - Load config JSON
//! - `layer_tarball()` - Get layer tarball path
//! - `layer_extracted()` - Get extracted layer path (extracts if needed)

use crate::db::{CachedImage, Database, ImageIndexStore};
use crate::images::manager::{ImageManifest, LayerInfo};
use crate::images::storage::ImageStorage;
use boxlite_shared::{BoxliteError, BoxliteResult};
use oci_client::Reference;
use oci_client::manifest::{
    ImageIndexEntry, OciDescriptor, OciImageIndex, OciImageManifest as ClientOciImageManifest,
};
use oci_client::secrets::RegistryAuth;
use oci_spec::image::MediaType;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

// ============================================================================
// INNER STATE (no locking awareness)
// ============================================================================

/// Mutable state for image operations.
///
/// This struct contains all mutable state but has NO locking - it's wrapped
/// by `ImageStore` which provides thread-safe access.
struct ImageStoreInner {
    index: ImageIndexStore,
    /// Storage is Arc-wrapped so it can be shared with BlobSource
    storage: Arc<ImageStorage>,
}

impl ImageStoreInner {
    fn new(images_dir: PathBuf, db: Database) -> BoxliteResult<Self> {
        let storage = Arc::new(ImageStorage::new(images_dir)?);
        let index = ImageIndexStore::new(db);
        Ok(Self { index, storage })
    }
}

// ============================================================================
// IMAGE STORE (thread-safe facade)
// ============================================================================

/// Thread-safe OCI image store.
///
/// Provides a simple, thread-safe API for image operations. Locking is handled
/// internally - callers don't need to manage locks.
///
/// # Thread Safety
///
/// - `pull()`: Releases lock during network I/O for better concurrency
/// - `storage()`: Returns shared storage for creating `BlobSource`
///
/// # Example
///
/// ```ignore
/// let store = Arc::new(ImageStore::new(images_dir)?);
///
/// // Pull image (thread-safe, releases lock during download)
/// let manifest = store.pull("python:alpine").await?;
///
/// // Create BlobSource for accessing layers
/// let storage = store.storage().await;
/// let blob_source = BlobSource::Store(StoreBlobSource::new(storage));
/// ```
pub struct ImageStore {
    /// OCI registry client (immutable, outside lock)
    client: oci_client::Client,
    /// Mutable state protected by RwLock
    inner: RwLock<ImageStoreInner>,
    /// Registries to search for unqualified image references.
    /// Tried in order; first successful pull wins.
    registries: Vec<String>,
}

impl std::fmt::Debug for ImageStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageStore").finish()
    }
}

impl ImageStore {
    /// Create a new image store for the given images' directory.
    ///
    /// # Arguments
    /// * `images_dir` - Directory for image cache
    /// * `db` - Database for image index
    /// * `registries` - Registries to search for unqualified images (tried in order)
    pub fn new(images_dir: PathBuf, db: Database, registries: Vec<String>) -> BoxliteResult<Self> {
        let inner = ImageStoreInner::new(images_dir, db)?;
        Ok(Self {
            client: oci_client::Client::new(Default::default()),
            inner: RwLock::new(inner),
            registries,
        })
    }

    /// Get shared reference to image storage for BlobSource creation.
    ///
    /// This allows creating `StoreBlobSource` that can outlive the lock.
    pub async fn storage(&self) -> Arc<ImageStorage> {
        Arc::clone(&self.inner.read().await.storage)
    }

    /// Compute cache directory for a local OCI bundle.
    ///
    /// Returns an isolated cache path based on bundle path and manifest digest.
    /// This ensures cache invalidation when bundle content changes.
    pub async fn local_bundle_cache_dir(
        &self,
        bundle_path: &std::path::Path,
        manifest_digest: &str,
    ) -> PathBuf {
        self.inner
            .read()
            .await
            .storage
            .local_bundle_cache_dir(bundle_path, manifest_digest)
    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    /// Pull an image from registry (or return cached manifest).
    ///
    /// This method:
    /// 1. Parses and resolves image reference using configured registries
    /// 2. Checks local cache for each candidate (quick read lock)
    /// 3. If not cached, downloads from registry (releases lock during I/O)
    /// 4. Tries each registry candidate in order until one succeeds
    ///
    /// Thread-safe: Multiple concurrent pulls of the same image will only
    /// download once; others will get the cached result.
    pub async fn pull(&self, image_ref: &str) -> BoxliteResult<ImageManifest> {
        use super::ReferenceIter;

        tracing::debug!(
            image_ref = %image_ref,
            registries = ?self.registries,
            "Starting image pull with registry fallback"
        );

        // Parse image reference and create iterator over registry candidates
        let candidates = ReferenceIter::new(image_ref, &self.registries)
            .map_err(|e| BoxliteError::Storage(format!("invalid image reference: {e}")))?;

        let mut errors: Vec<(String, BoxliteError)> = Vec::new();

        for reference in candidates {
            let ref_str = reference.whole();

            // Fast path: check cache with read lock
            {
                let inner = self.inner.read().await;
                if let Some(manifest) = self.try_load_cached(&inner, &ref_str)? {
                    tracing::info!("Using cached image: {}", ref_str);
                    return Ok(manifest);
                }
            } // Read lock released

            // Slow path: pull from registry
            tracing::info!("Pulling image from registry: {}", ref_str);
            match self.pull_from_registry(&reference).await {
                Ok(manifest) => {
                    if !errors.is_empty() {
                        tracing::info!(
                            original = %image_ref,
                            resolved = %ref_str,
                            "Successfully pulled image after {} attempts",
                            errors.len() + 1
                        );
                    }
                    return Ok(manifest);
                }
                Err(e) => {
                    tracing::debug!(
                        reference = %ref_str,
                        error = %e,
                        "Failed to pull image candidate, trying next"
                    );
                    errors.push((ref_str, e));
                }
            }
        }

        // All candidates failed - format comprehensive error message
        if errors.is_empty() {
            Err(BoxliteError::Storage(format!(
                "No registries configured for image: {}",
                image_ref
            )))
        } else {
            let details: Vec<String> = errors
                .iter()
                .map(|(registry, err)| format!("  - {}: {}", registry, err))
                .collect();

            Err(BoxliteError::Storage(format!(
                "Failed to pull image '{}' after trying {} {}:\n{}",
                image_ref,
                errors.len(),
                if errors.len() == 1 {
                    "registry"
                } else {
                    "registries"
                },
                details.join("\n")
            )))
        }
    }

    /// List all cached images.
    ///
    /// Returns a vector of (reference, CachedImage) tuples ordered by cache time (Newest first).
    pub async fn list(&self) -> BoxliteResult<Vec<(String, CachedImage)>> {
        let inner = self.inner.read().await;
        inner.index.list_all()
    }

    /// Load an OCI image from a local directory.
    ///
    /// Reads OCI layout files (index.json, manifest blob) using oci-spec types
    /// and returns an `ImageManifest`. Layers and configs are imported into the
    /// image store using hard links.
    ///
    /// Expected structure:
    ///   ```text
    ///   {path}/
    ///     oci-layout       - OCI layout specification file
    ///     index.json       - OCI image index (references manifests)
    ///     blobs/sha256/    - Content-addressed blobs
    ///       {manifest_digest}
    ///       {config_digest}
    ///       {layer_digest_1}
    ///       {layer_digest_2}
    ///       ...
    ///   ```
    ///
    /// # Arguments
    /// * `path` - Path to local image directory
    ///
    /// # Returns
    /// `ImageManifest` with layer digests and config digest
    ///
    /// # Errors
    /// - If `path/index.json` or `path/oci-layout` doesn't exist
    /// - If any referenced blob is missing
    /// - If hard linking fails
    pub async fn load_from_local(&self, path: std::path::PathBuf) -> BoxliteResult<ImageManifest> {
        tracing::info!("Loading OCI image from local path: {}", path.display());

        // 1. Validate OCI layout
        let oci_layout_path = path.join("oci-layout");
        if !oci_layout_path.exists() {
            return Err(BoxliteError::Storage(format!(
                "Local image must contain oci-layout file, not found at: {}",
                oci_layout_path.display()
            )));
        }

        // 2. Load and parse index.json using oci_client types
        let index_path = path.join("index.json");
        let index_json = std::fs::read_to_string(&index_path)
            .map_err(|e| BoxliteError::Storage(format!("Failed to read index.json: {}", e)))?;

        let index: OciImageIndex = serde_json::from_str(&index_json)
            .map_err(|e| BoxliteError::Storage(format!("Failed to parse index.json: {}", e)))?;

        // 3. Get first manifest descriptor
        let manifest_desc = index
            .manifests
            .first()
            .ok_or_else(|| BoxliteError::Storage("No manifests found in index.json".into()))?;

        // 4. Resolve to ImageManifest (handles at most one level of ImageIndex)
        let manifest_digest = self.get_image_manifest(&path, manifest_desc)?;

        // 5. Parse ImageManifest to extract config and layers
        let manifest_blob_path = path.join("blobs").join(manifest_digest.replace(':', "/"));

        let (config_digest_str, layers) = self.parse_oci_manifest_from_path(
            &manifest_blob_path,
            &format!("image manifest {}", manifest_digest),
        )?;

        // Note: Blobs are NOT imported to storage. LocalBundleBlobSource reads
        // directly from the bundle path, avoiding duplication.

        tracing::info!(
            "Loaded local OCI image: config={}, {} layers, manifest={}",
            config_digest_str,
            layers.len(),
            manifest_digest
        );

        Ok(ImageManifest {
            manifest_digest: manifest_digest.to_string(),
            layers,
            config_digest: config_digest_str,
        })
    }

    /// Get an ImageManifest digest from the descriptor.
    ///
    /// Handles at most two levels (like containerd):
    /// - index.json → ImageManifest (single platform)
    /// - index.json → ImageIndex → ImageManifest (multi-platform)
    ///
    /// Note: While the OCI image index specification theoretically supports
    /// arbitrary nesting, common implementations like containerd only support
    /// at most one level of indirection.
    ///
    /// # Arguments
    /// * `image_dir` - Base directory containing blobs/
    /// * `descriptor` - Starting descriptor (may point to ImageIndex or ImageManifest)
    ///
    /// # Returns
    /// The digest of the ImageManifest
    fn get_image_manifest(
        &self,
        image_dir: &std::path::Path,
        descriptor: &ImageIndexEntry,
    ) -> BoxliteResult<String> {
        // Check media type using string matching
        let media_type = MediaType::from(descriptor.media_type.as_str());

        match media_type {
            MediaType::ImageIndex => {
                tracing::info!("ImageIndex detected, selecting platform-specific manifest");

                // Load the ImageIndex blob
                let index_blob_path = image_dir
                    .join("blobs")
                    .join(descriptor.digest.replace(':', "/"));

                if !index_blob_path.exists() {
                    return Err(BoxliteError::Storage(format!(
                        "ImageIndex blob not found: {}",
                        index_blob_path.display()
                    )));
                }

                let index_json = std::fs::read_to_string(&index_blob_path).map_err(|e| {
                    BoxliteError::Storage(format!("Failed to read ImageIndex blob: {}", e))
                })?;

                let child_index: OciImageIndex =
                    serde_json::from_str(&index_json).map_err(|e| {
                        BoxliteError::Storage(format!("Failed to parse ImageIndex: {}", e))
                    })?;

                // Detect platform
                let (platform_os, platform_arch) = Self::detect_platform();

                tracing::debug!(
                    "Selecting platform manifest: {}/{} (Rust arch: {})",
                    platform_os,
                    platform_arch,
                    std::env::consts::ARCH
                );

                // Select platform-specific manifest descriptor using unified function
                let platform_manifest =
                    self.select_platform_manifest(&child_index, platform_os, platform_arch)?;

                tracing::info!(
                    "Selected platform-specific manifest: {}",
                    platform_manifest.digest
                );

                // Verify the selected manifest is an ImageManifest (not another ImageIndex)
                let platform_mt = MediaType::from(platform_manifest.media_type.as_str());
                match platform_mt {
                    MediaType::ImageIndex => Err(BoxliteError::Storage(format!(
                        "Nested ImageIndex not supported (platform manifest {} is an ImageIndex, not ImageManifest)",
                        platform_manifest.digest
                    ))),
                    _ => {
                        tracing::debug!("Platform manifest is ImageManifest");
                        Ok(platform_manifest.digest.clone())
                    }
                }
            }
            MediaType::ImageManifest => {
                tracing::debug!(
                    "ImageManifest found, returning digest: {}",
                    descriptor.digest
                );
                Ok(descriptor.digest.clone())
            }
            _ => Err(BoxliteError::Storage(format!(
                "Unsupported media type: {}. Expected ImageManifest or ImageIndex",
                media_type
            ))),
        }
    }

    // ========================================================================
    // INTERNAL: Cache Operations
    // ========================================================================

    /// Try to load image from local cache.
    fn try_load_cached(
        &self,
        inner: &ImageStoreInner,
        image_ref: &str,
    ) -> BoxliteResult<Option<ImageManifest>> {
        // Check if image exists in index
        let cached = match inner.index.get(image_ref)? {
            Some(c) if c.complete => c,
            _ => {
                tracing::debug!("Image not in cache or incomplete: {}", image_ref);
                return Ok(None);
            }
        };

        // Verify all files still exist
        if !self.verify_cached_image(inner, &cached)? {
            tracing::warn!(
                "Cached image files missing, will re-download: {}",
                image_ref
            );
            return Ok(None);
        }

        // Load manifest from disk
        let manifest = self.load_manifest_from_disk(inner, &cached)?;
        Ok(Some(manifest))
    }

    fn verify_cached_image(
        &self,
        inner: &ImageStoreInner,
        cached: &CachedImage,
    ) -> BoxliteResult<bool> {
        if !inner.storage.has_manifest(&cached.manifest_digest) {
            tracing::debug!("Manifest file missing: {}", cached.manifest_digest);
            return Ok(false);
        }

        if !inner.storage.verify_blobs_exist(&cached.layers) {
            tracing::debug!("Some layer files missing");
            return Ok(false);
        }

        if !inner.storage.has_config(&cached.config_digest) {
            tracing::debug!("Config blob missing: {}", cached.config_digest);
            return Ok(false);
        }

        Ok(true)
    }

    fn load_manifest_from_disk(
        &self,
        inner: &ImageStoreInner,
        cached: &CachedImage,
    ) -> BoxliteResult<ImageManifest> {
        let manifest = inner.storage.load_manifest(&cached.manifest_digest)?;

        let (layers, config_digest) = match manifest {
            oci_client::manifest::OciManifest::Image(ref img) => {
                let layers = Self::layers_from_image(img);
                let config_digest = img.config.digest.clone();
                (layers, config_digest)
            }
            _ => {
                return Err(BoxliteError::Storage(
                    "cached manifest is not a simple image".into(),
                ));
            }
        };

        Ok(ImageManifest {
            manifest_digest: cached.manifest_digest.clone(),
            layers,
            config_digest,
        })
    }

    // ========================================================================
    // INTERNAL: Registry Operations (releases lock during I/O)
    // ========================================================================

    /// Pull image from registry using a typed Reference.
    ///
    /// This method handles the actual network I/O - manifest pull, layer download, etc.
    /// Lock is released during network I/O to allow other operations.
    async fn pull_from_registry(&self, reference: &Reference) -> BoxliteResult<ImageManifest> {
        // Step 1: Pull manifest (no lock needed - uses self.client)
        let (manifest, manifest_digest_str) = self
            .client
            .pull_manifest(reference, &RegistryAuth::Anonymous)
            .await
            .map_err(|e| BoxliteError::Storage(format!("failed to pull manifest: {e}")))?;

        // Step 2: Save manifest (quick write lock)
        {
            let inner = self.inner.read().await;
            inner
                .storage
                .save_manifest(&manifest, &manifest_digest_str)?;
        }

        // Step 3: Extract image manifest (may pull platform-specific manifest for multi-platform images)
        let image_manifest = self
            .extract_image_manifest(reference, &manifest, manifest_digest_str)
            .await?;

        // Step 4: Download layers (no lock during download, atomic file writes)
        self.download_layers(reference, &image_manifest.layers)
            .await?;

        // Step 5: Download config (no lock during download)
        self.download_config(reference, &image_manifest.config_digest)
            .await?;

        // Step 6: Update index using reference.whole() as the cache key
        self.update_index(&reference.whole(), &image_manifest)
            .await?;

        Ok(image_manifest)
    }

    /// Update index with newly pulled image.
    async fn update_index(&self, image_ref: &str, manifest: &ImageManifest) -> BoxliteResult<()> {
        let inner = self.inner.read().await;

        let cached_image = CachedImage {
            manifest_digest: manifest.manifest_digest.clone(),
            config_digest: manifest.config_digest.clone(),
            layers: manifest.layers.iter().map(|l| l.digest.clone()).collect(),
            cached_at: chrono::Utc::now().to_rfc3339(),
            complete: true,
        };

        inner.index.upsert(image_ref, &cached_image)?;

        tracing::debug!("Updated index for image: {}", image_ref);
        Ok(())
    }

    // ========================================================================
    // INTERNAL: Manifest Parsing
    // ========================================================================

    async fn extract_image_manifest(
        &self,
        reference: &Reference,
        manifest: &oci_client::manifest::OciManifest,
        manifest_digest: String,
    ) -> BoxliteResult<ImageManifest> {
        match manifest {
            oci_client::manifest::OciManifest::Image(img) => {
                let layers = Self::layers_from_image(img);
                let config_digest = img.config.digest.clone();
                Ok(ImageManifest {
                    manifest_digest,
                    layers,
                    config_digest,
                })
            }
            oci_client::manifest::OciManifest::ImageIndex(index) => {
                self.extract_platform_manifest(reference, index).await
            }
        }
    }

    fn layers_from_image(image: &oci_client::manifest::OciImageManifest) -> Vec<LayerInfo> {
        image
            .layers
            .iter()
            .map(|layer| LayerInfo {
                digest: layer.digest.clone(),
                media_type: layer.media_type.clone(),
            })
            .collect()
    }

    async fn extract_platform_manifest(
        &self,
        reference: &Reference,
        index: &oci_client::manifest::OciImageIndex,
    ) -> BoxliteResult<ImageManifest> {
        let (platform_os, platform_arch) = Self::detect_platform();

        tracing::debug!(
            "Image index detected, selecting platform: {}/{} (Rust arch: {})",
            platform_os,
            platform_arch,
            std::env::consts::ARCH
        );

        let platform_manifest = self.select_platform_manifest(index, platform_os, platform_arch)?;

        let platform_ref = format!("{}@{}", reference.whole(), platform_manifest.digest);
        let platform_reference: Reference = platform_ref
            .parse()
            .map_err(|e| BoxliteError::Storage(format!("invalid platform reference: {e}")))?;

        tracing::info!(
            "Pulling platform-specific manifest: {}",
            platform_manifest.digest
        );
        let (platform_image, platform_digest) = self
            .client
            .pull_manifest(&platform_reference, &RegistryAuth::Anonymous)
            .await
            .map_err(|e| BoxliteError::Storage(format!("failed to pull platform manifest: {e}")))?;

        // Save platform manifest (quick lock)
        {
            let inner = self.inner.read().await;
            inner
                .storage
                .save_manifest(&platform_image, &platform_digest)?;
        }

        match platform_image {
            oci_client::manifest::OciManifest::Image(img) => {
                let layers = Self::layers_from_image(&img);
                let config_digest = img.config.digest.clone();
                Ok(ImageManifest {
                    manifest_digest: platform_digest,
                    layers,
                    config_digest,
                })
            }
            _ => Err(BoxliteError::Storage(
                "platform manifest is not a valid image".into(),
            )),
        }
    }

    fn detect_platform() -> (&'static str, &'static str) {
        let os = "linux";
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "amd64",
            "x86" => "386",
            "arm" => "arm",
            other => other,
        };
        (os, arch)
    }

    fn select_platform_manifest<'b>(
        &self,
        index: &'b oci_client::manifest::OciImageIndex,
        platform_os: &str,
        platform_arch: &str,
    ) -> BoxliteResult<&'b oci_client::manifest::ImageIndexEntry> {
        index
            .manifests
            .iter()
            .find(|m| {
                if let Some(p) = &m.platform {
                    p.os == platform_os && p.architecture == platform_arch
                } else {
                    false
                }
            })
            .ok_or_else(|| {
                let available = index
                    .manifests
                    .iter()
                    .filter_map(|m| {
                        m.platform
                            .as_ref()
                            .map(|p| format!("{}/{}", p.os, p.architecture))
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                BoxliteError::Storage(format!(
                    "no image found for platform {}/{}. Available platforms: {}",
                    platform_os, platform_arch, available
                ))
            })
    }

    // ========================================================================
    // INTERNAL: Layer Download (no lock during I/O)
    // ========================================================================

    async fn download_layers(
        &self,
        reference: &Reference,
        layers: &[LayerInfo],
    ) -> BoxliteResult<()> {
        use futures::future::join_all;

        // Check which layers need downloading (quick read lock)
        let layers_to_download: Vec<_> = {
            let inner = self.inner.read().await;
            let mut to_download = Vec::new();
            for layer in layers {
                if !inner.storage.has_layer(&layer.digest) {
                    to_download.push(layer.clone());
                } else {
                    // Verify cached layer
                    match inner.storage.verify_layer(&layer.digest).await {
                        Ok(true) => {
                            tracing::debug!("Layer tarball cached and verified: {}", layer.digest);
                        }
                        _ => {
                            tracing::warn!(
                                "Cached layer corrupted, will re-download: {}",
                                layer.digest
                            );
                            let _ = std::fs::remove_file(
                                inner.storage.layer_tarball_path(&layer.digest),
                            );
                            to_download.push(layer.clone());
                        }
                    }
                }
            }
            to_download
        }; // Read lock released

        if layers_to_download.is_empty() {
            return Ok(());
        }

        tracing::info!(
            "Downloading {} layers in parallel",
            layers_to_download.len()
        );

        // Download in parallel (no lock held)
        let download_futures = layers_to_download
            .iter()
            .map(|layer| self.download_layer(reference, layer));

        let results = join_all(download_futures).await;

        for result in results {
            result?;
        }

        Ok(())
    }

    async fn download_layer(&self, reference: &Reference, layer: &LayerInfo) -> BoxliteResult<()> {
        const MAX_RETRIES: u32 = 3;

        tracing::info!("Downloading layer: {}", layer.digest);

        let mut last_error = None;

        for attempt in 1..=MAX_RETRIES {
            if attempt > 1 {
                tracing::info!(
                    "Retrying layer download (attempt {}/{}): {}",
                    attempt,
                    MAX_RETRIES,
                    layer.digest
                );
            }

            // Stage download (quick read lock for path computation)
            let mut staged = {
                let inner = self.inner.read().await;
                match inner.storage.stage_layer_download(&layer.digest).await {
                    Ok(result) => result,
                    Err(e) => {
                        last_error = Some(format!(
                            "Failed to stage layer {} download: {e}",
                            layer.digest
                        ));
                        continue;
                    }
                }
            };

            // Download (no lock)
            match self
                .client
                .pull_blob(
                    reference,
                    &OciDescriptor {
                        digest: layer.digest.clone(),
                        media_type: layer.media_type.clone(),
                        size: 0,
                        urls: None,
                        annotations: None,
                    },
                    staged.file(),
                )
                .await
            {
                Ok(_) => match staged.commit().await {
                    Ok(true) => {
                        tracing::info!("Downloaded and verified layer: {}", layer.digest);
                        return Ok(());
                    }
                    Ok(false) => {
                        tracing::warn!(
                            "Layer integrity check failed (attempt {}): hash mismatch for {}",
                            attempt,
                            layer.digest
                        );
                        last_error =
                            Some("layer integrity verification failed: hash mismatch".to_string());
                    }
                    Err(e) => {
                        tracing::warn!("Layer commit error (attempt {}): {}", attempt, e);
                        last_error = Some(format!("layer commit error: {e}"));
                    }
                },
                Err(e) => {
                    tracing::warn!("Layer download failed (attempt {}): {}", attempt, e);
                    last_error = Some(format!("failed to pull layer {}: {e}", layer.digest));
                    staged.abort().await;
                }
            }
        }

        Err(BoxliteError::Storage(last_error.unwrap_or_else(|| {
            "download failed after retries".to_string()
        })))
    }

    async fn download_config(
        &self,
        reference: &Reference,
        config_digest: &str,
    ) -> BoxliteResult<()> {
        // Check if already cached (quick read lock)
        {
            let inner = self.inner.read().await;
            if inner.storage.has_config(config_digest) {
                tracing::debug!("Config blob already cached: {}", config_digest);
                return Ok(());
            }
        }

        tracing::debug!("Downloading config blob: {}", config_digest);

        // Start staged download (quick read lock)
        let mut staged = {
            let inner = self.inner.read().await;
            inner.storage.stage_config_download(config_digest).await?
        };

        // Download to temp file (no lock)
        if let Err(e) = self
            .client
            .pull_blob(
                reference,
                &OciDescriptor {
                    digest: config_digest.to_string(),
                    media_type: "application/vnd.oci.image.config.v1+json".to_string(),
                    size: 0,
                    urls: None,
                    annotations: None,
                },
                staged.file(),
            )
            .await
        {
            staged.abort().await;
            return Err(BoxliteError::Storage(format!("failed to pull config: {e}")));
        }

        // Verify and commit (atomic move to final location)
        if !staged.commit().await? {
            return Err(BoxliteError::Storage(format!(
                "Config blob verification failed for {}",
                config_digest
            )));
        }

        Ok(())
    }

    /// Parse OCI image manifest from file path.
    ///
    /// Reads an OCI ImageManifest from the given path and extracts
    /// config digest and layer information.
    ///
    /// # Arguments
    /// * `manifest_path` - Path to the manifest JSON file
    /// * `context` - Description for error messages (e.g., "platform manifest", "image manifest")
    ///
    /// # Returns
    /// Tuple of (config_digest_string, layers_vector)
    fn parse_oci_manifest_from_path(
        &self,
        manifest_path: &std::path::Path,
        context: &str,
    ) -> BoxliteResult<(String, Vec<LayerInfo>)> {
        let manifest_json = std::fs::read_to_string(manifest_path)
            .map_err(|e| BoxliteError::Storage(format!("Failed to read manifest file: {}", e)))?;

        let oci_manifest: ClientOciImageManifest = serde_json::from_str(&manifest_json)
            .map_err(|e| BoxliteError::Storage(format!("Failed to parse {}: {}", context, e)))?;

        let config_digest_str = oci_manifest.config.digest.clone();

        let layers: Vec<LayerInfo> = oci_manifest
            .layers
            .iter()
            .map(|layer| LayerInfo {
                digest: layer.digest.clone(),
                media_type: layer.media_type.clone(),
            })
            .collect();

        Ok((config_digest_str, layers))
    }
}

// ============================================================================
// SHARED TYPE ALIAS
// ============================================================================

/// Shared reference to ImageStore.
///
/// Used by `ImageManager` and `ImageObject` to share the same store.
pub type SharedImageStore = Arc<ImageStore>;

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::path::Path;

    /// Helper to create a minimal OCI bundle for testing
    fn create_test_oci_bundle(bundle_dir: &Path) -> String {
        use sha2::Digest;

        // Create OCI layout
        std::fs::create_dir_all(bundle_dir.join("blobs/sha256")).unwrap();

        let oci_layout = r#"{"imageLayoutVersion": "1.0.0"}"#;
        std::fs::write(bundle_dir.join("oci-layout"), oci_layout).unwrap();

        // Create a minimal layer tarball with a single file
        let layer_content = create_minimal_tarball();
        let layer_digest = format!(
            "sha256:{}",
            sha2::Sha256::digest(&layer_content)
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
            sha2::Sha256::digest(config_bytes)
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
            sha2::Sha256::digest(manifest_bytes)
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

        layer_digest
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

    #[tokio::test]
    async fn test_load_from_local_basic() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let images_dir = temp_dir.path().join("images");
        let db_path = temp_dir.path().join("test.db");

        // Create test bundle
        let layer_digest = create_test_oci_bundle(&bundle_dir);

        // Create store
        let db = Database::open(&db_path).unwrap();
        let store = ImageStore::new(images_dir.clone(), db, vec![]).unwrap();

        // Load from local
        let manifest = store.load_from_local(bundle_dir.clone()).await.unwrap();

        // Verify manifest
        assert_eq!(manifest.layers.len(), 1);
        assert_eq!(manifest.layers[0].digest, layer_digest);
        assert!(!manifest.config_digest.is_empty());
        assert!(!manifest.manifest_digest.is_empty());
    }

    #[tokio::test]
    async fn test_load_from_local_no_blob_import() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let images_dir = temp_dir.path().join("images");
        let db_path = temp_dir.path().join("test.db");

        // Create test bundle
        let layer_digest = create_test_oci_bundle(&bundle_dir);

        // Create store
        let db = Database::open(&db_path).unwrap();
        let store = ImageStore::new(images_dir.clone(), db, vec![]).unwrap();

        // Load from local
        let _manifest = store.load_from_local(bundle_dir.clone()).await.unwrap();

        // Verify blobs were NOT imported to storage
        // (This is the key behavior change - LocalBundleBlobSource reads from bundle)
        let layer_path = images_dir
            .join("layers")
            .join(format!("{}.tar.gz", layer_digest.replace(':', "-")));
        assert!(
            !layer_path.exists(),
            "Layer should NOT be imported to storage"
        );

        // The original bundle should still have the layer
        let bundle_layer_path = bundle_dir
            .join("blobs")
            .join(layer_digest.replace(':', "/"));
        assert!(bundle_layer_path.exists(), "Bundle should still have layer");
    }

    #[tokio::test]
    async fn test_load_from_local_missing_oci_layout() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let images_dir = temp_dir.path().join("images");
        let db_path = temp_dir.path().join("test.db");

        // Create incomplete bundle (missing oci-layout)
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(bundle_dir.join("index.json"), "{}").unwrap();

        // Create store
        let db = Database::open(&db_path).unwrap();
        let store = ImageStore::new(images_dir.clone(), db, vec![]).unwrap();

        // Load should fail
        let result = store.load_from_local(bundle_dir).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("oci-layout"));
    }

    #[tokio::test]
    async fn test_load_from_local_missing_index() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle_dir = temp_dir.path().join("bundle");
        let images_dir = temp_dir.path().join("images");
        let db_path = temp_dir.path().join("test.db");

        // Create incomplete bundle (missing index.json)
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(
            bundle_dir.join("oci-layout"),
            r#"{"imageLayoutVersion": "1.0.0"}"#,
        )
        .unwrap();

        // Create store
        let db = Database::open(&db_path).unwrap();
        let store = ImageStore::new(images_dir.clone(), db, vec![]).unwrap();

        // Load should fail
        let result = store.load_from_local(bundle_dir).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("index.json"));
    }
}
