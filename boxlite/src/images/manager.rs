//! OCI images management: pulling, caching, and manifest handling.
//!
//! This module provides:
//! - `ImageManager`: Public facade for image operations
//! - `ImageManifest`, `LayerInfo`: Internal types for manifest data
//!
//! Architecture:
//! - `ImageManager` holds `Arc<ImageStore>` (thread-safe store)
//! - `ImageStore` handles all locking internally
//! - `ImageObject` uses `BlobSource` for blob access

use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::blob_source::{BlobSource, LocalBundleBlobSource, StoreBlobSource};
use super::object::ImageObject;
use crate::db::Database;
use crate::images::store::{ImageStore, SharedImageStore};
use crate::runtime::types::ImageInfo;
use boxlite_shared::errors::BoxliteResult;
use oci_client::Reference;
use std::str::FromStr;

// ============================================================================
// INTERNAL TYPES
// ============================================================================

#[derive(Debug, Clone)]
pub(super) struct ImageManifest {
    /// Manifest digest of the final image (platform-specific for multi-platform images)
    pub(super) manifest_digest: String,
    pub(super) layers: Vec<LayerInfo>,
    pub(super) config_digest: String,
}

#[derive(Debug, Clone)]
pub(super) struct LayerInfo {
    pub(super) digest: String,
    pub(super) media_type: String,
}

// ============================================================================
// IMAGE MANAGER (Public Facade)
// ============================================================================

/// Public API for OCI image operations.
///
/// This is a lightweight facade over `Arc<ImageStore>`. It can be cloned
/// cheaply and all clones share the same underlying store.
///
/// Thread Safety: `ImageStore` handles all locking internally. Multiple
/// concurrent pulls are safe and will share downloaded layers.
///
/// # Example
///
/// ```ignore
/// use boxlite::images::ImageManager;
/// use boxlite::db::Database;
/// use std::path::PathBuf;
///
/// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
/// let db = Database::open(&PathBuf::from("/tmp/boxlite.db"))?;
/// let manager = ImageManager::new(PathBuf::from("/tmp/images"), db, vec![])?;
///
/// // Pull an image
/// let image = manager.pull("python:alpine").await?;
///
/// // Access image information
/// println!("Image: {}", image.reference());
/// println!("Layers: {}", image.layer_count());
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct ImageManager {
    store: SharedImageStore,
}

impl std::fmt::Debug for ImageManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageManager").finish()
    }
}

impl ImageManager {
    /// Create a new image manager for the given images directory.
    ///
    /// # Arguments
    /// * `images_dir` - Directory for image cache
    /// * `db` - Database for image index
    /// * `registries` - Registries to search for unqualified images (tried in order)
    pub fn new(images_dir: PathBuf, db: Database, registries: Vec<String>) -> BoxliteResult<Self> {
        let store = Arc::new(ImageStore::new(images_dir, db, registries)?);
        Ok(Self { store })
    }

    /// Pull an OCI image from a registry.
    ///
    /// Checks local cache first. If the image is already cached and complete,
    /// returns immediately without network access. Otherwise pulls from registry.
    ///
    /// Thread Safety: `ImageStore` handles locking internally. Multiple
    /// concurrent pulls of the same image will only download once.
    pub async fn pull(&self, image_ref: &str) -> BoxliteResult<ImageObject> {
        let manifest = self.store.pull(image_ref).await?;
        let storage = self.store.storage().await;
        let blob_source = BlobSource::Store(StoreBlobSource::new(storage));

        Ok(ImageObject::new(
            image_ref.to_string(),
            manifest,
            blob_source,
        ))
    }

    /// List all cached images.
    pub async fn list(&self) -> BoxliteResult<Vec<ImageInfo>> {
        let raw_images = self.store.list().await?;

        let mut images = Vec::with_capacity(raw_images.len());
        for (reference, cached) in raw_images {
            // If parsing fails, default to UNIX_EPOCH to signal error
            let cached_at = DateTime::parse_from_rfc3339(&cached.cached_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    tracing::warn!("Invalid cached_at timestamp: {}, using epoch", e);
                    DateTime::<Utc>::from(std::time::SystemTime::UNIX_EPOCH)
                });

            let (repository, tag) = match Reference::from_str(&reference) {
                Ok(r) => (
                    r.repository().to_string(),
                    r.tag().unwrap_or("latest").to_string(),
                ),
                Err(_) => {
                    // Fallback if reference stored in DB is invalid
                    (reference.clone(), "<none>".to_string())
                }
            };

            images.push(ImageInfo {
                reference,
                repository,
                tag,
                id: cached.manifest_digest,
                cached_at,
                size: None, // Size calculation is expensive now? omitted for list temporarily
            });
        }

        Ok(images)
    }

    /// Load an OCI/Docker image from a local directory.
    ///
    /// Reads image manifest from `manifest.json` and returns an `ImageObject`.
    /// Blobs are read directly from the bundle (not copied to the store).
    ///
    /// Expected structure:
    ///   ```text
    ///   {path}/
    ///     manifest.json     - Docker/OCI manifest with Config and Layers paths
    ///     blobs/sha256/     - Content-addressed blobs
    ///   ```
    ///
    /// # Arguments
    /// * `path` - Path to local image directory
    /// * `reference` - Image reference for display (e.g., "local/redis:latest")
    ///
    /// # Returns
    /// `ImageObject` with access to layers and config
    pub async fn load_from_local(
        &self,
        path: std::path::PathBuf,
        reference: String,
    ) -> BoxliteResult<ImageObject> {
        let manifest = self.store.load_from_local(path.clone()).await?;

        // Let store compute cache dir (layout owns directory structure decisions)
        // Cache dir includes manifest digest for automatic invalidation when bundle changes
        let cache_dir = self
            .store
            .local_bundle_cache_dir(&path, &manifest.manifest_digest)
            .await;
        let blob_source = BlobSource::LocalBundle(LocalBundleBlobSource::new(path, cache_dir));

        Ok(ImageObject::new(reference, manifest, blob_source))
    }
}
