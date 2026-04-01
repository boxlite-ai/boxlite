mod archive;
mod blob_source;
mod config;
mod image_disk;
mod manager;
mod object;
mod storage;
mod store;

pub use archive::extract_layer_tarball_streaming;
pub use config::ContainerImageConfig;
pub use image_disk::ImageDiskManager;
pub use manager::ImageManager;
pub use object::ImageObject;

use oci_client::Reference;

// ============================================================================
// Registry Resolution (Reference Iterator)
// ============================================================================

/// Iterator that yields `Reference` candidates for an image.
///
/// For qualified images (e.g., `"ghcr.io/foo/bar"`), yields only the original.
/// For unqualified images (e.g., `"alpine"`), yields one `Reference` per registry.
///
/// # Examples
///
/// ```ignore
/// // Unqualified image with registries - yields one per registry
/// let registries = vec!["docker.io".into(), "quay.io".into()];
/// let iter = ReferenceIter::new("alpine:latest", &registries)?;
/// for reference in iter {
///     println!("{}", reference.whole());
/// }
/// // Prints: docker.io/alpine:latest, quay.io/alpine:latest
///
/// // Qualified image - yields original only
/// let iter = ReferenceIter::new("ghcr.io/foo/bar:v1", &registries)?;
/// // Yields only: ghcr.io/foo/bar:v1
/// ```
pub(crate) struct ReferenceIter<'a> {
    /// The parsed base reference (before registry substitution).
    base_ref: Reference,
    /// List of registries to try for unqualified images (tried in order).
    registries: &'a [String],
    /// Current index in the registries list (for iteration state).
    index: usize,
    /// Whether the original image ref was fully qualified (has explicit registry).
    /// If true, we skip registry substitution and yield the original only.
    is_qualified: bool,
    /// Whether we've already yielded the original reference.
    /// Used for qualified refs or when registries list is empty.
    yielded_original: bool,
}

impl<'a> ReferenceIter<'a> {
    /// Create a new iterator for the given image reference and registries.
    ///
    /// # Arguments
    ///
    /// * `image_ref` - The image reference string (e.g., "alpine:latest" or "ghcr.io/foo/bar:v1")
    /// * `registries` - List of registries to try for unqualified images
    ///
    /// # Errors
    ///
    /// Returns an error if the image reference cannot be parsed by oci_client.
    pub fn new(image_ref: &str, registries: &'a [String]) -> Result<Self, oci_client::ParseError> {
        let base_ref: Reference = image_ref.parse()?;
        let is_qualified = is_fully_qualified(image_ref);

        tracing::debug!(
            image_ref = %image_ref,
            is_qualified = %is_qualified,
            registry_count = registries.len(),
            "Created reference iterator for image resolution"
        );

        Ok(Self {
            base_ref,
            registries,
            index: 0,
            is_qualified,
            yielded_original: false,
        })
    }
}

impl Iterator for ReferenceIter<'_> {
    type Item = Reference;

    fn next(&mut self) -> Option<Self::Item> {
        // Qualified image: yield original once
        if self.is_qualified {
            if self.yielded_original {
                return None;
            }
            self.yielded_original = true;
            return Some(self.base_ref.clone());
        }

        // Unqualified with no registries: yield original once (docker.io default)
        if self.registries.is_empty() {
            if self.yielded_original {
                return None;
            }
            self.yielded_original = true;
            return Some(self.base_ref.clone());
        }

        // Unqualified: yield one Reference per registry
        if self.index >= self.registries.len() {
            return None;
        }

        let registry = &self.registries[self.index];
        self.index += 1;

        let tag = self.base_ref.tag().unwrap_or("latest").to_string();
        Some(Reference::with_tag(
            registry.clone(),
            self.base_ref.repository().to_string(),
            tag,
        ))
    }
}

/// Check if an image reference is fully qualified (contains a registry).
///
/// A reference is considered fully qualified if it contains a `/` and the
/// part before the first `/` looks like a registry hostname:
/// - Contains a `.` (e.g., `docker.io`, `ghcr.io`)
/// - Contains a `:` (e.g., `localhost:5000`)
/// - Is exactly `localhost`
fn is_fully_qualified(image_ref: &str) -> bool {
    if let Some(slash_pos) = image_ref.find('/') {
        let first_part = &image_ref[..slash_pos];
        first_part.contains('.') || first_part.contains(':') || first_part == "localhost"
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to collect References as (registry, repository, tag) tuples for easy comparison
    fn collect_refs(iter: ReferenceIter) -> Vec<(String, String, Option<String>)> {
        iter.map(|r| {
            (
                r.registry().to_string(),
                r.repository().to_string(),
                r.tag().map(|t| t.to_string()),
            )
        })
        .collect()
    }

    #[test]
    fn test_empty_registries_yields_original() {
        // Empty list - yields original once (docker.io default behavior)
        let registries: Vec<String> = vec![];
        let iter = ReferenceIter::new("alpine", &registries).unwrap();
        let refs = collect_refs(iter);

        assert_eq!(refs.len(), 1);
        // oci_client normalizes "alpine" to docker.io/library/alpine
        assert_eq!(refs[0].0, "docker.io");
    }

    #[test]
    fn test_single_registry() {
        let registries = vec!["ghcr.io".to_string()];
        let iter = ReferenceIter::new("alpine", &registries).unwrap();
        let refs = collect_refs(iter);

        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].0, "ghcr.io");
        // Repository should be "library/alpine" (normalized by oci_client)
    }

    #[test]
    fn test_multiple_registries() {
        let registries = vec![
            "ghcr.io".to_string(),
            "quay.io".to_string(),
            "docker.io".to_string(),
        ];
        let iter = ReferenceIter::new("alpine:3.18", &registries).unwrap();
        let refs = collect_refs(iter);

        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].0, "ghcr.io");
        assert_eq!(refs[1].0, "quay.io");
        assert_eq!(refs[2].0, "docker.io");

        // All should have the same tag
        for r in &refs {
            assert_eq!(r.2, Some("3.18".to_string()));
        }
    }

    #[test]
    fn test_qualified_bypasses_registries() {
        let registries = vec!["ghcr.io".to_string()];

        // docker.io is a registry - should yield only original
        let iter = ReferenceIter::new("docker.io/library/alpine", &registries).unwrap();
        let refs = collect_refs(iter);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].0, "docker.io");

        // quay.io is a registry
        let iter = ReferenceIter::new("quay.io/foo/bar:v1", &registries).unwrap();
        let refs = collect_refs(iter);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].0, "quay.io");

        // localhost is a registry
        let iter = ReferenceIter::new("localhost/myimage", &registries).unwrap();
        let refs = collect_refs(iter);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].0, "localhost");
    }

    #[test]
    fn test_namespace_not_registry() {
        // "library/alpine" - "library" is NOT a registry (no dot, no port, not localhost)
        let registries = vec!["ghcr.io".to_string()];
        let iter = ReferenceIter::new("library/alpine", &registries).unwrap();
        let refs = collect_refs(iter);

        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].0, "ghcr.io");
        // Repository includes the namespace
        assert!(refs[0].1.contains("library"));
    }

    #[test]
    fn test_is_fully_qualified() {
        // Qualified (has registry)
        assert!(is_fully_qualified("docker.io/library/alpine"));
        assert!(is_fully_qualified("ghcr.io/owner/repo"));
        assert!(is_fully_qualified("localhost/myimage"));
        assert!(is_fully_qualified("localhost:5000/myimage"));
        assert!(is_fully_qualified("my-registry.com:5000/image"));

        // Not qualified (no registry)
        assert!(!is_fully_qualified("alpine"));
        assert!(!is_fully_qualified("alpine:latest"));
        assert!(!is_fully_qualified("library/alpine"));
        assert!(!is_fully_qualified("myorg/myimage:v1"));
    }
}
