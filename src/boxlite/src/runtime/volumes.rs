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
//! perform network calls. The REST backend implements it against the managed
//! `/v1/volumes` API; the local backend (`LocalRuntime`) does not have a
//! volume store wired up yet and returns `Unsupported`.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use crate::volumes::{VolumeInfo, VolumeState};
use crate::{BoxliteError, BoxliteResult};

/// Poll interval for [`VolumeHandle::wait_until_ready`]. The backing bucket
/// is provisioned by a 5s reconciler tick server-side, so anything much
/// shorter than that just adds request volume without reducing latency.
const WAIT_UNTIL_READY_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Internal trait for named-volume management.
///
/// Implemented by both `LocalRuntime` (currently `Unsupported` — no local
/// volume store yet) and the REST runtime (backed by `/v1/volumes`).
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

    /// Poll `get(id)` client-side until the volume reaches `Ready`, `Error`,
    /// or `timeout` elapses.
    ///
    /// `create()` returns as soon as the volume is accepted (state
    /// `PendingCreate`) — provisioning the backing object storage happens
    /// asynchronously on the server. This is a convenience for callers that
    /// want the old "create and block until usable" behavior without the
    /// server itself holding the connection open (which risked client/gateway
    /// timeouts for what both `boxlite`'s runner and API treat as inherently
    /// async). Mirrors `ComputerBox`/`SkillBox`'s `waitUntilReady` in the
    /// Node SDK (`sdks/node/lib/computerbox.ts`, `skillbox.ts`).
    pub async fn wait_until_ready(&self, id: &str, timeout: Duration) -> BoxliteResult<VolumeInfo> {
        let deadline = std::time::Instant::now() + timeout;

        loop {
            let info = self.get(id).await?;
            match info.state {
                VolumeState::Ready => return Ok(info),
                VolumeState::Error => {
                    return Err(BoxliteError::InvalidState(format!(
                        "volume {id} failed to become ready: {}",
                        info.error_reason.as_deref().unwrap_or("unknown error")
                    )));
                }
                _ => {}
            }

            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(BoxliteError::InvalidState(format!(
                    "timed out waiting for volume {id} to become ready (still {:?})",
                    info.state
                )));
            }
            tokio::time::sleep(WAIT_UNTIL_READY_POLL_INTERVAL.min(remaining)).await;
        }
    }
}
