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

/// Longest tag the OCI distribution spec allows.
const MAX_ALIAS_CHARS: usize = 128;

/// Internal trait for image management, implemented by both backends.
///
/// `name` arguments have passed [`checked_name`].
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
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

    /// Create an alias, refusing every existing binding.
    /// `alias` and `digest` have passed [`checked_alias`] and [`checked_digest`].
    async fn create_alias(
        &self,
        name: &str,
        alias: &str,
        digest: &str,
    ) -> BoxliteResult<ImageDetail>;

    /// Delete only the named catalog alias.
    async fn delete_alias(&self, name: &str, alias: &str) -> BoxliteResult<()>;
}

/// `name` if it names an image without a tag or digest, refused otherwise.
///
/// Refused before either backend sees it, so both refuse the same names. A
/// tag or digest is refused rather than ignored: on a REST runtime the name
/// is what a remove deletes, every alias of it, and a caller passing `app:v1`
/// should not find `app:v2` gone. The rest would never be a name and, sent to
/// a server, could be read as another route: `usage` and `registries` are reserved, and `.` or `..`
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
    if is_traversal || matches!(name, "usage" | "registries") {
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

/// `tag` if the OCI distribution spec accepts it: a letter, digit or
/// underscore, then up to 127 of those, `.` or `-`. A server refuses the same
/// tags; refusing them here keeps a typo from becoming a round trip.
pub(crate) fn checked_alias(tag: &str) -> BoxliteResult<&str> {
    let mut chars = tag.chars();
    let starts_well = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let continues_well = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if starts_well && continues_well && tag.len() <= MAX_ALIAS_CHARS {
        Ok(tag)
    } else {
        Err(BoxliteError::InvalidArgument(format!(
            "'{tag}' is not a tag the OCI distribution spec accepts"
        )))
    }
}

/// `digest` if it is a sha256 manifest digest, the only kind a catalog records
/// and the form `ImageVersion::digest` takes.
pub(crate) fn checked_digest(digest: &str) -> BoxliteResult<&str> {
    match digest.strip_prefix("sha256:") {
        Some(hex)
            if hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Ok(digest)
        }
        _ => Err(BoxliteError::InvalidArgument(format!(
            "'{digest}' is not a sha256 digest; pass the digest of one of the image's versions"
        ))),
    }
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
    registry_backend: Option<Arc<dyn super::registries::RegistryBackend>>,
}

impl ImageHandle {
    /// Create a new ImageHandle with the given manager.
    ///
    /// This is an internal constructor used by `BoxliteRuntime`.
    pub(crate) fn new(
        manager: Arc<dyn ImageBackend>,
        registry_backend: Option<Arc<dyn super::registries::RegistryBackend>>,
    ) -> Self {
        Self {
            manager,
            registry_backend,
        }
    }

    /// Registry logins used by this REST catalog. Local image handles return `Unsupported`.
    pub fn registries(&self) -> BoxliteResult<super::RegistryHandle> {
        match &self.registry_backend {
            Some(backend) => Ok(super::RegistryHandle::new(Arc::clone(backend))),
            None => Err(BoxliteError::Unsupported(
                "registry logins require a REST image catalog; local runtimes use image_registries in their options".into(),
            )),
        }
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

    /// Create a catalog alias for a recorded ready build.
    ///
    /// Every existing name returns `AlreadyExists`, including the same digest.
    /// Delete an alias explicitly before recreating it. Existing boxes and
    /// upstream registry tags are unchanged; no image bytes are pulled.
    /// REST runtimes only. Inputs are validated before sending a request.
    pub async fn create_alias(
        &self,
        name: &str,
        alias: &str,
        digest: &str,
    ) -> BoxliteResult<ImageDetail> {
        self.manager
            .create_alias(
                checked_name(name)?,
                checked_alias(alias)?,
                checked_digest(digest)?,
            )
            .await
    }
    /// Delete a catalog alias without removing versions or changing existing boxes.
    /// REST runtimes only; an absent alias returns `NotFound`.
    pub async fn delete_alias(&self, name: &str, alias: &str) -> BoxliteResult<()> {
        self.manager
            .delete_alias(checked_name(name)?, checked_alias(alias)?)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::{checked_alias, checked_digest, checked_name};

    #[test]
    fn accepts_a_tag_oci_accepts() {
        for tag in ["v1", "stable", "_private", "3.20-alpine", &"a".repeat(128)] {
            assert_eq!(checked_alias(tag).unwrap(), tag);
        }
    }

    #[test]
    fn refuses_a_tag_oci_refuses() {
        for tag in [
            "",
            "-v1",
            ".hidden",
            "v1/x",
            "v 1",
            "v1:x",
            &"a".repeat(129),
        ] {
            assert!(checked_alias(tag).is_err(), "{tag:?} was accepted");
        }
    }

    #[test]
    fn accepts_only_a_sha256_digest() {
        let digest = format!("sha256:{}", "a".repeat(64));
        assert_eq!(checked_digest(&digest).unwrap(), digest);
        for digest in [
            String::new(),
            "latest".into(),
            "sha256:aa".into(),
            format!("sha256:{}", "A".repeat(64)),
            format!("sha512:{}", "a".repeat(64)),
            format!("sha256:{}", "a".repeat(65)),
        ] {
            assert!(checked_digest(&digest).is_err(), "{digest:?} was accepted");
        }
    }

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
            "registries",
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
