//! Named-volume operations handle.
//!
//! Provides [`VolumeHandle`] for managing named local volumes (create, list,
//! get, remove). This mirrors [`ImageHandle`](crate::runtime::ImageHandle):
//! volume management is a distinct capability, surfaced via
//! `BoxliteRuntime::volumes()` and backed only by local runtimes.
//!
//! Operations are synchronous filesystem calls (no network), so the trait is
//! plain `Send + Sync` rather than `async_trait` — the CLI calls these without
//! `.await`.

use std::sync::Arc;

use crate::BoxliteResult;
use crate::volumes::VolumeInfo;

/// Internal trait for named-volume management.
///
/// Implemented by runtime backends that own a local `<home>/volumes` tree.
/// Currently only `LocalRuntime` implements this; the REST runtime does not.
pub(crate) trait VolumeBackend: Send + Sync {
    /// Create a named volume. `size_gb` is stored as an advisory hint only.
    fn create_volume(&self, name: &str, size_gb: Option<u64>) -> BoxliteResult<VolumeInfo>;

    /// List all named volumes (sorted by name).
    fn list_volumes(&self) -> BoxliteResult<Vec<VolumeInfo>>;

    /// Get metadata for a single named volume.
    fn get_volume(&self, name: &str) -> BoxliteResult<VolumeInfo>;

    /// Remove a named volume. `force` makes a missing volume a no-op.
    fn remove_volume(&self, name: &str, force: bool) -> BoxliteResult<()>;
}

/// Handle for performing named-volume operations.
///
/// Obtained via [`BoxliteRuntime::volumes()`](crate::BoxliteRuntime::volumes).
#[derive(Clone)]
pub struct VolumeHandle {
    backend: Arc<dyn VolumeBackend>,
}

impl VolumeHandle {
    /// Internal constructor used by `BoxliteRuntime`.
    pub(crate) fn new(backend: Arc<dyn VolumeBackend>) -> Self {
        Self { backend }
    }

    /// Create a named volume, returning its metadata.
    pub fn create(&self, name: &str, size_gb: Option<u64>) -> BoxliteResult<VolumeInfo> {
        self.backend.create_volume(name, size_gb)
    }

    /// List all named volumes, sorted by name.
    pub fn list(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        self.backend.list_volumes()
    }

    /// Get metadata for a single named volume.
    pub fn get(&self, name: &str) -> BoxliteResult<VolumeInfo> {
        self.backend.get_volume(name)
    }

    /// Remove a named volume. With `force`, a missing volume is a no-op.
    pub fn remove(&self, name: &str, force: bool) -> BoxliteResult<()> {
        self.backend.remove_volume(name, force)
    }
}
