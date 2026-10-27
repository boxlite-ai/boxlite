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
use crate::images::image_registry_proxy;
use crate::images::manager::{ImageManifest, LayerInfo};
use crate::images::storage::ImageStorage;
use crate::images::system_trust;
use crate::runtime::options::{
    ImageRegistry, ImageRegistryAuth, ImageRegistryProxy, RegistryTransport,
};
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
/// let store = Arc::new(ImageStore::new(images_dir, db, vec![], None)?);
///
/// // Pull image (thread-safe, releases lock during download)
/// let manifest = store.pull("python:alpine").await?;
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
    /// Proxy for every registry request; `None` leaves it to the environment.
    image_registry_proxy: Option<ImageRegistryProxy>,
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
    /// * `image_registry_proxy` - Proxy for registry requests, already validated;
    ///   `None` leaves proxying to the environment
    pub fn new(
        images_dir: PathBuf,
        db: Database,
        image_registries: Vec<ImageRegistry>,
        image_registry_proxy: Option<ImageRegistryProxy>,
    ) -> BoxliteResult<Self> {
        validate_image_registries(&image_registries)?;

        let inner = ImageStoreInner::new(images_dir, db)?;
        let registries = search_registries(&image_registries);
        Ok(Self {
            inner: RwLock::new(inner),
            registries,
            image_registries,
            image_registry_proxy,
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
        self.resolve(image_ref, CacheUse::First).await
    }

    /// Resolve an image against its registry even when it is cached, keeping
    /// the cached copy for when the registry gives no answer.
    ///
    /// The cache answers by ref string and never re-checks it, so a tag keeps
    /// resolving to whatever it pointed at when this host first pulled it.
    /// Layers are keyed by their own digests, so asking again downloads only
    /// what changed. The cache stands in only for a registry that did not
    /// answer — see [`RegistryPullError`] — never for one that said the image
    /// is gone or not this caller's to read.
    pub async fn refresh(&self, image_ref: &str) -> BoxliteResult<ImageManifest> {
        self.resolve(image_ref, CacheUse::Fallback).await
    }

    async fn resolve(&self, image_ref: &str, cache: CacheUse) -> BoxliteResult<ImageManifest> {
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
        let mut throttled = false;

        for reference in candidates {
            let ref_str = reference.whole();

            // Fast path: check cache with read lock
            if cache == CacheUse::First {
                let inner = self.inner.read().await;
                let cached = self.try_load_cached(&inner, &ref_str)?;
                drop(inner);
                if let Some(manifest) = cached {
                    tracing::info!("Using cached image: {}", ref_str);
                    return self.serve_cached(&reference, manifest).await;
                }
            }

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
                Err(failure) => {
                    let answered = matches!(failure, RegistryPullError::Failed(_));
                    throttled |= matches!(failure, RegistryPullError::Throttled(_));
                    let e = failure.into_error();
                    if !answered && cache == CacheUse::Fallback {
                        let cached = self.try_load_cached(&*self.inner.read().await, &ref_str)?;
                        if let Some(manifest) = cached {
                            tracing::warn!(
                                reference = %ref_str,
                                error = %e,
                                "Registry gave no answer; using the cached image"
                            );
                            return self.serve_cached(&reference, manifest).await;
                        }
                    }
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

            // A throttled registry says nothing about the image, so the caller
            // is told to wait rather than that the pull failed.
            if throttled {
                return Err(BoxliteError::ResourceExhausted(format!(
                    "image registry rate limit reached pulling '{}'; retry later:\n{}",
                    image_ref,
                    details.join("\n")
                )));
            }

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

    /// Drop every reference `is_match` accepts from the index, all of them or,
    /// on error, none, and return how many went. They are chosen under the
    /// same write lock that drops them, so a reference a pull indexes
    /// meanwhile is either among them or indexed after. Their layers stay in
    /// storage, so pulling one of these builds again reuses them.
    pub async fn forget_matching(&self, is_match: impl Fn(&str) -> bool) -> BoxliteResult<usize> {
        let inner = self.inner.write().await;
        let references: Vec<String> = inner
            .index
            .list_all()?
            .into_iter()
            .map(|(reference, _)| reference)
            .filter(|reference| is_match(reference))
            .collect();
        inner.index.remove_all(&references)?;
        Ok(references.len())
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
    ) -> Result<ImageManifest, RegistryPullError> {
        let client = self.client_for(reference).await?;
        let auth = registry_auth_for(reference.registry(), &self.image_registries);

        // Step 0: Fetch the token first. Left to the manifest request, the
        // client drops a failed token exchange and asks without one, so a token
        // service that is down or throttling reads as a 401 on the image. The
        // token is cached, so the requests below reuse it.
        client
            .auth(reference, &auth, oci_client::RegistryOperation::Pull)
            .await
            .map_err(|e| RegistryPullError::from_token_exchange(e, &auth))?;

        // Step 1: Pull manifest (no lock needed)
        let (manifest, manifest_digest_str) = client
            .pull_manifest(reference, &auth)
            .await
            .map_err(|e| RegistryPullError::from_registry("manifest", e))?;

        // Step 2: Save manifest (quick write lock)
        {
            let inner = self.inner.read().await;
            inner
                .storage
                .save_manifest(&manifest, &manifest_digest_str)?;
        }

        // Step 3: Extract image manifest (may pull platform-specific manifest for multi-platform images)
        let mut image_manifest = self
            .extract_image_manifest(&client, reference, &manifest, manifest_digest_str)
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

        // Step 6: Index it under the ref it was pulled by and the digest it resolved to
        self.record_in_index(reference, &image_manifest).await?;

        Ok(image_manifest)
    }

    /// Index a pulled image under the digest it resolved to and, the first time
    /// this host caches that ref, under the ref as well.
    ///
    /// The digest's entry is what a pinned pull finds: a restart reads its
    /// disk's build by it, and so do curated pins and catalog hits. The ref's
    /// entry keeps the build this host first cached for it, as it always has,
    /// because a box made before builds were recorded restarts by reading it,
    /// and moving it to follow the tag would pair a newer build's config with
    /// that box's disk. A new disk never reads it — a refresh hands its answer
    /// straight back — so nothing needs it to move.
    async fn record_in_index(
        &self,
        reference: &Reference,
        manifest: &ImageManifest,
    ) -> BoxliteResult<()> {
        let by_ref = reference.whole();
        let by_digest = digest_key(reference, manifest);
        if by_digest != by_ref {
            self.update_index(&by_digest, manifest).await?;
            let first = self.try_load_cached(&*self.inner.read().await, &by_ref)?;
            if first.is_some() {
                return Ok(());
            }
        }
        self.update_index(&by_ref, manifest).await
    }

    /// Serve a cached image, making sure its build can be found by digest.
    ///
    /// A pull indexes both keys itself, but a cache written before digests were
    /// indexed holds only the tag. Served from there — offline, say — the tag
    /// reports a digest that a pinned pull (a curated pin, a catalog hit, a
    /// restart) would then miss, and that pull needs the very registry that
    /// just gave no answer.
    async fn serve_cached(
        &self,
        reference: &Reference,
        manifest: ImageManifest,
    ) -> BoxliteResult<ImageManifest> {
        let by_digest = digest_key(reference, &manifest);
        let indexed = self.inner.read().await.index.get(&by_digest)?.is_some();
        if !indexed {
            self.update_index(&by_digest, &manifest).await?;
        }
        Ok(manifest)
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
    ) -> Result<ImageManifest, RegistryPullError> {
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
                self.extract_platform_manifest(client, reference, index)
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
    ) -> Result<ImageManifest, RegistryPullError> {
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
                &registry_auth_for(reference.registry(), &self.image_registries),
            )
            .await
            .map_err(|e| RegistryPullError::from_registry("platform manifest", e))?;

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
            _ => Err(BoxliteError::Storage("platform manifest is not a valid image".into()).into()),
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
    ) -> Result<(), RegistryPullError> {
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
    ) -> Result<(), RegistryPullError> {
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
                        last_error = Some(RegistryPullError::Failed(BoxliteError::Storage(
                            format!("Failed to stage layer {} download: {e}", layer.digest),
                        )));
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
                        last_error = Some(RegistryPullError::Failed(BoxliteError::Storage(
                            "layer integrity verification failed: hash mismatch".to_string(),
                        )));
                    }
                    Err(e) => {
                        tracing::warn!("Layer commit error (attempt {}): {}", attempt, e);
                        last_error = Some(RegistryPullError::Failed(BoxliteError::Storage(
                            format!("layer commit error: {e}"),
                        )));
                    }
                },
                Err(e) => {
                    tracing::warn!("Layer download failed (attempt {}): {}", attempt, e);
                    last_error = Some(RegistryPullError::from_registry(
                        &format!("layer {}", layer.digest),
                        e,
                    ));
                    staged.abort().await;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            RegistryPullError::Failed(BoxliteError::Storage(
                "download failed after retries".to_string(),
            ))
        }))
    }

    async fn download_config(
        &self,
        client: &oci_client::Client,
        reference: &Reference,
        config_digest: &str,
    ) -> Result<(), RegistryPullError> {
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
            return Err(RegistryPullError::from_registry("config", e));
        }

        // Verify and commit (atomic move to final location)
        if !staged.commit().await? {
            return Err(BoxliteError::Storage(format!(
                "Config blob verification failed for {}",
                config_digest
            ))
            .into());
        }

        Ok(())
    }

    /// Build the client for one pull: through the proxy when one is set, and
    /// trusting the system certificate store on top of the bundled roots. It
    /// fails where `Client::new` would log the error and fall back to a default
    /// client without the proxy and TLS settings.
    async fn client_for(&self, reference: &Reference) -> BoxliteResult<oci_client::Client> {
        let host = reference.registry();
        let mut config = client_config_for_registry(host, &self.image_registries);
        image_registry_proxy::apply(self.image_registry_proxy.as_ref(), &mut config);
        // With verification off no root is consulted, so the store is not read.
        if !config.accept_invalid_certificates {
            config.extra_root_certificates = system_trust::root_certificates().await;
        }
        oci_client::Client::try_from(config).map_err(|e| {
            let mut message = e.to_string();
            let mut source = std::error::Error::source(&e);
            while let Some(cause) = source {
                message.push_str(&format!(": {cause}"));
                source = cause.source();
            }
            BoxliteError::Config(format!(
                "failed to create registry client for '{host}': {message}"
            ))
        })
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

/// How long a registry may take to accept a connection, and then to send the
/// next bytes, before the pull gives up on it.
///
/// Without a bound, a registry that drops packets or stalls after connecting
/// blocks a box's first start for as long as the OS keeps the socket, and a
/// refresh never reaches its fallback to the cache. A timeout is a transport
/// failure, so it counts as no answer. The read bound resets on every read, so
/// a large layer that keeps streaming is never cut off. Short under test, so a
/// stalled registry can be exercised without waiting out the real bounds.
#[cfg(not(test))]
const REGISTRY_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
#[cfg(not(test))]
const REGISTRY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
#[cfg(test)]
const REGISTRY_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
#[cfg(test)]
const REGISTRY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

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
        connect_timeout: Some(REGISTRY_CONNECT_TIMEOUT),
        read_timeout: Some(REGISTRY_READ_TIMEOUT),
        ..Default::default()
    }
}

/// The index key a build is found by wherever it was pulled from: its
/// repository pinned to the manifest digest it resolved to.
fn digest_key(reference: &Reference, manifest: &ImageManifest) -> String {
    Reference::with_digest(
        reference.registry().to_string(),
        reference.repository().to_string(),
        manifest.manifest_digest.clone(),
    )
    .whole()
}

/// How much a pull trusts the ref-keyed cache.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CacheUse {
    /// A cached image answers without asking the registry: [`ImageStore::pull`].
    First,
    /// The registry is asked first, and the cached image answers only when the
    /// registry gives no answer: [`ImageStore::refresh`].
    Fallback,
}

/// A registry pull that failed, sorted by whether a cached copy may stand in.
///
/// Only a registry that gave no answer may be covered for. A 401 or a 404 is
/// the registry's answer, and serving the cached build over it would hide that
/// the image is gone or no longer this caller's to read.
#[derive(Debug)]
enum RegistryPullError {
    /// Nothing reached the registry — its host did not resolve, resolved to an
    /// address the pull refuses, or could not be connected to — or it failed on
    /// its side (5xx).
    Unanswered(BoxliteError),
    /// The registry throttled the pull (429). No answer about the image either,
    /// so the cache may stand in; kept apart so that, with nothing cached, the
    /// caller is told to retry later rather than that the pull failed.
    Throttled(BoxliteError),
    /// Anything else, including every answer the registry gave.
    Failed(BoxliteError),
}

impl RegistryPullError {
    /// Sorts a failed request to the registry — for the manifest, a platform
    /// manifest, a layer or the config — by whether the registry answered.
    ///
    /// Every exchange is sorted the same way, not just the first: a registry
    /// that answered the tag and then throttled or failed on the platform
    /// manifest or a layer still gave no answer about the build. Blob requests
    /// report their status through `RequestError`, so its status decides; one
    /// with none never reached the registry.
    fn from_registry(what: &str, error: oci_client::errors::OciDistributionError) -> Self {
        use oci_client::errors::{OciDistributionError, OciErrorCode};

        let status = match &error {
            OciDistributionError::ServerError { code, .. } => Some(*code),
            OciDistributionError::RequestError(e) => e.status().map(|s| s.as_u16()),
            _ => None,
        };
        let throttled = status == Some(429)
            || matches!(&error, OciDistributionError::RegistryError { envelope, .. }
                if envelope.errors.iter().any(|e| e.code == OciErrorCode::Toomanyrequests));
        let unanswered = match &error {
            OciDistributionError::RequestError(_) => status.is_none_or(|code| code >= 500),
            OciDistributionError::ServerError { code, .. } => *code >= 500,
            _ => false,
        };
        let codes = match &error {
            OciDistributionError::RegistryError { envelope, .. } => {
                registry_codes(envelope.errors.iter().map(|e| &e.code))
            }
            // The client keeps no body for a 401, so its status is the code.
            OciDistributionError::UnauthorizedError { .. } => {
                registry_codes([&OciErrorCode::Unauthorized])
            }
            _ => String::new(),
        };
        let error = BoxliteError::Storage(format!("failed to pull {what}{codes}: {error}"));
        if throttled {
            Self::Throttled(error)
        } else if unanswered {
            Self::Unanswered(error)
        } else {
            Self::Failed(error)
        }
    }

    /// Sorts a failed token exchange, which comes before the registry says
    /// anything about the image. The client keeps only the response body, not
    /// its status, so the body decides. `TOOMANYREQUESTS` anywhere in it is a
    /// rate limit, since throttling pages are rarely well-formed. A refusal
    /// needs the error envelope's `UNAUTHORIZED` or `DENIED` code — a page
    /// that merely says "denied" is a proxy's, not the registry's — and is an
    /// answer, as is any refusal of credentials this caller supplied. Anything
    /// else from an anonymous request is a service that did not answer.
    fn from_token_exchange(
        error: oci_client::errors::OciDistributionError,
        auth: &OciRegistryAuth,
    ) -> Self {
        use oci_client::errors::{OciDistributionError, OciEnvelope, OciErrorCode};

        let OciDistributionError::AuthenticationFailure(reason) = &error else {
            return Self::from_registry("a registry token", error);
        };
        let codes: Vec<OciErrorCode> = serde_json::from_str::<OciEnvelope>(reason)
            .map(|envelope| envelope.errors.into_iter().map(|e| e.code).collect())
            .unwrap_or_default();
        let throttled = reason.to_ascii_lowercase().contains("toomanyrequests");
        let refused = codes
            .iter()
            .any(|code| matches!(code, OciErrorCode::Unauthorized | OciErrorCode::Denied));
        let error = BoxliteError::Storage(format!(
            "failed to pull a registry token{}: {error}",
            registry_codes(&codes)
        ));
        if throttled {
            Self::Throttled(error)
        } else if refused || !matches!(auth, OciRegistryAuth::Anonymous) {
            Self::Failed(error)
        } else {
            Self::Unanswered(error)
        }
    }

    fn into_error(self) -> BoxliteError {
        match self {
            Self::Unanswered(error) | Self::Throttled(error) | Self::Failed(error) => error,
        }
    }
}

/// The error codes a registry answered with, as ` [MANIFEST_UNKNOWN]`, or
/// nothing when it sent none.
///
/// The client renders an error by its free-text message alone, which every
/// registry words its own way; the code is what tells an image that is gone
/// from one this caller may not read. It goes into the message because the
/// message is all a runner reports of a failed pull, and the control plane
/// reads the code back from there.
fn registry_codes<'a>(
    codes: impl IntoIterator<Item = &'a oci_client::errors::OciErrorCode>,
) -> String {
    let names: Vec<String> = codes
        .into_iter()
        .filter_map(|code| serde_json::to_value(code).ok())
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect();
    if names.is_empty() {
        String::new()
    } else {
        format!(" [{}]", names.join(", "))
    }
}

impl From<BoxliteError> for RegistryPullError {
    fn from(error: BoxliteError) -> Self {
        Self::Failed(error)
    }
}

impl std::fmt::Display for RegistryPullError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unanswered(error) | Self::Throttled(error) | Self::Failed(error) => error.fmt(f),
        }
    }
}

fn registry_auth_for(host: &str, image_registries: &[ImageRegistry]) -> OciRegistryAuth {
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
pub(super) mod tests {
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
                registry_auth_for(host, &registries),
                expected,
                "host={host}"
            );
        }
    }

    /// The HTTP client must get to make the connection even when the registry
    /// is on loopback and has no explicit runtime configuration.
    #[tokio::test]
    async fn pull_reaches_an_unconfigured_loopback_registry() {
        use std::time::Duration;
        use tokio::io::AsyncReadExt;
        use tokio::time::timeout;

        const CHILD_ENV: &str = "BOXLITE_TEST_LOOPBACK_PULL_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            // Isolate proxy settings without changing another test's environment.
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "images::store::tests::pull_reaches_an_unconfigured_loopback_registry",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .kill_on_drop(true);
            for name in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "NO_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
                "no_proxy",
            ] {
                command.env_remove(name);
            }
            let output = timeout(Duration::from_secs(10), command.output())
                .await
                .expect("isolated pull test must finish")
                .unwrap();
            assert!(
                output.status.success(),
                "isolated pull test failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let image_ref = format!("{}/acme/app:v1", listener.local_addr().unwrap());
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(temp_dir.path().join("images"), db, vec![], None).unwrap();

        let (pull, received) = timeout(Duration::from_secs(5), async {
            tokio::join!(
                store.pull(&image_ref),
                timeout(Duration::from_secs(3), async {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut byte = [0u8; 1];
                    assert_eq!(socket.read(&mut byte).await.unwrap(), 1);
                    // Close during TLS: reaching the server, not a successful
                    // image download, is the behavior this fixture observes.
                }),
            )
        })
        .await
        .expect("pull and listener must finish");
        assert!(
            received.is_ok(),
            "pull must reach the loopback registry; pull result: {pull:?}",
        );
        pull.expect_err("the fixture closes the connection during TLS");
    }

    /// A CA's PEM, and a TLS acceptor presenting a `localhost` certificate it issued.
    fn tls_issued_by_a_private_ca() -> (String, tokio_rustls::TlsAcceptor) {
        use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};

        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::default();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let leaf_key = KeyPair::generate().unwrap();
        let leaf = CertificateParams::new(vec!["localhost".to_string()])
            .unwrap()
            .signed_by(&leaf_key, &ca, &ca_key)
            .unwrap();
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(leaf_key.serialize_der());
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![leaf.der().clone()], key.into())
        .unwrap();
        (ca.pem(), tokio_rustls::TlsAcceptor::from(Arc::new(config)))
    }

    #[tokio::test]
    async fn pull_trusts_a_registry_ca_from_the_system_store() {
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::time::timeout;

        const CHILD_IMAGE_ENV: &str = "BOXLITE_TEST_SYSTEM_TRUST_PULL_IMAGE";
        if let Some(image_ref) = std::env::var_os(CHILD_IMAGE_ENV) {
            let temp_dir = tempfile::tempdir().unwrap();
            let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
            let store = ImageStore::new(temp_dir.path().join("images"), db, vec![], None).unwrap();
            let pulled = timeout(
                Duration::from_secs(5),
                store.pull(image_ref.to_str().unwrap()),
            )
            .await
            .expect("pull must finish");
            pulled.expect_err("the fixture serves no image");
            return;
        }

        let (registry_ca, tls) = tls_issued_by_a_private_ca();
        let (other_ca, _) = tls_issued_by_a_private_ca();
        let ca_dir = tempfile::tempdir().unwrap();
        for (store_holds_registry_ca, ca_pem) in [(true, registry_ca), (false, other_ca)] {
            let ca_file = ca_dir.path().join(format!("{store_holds_registry_ca}.pem"));
            std::fs::write(&ca_file, ca_pem).unwrap();

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let tls = tls.clone();
            // The first request line, which only a completed TLS handshake can carry.
            let server = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.ok()?;
                let mut stream = tls.accept(tcp).await.ok()?;
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n") && stream.read(&mut byte).await.ok()? == 1 {
                    head.push(byte[0]);
                }
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n").await;
                Some(String::from_utf8_lossy(&head).trim_end().to_string())
            });

            // A child process owns the trust store, so no other test sees SSL_CERT_FILE.
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "images::store::tests::pull_trusts_a_registry_ca_from_the_system_store",
                    "--nocapture",
                ])
                .env(CHILD_IMAGE_ENV, format!("localhost:{port}/acme/app:v1"))
                .env("SSL_CERT_FILE", &ca_file)
                .env_remove("SSL_CERT_DIR")
                .kill_on_drop(true);
            for name in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "NO_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
                "no_proxy",
            ] {
                command.env_remove(name);
            }
            let output = timeout(Duration::from_secs(10), command.output())
                .await
                .expect("isolated pull test must finish")
                .unwrap();
            assert!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
                "isolated pull test failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );

            let request = timeout(Duration::from_secs(1), server)
                .await
                .ok()
                .and_then(|joined| joined.unwrap());
            let reached = request
                .as_deref()
                .is_some_and(|line| line.starts_with("GET /v2/"));
            assert_eq!(
                reached, store_holds_registry_ca,
                "store holds the registry CA: {store_holds_registry_ca}; request: {request:?}",
            );
        }
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
        let store = ImageStore::new(images_dir.clone(), db, vec![], None).unwrap();

        // Load from local
        let manifest = store.load_from_local(bundle_dir.clone()).await.unwrap();

        // Verify manifest
        assert_eq!(manifest.layers.len(), 1);
        assert_eq!(manifest.layers[0].digest, layer_digest);
        assert!(!manifest.config_digest.is_empty());
        assert!(!manifest.manifest_digest.is_empty());
    }

    /// Removing an image forgets its tag and its digest alias together. If the
    /// database refuses partway, both must stay: losing only the tag leaves the
    /// image listed with no name a caller would pull it by.
    #[tokio::test]
    async fn forget_matching_keeps_every_reference_when_one_cannot_be_removed() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store =
            ImageStore::new(temp_dir.path().join("images"), db.clone(), vec![], None).unwrap();
        let tag = "quay.io/acme/app:v1".to_string();
        let manifest = seed_cached_image(&store, &tag).await;
        let alias = format!("quay.io/acme/app@{}", manifest.manifest_digest);
        seed_cached_build(&store, &alias, &manifest.manifest_digest).await;
        // Stands in for a delete the database fails, such as on a full disk.
        // The tag is the older entry, so it is dropped second, after the alias.
        db.conn()
            .execute_batch(&format!(
                "CREATE TRIGGER refuse_tag BEFORE DELETE ON image_index \
                 WHEN OLD.reference = '{tag}' BEGIN SELECT RAISE(ABORT, 'refused'); END;"
            ))
            .unwrap();

        let error = store
            .forget_matching(|reference| reference == tag || reference == alias)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("refused"), "{error}");
        let mut held: Vec<String> = store
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|(reference, _)| reference)
            .collect();
        held.sort();
        assert_eq!(held, [tag, alias]);
    }

    /// A tag a pull indexes while a remove of its image waits for the index
    /// goes with the remove: what to drop is chosen once the remove holds the
    /// index, not before it starts waiting.
    ///
    /// This guards the locked remove; it cannot replay the old race. Before
    /// the fix a remove never waited for the index at all, so there was no
    /// moment for the test to wedge a pull into.
    #[tokio::test]
    async fn remove_takes_a_tag_indexed_while_it_waited() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let images =
            crate::images::ImageManager::new(temp_dir.path().join("images"), db, vec![], None)
                .unwrap();
        let store = images.store();
        let manifest = seed_cached_image(store, "quay.io/acme/app:v1").await;

        // A pull part-way through `update_index` holds the read lock.
        let pull = store.inner.read().await;
        let remove = tokio::spawn({
            let images = images.clone();
            async move { images.remove("quay.io/acme/app").await }
        });
        // The lock is fair, so once the remove queues for it no reader gets
        // in; nothing signals that moment, so it is polled.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while store.inner.try_read().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the remove never waited for the index");
        let pulled = CachedImage {
            manifest_digest: manifest.manifest_digest,
            config_digest: manifest.config_digest,
            layers: vec![],
            cached_at: chrono::Utc::now().to_rfc3339(),
            complete: true,
        };
        pull.index.upsert("quay.io/acme/app:v2", &pulled).unwrap();
        drop(pull);

        remove.await.unwrap().unwrap();

        let left: Vec<String> = store
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|(reference, _)| reference)
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    /// Build a cache entry the store will actually accept: the manifest, its
    /// config blob (whose bytes have to hash to the digest the manifest names)
    /// and the layer file, plus the index row that points at them.
    async fn seed_cached_image(store: &ImageStore, image_ref: &str) -> ImageManifest {
        seed_cached_build(
            store,
            image_ref,
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0",
        )
        .await
    }

    /// [`seed_cached_image`] with the manifest digest chosen, so two builds of
    /// one ref can sit in the cache side by side.
    pub(crate) async fn seed_cached_build(
        store: &ImageStore,
        image_ref: &str,
        manifest_digest: &str,
    ) -> ImageManifest {
        use sha2::{Digest, Sha256};

        let config_bytes =
            br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#;
        let config_digest = format!("sha256:{}", hex::encode(Sha256::digest(config_bytes)));
        let layer_digest =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd0".to_string();
        let manifest_digest = manifest_digest.to_string();

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

    /// A registry that answers every request with one status and an empty
    /// body, so a refresh can be shown an answer and a non-answer without a
    /// network. The version probe gets the same status: with no
    /// `WWW-Authenticate` header the client treats it as needing no auth and
    /// goes on to the manifest request, which is the exchange being sorted.
    pub(crate) async fn registry_answering(status: u16) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let _ = socket.read(&mut request).await;
                    let response = format!(
                        "HTTP/1.1 {status} Status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        host
    }

    /// A registry that answers each path in `routes` and 404s the rest, so a
    /// test can let the first exchanges of a pull through and fail a later one.
    /// Every body is sent with its own digest, as a registry would.
    async fn registry_serving(routes: Vec<(String, u16, &'static str, Vec<u8>)>) -> String {
        use sha2::{Digest, Sha256};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = listener.local_addr().unwrap().to_string();
        let routes = std::sync::Arc::new(routes);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut request = [0u8; 8192];
                    let read = socket.read(&mut request).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&request[..read]).to_string();
                    let target = head.split_whitespace().nth(1).unwrap_or_default();
                    let path = target.split('?').next().unwrap_or_default();
                    let (status, content_type, body) = routes
                        .iter()
                        .find(|(route, ..)| route == path)
                        .map(|(_, status, kind, body)| (*status, *kind, body.clone()))
                        .unwrap_or((404, "text/plain", Vec::new()));
                    let digest = hex::encode(Sha256::digest(&body));
                    let response = format!(
                        "HTTP/1.1 {status} Status\r\nContent-Type: {content_type}\r\n\
                         Docker-Content-Digest: sha256:{digest}\r\nContent-Length: {}\r\n\
                         Connection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });
        host
    }

    /// A registry that sends every request to the token service at `realm`, the
    /// way Docker Hub sends it to auth.docker.io, and refuses it without a token.
    async fn registry_behind_a_token_service(realm: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = listener.local_addr().unwrap().to_string();
        let response = format!(
            "HTTP/1.1 401 Unauthorized\r\n\
             WWW-Authenticate: Bearer realm=\"{realm}\",service=\"registry\"\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n"
        );
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let response = response.clone();
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let _ = socket.read(&mut request).await;
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        host
    }

    /// The routes of a registry whose `acme/app:v1` is a multi-platform index,
    /// with the platform manifest this host would pick answered by `status`.
    fn index_whose_platform_manifest_answers(
        status: u16,
    ) -> Vec<(String, u16, &'static str, Vec<u8>)> {
        let (os, architecture) = ImageStore::detect_platform();
        let platform = format!("sha256:{}", "a".repeat(64));
        let index = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [{
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": platform,
                "size": 100,
                "platform": { "os": os, "architecture": architecture },
            }],
        });
        vec![
            ("/v2/".into(), 200, "application/json", b"{}".to_vec()),
            (
                "/v2/acme/app/manifests/v1".into(),
                200,
                "application/vnd.oci.image.index.v1+json",
                index.to_string().into_bytes(),
            ),
            (
                format!("/v2/acme/app/manifests/{platform}"),
                status,
                "application/json",
                Vec::new(),
            ),
        ]
    }

    /// A registry that accepts every connection and never answers — the shape of
    /// a stalled registry or a proxy holding the socket open.
    async fn registry_that_stalls() -> String {
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let _ = socket.read(&mut request).await;
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    drop(socket);
                });
            }
        });
        host
    }

    /// A store whose one registry is `host`, configured so the pull gets past
    /// the address check and reaches the registry, with `app:v1` cached.
    async fn store_with_cached_image(
        temp_dir: &tempfile::TempDir,
        host: &str,
    ) -> (ImageStore, String, ImageManifest) {
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(
            temp_dir.path().join("images"),
            db,
            vec![ImageRegistry::http(host)],
            None,
        )
        .unwrap();
        let image_ref = format!("{host}/acme/app:v1");
        let seeded = seed_cached_image(&store, &image_ref).await;
        (store, image_ref, seeded)
    }

    /// A restart reads its disk's build by the digest it resolved to, whatever
    /// build the tag's entry names, and must find it with no
    /// registry. Recorded through the call a pull makes; the registry refuses
    /// connections, so only the index can answer.
    #[tokio::test]
    async fn a_pull_is_found_again_by_the_digest_it_resolved_to() {
        let temp_dir = tempfile::tempdir().unwrap();
        let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, "127.0.0.1:1").await;
        let reference: Reference = image_ref.parse().unwrap();

        store.record_in_index(&reference, &seeded).await.unwrap();

        let by_digest = store
            .pull(&format!("127.0.0.1:1/acme/app@{}", seeded.manifest_digest))
            .await
            .expect("indexed under its digest, so no registry is needed");
        assert_eq!(by_digest.manifest_digest, seeded.manifest_digest);
    }

    /// A box made before builds were recorded restarts by reading its ref, so a
    /// refresh that brings in a newer build must leave the ref's entry on the
    /// build this host first cached — the one that box's disk was made from.
    #[tokio::test]
    async fn a_newer_build_leaves_the_ref_on_the_first_one_cached() {
        let temp_dir = tempfile::tempdir().unwrap();
        let (store, image_ref, first) = store_with_cached_image(&temp_dir, "127.0.0.1:1").await;
        let newer_digest =
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1";
        let newer = seed_cached_build(&store, "127.0.0.1:1/acme/app:unused", newer_digest).await;
        let reference: Reference = image_ref.parse().unwrap();

        store.record_in_index(&reference, &newer).await.unwrap();

        let by_ref = store
            .pull(&image_ref)
            .await
            .expect("the ref is still cached");
        assert_eq!(by_ref.manifest_digest, first.manifest_digest);
        let by_digest = store
            .pull(&format!("127.0.0.1:1/acme/app@{newer_digest}"))
            .await
            .expect("the newer build is found by its digest");
        assert_eq!(by_digest.manifest_digest, newer_digest);
    }

    /// Offline is the case the fallback exists for: a host that has the image
    /// must still start it. Port 1 refuses the connection, so the registry
    /// gives no answer at all.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_the_registry_cannot_be_reached() {
        let temp_dir = tempfile::tempdir().unwrap();
        let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, "127.0.0.1:1").await;

        let refreshed = store
            .refresh(&image_ref)
            .await
            .expect("an unreachable registry must leave the cached image usable");
        assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
    }

    /// A cache written before digests were indexed holds only the tag. Served
    /// from there while the registry is down, the tag reports a digest that the
    /// next box is pinned to — a curated pin, a catalog hit — and that pull has
    /// to find the build too, with the same registry still silent.
    #[tokio::test]
    async fn a_build_refreshed_from_an_old_cache_is_found_again_by_its_digest() {
        let temp_dir = tempfile::tempdir().unwrap();
        let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, "127.0.0.1:1").await;

        store
            .refresh(&image_ref)
            .await
            .expect("served from the cache");

        let pinned = store
            .pull(&format!("127.0.0.1:1/acme/app@{}", seeded.manifest_digest))
            .await
            .expect("the build it served must be found by its digest without a registry");
        assert_eq!(pinned.manifest_digest, seeded.manifest_digest);
    }

    #[tokio::test]
    async fn a_build_pulled_from_an_old_cache_is_found_again_by_its_digest() {
        let temp_dir = tempfile::tempdir().unwrap();
        let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, "127.0.0.1:1").await;

        store.pull(&image_ref).await.expect("served from the cache");

        let pinned = store
            .pull(&format!("127.0.0.1:1/acme/app@{}", seeded.manifest_digest))
            .await
            .expect("the build it served must be found by its digest without a registry");
        assert_eq!(pinned.manifest_digest, seeded.manifest_digest);
    }

    /// Most public images are multi-platform: the tag answers with an index and
    /// the build is a second request. A registry that answers the first and
    /// fails or throttles the second has still said nothing about the build.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_a_platform_manifest_gets_no_answer() {
        for status in [503, 429] {
            let host = registry_serving(index_whose_platform_manifest_answers(status)).await;
            let temp_dir = tempfile::tempdir().unwrap();
            let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, &host).await;

            let refreshed = store
                .refresh(&image_ref)
                .await
                .unwrap_or_else(|e| panic!("status {status} on the platform manifest: {e}"));
            assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
        }
    }

    #[tokio::test]
    async fn a_throttled_platform_manifest_with_nothing_cached_reports_the_rate_limit() {
        let host = registry_serving(index_whose_platform_manifest_answers(429)).await;
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(
            temp_dir.path().join("images"),
            db,
            vec![ImageRegistry::http(&host)],
            None,
        )
        .unwrap();

        let error = store
            .refresh(&format!("{host}/acme/app:v1"))
            .await
            .expect_err("nothing cached, so a throttled pull cannot succeed");
        assert!(
            matches!(error, BoxliteError::ResourceExhausted(_)),
            "a rate limit must be reported as one, got {error:?}"
        );
    }

    /// Docker Hub hands out tokens from a separate service. When that service
    /// cannot be reached or fails, the registry has said nothing about the
    /// image, and the client would otherwise go on to a 401 that reads as if
    /// the image were private.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_the_token_service_gets_no_answer() {
        let failing = registry_answering(503).await;
        for realm in [
            "http://127.0.0.1:1/token".to_string(),
            format!("http://{failing}/token"),
        ] {
            let host = registry_behind_a_token_service(&realm).await;
            let temp_dir = tempfile::tempdir().unwrap();
            let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, &host).await;

            let refreshed = store
                .refresh(&image_ref)
                .await
                .unwrap_or_else(|e| panic!("token service at {realm}: {e}"));
            assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
        }
    }

    /// A token service that refuses the pull outright — the repository is
    /// private now — has answered, and the cached copy must not stand in for
    /// a build this caller may no longer read. The message names the code, as
    /// a manifest refusal does: it is what tells a refusal from a missing image.
    #[tokio::test]
    async fn refresh_reports_a_refused_token() {
        for (status, code) in [(401, "UNAUTHORIZED"), (403, "DENIED")] {
            let refusal = format!(r#"{{"errors":[{{"code":"{code}","message":"no"}}]}}"#);
            let tokens = registry_serving(vec![(
                "/token".into(),
                status,
                "application/json",
                refusal.into_bytes(),
            )])
            .await;
            let host = registry_behind_a_token_service(&format!("http://{tokens}/token")).await;
            let temp_dir = tempfile::tempdir().unwrap();
            let (store, image_ref, _seeded) = store_with_cached_image(&temp_dir, &host).await;

            let error = store
                .refresh(&image_ref)
                .await
                .expect_err("a refused token is the registry's answer, not a gap");
            assert!(
                !matches!(error, BoxliteError::ResourceExhausted(_))
                    && error
                        .to_string()
                        .contains(&format!("failed to pull a registry token [{code}]: ")),
                "{code}: {error}"
            );
        }
    }

    /// A proxy that answers for the token service with its own error page has
    /// told nothing about the image, even when the page says access is denied.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_a_proxy_answers_for_the_token_service() {
        let tokens = registry_serving(vec![(
            "/token".into(),
            403,
            "text/html",
            b"<html><body>Access denied</body></html>".to_vec(),
        )])
        .await;
        let host = registry_behind_a_token_service(&format!("http://{tokens}/token")).await;
        let temp_dir = tempfile::tempdir().unwrap();
        let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, &host).await;

        let refreshed = store
            .refresh(&image_ref)
            .await
            .expect("a proxy page is not the registry's answer");
        assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
    }

    /// Throttling pages are rarely well-formed envelopes, so a rate limit is
    /// read from the code wherever it appears in the body.
    #[tokio::test]
    async fn a_throttled_token_service_with_nothing_cached_reports_the_rate_limit() {
        for (kind, body) in [
            (
                "application/json",
                br#"{"errors":[{"code":"TOOMANYREQUESTS","message":"rate limited"}]}"#.to_vec(),
            ),
            ("text/plain", b"toomanyrequests: slow down".to_vec()),
        ] {
            assert_throttled_token_service_reports_the_rate_limit(kind, body).await;
        }
    }

    async fn assert_throttled_token_service_reports_the_rate_limit(
        kind: &'static str,
        body: Vec<u8>,
    ) {
        let tokens = registry_serving(vec![("/token".into(), 429, kind, body)]).await;
        let host = registry_behind_a_token_service(&format!("http://{tokens}/token")).await;
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(
            temp_dir.path().join("images"),
            db,
            vec![ImageRegistry::http(&host)],
            None,
        )
        .unwrap();

        let error = store
            .refresh(&format!("{host}/acme/app:v1"))
            .await
            .expect_err("nothing cached, so a throttled pull cannot succeed");
        assert!(
            matches!(error, BoxliteError::ResourceExhausted(_)),
            "a rate limit must be reported as one, got {error:?}"
        );
    }

    /// Docker Hub throttles with a 429 whose body is an error envelope coded
    /// `TOOMANYREQUESTS`, which the client surfaces as a registry error rather
    /// than a bare status. It is still a rate limit.
    #[tokio::test]
    async fn a_rate_limit_envelope_is_reported_as_a_rate_limit() {
        let envelope = br#"{"errors":[{"code":"TOOMANYREQUESTS","message":"You have reached your pull rate limit."}]}"#;
        let host = registry_serving(vec![
            ("/v2/".into(), 200, "application/json", b"{}".to_vec()),
            (
                "/v2/acme/app/manifests/v1".into(),
                429,
                "application/json",
                envelope.to_vec(),
            ),
        ])
        .await;
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(
            temp_dir.path().join("images"),
            db,
            vec![ImageRegistry::http(&host)],
            None,
        )
        .unwrap();

        let error = store
            .refresh(&format!("{host}/acme/app:v1"))
            .await
            .expect_err("nothing cached, so a throttled pull cannot succeed");
        assert!(
            matches!(error, BoxliteError::ResourceExhausted(_)),
            "a rate limit must be reported as one, got {error:?}"
        );
    }

    /// The registry's error code survives into the pull's message, where the
    /// control plane reads it. The free-text message beside it is each
    /// registry's own wording; the code is what says the image is gone, or that
    /// this caller may not read it.
    #[tokio::test]
    async fn a_failed_pull_names_the_code_the_registry_answered_with() {
        for (status, body, code) in [
            (
                404,
                r#"{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}"#,
                "[MANIFEST_UNKNOWN]",
            ),
            (
                404,
                r#"{"errors":[{"code":"NAME_UNKNOWN","message":"repository name not known to registry"}]}"#,
                "[NAME_UNKNOWN]",
            ),
            (
                403,
                r#"{"errors":[{"code":"DENIED","message":"requested access to the resource is denied"}]}"#,
                "[DENIED]",
            ),
            // The client keeps no body for a 401, so the status stands for it.
            (401, "", "[UNAUTHORIZED]"),
        ] {
            let message = manifest_refusal(status, body).await;
            assert!(
                message.contains(&format!("failed to pull manifest {code}: ")),
                "a {status} must name {code}, got {message}"
            );
        }
    }

    /// No envelope, no code. A web server's error page is not the registry
    /// saying the image is unknown, and a code read into a bare status would
    /// report it as gone.
    #[tokio::test]
    async fn a_failed_pull_without_an_error_envelope_names_no_code() {
        let message = manifest_refusal(404, "not found").await;

        assert!(
            message.contains("failed to pull manifest: "),
            "a bare 404 must carry no code, got {message}"
        );
    }

    /// The message a refresh fails with when the registry answers the version
    /// probe and then refuses the manifest with `status` and `body`.
    async fn manifest_refusal(status: u16, body: &'static str) -> String {
        let content_type = if body.starts_with('{') {
            "application/json"
        } else {
            "text/plain"
        };
        let host = registry_serving(vec![
            ("/v2/".into(), 200, "application/json", b"{}".to_vec()),
            (
                "/v2/acme/app/manifests/v1".into(),
                status,
                content_type,
                body.as_bytes().to_vec(),
            ),
        ])
        .await;
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(
            temp_dir.path().join("images"),
            db,
            vec![ImageRegistry::http(&host)],
            None,
        )
        .unwrap();

        store
            .refresh(&format!("{host}/acme/app:v1"))
            .await
            .expect_err("the registry refused the manifest and nothing is cached")
            .to_string()
    }

    /// A tag that moved to a new build is fetched layer by layer. A registry
    /// that fails one of those downloads has not delivered the build, and the
    /// cached one still stands in.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_a_layer_gets_no_answer() {
        let layer = format!("sha256:{}", "b".repeat(64));
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": format!("sha256:{}", "c".repeat(64)),
                "size": 2,
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": layer,
                "size": 10,
            }],
        });
        let host = registry_serving(vec![
            ("/v2/".into(), 200, "application/json", b"{}".to_vec()),
            (
                "/v2/acme/app/manifests/v1".into(),
                200,
                "application/vnd.oci.image.manifest.v1+json",
                manifest.to_string().into_bytes(),
            ),
            (
                format!("/v2/acme/app/blobs/{layer}"),
                503,
                "text/plain",
                Vec::new(),
            ),
        ])
        .await;
        let temp_dir = tempfile::tempdir().unwrap();
        let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, &host).await;

        let refreshed = store
            .refresh(&image_ref)
            .await
            .expect("a layer the registry failed to deliver leaves the cached build usable");
        assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
    }

    /// A refused address has not been contacted, so the registry has said
    /// nothing either: behind a resolver that answers with a proxy's fake
    /// address, a host that has the image must still start it, as it did when
    /// the cache answered first. Unconfigured, so the address check applies;
    /// with nothing cached the same pull is refused, which
    /// `pull_refuses_an_address_inside_the_deployment` pins.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_the_registry_address_is_refused() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(temp_dir.path().join("images"), db, vec![], None).unwrap();
        let image_ref = "127.0.0.1:1/acme/app:v1";
        let seeded = seed_cached_image(&store, image_ref).await;

        let refreshed = store
            .refresh(image_ref)
            .await
            .expect("a refused address contacts nothing, so the cache still answers");
        assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
    }

    /// A registry that holds the connection and never answers has not answered
    /// either. The read bound is what turns it into no answer; without one the
    /// refresh would wait on the socket and the box would never start.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_the_registry_stalls() {
        let temp_dir = tempfile::tempdir().unwrap();
        let host = registry_that_stalls().await;
        let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, &host).await;

        let refreshed = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            store.refresh(&image_ref),
        )
        .await
        .expect("a stalled registry must be given up on, not waited on")
        .expect("a stalled registry must leave the cached image usable");
        assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
    }

    /// A registry that fails on its side or throttles has not said anything
    /// about the image either, so the cached copy is still the best answer.
    #[tokio::test]
    async fn refresh_uses_the_cache_when_the_registry_fails_or_throttles() {
        for status in [503, 500, 429] {
            let temp_dir = tempfile::tempdir().unwrap();
            let host = registry_answering(status).await;
            let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, &host).await;

            let refreshed = store
                .refresh(&image_ref)
                .await
                .unwrap_or_else(|e| panic!("status {status} must fall back to the cache: {e}"));
            assert_eq!(refreshed.manifest_digest, seeded.manifest_digest);
        }
    }

    /// With nothing cached there is nothing to stand in, and a throttled pull
    /// must say so: the caller is told to retry later, as a rate limit, not
    /// that the pull failed. Both calls, since a cached pull that misses goes
    /// to the registry the same way.
    #[tokio::test]
    async fn a_throttled_pull_with_nothing_cached_reports_the_rate_limit() {
        let temp_dir = tempfile::tempdir().unwrap();
        let host = registry_answering(429).await;
        let db = Database::open(&temp_dir.path().join("test.db")).unwrap();
        let store = ImageStore::new(
            temp_dir.path().join("images"),
            db,
            vec![ImageRegistry::http(&host)],
            None,
        )
        .unwrap();
        let image_ref = format!("{host}/acme/app:v1");

        for (call, result) in [
            ("refresh", store.refresh(&image_ref).await),
            ("pull", store.pull(&image_ref).await),
        ] {
            let error = result.expect_err("nothing cached, so a throttled pull cannot succeed");
            assert!(
                matches!(error, BoxliteError::ResourceExhausted(_)),
                "{call}: a rate limit must be reported as one, got {error:?}"
            );
            assert!(error.to_string().contains("retry later"), "{call}: {error}");
        }
    }

    /// The other half, and the reason a refresh asks the registry at all: an
    /// answer — the image is gone, or not this caller's to read — must reach
    /// the caller, not be covered by a build the cache happens to hold. `pull`
    /// on the same store still answers from the cache, which is what shows the
    /// refresh went to the registry first.
    #[tokio::test]
    async fn refresh_reports_what_the_registry_answered() {
        for status in [404, 401] {
            let temp_dir = tempfile::tempdir().unwrap();
            let host = registry_answering(status).await;
            let (store, image_ref, seeded) = store_with_cached_image(&temp_dir, &host).await;

            let cached = store
                .pull(&image_ref)
                .await
                .expect("a complete cache entry answers without a registry");
            assert_eq!(cached.manifest_digest, seeded.manifest_digest);

            store.refresh(&image_ref).await.expect_err(&format!(
                "status {status} is the registry's answer, not a gap"
            ));
        }
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
        let store = ImageStore::new(images_dir.clone(), db, vec![], None).unwrap();

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
        let store = ImageStore::new(images_dir.clone(), db, vec![], None).unwrap();

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
        let store = ImageStore::new(images_dir.clone(), db, vec![], None).unwrap();

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
        ImageStore::new(temp_dir.join("images"), db, vec![], None).unwrap()
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
