//! OCI images management: pulling, caching, and manifest handling.
//!
//! This module provides:
//! - `ImageManager`: Public facade for image operations
//! - `ImageManifest`, `LayerInfo`: Internal types for manifest data
//!
//! Architecture:
//! - `ImageManager` holds `Arc<ImageStore>` (thread-safe store)
//! - `ImageStore` handles all locking internally
//! - `ImageObject` also holds `Arc<ImageStore>` for layer access

use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};

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
/// ```no_run
/// use boxlite::images::ImageManager;
/// use boxlite::db::Database;
/// use std::path::PathBuf;
///
/// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
/// let db = Database::open(&PathBuf::from("/tmp/boxlite.db"))?;
/// let manager = ImageManager::new(PathBuf::from("/tmp/images"), db)?;
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

        Ok(ImageObject::new(
            image_ref.to_string(),
            manifest,
            Arc::clone(&self.store),
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
                .unwrap_or_else(|_| DateTime::<Utc>::from(std::time::SystemTime::UNIX_EPOCH));

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
}
