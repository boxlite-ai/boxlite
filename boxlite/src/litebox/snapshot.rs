//! Snapshot sub-resource on LiteBox.

use std::sync::Arc;

use boxlite_shared::errors::BoxliteResult;

use crate::db::snapshots::SnapshotInfo;
use crate::runtime::backend::SnapshotBackend;
use crate::runtime::options::SnapshotOptions;

/// Handle for snapshot operations on a LiteBox.
///
/// Obtained via `litebox.snapshot()`. Owns backend handles and can be
/// used independently from the originating `LiteBox` borrow.
pub struct SnapshotHandle {
    snapshot_backend: Arc<dyn SnapshotBackend>,
}

impl SnapshotHandle {
    pub(crate) fn new(snapshot_backend: Arc<dyn SnapshotBackend>) -> Self {
        Self { snapshot_backend }
    }

    /// Create a snapshot of the box's current disk state.
    pub async fn create(
        &self,
        options: SnapshotOptions,
        name: &str,
    ) -> BoxliteResult<SnapshotInfo> {
        self.snapshot_backend.create(options, name).await
    }

    /// List all snapshots for this box.
    pub async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.snapshot_backend.list().await
    }

    /// Get a snapshot by name.
    pub async fn get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        self.snapshot_backend.get(name).await
    }

    /// Remove a snapshot by name.
    pub async fn remove(&self, name: &str) -> BoxliteResult<()> {
        self.snapshot_backend.remove(name).await
    }

    /// Restore box disks from a snapshot.
    pub async fn restore(&self, name: &str) -> BoxliteResult<()> {
        self.snapshot_backend.restore(name).await
    }
}
