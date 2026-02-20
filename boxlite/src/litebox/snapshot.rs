//! Snapshot sub-resource on LiteBox.
//!
//! Snapshots are not yet implemented. All methods return an error.
//! The API surface is kept for future re-enablement.

use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::db::snapshots::SnapshotInfo;
use crate::runtime::backend::SnapshotBackend;
use crate::runtime::options::SnapshotOptions;

/// Handle for snapshot operations on a LiteBox.
///
/// Obtained via `litebox.snapshot()`. Owns backend handles and can be
/// used independently from the originating `LiteBox` borrow.
pub struct SnapshotHandle {
    #[allow(dead_code)] // Snapshots temporarily disabled; will be re-enabled
    snapshot_backend: Arc<dyn SnapshotBackend>,
}

fn unimplemented_error() -> BoxliteError {
    BoxliteError::Internal("Snapshots are not yet implemented".to_string())
}

impl SnapshotHandle {
    pub(crate) fn new(snapshot_backend: Arc<dyn SnapshotBackend>) -> Self {
        Self { snapshot_backend }
    }

    /// Create a snapshot of the box's current disk state.
    pub async fn create(
        &self,
        _options: SnapshotOptions,
        _name: &str,
    ) -> BoxliteResult<SnapshotInfo> {
        Err(unimplemented_error())
    }

    /// List all snapshots for this box.
    pub async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        Err(unimplemented_error())
    }

    /// Get a snapshot by name.
    pub async fn get(&self, _name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        Err(unimplemented_error())
    }

    /// Remove a snapshot by name.
    pub async fn remove(&self, _name: &str) -> BoxliteResult<()> {
        Err(unimplemented_error())
    }

    /// Restore box disks from a snapshot.
    pub async fn restore(&self, _name: &str) -> BoxliteResult<()> {
        Err(unimplemented_error())
    }
}
