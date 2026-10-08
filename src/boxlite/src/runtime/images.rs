//! Image operations handle
//!
//! Provides `ImageHandle` for the images a runtime can boot from: the local
//! cache on an embedded runtime, the server's catalog on a REST one. This
//! abstraction separates image management from runtime management, following
//! the same pattern as `LiteBox` for box operations.

use async_trait::async_trait;
use std::sync::Arc;

use boxlite_shared::errors::BoxliteError;

use crate::BoxliteResult;
use crate::images::ImageObject;
use crate::runtime::types::{ImageDetail, ImageInfo, ImageUsage};

/// Longest image name accepted; a catalog name is a registry host and a
/// repository path, both bounded well below this.
const MAX_NAME_CHARS: usize = 512;

/// Internal trait for image management, implemented by both backends.
///
/// `name` arguments have passed [`checked_name`].
#[async_trait]
pub(crate) trait ImageBackend: Send + Sync {
    /// Pull an image from a registry.
    async fn pull_image(&self, image_ref: &str) -> BoxliteResult<ImageObject>;

    /// List the images held, one entry per reference.
    async fn list_images(&self) -> BoxliteResult<Vec<ImageInfo>>;

    /// Every build held under `name`.
    async fn get_image(&self, name: &str) -> BoxliteResult<ImageDetail>;

    /// Stop holding `name`. The layers stay where they are.
    async fn remove_image(&self, name: &str) -> BoxliteResult<()>;

    /// How many images are held against the caller's allowance.
    async fn image_usage(&self) -> BoxliteResult<ImageUsage>;
}

/// `name` if it names an image without a tag or digest, refused otherwise.
///
/// Refused before either backend sees it, so both refuse the same names. A
/// tag or digest is refused rather than ignored: on a REST runtime the name
/// is what a remove deletes, every tag of it, and a caller passing `app:v1`
/// should not find `app:v2` gone. The rest would never be a name and, sent to
/// a server, could be read as another route: `usage` is one, and `.` or `..`
/// would be normalised out of the URL.
pub(crate) fn checked_name(name: &str) -> BoxliteResult<&str> {
    let refuse = |why: String| Err(BoxliteError::InvalidArgument(why));
    if name.is_empty() || name.trim() != name {
        return refuse("an image name must be non-empty, without surrounding whitespace".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return refuse(format!(
            "an image name must not exceed {MAX_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(|c| c < '\u{20}' || c == '\u{7f}') {
        return refuse("an image name must not contain control characters".into());
    }
    let is_traversal = name.starts_with('/')
        || name
            .replace('\\', "/")
            .split('/')
            .any(|part| part == "." || part == "..");
    if is_traversal || name == "usage" {
        return refuse(format!("'{name}' is not an image name"));
    }
    let untagged = untagged(name);
    if untagged != name {
        return refuse(format!(
            "'{name}' names a tag or digest; pass the image name alone, such as '{untagged}'"
        ));
    }
    Ok(name)
}

/// `reference` without a trailing `:tag` or `@digest`.
fn untagged(reference: &str) -> &str {
    let reference = reference.split('@').next().unwrap_or(reference);
    match reference.rsplit_once(':') {
        // A colon before the last slash is a registry port (`localhost:5000/app`).
        Some((name, tag)) if !tag.contains('/') => name,
        _ => reference,
    }
}

/// Handle for performing image operations.
///
/// Obtained via `BoxliteRuntime::images()`. On an embedded runtime it reads
/// and writes the local cache; on a REST runtime, the server's catalog.
/// `pull` is local only — a REST runtime pulls when a box is created — and
/// `usage` is REST only, since a cache has no allowance.
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

    /// Every build held under an image name, such as `docker.io/library/alpine`.
    ///
    /// Fails with `NotFound` when nothing is held under it, and with
    /// `InvalidArgument` for a reference that carries a tag or digest.
    pub async fn get(&self, name: &str) -> BoxliteResult<ImageDetail> {
        self.manager.get_image(checked_name(name)?).await
    }

    /// Stop holding an image name, every tag of it.
    ///
    /// The layers are not deleted. Locally nothing is refused, but a box built
    /// from the image reads the image's configuration from the cache each time
    /// it starts (`image_for_restart` in `litebox/init/tasks/container_rootfs.rs`),
    /// so after a remove that start fetches it from the registry again, and
    /// fails while the registry is unreachable. On a REST runtime the server
    /// refuses while a box can still boot from the image.
    pub async fn remove(&self, name: &str) -> BoxliteResult<()> {
        self.manager.remove_image(checked_name(name)?).await
    }

    /// How many images are held against the allowance. REST runtimes only.
    pub async fn usage(&self) -> BoxliteResult<ImageUsage> {
        self.manager.image_usage().await
    }
}

#[cfg(test)]
mod tests {
    use super::checked_name;

    #[test]
    fn accepts_an_image_name() {
        for name in [
            "alpine",
            "docker.io/library/alpine",
            "quay.io/acme/app",
            "localhost:5000/app",
        ] {
            assert_eq!(checked_name(name).unwrap(), name);
        }
    }

    #[test]
    fn refuses_a_reference_that_carries_a_tag_or_digest() {
        for (reference, name) in [
            ("alpine:3.20", "alpine"),
            ("quay.io/acme/app:v1", "quay.io/acme/app"),
            ("localhost:5000/app:v1", "localhost:5000/app"),
            (
                "alpine@sha256:4a1c2f00000000000000000000000000000000000000000000000000000000aa",
                "alpine",
            ),
        ] {
            let message = checked_name(reference).unwrap_err().to_string();
            assert!(
                message.starts_with("invalid argument:"),
                "{reference}: {message}"
            );
            assert!(message.contains(&format!("such as '{name}'")), "{message}");
        }
    }

    #[test]
    fn refuses_what_could_reach_another_route() {
        let too_long = "a".repeat(super::MAX_NAME_CHARS + 1);
        for name in [
            "",
            " acme/app",
            "acme/app\n",
            "acme\u{7f}app",
            "/etc/passwd",
            "../etc",
            "quay.io/acme/..",
            "quay.io\\..\\x",
            ".",
            "acme/./app",
            "usage",
            too_long.as_str(),
        ] {
            let message = checked_name(name).unwrap_err().to_string();
            assert!(
                message.starts_with("invalid argument:"),
                "{name:?}: {message}"
            );
        }
    }
}
