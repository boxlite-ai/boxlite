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

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::blob_source::{BlobSource, LocalBundleBlobSource, StoreBlobSource};
use super::object::ImageObject;
use crate::db::Database;
use crate::images::store::{ImageStore, SharedImageStore};
use crate::runtime::options::ImageRegistry;
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
    /// DiffIDs from image config's `rootfs.diff_ids` (SHA256 of uncompressed layers).
    /// Empty if not available (e.g., config not yet downloaded, or empty in config).
    pub(super) diff_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub(super) struct LayerInfo {
    pub(super) digest: String,
    pub(super) media_type: String,
    /// Expected size from manifest descriptor (bytes).
    /// Values <= 0 mean "unknown" and skip size validation.
    pub(super) size: i64,
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
    /// * `image_registries` - Registry transport, TLS, auth, and search settings
    pub fn new(
        images_dir: PathBuf,
        db: Database,
        image_registries: Vec<ImageRegistry>,
    ) -> BoxliteResult<Self> {
        let store = Arc::new(ImageStore::new(images_dir, db, image_registries)?);
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
        Ok(self.image_object(image_ref, manifest).await)
    }

    /// Resolve an image reference against its registry, even when it is cached.
    ///
    /// The cache is keyed by the ref string, so a tag answers with whatever it
    /// pointed at when this host first pulled it. This asks the registry again
    /// and reuses every layer already stored. When no answer comes back — the
    /// registry cannot be reached, fails on its side, or throttles — the cached
    /// image stands in, so an offline host still starts what it has.
    pub async fn refresh(&self, image_ref: &str) -> BoxliteResult<ImageObject> {
        let manifest = self.store.refresh(image_ref).await?;
        Ok(self.image_object(image_ref, manifest).await)
    }

    #[cfg(test)]
    pub(super) fn store(&self) -> &ImageStore {
        &self.store
    }

    async fn image_object(&self, image_ref: &str, manifest: ImageManifest) -> ImageObject {
        let storage = self.store.storage().await;
        let blob_source = BlobSource::Store(StoreBlobSource::new(storage));
        ImageObject::new(image_ref.to_string(), manifest, blob_source)
    }

    /// List all cached images.
    ///
    /// A pull indexes its build under its own digest as well as the ref it was
    /// pulled by, so a pinned pull can find it. That `repository@<build>` entry
    /// is not a second image: it is listed only when no other entry of the same
    /// repository names the build — a tag, a tag pinned to it, or the index
    /// digest a multi-platform image was pulled by — and then with no tag.
    pub async fn list(&self) -> BoxliteResult<Vec<ImageInfo>> {
        let raw_images = self.store.list().await?;
        let named: HashSet<(String, String)> = raw_images
            .iter()
            .filter_map(|(reference, cached)| {
                let parsed = Reference::from_str(reference).ok()?;
                (!is_build_alias(&parsed, &cached.manifest_digest))
                    .then(|| (repository_of(&parsed), cached.manifest_digest.clone()))
            })
            .collect();

        let mut images = Vec::with_capacity(raw_images.len());
        for (reference, cached) in raw_images {
            let folded = Reference::from_str(&reference).is_ok_and(|parsed| {
                is_build_alias(&parsed, &cached.manifest_digest)
                    && named.contains(&(repository_of(&parsed), cached.manifest_digest.clone()))
            });
            if folded {
                continue;
            }
            // If parsing fails, default to UNIX_EPOCH to signal error
            let cached_at = DateTime::parse_from_rfc3339(&cached.cached_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|e| {
                    tracing::warn!("Invalid cached_at timestamp: {}, using epoch", e);
                    DateTime::<Utc>::from(std::time::SystemTime::UNIX_EPOCH)
                });

            let (repository, tag) = match Reference::from_str(&reference) {
                Ok(r) => {
                    let tag = match (r.tag(), r.digest()) {
                        (Some(tag), _) => tag,
                        (None, Some(_)) => "<none>",
                        (None, None) => "latest",
                    };
                    (r.repository().to_string(), tag.to_string())
                }
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

/// Whether `reference` is the entry a pull writes under its own build's
/// digest: no tag, and pinned to exactly `build`.
fn is_build_alias(reference: &Reference, build: &str) -> bool {
    reference.tag().is_none() && reference.digest() == Some(build)
}

fn repository_of(reference: &Reference) -> String {
    format!("{}/{}", reference.registry(), reference.repository())
}

#[cfg(test)]
mod tests {
    use super::ImageManager;
    use crate::db::Database;
    use crate::images::store::tests::seed_cached_build;

    const FIRST: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0";
    const NEWER: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1";

    /// A pulled tag and the digest entry its pull wrote are one image; a build
    /// no tag names still takes disk, so it is listed, with no tag.
    #[tokio::test]
    async fn a_pulled_tag_is_listed_once() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.db")).unwrap();
        let images = ImageManager::new(dir.path().join("images"), db, vec![]).unwrap();
        seed_cached_build(images.store(), "quay.io/acme/app:v1", FIRST).await;
        seed_cached_build(images.store(), &format!("quay.io/acme/app@{FIRST}"), FIRST).await;
        seed_cached_build(images.store(), &format!("quay.io/acme/app@{NEWER}"), NEWER).await;

        let listed = images.list().await.unwrap();
        let rows: Vec<(&str, &str)> = listed
            .iter()
            .map(|image| (image.tag.as_str(), image.id.as_str()))
            .collect();

        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows.contains(&("v1", FIRST)), "{rows:?}");
        assert!(rows.contains(&("<none>", NEWER)), "{rows:?}");
    }

    /// A multi-platform image pulled by its index digest names one build twice:
    /// by the index the caller asked for and by the platform manifest it
    /// resolved to. Listed once, under what the caller pulled.
    #[tokio::test]
    async fn an_image_pulled_by_its_index_digest_is_listed_once() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.db")).unwrap();
        let images = ImageManager::new(dir.path().join("images"), db, vec![]).unwrap();
        let index = format!("sha256:{}", "a".repeat(64));
        let pulled = format!("quay.io/acme/app@{index}");
        seed_cached_build(images.store(), &pulled, FIRST).await;
        seed_cached_build(images.store(), &format!("quay.io/acme/app@{FIRST}"), FIRST).await;

        let listed = images.list().await.unwrap();
        let rows: Vec<&str> = listed
            .iter()
            .map(|image| image.reference.as_str())
            .collect();

        assert_eq!(rows, vec![pulled.as_str()]);
    }

    async fn listed(seeds: &[(&str, &str)]) -> Vec<String> {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.db")).unwrap();
        let images = ImageManager::new(dir.path().join("images"), db, vec![]).unwrap();
        for (reference, build) in seeds {
            seed_cached_build(images.store(), reference, build).await;
        }
        let mut rows: Vec<String> = images
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|image| image.reference)
            .collect();
        rows.sort();
        rows
    }

    /// Pinned as `name:tag@digest`, a pull keys its build by that ref and by
    /// the bare digest; the second is the alias.
    #[tokio::test]
    async fn a_tag_pinned_to_a_digest_is_listed_once() {
        let pinned = format!("quay.io/acme/app:v1@{FIRST}");
        let rows = listed(&[
            (&pinned, FIRST),
            (&format!("quay.io/acme/app@{FIRST}"), FIRST),
        ])
        .await;

        assert_eq!(rows, vec![pinned]);
    }

    /// Mirrors share digests. A build another repository names does not hide
    /// the one a caller pulled from here.
    #[tokio::test]
    async fn the_same_build_in_another_repository_is_listed_there_too() {
        let index = format!("sha256:{}", "a".repeat(64));
        let hub = format!("docker.io/library/alpine@{index}");
        let ecr = format!("public.ecr.aws/docker/library/alpine@{FIRST}");
        let rows = listed(&[
            (&hub, FIRST),
            (&format!("docker.io/library/alpine@{FIRST}"), FIRST),
            (&ecr, FIRST),
        ])
        .await;

        assert_eq!(rows, vec![hub, ecr]);
    }

    /// Only the alias is folded away: an index digest the caller pulled stays
    /// listed beside the tag that names the same build.
    #[tokio::test]
    async fn an_index_digest_the_caller_pulled_is_listed_beside_its_tag() {
        let index = format!("sha256:{}", "a".repeat(64));
        let pulled = format!("quay.io/acme/app@{index}");
        let rows = listed(&[
            ("quay.io/acme/app:v1", FIRST),
            (&pulled, FIRST),
            (&format!("quay.io/acme/app@{FIRST}"), FIRST),
        ])
        .await;

        assert_eq!(rows, vec!["quay.io/acme/app:v1".to_string(), pulled]);
    }
}
