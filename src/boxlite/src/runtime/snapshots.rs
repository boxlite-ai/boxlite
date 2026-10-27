//! Organization-wide snapshot management, independent of a source box's lifetime.

use crate::{BoxOptions, BoxliteResult, LiteBox, SnapshotInfo};
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub(crate) trait RuntimeSnapshotBackend: Send + Sync {
    async fn list_snapshots(&self) -> BoxliteResult<Vec<SnapshotInfo>>;
    async fn get_snapshot(&self, id_or_name: &str) -> BoxliteResult<SnapshotInfo>;
    async fn remove_snapshot(&self, id_or_name: &str, force: bool) -> BoxliteResult<()>;
    async fn create_from_snapshot(
        &self,
        snapshot: &str,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox>;
}

/// Organization snapshots, including snapshots whose source box was deleted.
///
/// Obtain this capability through `runtime.snapshots()`. Local runtimes do not
/// have an organization catalog; their snapshots remain available on each box.
#[derive(Clone)]
pub struct RuntimeSnapshotHandle {
    backend: Arc<dyn RuntimeSnapshotBackend>,
}

impl std::fmt::Debug for RuntimeSnapshotHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeSnapshotHandle")
            .finish_non_exhaustive()
    }
}

impl RuntimeSnapshotHandle {
    pub(crate) fn new(backend: Arc<dyn RuntimeSnapshotBackend>) -> Self {
        Self { backend }
    }

    /// List all snapshots visible to this runtime's organization.
    pub async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.backend.list_snapshots().await
    }

    /// Look up a snapshot by ID or name. An absent snapshot returns NotFound.
    pub async fn get(&self, id_or_name: &str) -> BoxliteResult<SnapshotInfo> {
        self.backend.get_snapshot(id_or_name).await
    }

    /// Delete a snapshot. `force` ignores absence, but preserves other failures.
    pub async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        self.backend.remove_snapshot(id_or_name, force).await
    }
}
