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
#[async_trait]
pub(crate) trait ImageManager: Send + Sync {
    /// Pull an image from a registry.
    async fn pull_image(&self, image_ref: &str) -> BoxliteResult<ImageObject>;

    /// List all locally cached images.
    async fn list_images(&self) -> BoxliteResult<Vec<ImageInfo>>;
}

/// Handle for performing image operations.
///
/// Obtained via `BoxliteRuntime::images()`. Provides methods for pulling
/// and listing images.
///
/// # Examples
///
/// ```no_run
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
pub struct ImageHandle {
    manager: Arc<dyn ImageManager>,
}

impl ImageHandle {
    /// Create a new ImageHandle with the given manager.
    ///
    /// This is an internal constructor used by `BoxliteRuntime`.
    pub(crate) fn new(manager: Arc<dyn ImageManager>) -> Self {
        Self { manager }
    }

    /// Pull an image from a registry.
    ///
    /// Downloads the image layers and stores them in the local image cache.
    /// Returns an ImageObject handle for the pulled image.
    ///
    /// # Example
    ///
    /// ```no_run
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
    /// ```no_run
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
}
