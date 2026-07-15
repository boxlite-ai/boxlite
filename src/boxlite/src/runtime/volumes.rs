//! Named-volume operations handle.
//!
//! Provides [`VolumeHandle`] for managing named volumes (create, list, get,
//! remove). This mirrors [`ImageHandle`](crate::runtime::ImageHandle): volume
//! management is a distinct capability, surfaced via `BoxliteRuntime::volumes()`
//! and backed by either a local runtime or a REST runtime.
//!
//! The trait is `#[async_trait]` like the other capability backends
//! ([`ImageBackend`](crate::runtime::images::ImageBackend),
//! [`AuthBackend`](crate::runtime::auth::AuthBackend)) so REST backends can
//! perform network calls. The concrete backend is not implemented yet — every
//! operation currently returns `Unsupported`.

use std::sync::Arc;

use async_trait::async_trait;

use crate::BoxliteResult;
use crate::volumes::VolumeInfo;

/// Internal trait for named-volume management.
///
/// Implemented by both `LocalRuntime` and the REST runtime. Both return
/// `Unsupported` until a managed volume backend is wired up.
#[async_trait]
pub(crate) trait VolumeBackend: Send + Sync {
    /// Create a named volume. `size_gb` is stored as an advisory hint only.
    async fn create_volume(&self, name: &str, size_gb: Option<u64>) -> BoxliteResult<VolumeInfo>;

    /// List all named volumes (sorted by name).
    async fn list_volumes(&self) -> BoxliteResult<Vec<VolumeInfo>>;

    /// Get metadata for a single named volume.
    async fn get_volume(&self, name: &str) -> BoxliteResult<VolumeInfo>;

    /// Remove a named volume. `force` makes a missing volume a no-op.
    async fn remove_volume(&self, name: &str, force: bool) -> BoxliteResult<()>;
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
    pub async fn create(&self, name: &str, size_gb: Option<u64>) -> BoxliteResult<VolumeInfo> {
        self.backend.create_volume(name, size_gb).await
    }

    /// List all named volumes, sorted by name.
    pub async fn list(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        self.backend.list_volumes().await
    }

    /// Get metadata for a single named volume.
    pub async fn get(&self, name: &str) -> BoxliteResult<VolumeInfo> {
        self.backend.get_volume(name).await
    }

    /// Remove a named volume. With `force`, a missing volume is a no-op.
    pub async fn remove(&self, name: &str, force: bool) -> BoxliteResult<()> {
        self.backend.remove_volume(name, force).await
    }
}
