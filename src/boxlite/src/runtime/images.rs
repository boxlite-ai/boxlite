//! Image operations handle
//!
//! Provides `ImageHandle` for performing image-related operations like pulling
//! and listing images. This abstraction separates image management from runtime
//! management, following the same pattern as `LiteBox` for box operations.

use async_trait::async_trait;
use std::sync::Arc;

use crate::BoxliteResult;
use crate::images::ImageObject;
use crate::runtime::types::ImageInfo;

/// Internal trait for image management.
///
/// Implemented by runtime backends that support image operations.
/// Currently only `LocalRuntime` implements this trait; REST runtime does not.
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait ImageBackend: Send + Sync {
    /// Pull an image from a registry.
    async fn pull_image(&self, image_ref: &str) -> BoxliteResult<ImageObject>;

    /// List all locally cached images.
    async fn list_images(&self) -> BoxliteResult<Vec<ImageInfo>>;

    /// Remove one image name, or the ext4 behind it when it is the last name.
    async fn remove_image(&self, image_ref: &str, force: bool) -> BoxliteResult<()>;

    /// Remove one ext4 by `disk_key` when no image name and no disk root use it.
    async fn remove_image_disk(&self, disk_key: &str) -> BoxliteResult<()>;

    /// Remove ext4 files that no image name and no disk root use.
    async fn remove_unused_images(&self) -> BoxliteResult<()>;
}

/// Handle for performing image operations.
///
/// Obtained via `BoxliteRuntime::images()`. Provides methods for pulling
/// and listing images.
///
/// # Examples
///
/// ```ignore
/// use boxlite::{Boxlite, Options};
///
/// #[tokio::main]
/// async fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let runtime = Boxlite::new(Options::default())?;
///     let images = runtime.images()?;
///
///     // Pull an image
///     let image = images.pull("alpine:latest").await?;
///     println!("Pulled: {}", image.reference());
///
///     // List all images
///     let all_images = images.list().await?;
///     println!("Total images: {}", all_images.len());
///
///     Ok(())
/// }
/// ```
#[derive(Clone)]
pub struct ImageHandle {
    manager: Arc<dyn ImageBackend>,
}

impl ImageHandle {
    /// Create a new ImageHandle with the given manager.
    ///
    /// This is an internal constructor used by `BoxliteRuntime`.
    pub(crate) fn new(manager: Arc<dyn ImageBackend>) -> Self {
        Self { manager }
    }

    /// Pull an image from a registry.
    ///
    /// Downloads the image layers and stores them in the local image cache.
    /// Returns an ImageObject handle for the pulled image.
    ///
    /// # Example
    ///
    /// ```ignore
    /// # use boxlite::{Boxlite, Options};
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// # let runtime = Boxlite::new(Options::default())?;
    /// let images = runtime.images()?;
    /// let image = images.pull("alpine:latest").await?;
    /// println!("Image digest: {}", image.config_digest());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn pull(&self, image_ref: &str) -> BoxliteResult<ImageObject> {
        self.manager.pull_image(image_ref).await
    }

    /// List all locally cached images.
    ///
    /// Returns metadata for all images stored in the local cache.
    ///
    /// # Example
    ///
    /// ```ignore
    /// # use boxlite::{Boxlite, Options};
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// # let runtime = Boxlite::new(Options::default())?;
    /// let images = runtime.images()?;
    /// let all_images = images.list().await?;
    /// for image in all_images {
    ///     println!("{}: {}", image.reference, image.id);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn list(&self) -> BoxliteResult<Vec<ImageInfo>> {
        self.manager.list_images().await
    }

    /// Remove an image name. `--force` does not override a `disk.root` reference.
    /// A live build is left running unless this is the last name and `force` is set.
    pub async fn remove(&self, image_ref: &str, force: bool) -> BoxliteResult<()> {
        self.manager.remove_image(image_ref, force).await
    }

    /// Remove one shared ext4 by its `disk_key`.
    pub async fn remove_disk(&self, disk_key: &str) -> BoxliteResult<()> {
        self.manager.remove_image_disk(disk_key).await
    }

    /// Remove shared ext4 files with no image name and no disk root.
    pub async fn remove_unused(&self) -> BoxliteResult<()> {
        self.manager.remove_unused_images().await
    }
}
