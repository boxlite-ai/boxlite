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
    /// Create a volume, returning its server-assigned metadata (including id).
    async fn create_volume(&self) -> BoxliteResult<VolumeInfo>;

    /// List all volumes.
    async fn list_volumes(&self) -> BoxliteResult<Vec<VolumeInfo>>;

    /// Get metadata for a single volume by id.
    async fn get_volume(&self, id: &str) -> BoxliteResult<VolumeInfo>;

    /// Remove a volume by id. `force` makes a missing volume a no-op.
    async fn remove_volume(&self, id: &str, force: bool) -> BoxliteResult<()>;
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

    /// Create a volume, returning its metadata (including the assigned id).
    pub async fn create(&self) -> BoxliteResult<VolumeInfo> {
        self.backend.create_volume().await
    }

    /// List all volumes.
    pub async fn list(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        self.backend.list_volumes().await
    }

    /// Get metadata for a single volume by id.
    pub async fn get(&self, id: &str) -> BoxliteResult<VolumeInfo> {
        self.backend.get_volume(id).await
    }

    /// Remove a volume by id. With `force`, a missing volume is a no-op.
    pub async fn remove(&self, id: &str, force: bool) -> BoxliteResult<()> {
        self.backend.remove_volume(id, force).await
    }
}
