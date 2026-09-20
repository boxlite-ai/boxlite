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
use crate::runtime::options::{ImageRegistry, ImageRegistryAuth, RegistryTransport};
use boxlite_shared::{BoxliteError, BoxliteResult};
use oci_client::Reference;
use oci_client::client::{ClientConfig, ClientProtocol};
use oci_client::manifest::{
    ImageIndexEntry, OciDescriptor, OciImageIndex, OciImageManifest as ClientOciImageManifest,
};
use oci_client::secrets::RegistryAuth as OciRegistryAuth;
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

/// What one pull may do that the runtime it runs on cannot decide for it.
///
/// Not configuration. The registry list and its credentials are built once,
/// when the runtime is, and this changes neither: `anonymous` selects among
/// them and `revalidate` says whether the ref-keyed cache may answer. Both
/// belong to the box being started rather than to the runtime starting it,
/// which is why neither can be settled once.
///
/// Credentials are matched by host, and that is what forces the first one to
/// be per pull: a single runtime serves the operator's own images and a ref a
/// tenant named from the same hosts. Without the split,
/// `ghcr.io/<someone-else>/<private-image>` is fetched with the operator's
/// token and handed to the tenant who named it.
///
/// Which of the two a ref is cannot be decided here, and cannot be decided by
/// host either. It is whether the ref is in the operator's curated set —
/// env-driven, and the control plane's to know — and an operator may point a
/// curated entry at a private package, so a host rule would either strip the
/// credential those need or hand it to every tenant ref on the same host. So
/// the answer arrives with the pull.
///
/// `anonymous` covers credentials only. Which transport to use and whether to
/// skip certificate verification stay keyed by host, because reaching a local
/// insecure registry is about where the bytes come from, not about whose token
/// opens the door.
#[derive(Debug, Clone, Copy, Default)]
pub struct PullPolicy {
    /// Send no credentials, whatever the registry list holds for this host.
    pub anonymous: bool,
    /// Ask the registry even when this ref is already cached.
    ///
    /// The cache is keyed by the ref string, so a moving tag keeps resolving to
    /// whatever it first pointed at. A caller that wants the tag followed — one
    /// that has not yet pinned this ref to a digest — sets this; the pull still
    /// reuses every layer it already has, because layers are keyed by their own
    /// digests.
    pub revalidate: bool,
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
/// let store = Arc::new(ImageStore::new(images_dir, db, vec![])?);
///
/// // Pull image (thread-safe, releases lock during download)
/// let manifest = store.pull("python:alpine", PullPolicy::default()).await?;
///
/// // Create BlobSource for accessing layers
/// let storage = store.storage().await;
/// let blob_source = BlobSource::Store(StoreBlobSource::new(storage));
/// ```
pub struct ImageStore {
    /// Mutable state protected by RwLock
    inner: RwLock<ImageStoreInner>,
    /// Registry host names to search for unqualified image references.
    registries: Vec<String>,
    /// Registry transport, TLS, auth, and search settings.
    image_registries: Vec<ImageRegistry>,
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
    /// * `image_registries` - Registry transport, TLS, auth, and search settings
    pub fn new(
        images_dir: PathBuf,
        db: Database,
        image_registries: Vec<ImageRegistry>,
    ) -> BoxliteResult<Self> {
        validate_image_registries(&image_registries)?;

        let inner = ImageStoreInner::new(images_dir, db)?;
        let registries = search_registries(&image_registries);
        Ok(Self {
            inner: RwLock::new(inner),
            registries,
            image_registries,
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
    pub async fn pull(&self, image_ref: &str, policy: PullPolicy) -> BoxliteResult<ImageManifest> {
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

            // Fast path: check cache with read lock. Skipped when the caller
            // asked for revalidation — the cache answers by ref string, which
            // is the thing being re-checked.
            if !policy.revalidate {
                let inner = self.inner.read().await;
                if let Some(manifest) = self.try_load_cached(&inner, &ref_str)? {
                    tracing::info!("Using cached image: {}", ref_str);
                    return Ok(manifest);
                }
            } // Read lock released

            // Slow path: pull from registry
            tracing::info!("Pulling image from registry: {}", ref_str);
            match self.pull_from_registry(&reference, policy).await {
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
            diff_ids: Vec::new(), // Populated later if config is available
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
                let layers = Self::layers_from_image(img)?;
                let config_digest = img.config.digest.clone();
                (layers, config_digest)
            }
            _ => {
                return Err(BoxliteError::Storage(
                    "cached manifest is not a simple image".into(),
                ));
            }
        };

        // Load diff_ids from config. A cached config that can't be read/parsed
        // errors here rather than yielding empty diff_ids (which would silently
        // skip DiffID verification at extraction time).
        let diff_ids = self.load_diff_ids_from_config(inner, &config_digest)?;

        Ok(ImageManifest {
            manifest_digest: cached.manifest_digest.clone(),
            layers,
            config_digest,
            diff_ids,
        })
    }

    /// Load `rootfs.diff_ids` from the image config on disk.
    ///
    /// Returns the DiffIDs the config declares — possibly an empty list, if the
    /// config genuinely declares none. Returns `Err` when the config blob can't
    /// be read, fails its digest check, or can't be parsed: none of these may be
    /// silently mapped to an empty list, because downstream
    /// `ImageObject::verify_diff_ids` treats an empty list as "nothing to verify"
    /// and would skip DiffID verification entirely — disabling the integrity
    /// check on a config we never actually trusted. Distinguishing "config says
    /// none" from "we couldn't load/trust the config" keeps that decision honest.
    fn load_diff_ids_from_config(
        &self,
        inner: &ImageStoreInner,
        config_digest: &str,
    ) -> BoxliteResult<Vec<String>> {
        use sha2::{Digest, Sha256};

        let config_path = inner.storage.config_path(config_digest);
        let config_bytes = std::fs::read(&config_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to read image config {} for diff_ids: {}",
                config_digest, e
            ))
        })?;

        // The config blob is content-addressed by config_digest, but
        // download_config takes an existence-only fast path and the cache-hit
        // path never re-downloads — so re-verify the bytes here before trusting
        // their DiffIDs. Otherwise a corrupted / tampered cached config could
        // supply attacker-chosen rootfs.diff_ids and defeat layer verification.
        let computed = format!("sha256:{}", hex::encode(Sha256::digest(&config_bytes)));
        if computed != config_digest {
            return Err(BoxliteError::Storage(format!(
                "image config digest mismatch: expected {}, computed {} ({} bytes)",
                config_digest,
                computed,
                config_bytes.len()
            )));
        }

        let image_config: oci_spec::image::ImageConfiguration =
            serde_json::from_slice(&config_bytes).map_err(|e| {
                BoxliteError::Storage(format!(
                    "failed to parse image config {} for diff_ids: {}",
                    config_digest, e
                ))
            })?;

        Ok(image_config
            .rootfs()
            .diff_ids()
            .iter()
            .map(|d| d.to_string())
            .collect())
    }

    // ========================================================================
    // INTERNAL: Registry Operations (releases lock during I/O)
    // ========================================================================

    /// Pull image from registry using a typed Reference.
    ///
    /// This method handles the actual network I/O - manifest pull, layer download, etc.
    /// Lock is released during network I/O to allow other operations.
    async fn pull_from_registry(
        &self,
        reference: &Reference,
        policy: PullPolicy,
    ) -> BoxliteResult<ImageManifest> {
        assert_registry_is_public(reference.registry(), &self.image_registries).await?;

        // The client is still built per host: anonymity is about credentials,
        // not about transport, so an insecure local registry stays reachable.
        let client = self.client_for(reference);
        let auth = registry_auth_for(reference.registry(), &self.image_registries, policy);

        // Step 1: Pull manifest (no lock needed)
        let (manifest, manifest_digest_str) = client
            .pull_manifest(reference, &auth)
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
        let mut image_manifest = self
            .extract_image_manifest(&client, reference, &manifest, manifest_digest_str, policy)
            .await?;

        // Step 4: Download layers (no lock during download, atomic file writes)
        self.download_layers(&client, reference, &image_manifest.layers)
            .await?;

        // Step 5: Download config (no lock during download)
        self.download_config(&client, reference, &image_manifest.config_digest)
            .await?;

        // Step 5b: Parse diff_ids from config for DiffID verification.
        // load_diff_ids_from_config re-verifies the config digest, so a
        // read/digest/parse failure here is a genuine fault and fails the pull.
        {
            let inner = self.inner.read().await;
            image_manifest.diff_ids =
                self.load_diff_ids_from_config(&inner, &image_manifest.config_digest)?;
        }

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
        client: &oci_client::Client,
        reference: &Reference,
        manifest: &oci_client::manifest::OciManifest,
        manifest_digest: String,
        policy: PullPolicy,
    ) -> BoxliteResult<ImageManifest> {
        match manifest {
            oci_client::manifest::OciManifest::Image(img) => {
                let layers = Self::layers_from_image(img)?;
                let config_digest = img.config.digest.clone();
                Ok(ImageManifest {
                    manifest_digest,
                    layers,
                    config_digest,
                    diff_ids: Vec::new(), // Populated after config download
                })
            }
            oci_client::manifest::OciManifest::ImageIndex(index) => {
                self.extract_platform_manifest(client, reference, index, policy)
                    .await
            }
        }
    }

    fn layers_from_image(
        image: &oci_client::manifest::OciImageManifest,
    ) -> BoxliteResult<Vec<LayerInfo>> {
        let mut layers = Vec::with_capacity(image.layers.len());
        for layer in &image.layers {
            // Reject non-distributable / foreign layers (CVE-2020-15157 mitigation)
            if layer.media_type.contains("nondistributable") || layer.media_type.contains("foreign")
            {
                return Err(BoxliteError::Image(format!(
                    "Refusing non-distributable layer {}: media_type={} — \
                     boxlite does not support foreign layer URLs",
                    layer.digest, layer.media_type
                )));
            }
            if layer.urls.as_ref().is_some_and(|urls| !urls.is_empty()) {
                return Err(BoxliteError::Image(format!(
                    "Refusing layer {} with foreign URLs: {:?} — \
                     foreign layer URLs are rejected for security (CVE-2020-15157)",
                    layer.digest, layer.urls
                )));
            }

            layers.push(LayerInfo {
                digest: layer.digest.clone(),
                media_type: layer.media_type.clone(),
                size: layer.size,
            });
        }
        Ok(layers)
    }

    async fn extract_platform_manifest(
        &self,
        client: &oci_client::Client,
        reference: &Reference,
        index: &oci_client::manifest::OciImageIndex,
        policy: PullPolicy,
    ) -> BoxliteResult<ImageManifest> {
        let (platform_os, platform_arch) = Self::detect_platform();

        tracing::debug!(
            "Image index detected, selecting platform: {}/{} (Rust arch: {})",
            platform_os,
            platform_arch,
            std::env::consts::ARCH
        );

        let platform_manifest = self.select_platform_manifest(index, platform_os, platform_arch)?;

        let platform_ref = build_platform_ref(reference, &platform_manifest.digest);
        let platform_reference: Reference = platform_ref
            .parse()
            .map_err(|e| BoxliteError::Storage(format!("invalid platform reference: {e}")))?;

        tracing::info!(
            "Pulling platform-specific manifest: {}",
            platform_manifest.digest
        );
        let (platform_image, platform_digest) = client
            .pull_manifest(
                &platform_reference,
                &registry_auth_for(reference.registry(), &self.image_registries, policy),
            )
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
                let layers = Self::layers_from_image(&img)?;
                let config_digest = img.config.digest.clone();
                Ok(ImageManifest {
                    manifest_digest: platform_digest,
                    layers,
                    config_digest,
                    diff_ids: Vec::new(), // Populated after config download
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
        client: &oci_client::Client,
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
            .map(|layer| self.download_layer(client, reference, layer));

        let results = join_all(download_futures).await;

        for result in results {
            result?;
        }

        Ok(())
    }

    async fn download_layer(
        &self,
        client: &oci_client::Client,
        reference: &Reference,
        layer: &LayerInfo,
    ) -> BoxliteResult<()> {
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
                match inner
                    .storage
                    .stage_layer_download(&layer.digest, layer.size)
                    .await
                {
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
            match client
                .pull_blob(
                    reference,
                    &OciDescriptor {
                        digest: layer.digest.clone(),
                        media_type: layer.media_type.clone(),
                        size: layer.size,
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
        client: &oci_client::Client,
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
        if let Err(e) = client
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

    fn client_for(&self, reference: &Reference) -> oci_client::Client {
        oci_client::Client::new(client_config_for_registry(
            reference.registry(),
            &self.image_registries,
        ))
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
        let layers = Self::layers_from_image(&oci_manifest)?;

        Ok((config_digest_str, layers))
    }
}

fn client_config_for_registry(host: &str, image_registries: &[ImageRegistry]) -> ClientConfig {
    let registry = image_registries
        .iter()
        .find(|registry| registry.host == host);

    let protocol = match registry.map(|registry| &registry.transport) {
        Some(RegistryTransport::Http) => ClientProtocol::Http,
        _ => ClientProtocol::Https,
    };

    ClientConfig {
        protocol,
        accept_invalid_certificates: registry.is_some_and(|registry| registry.skip_verify),
        ..Default::default()
    }
}

/// Refuse a registry that is not out on the public internet.
///
/// The allowlist a tenant's reference passed is by name, and a name can point
/// anywhere: whoever controls DNS for an allowed host can aim the pull at the
/// instance metadata endpoint or at a neighbour's service, and the request
/// leaves from the runner, with the runner's network position.
///
/// A host the operator configured explicitly is exempt. A local registry is
/// loopback by definition, and which addresses this deployment may reach is the
/// operator's decision rather than DNS's — the same stance the control plane
/// takes when it allows an internal address that was put on its list by hand.
///
/// **Two gaps are accepted rather than closed, and both are the same shape.**
///
/// This resolves the name; `oci-client` resolves it again, per connection,
/// through its own stack. A resolver that answers differently the second time
/// — the very attacker named above — is not caught. Refusing a host whose DNS
/// answers consistently private is what this buys, not a guarantee.
///
/// And it covers the initial host only. `oci-client` 0.15 builds its own
/// reqwest client and exposes no hook for a redirect policy, a connector or a
/// DNS resolver, so a registry that answers a blob request with a 302 to
/// anywhere is followed unchecked — reqwest's default is up to ten hops.
///
/// Closing either one means vendoring the client, a hook upstream, or routing
/// pulls through a gateway that is the only address a runner may reach.
async fn assert_registry_is_public(
    host: &str,
    image_registries: &[ImageRegistry],
) -> BoxliteResult<()> {
    if image_registries
        .iter()
        .any(|registry| registry.host == host)
    {
        return Ok(());
    }

    let hostname = registry_hostname(host);

    // A literal is already the answer. Handing it to a resolver would only
    // invite a different one than the address that gets connected to.
    if let Ok(address) = hostname.parse::<std::net::IpAddr>() {
        return refuse_non_public(host, &address);
    }

    // The port is required by `lookup_host` and does not reach the result: only
    // the addresses are read, and they are the same whichever port is asked
    // for.
    let resolved = tokio::net::lookup_host((hostname, 443))
        .await
        .map_err(|e| {
            BoxliteError::Image(format!("failed to resolve registry host '{host}': {e}"))
        })?;

    for address in resolved {
        refuse_non_public(host, &address.ip())?;
    }

    Ok(())
}

fn refuse_non_public(host: &str, address: &std::net::IpAddr) -> BoxliteResult<()> {
    if is_non_public_address(address) {
        return Err(BoxliteError::Image(format!(
            "registry host '{host}' is at {address}, which is not a public registry address"
        )));
    }
    Ok(())
}

/// The host part of `host[:port]`, with an IPv6 literal's brackets removed.
///
/// Written out rather than reached for through `SocketAddr`, which needs a port
/// this caller does not have and rejects the bare literals a registry list may
/// perfectly well hold.
fn registry_hostname(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        // `[::1]` and `[::1]:5000` alike: the literal ends at the bracket.
        return rest.split_once(']').map_or(rest, |(literal, _)| literal);
    }
    match host.split_once(':') {
        // A single unbracketed colon separates a port. More than one means a
        // bare IPv6 literal, which has no port to strip.
        Some((name, rest)) if !rest.contains(':') => name,
        _ => host,
    }
}

/// Addresses a public registry cannot be at: inside a deployment, or not
/// routable on the internet at all.
///
/// The second half is not pedantry — a resolver that answers with benchmarking
/// or reserved space is either broken or redirecting, and either way the
/// connection is not going to the registry the reference named.
fn is_non_public_address(address: &std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                // No stable predicate for these (they exist behind the
                // unstable `ip` feature): this host's own /8, carrier-grade
                // NAT that cloud providers hand out internally, benchmarking
                // space that some local DNS proxies answer with, IETF protocol
                // assignments, and reserved space.
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (18..20).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || a >= 240
        }
        std::net::IpAddr::V6(v6) => {
            // The v6-native answers come first. `to_ipv4` below maps anything
            // whose top 96 bits are zero, which includes `::1` — it would hand
            // back `0.0.0.1` and call loopback public.
            if v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                // Site-local, deprecated but still answered by some resolvers.
                || (v6.segments()[0] & 0xffc0) == 0xfec0
            {
                return true;
            }

            // An IPv4 address in IPv6 clothing is the same address, in each of
            // the shapes it arrives in: mapped, compatible, the NAT64 prefix a
            // DNS64 resolver synthesizes from an A record — `64:ff9b::a9fe:a9fe`
            // is the metadata endpoint — and 6to4.
            if let Some(v4) = v6.to_ipv4() {
                return is_non_public_address(&std::net::IpAddr::V4(v4));
            }
            let segments = v6.segments();
            // The well-known prefix and RFC 8215's local-use one both carry an
            // IPv4 address in the last two groups.
            if segments[0] == 0x0064
                && segments[1] == 0xff9b
                && (segments[2..6] == [0; 4] || segments[2] == 0x0001)
            {
                return is_non_public_address(&std::net::IpAddr::V4(embedded_ipv4(
                    segments[6],
                    segments[7],
                )));
            }
            if segments[0] == 0x2002 {
                // 6to4 carries its IPv4 in the next two groups.
                return is_non_public_address(&std::net::IpAddr::V4(embedded_ipv4(
                    segments[1],
                    segments[2],
                )));
            }
            false
        }
    }
}

fn embedded_ipv4(high: u16, low: u16) -> std::net::Ipv4Addr {
    std::net::Ipv4Addr::new(
        (high >> 8) as u8,
        (high & 0xff) as u8,
        (low >> 8) as u8,
        (low & 0xff) as u8,
    )
}

fn registry_auth_for(
    host: &str,
    image_registries: &[ImageRegistry],
    policy: PullPolicy,
) -> OciRegistryAuth {
    // Decided here rather than at the call sites because a pull resolves a
    // credential in more than one place — the manifest, then the
    // platform-specific manifest of a multi-platform image — and a credential
    // that leaks at the second one leaks just the same. Layer and config
    // downloads reuse whatever this returned, through the client's own auth
    // cache, so they follow without asking again.
    if policy.anonymous {
        return OciRegistryAuth::Anonymous;
    }

    let auth = image_registries
        .iter()
        .find(|registry| registry.host == host)
        .map(|registry| &registry.auth);

    match auth {
        Some(ImageRegistryAuth::Basic { username, password }) => {
            OciRegistryAuth::Basic(username.clone(), password.clone())
        }
        Some(ImageRegistryAuth::Bearer { token }) => OciRegistryAuth::Bearer(token.clone()),
        _ => OciRegistryAuth::Anonymous,
    }
}

fn search_registries(image_registries: &[ImageRegistry]) -> Vec<String> {
    let mut registries = Vec::new();
    for registry in image_registries.iter().filter(|registry| registry.search) {
        if !registries.iter().any(|host| host == &registry.host) {
            registries.push(registry.host.clone());
        }
    }
    registries
}

fn validate_image_registries(image_registries: &[ImageRegistry]) -> BoxliteResult<()> {
    for registry in image_registries {
        let host = registry.host.trim();
        if host.is_empty() {
            return Err(BoxliteError::Config(
                "image registry host cannot be empty".to_string(),
            ));
        }
        if host.contains("://") || host.contains('/') {
            return Err(BoxliteError::Config(format!(
                "image registry host must be host[:port], not a URL: {}",
                registry.host
            )));
        }
    }
    Ok(())
}

// ============================================================================
// SHARED TYPE ALIAS
// ============================================================================

/// Shared reference to ImageStore.
///
/// Used by `ImageManager` and `ImageObject` to share the same store.
pub type SharedImageStore = Arc<ImageStore>;

/// Build the per-platform pull reference from registry+repository only.
///
/// `Reference::whole()` preserves any incoming tag *or* digest, so naively
/// appending `"@{platform_digest}"` produces the invalid double-`@` form
/// `repo@sha256:idx@sha256:plat` for digest-pinned refs (e.g.
/// `ghcr.io/.../base@sha256:...`). The OCI distribution spec accepts at
/// most one tag-or-digest qualifier per reference, so the per-platform
/// ref must be rebuilt from the host+path components.
fn build_platform_ref(reference: &Reference, platform_digest: &str) -> String {
    format!(
        "{}/{}@{}",
        reference.registry(),
        reference.repository(),
        platform_digest
    )
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::path::Path;

    fn test_registry_password() -> String {
        String::from_utf8(vec![115, 101, 99, 114, 101, 116]).unwrap()
    }

    fn test_bearer_token() -> String {
        String::from_utf8(vec![111, 112, 97, 113, 117, 101]).unwrap()
    }

    #[test]
    fn build_platform_ref_collapses_digest_pinned_input_to_single_digest() {
        // Digest-pinned input — previous impl returned
        // `ghcr.io/.../base@sha256:idx@sha256:plat`, which fails to parse.
        let reference: Reference =
            "ghcr.io/boxlite-ai/boxlite-agent-base@sha256:834dcb65465985fc2f648451d76c81d166bc7672391c9064a0a115ce6306c85f"
                .parse()
                .expect("parse digest-pinned input");
        let platform_digest =
            "sha256:abc1230000000000000000000000000000000000000000000000000000000000";

        let platform_ref = build_platform_ref(&reference, platform_digest);

        assert_eq!(
            platform_ref,
            "ghcr.io/boxlite-ai/boxlite-agent-base@sha256:abc1230000000000000000000000000000000000000000000000000000000000",
        );
        // Has exactly one `@` qualifier and round-trips through Reference.
        assert_eq!(platform_ref.matches('@').count(), 1);
        let _: Reference = platform_ref
            .parse()
            .expect("rebuilt platform ref must parse");
    }

    #[test]
    fn build_platform_ref_drops_tag_when_resolving_to_platform_digest() {
        let reference: Reference = "docker.io/library/alpine:3.23"
            .parse()
            .expect("parse tagged input");
        let platform_digest =
            "sha256:def4560000000000000000000000000000000000000000000000000000000000";

        let platform_ref = build_platform_ref(&reference, platform_digest);

        let parsed: Reference = platform_ref
            .parse()
            .expect("rebuilt platform ref must parse");
        assert_eq!(parsed.registry(), "docker.io");
        assert_eq!(parsed.repository(), "library/alpine");
        assert_eq!(parsed.digest(), Some(platform_digest));
        assert_eq!(parsed.tag(), None);
    }

    #[test]
    fn client_config_uses_exact_registry_transport_and_tls_settings() {
        let registries = [
            ImageRegistry::http("registry.local:5000").with_skip_verify(true),
            ImageRegistry::https("registry.example.com").with_skip_verify(true),
        ];
        let cases = [
            ("registry.local:5000", ClientProtocol::Http, true),
            ("registry.example.com", ClientProtocol::Https, true),
            ("docker.io", ClientProtocol::Https, false),
        ];

        for (host, protocol, accept_invalid_certificates) in cases {
            let config = client_config_for_registry(host, &registries);
            assert_eq!(config.protocol, protocol, "host={host}");
            assert_eq!(
                config.accept_invalid_certificates, accept_invalid_certificates,
                "host={host}"
            );
        }
    }

    #[test]
    fn registry_auth_uses_exact_registry_credentials() {
        let password = test_registry_password();
        let token = test_bearer_token();
        let registries = [
            ImageRegistry::https("basic.local").with_basic_auth("alice", password.as_str()),
            ImageRegistry::https("bearer.local").with_bearer_auth(token.as_str()),
            ImageRegistry::https("anonymous.local"),
        ];
        let cases = [
            (
                "basic.local",
                OciRegistryAuth::Basic("alice".to_string(), password),
            ),
            ("bearer.local", OciRegistryAuth::Bearer(token)),
            ("anonymous.local", OciRegistryAuth::Anonymous),
            ("docker.io", OciRegistryAuth::Anonymous),
        ];

        for (host, expected) in cases {
            assert_eq!(
                registry_auth_for(host, &registries, PullPolicy::default()),
                expected,
                "host={host}"
            );
        }
    }

    /// The confused deputy this policy exists for: the registries a runtime
    /// holds credentials for are exactly the ones a tenant would name to have
    /// them spent. Matching by host is what makes the credential reachable, so
    /// the test pins the case where the host does match.
    #[test]
    fn anonymous_pull_sends_no_credential_the_host_would_otherwise_match() {
        let password = test_registry_password();
        let token = test_bearer_token();
        let registries = [
            ImageRegistry::https("ghcr.io").with_basic_auth("operator", password.as_str()),
            ImageRegistry::https("docker.io").with_bearer_auth(token.as_str()),
        ];

        for host in ["ghcr.io", "docker.io"] {
            assert_eq!(
                registry_auth_for(
                    host,
                    &registries,
                    PullPolicy {
                        anonymous: true,
                        ..Default::default()
                    }
                ),
                OciRegistryAuth::Anonymous,
                "host={host}"
            );
        }
    }

    /// The other half: turning anonymity on must not be the only way to get a
    /// pull to work, or the operator's own images stop resolving.
    #[test]
    fn credentialed_pull_still_matches_the_host() {
        let password = test_registry_password();
        let registries =
            [ImageRegistry::https("ghcr.io").with_basic_auth("operator", password.as_str())];

        assert_eq!(
            registry_auth_for(
                "ghcr.io",
                &registries,
                PullPolicy {
                    anonymous: false,
                    ..Default::default()
                }
            ),
            OciRegistryAuth::Basic("operator".to_string(), password),
        );
    }

    /// Anonymity is about credentials only. A local insecure registry has to
    /// stay reachable, and that is decided by a different function keyed by
    /// host — this pins that the two are not the same switch.
    #[test]
    fn anonymous_pull_leaves_transport_and_tls_alone() {
        let registries = [ImageRegistry::http("registry.local:5000")
            .with_skip_verify(true)
            .with_basic_auth("operator", test_registry_password().as_str())];

        let config = client_config_for_registry("registry.local:5000", &registries);

        assert!(matches!(config.protocol, ClientProtocol::Http));
        assert!(config.accept_invalid_certificates);
        assert_eq!(
            registry_auth_for(
                "registry.local:5000",
                &registries,
                PullPolicy {
                    anonymous: true,
                    ..Default::default()
                }
            ),
            OciRegistryAuth::Anonymous,
        );
    }

    /// The class this check exists for: the allowlist upstream is by name, and
    /// a name can be pointed at the metadata endpoint or at a neighbour.
    #[test]
    fn addresses_a_public_registry_cannot_be_at() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "198.18.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "203.0.113.1",
            "0.1.2.3",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            // The same IPv4 address in each of the shapes IPv6 carries it.
            "::ffff:169.254.169.254",
            "::169.254.169.254",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::a9fe:a9fe",
            "2002:a9fe:a9fe::",
        ] {
            assert!(
                is_non_public_address(&address.parse().unwrap()),
                "{address} must be refused"
            );
        }
    }

    /// The other half: a check that refuses everything protects nothing, it
    /// just stops the product working.
    #[test]
    fn public_addresses_stay_reachable() {
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "99.255.255.255",
            "198.20.0.1",
            "192.0.1.1",
            "64:ff9b:2::0101:0101",
            "2606:4700:4700::1111",
            "2002:0101:0101::",
        ] {
            assert!(
                !is_non_public_address(&address.parse().unwrap()),
                "{address} must stay reachable"
            );
        }
    }

    /// A registry host may be a bare name, a name with a port, or an IPv6
    /// literal with or without one. Getting the literal wrong resolves a
    /// different string than the one that gets connected to — which on a
    /// resolver that answers everything is a check that silently passes.
    #[test]
    fn registry_hostname_survives_every_shape_a_host_arrives_in() {
        for (host, expected) in [
            ("ghcr.io", "ghcr.io"),
            ("registry.local:5000", "registry.local"),
            ("[::1]", "::1"),
            ("[::1]:5000", "::1"),
            ("[2606:4700:4700::1111]:443", "2606:4700:4700::1111"),
            ("::1", "::1"),
            ("fd00::1", "fd00::1"),
        ] {
            assert_eq!(registry_hostname(host), expected, "host={host}");
        }
    }

    /// A local registry is loopback by definition. Which addresses this
    /// deployment may reach is the operator's decision, and configuring the
    /// registry is how that decision is expressed.
    #[tokio::test]
    async fn a_configured_registry_is_reachable_even_on_loopback() {
        let registries = [ImageRegistry::http("127.0.0.1:25000")];

        assert_registry_is_public("127.0.0.1:25000", &registries)
            .await
            .expect("an operator-configured registry is not DNS's call");
    }

    /// Literals, so the check answers without a resolver — these must not
    /// depend on what this machine's DNS happens to say.
    #[tokio::test]
    async fn an_unconfigured_internal_address_is_refused() {
        for host in [
            "169.254.169.254",
            "127.0.0.1:5000",
            "[::1]:5000",
            "[fd00::1]",
        ] {
            let error = assert_registry_is_public(host, &[])
                .await
                .expect_err("an address inside the deployment must not be pulled from");

            assert!(
                error.to_string().contains("not a public registry address"),
                "host={host}, unexpected error: {error}"
            );
        }
    }

    /// The check has to be on the pull path, not merely available: a reference
    /// naming an address inside the deployment must not reach the registry
    /// client at all. A literal, so this needs no resolver, and a port nothing
    /// listens on, so removing the guard fails here in milliseconds rather
    /// than hanging on a handshake with whatever answered.
    #[tokio::test]
    async fn pull_refuses_an_address_inside_the_deployment() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(temp_dir.path().join("images"), db, vec![]).unwrap();

        let error = store
            .pull("127.0.0.1:1/acme/app:v1", PullPolicy::default())
            .await
            .expect_err("an address inside the deployment must not be pulled from");

        assert!(
            error.to_string().contains("not a public registry address"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn an_unconfigured_public_address_is_allowed() {
        assert_registry_is_public("1.1.1.1", &[])
            .await
            .expect("a public address is what this check exists to let through");
    }

    #[test]
    fn search_registries_preserves_search_order_and_deduplicates() {
        let registries = search_registries(&[
            ImageRegistry::https("ghcr.io").with_search(true),
            ImageRegistry::https("quay.io"),
            ImageRegistry::http("registry.local:5000").with_search(true),
            ImageRegistry::https("ghcr.io").with_search(true),
        ]);

        assert_eq!(
            registries,
            vec!["ghcr.io".to_string(), "registry.local:5000".to_string()]
        );
    }

    #[test]
    fn validate_image_registries_rejects_invalid_hosts() {
        let invalid = [
            ImageRegistry::https(""),
            ImageRegistry::https("   "),
            ImageRegistry::http("http://registry.local:5000"),
            ImageRegistry::https("registry.local:5000/ns"),
        ];

        for registry in invalid {
            assert!(validate_image_registries(&[registry]).is_err());
        }
    }

    #[test]
    fn validate_image_registries_accepts_host_and_host_port() {
        validate_image_registries(&[
            ImageRegistry::https("docker.io"),
            ImageRegistry::http("registry.local:5000"),
        ])
        .unwrap();
    }

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

    /// Build a cache entry the store will actually accept: the manifest, its
    /// config blob (whose bytes have to hash to the digest the manifest names)
    /// and the layer file, plus the index row that points at them.
    async fn seed_cached_image(store: &ImageStore, image_ref: &str) -> ImageManifest {
        use sha2::{Digest, Sha256};

        let config_bytes =
            br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#;
        let config_digest = format!("sha256:{}", hex::encode(Sha256::digest(config_bytes)));
        let layer_digest =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd0".to_string();
        let manifest_digest =
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0".to_string();

        let storage = store.storage().await;
        for path in [
            storage.config_path(&config_digest),
            storage.layer_tarball_path(&layer_digest),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        }
        std::fs::write(storage.config_path(&config_digest), config_bytes).unwrap();
        std::fs::write(storage.layer_tarball_path(&layer_digest), b"").unwrap();

        let oci = oci_client::manifest::OciImageManifest {
            schema_version: 2,
            media_type: Some("application/vnd.oci.image.manifest.v1+json".to_string()),
            config: oci_client::manifest::OciDescriptor {
                media_type: "application/vnd.oci.image.config.v1+json".to_string(),
                digest: config_digest.clone(),
                size: config_bytes.len() as i64,
                ..Default::default()
            },
            layers: vec![oci_client::manifest::OciDescriptor {
                media_type: "application/vnd.oci.image.layer.v1.tar+gzip".to_string(),
                digest: layer_digest.clone(),
                size: 0,
                ..Default::default()
            }],
            ..Default::default()
        };
        storage
            .save_manifest(
                &oci_client::manifest::OciManifest::Image(oci),
                &manifest_digest,
            )
            .unwrap();

        let manifest = ImageManifest {
            manifest_digest,
            layers: vec![LayerInfo {
                digest: layer_digest,
                media_type: "application/vnd.oci.image.layer.v1.tar+gzip".to_string(),
                size: 0,
            }],
            config_digest,
            diff_ids: vec![],
        };
        store.update_index(image_ref, &manifest).await.unwrap();
        manifest
    }

    /// The cache answers by ref string and never re-checks it, which is the
    /// whole reason a caller may need to ask again. Pinned from both sides with
    /// one cached image and an unreachable registry: without revalidation the
    /// cached manifest comes back and nothing touches the network, with it the
    /// pull has to go out and fails against a port nothing listens on.
    #[tokio::test]
    async fn revalidate_skips_the_ref_keyed_cache() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        // Configured, so the pull gets past the address check and actually
        // tries to connect — which is the thing this test is about. Without it
        // the revalidating pull would be refused as an internal address, which
        // is what the assertion below now catches.
        let store = ImageStore::new(
            temp_dir.path().join("images"),
            db,
            vec![ImageRegistry::http("127.0.0.1:1")],
        )
        .unwrap();

        let image_ref = "127.0.0.1:1/acme/app:v1";
        let seeded = seed_cached_image(&store, image_ref).await;

        let cached = store
            .pull(image_ref, PullPolicy::default())
            .await
            .expect("a complete cache entry answers without a registry");
        assert_eq!(cached.manifest_digest, seeded.manifest_digest);

        let revalidated = store
            .pull(
                image_ref,
                PullPolicy {
                    revalidate: true,
                    ..Default::default()
                },
            )
            .await;
        let error = revalidated.expect_err("revalidation must reach the registry, not the cache");
        assert!(
            !error.to_string().contains("not a public registry address"),
            "this must fail at the connection, not at a guard in front of it: {error}"
        );
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

    // ========================================================================
    // Foreign Layer URL Rejection Tests (Phase 1B)
    // ========================================================================

    #[test]
    fn test_layers_from_image_rejects_nondistributable_media_type() {
        let manifest = ClientOciImageManifest {
            schema_version: 2,
            config: OciDescriptor {
                digest: "sha256:config".into(),
                media_type: "application/vnd.oci.image.config.v1+json".into(),
                size: 100,
                urls: None,
                annotations: None,
            },
            layers: vec![OciDescriptor {
                digest: "sha256:layer1".into(),
                media_type: "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip".into(),
                size: 1000,
                urls: None,
                annotations: None,
            }],
            media_type: None,
            annotations: None,
            artifact_type: None,
            subject: None,
        };

        let result = ImageStore::layers_from_image(&manifest);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("nondistributable"),
            "error should mention nondistributable: {err}"
        );
    }

    #[test]
    fn test_layers_from_image_rejects_foreign_urls() {
        let manifest = ClientOciImageManifest {
            schema_version: 2,
            config: OciDescriptor {
                digest: "sha256:config".into(),
                media_type: "application/vnd.oci.image.config.v1+json".into(),
                size: 100,
                urls: None,
                annotations: None,
            },
            layers: vec![OciDescriptor {
                digest: "sha256:layer1".into(),
                media_type: "application/vnd.oci.image.layer.v1.tar+gzip".into(),
                size: 1000,
                urls: Some(vec!["https://evil.example.com/blob".into()]),
                annotations: None,
            }],
            media_type: None,
            annotations: None,
            artifact_type: None,
            subject: None,
        };

        let result = ImageStore::layers_from_image(&manifest);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("foreign"),
            "error should mention foreign URLs: {err}"
        );
    }

    #[test]
    fn test_layers_from_image_accepts_normal_layers() {
        let manifest = ClientOciImageManifest {
            schema_version: 2,
            config: OciDescriptor {
                digest: "sha256:config".into(),
                media_type: "application/vnd.oci.image.config.v1+json".into(),
                size: 100,
                urls: None,
                annotations: None,
            },
            layers: vec![
                OciDescriptor {
                    digest: "sha256:layer1".into(),
                    media_type: "application/vnd.oci.image.layer.v1.tar+gzip".into(),
                    size: 1000,
                    urls: None,
                    annotations: None,
                },
                OciDescriptor {
                    digest: "sha256:layer2".into(),
                    media_type: "application/vnd.docker.image.rootfs.diff.tar.gzip".into(),
                    size: 2000,
                    urls: None,
                    annotations: None,
                },
            ],
            media_type: None,
            annotations: None,
            artifact_type: None,
            subject: None,
        };

        let result = ImageStore::layers_from_image(&manifest).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].digest, "sha256:layer1");
        assert_eq!(result[0].size, 1000);
        assert_eq!(result[1].digest, "sha256:layer2");
        assert_eq!(result[1].size, 2000);
    }

    #[test]
    fn test_layers_from_image_accepts_empty_urls() {
        let manifest = ClientOciImageManifest {
            schema_version: 2,
            config: OciDescriptor {
                digest: "sha256:config".into(),
                media_type: "application/vnd.oci.image.config.v1+json".into(),
                size: 100,
                urls: None,
                annotations: None,
            },
            layers: vec![OciDescriptor {
                digest: "sha256:layer1".into(),
                media_type: "application/vnd.oci.image.layer.v1.tar+gzip".into(),
                size: 500,
                urls: Some(vec![]), // Empty URLs vec should be OK
                annotations: None,
            }],
            media_type: None,
            annotations: None,
            artifact_type: None,
            subject: None,
        };

        let result = ImageStore::layers_from_image(&manifest).unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_layers_from_image_rejects_docker_foreign_media_type() {
        let manifest = ClientOciImageManifest {
            schema_version: 2,
            config: OciDescriptor {
                digest: "sha256:config".into(),
                media_type: "application/vnd.oci.image.config.v1+json".into(),
                size: 100,
                urls: None,
                annotations: None,
            },
            layers: vec![OciDescriptor {
                digest: "sha256:layer1".into(),
                media_type: "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip".into(),
                size: 1000,
                urls: None,
                annotations: None,
            }],
            media_type: None,
            annotations: None,
            artifact_type: None,
            subject: None,
        };

        let result = ImageStore::layers_from_image(&manifest);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("foreign") || err.contains("nondistributable"),
            "error should indicate rejection: {err}"
        );
    }

    /// A minimal, valid OCI image config JSON declaring the given diff_ids.
    fn image_config_with_diff_ids(diff_ids: &[&str]) -> String {
        let ids = diff_ids
            .iter()
            .map(|d| format!("\"{d}\""))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"{{
                "architecture": "amd64",
                "os": "linux",
                "rootfs": {{ "type": "layers", "diff_ids": [{ids}] }}
            }}"#
        )
    }

    fn store_with_tmp(temp_dir: &Path) -> ImageStore {
        let db = Database::open(&temp_dir.join("test.db")).unwrap();
        ImageStore::new(temp_dir.join("images"), db, vec![]).unwrap()
    }

    /// Store `bytes` as a content-addressed config blob and return the digest
    /// they hash to — mirrors how a real (untampered) config is stored, so
    /// `load_diff_ids_from_config`'s digest check passes.
    fn write_config_blob(inner: &ImageStoreInner, bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let digest = format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
        let path = inner.storage.config_path(&digest);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        digest
    }

    // A config blob whose bytes hash to its digest but aren't valid JSON must
    // surface as an error, not an empty diff_ids list. The old code logged at
    // debug and returned Vec::new(), which downstream `verify_diff_ids` would
    // treat as "nothing to verify" — silently disabling DiffID verification for
    // a config we merely failed to parse. With the fix reverted to
    // `return Vec::new()` this returns Ok(empty) and `expect_err` panics.
    #[tokio::test]
    async fn load_diff_ids_from_config_errors_on_unparseable_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = store_with_tmp(temp_dir.path());

        let inner = store.inner.read().await;
        // Honestly-stored bytes (digest matches) that aren't valid JSON, so the
        // failure is the parse step rather than the digest check.
        let config_digest = write_config_blob(&inner, b"{ not valid json");

        let err = store
            .load_diff_ids_from_config(&inner, &config_digest)
            .expect_err("unparseable config must error, not yield empty diff_ids");
        assert!(
            err.to_string().contains("parse"),
            "error should name the parse failure, got: {err}"
        );
    }

    // A config whose on-disk bytes do NOT hash to the requested digest must be
    // rejected — a corrupted/tampered cache blob must not supply DiffIDs.
    // Without the digest check the valid JSON parses fine and returns Ok, so
    // `expect_err` panics.
    #[tokio::test]
    async fn load_diff_ids_from_config_errors_on_digest_mismatch() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = store_with_tmp(temp_dir.path());
        let wrong_digest =
            "sha256:0000000000000000000000000000000000000000000000000000000000000000";

        let inner = store.inner.read().await;
        // Valid config bytes deliberately stored under a digest they don't hash to.
        let path = inner.storage.config_path(wrong_digest);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            image_config_with_diff_ids(&[
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ]),
        )
        .unwrap();

        let err = store
            .load_diff_ids_from_config(&inner, wrong_digest)
            .expect_err("config whose bytes don't match its digest must be rejected");
        assert!(
            err.to_string().contains("digest mismatch"),
            "error should name the digest mismatch, got: {err}"
        );
    }

    // A missing config blob is likewise a load failure, not "no diff_ids".
    // Reverting the fix makes this return Ok(empty) and `expect_err` panics.
    #[tokio::test]
    async fn load_diff_ids_from_config_errors_on_missing_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = store_with_tmp(temp_dir.path());
        let config_digest =
            "sha256:2222222222222222222222222222222222222222222222222222222222222222";

        let inner = store.inner.read().await;
        let err = store
            .load_diff_ids_from_config(&inner, config_digest)
            .expect_err("missing config must error, not yield empty diff_ids");
        assert!(
            err.to_string().contains("read"),
            "error should name the read failure, got: {err}"
        );
    }

    // The happy path: a valid config's declared diff_ids round-trip back through
    // the digest check + oci_spec parse (the value crosses a real boundary, not
    // built by the test body).
    #[tokio::test]
    async fn load_diff_ids_from_config_returns_declared_diff_ids() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = store_with_tmp(temp_dir.path());
        let want = [
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ];

        let inner = store.inner.read().await;
        let config_digest = write_config_blob(&inner, image_config_with_diff_ids(&want).as_bytes());

        let got = store
            .load_diff_ids_from_config(&inner, &config_digest)
            .unwrap();
        let want: Vec<String> = want.iter().map(|s| s.to_string()).collect();
        assert_eq!(got, want);
    }

    // A config that genuinely declares no DiffIDs parses successfully and yields
    // an empty list — Ok, NOT Err. This is the distinction the fix preserves:
    // "config says none" stays lenient, only "couldn't read/verify/parse" fails.
    #[tokio::test]
    async fn load_diff_ids_from_config_allows_genuinely_empty() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = store_with_tmp(temp_dir.path());

        let inner = store.inner.read().await;
        let config_digest = write_config_blob(&inner, image_config_with_diff_ids(&[]).as_bytes());

        let got = store
            .load_diff_ids_from_config(&inner, &config_digest)
            .unwrap();
        assert!(
            got.is_empty(),
            "genuinely-empty diff_ids must be Ok, got {got:?}"
        );
    }
}
