//! Local `BoxImpl` implementation for snapshot operations.
//!
//! Thin VM-aware wrapper that handles quiescing, locking, and state checks,
//! then delegates disk + DB operations to `SnapshotManager`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::disk::constants::filenames as disk_filenames;
use crate::litebox::box_impl::BoxImpl;
use crate::litebox::snapshot_mgr::{SnapshotInfo, validate_snapshot_name};
use crate::runtime::options::SnapshotOptions;

pub(crate) struct LocalSnapshotBackend {
    inner: Arc<BoxImpl>,
}

impl LocalSnapshotBackend {
    pub(crate) fn new(inner: Arc<BoxImpl>) -> Self {
        Self { inner }
    }

    async fn snapshot_create(
        &self,
        name: &str,
        _opts: SnapshotOptions,
    ) -> BoxliteResult<SnapshotInfo> {
        validate_snapshot_name(name)?;
        let t0 = Instant::now();
        let _lock = self.inner.disk_ops.lock().await;

        let box_id = self.inner.id().as_str();
        let snap_mgr = &self.inner.runtime.snapshot_mgr;

        // Check if snapshot name already exists for this box.
        if snap_mgr.exists(box_id, name)? {
            return Err(BoxliteError::AlreadyExists(format!(
                "snapshot '{}' already exists for box '{}'",
                name, box_id
            )));
        }

        // Write crash-recovery marker before moving disks (point of no return).
        let box_home = &self.inner.config.box_home;
        let disks_dir = box_home.join("disks");
        let container_disk = disks_dir.join(disk_filenames::CONTAINER_DISK);
        let pending_marker = box_home.join(".snapshot_pending");
        let snapshot_dir = box_home.join("snapshots").join(name);
        let marker_data = serde_json::json!({
            "snapshot_dir": snapshot_dir.to_string_lossy(),
            "container_disk": container_disk.to_string_lossy(),
        });
        std::fs::write(&pending_marker, marker_data.to_string()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to write snapshot marker: {}", e))
        })?;

        // Quiesce VM for point-in-time snapshot consistency.
        let result = self
            .inner
            .with_quiesce_async(async { snap_mgr.create(box_home, name, box_id) })
            .await;

        // Remove marker on success.
        let _ = std::fs::remove_file(&pending_marker);

        let info = result?;

        tracing::info!(
            box_id = %self.inner.id(),
            snapshot = %name,
            snapshot_id = %info.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            "Created snapshot"
        );

        Ok(info)
    }

    async fn snapshot_list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        let box_id = self.inner.id().as_str();
        self.inner.runtime.snapshot_mgr.list(box_id)
    }

    async fn snapshot_get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        validate_snapshot_name(name)?;
        let box_id = self.inner.id().as_str();
        self.inner.runtime.snapshot_mgr.get(box_id, name)
    }

    async fn snapshot_remove(&self, name: &str) -> BoxliteResult<()> {
        validate_snapshot_name(name)?;
        let _lock = self.inner.disk_ops.lock().await;

        let box_id = self.inner.id().as_str();
        let container_disk = self
            .inner
            .config
            .box_home
            .join("disks")
            .join(disk_filenames::CONTAINER_DISK);
        let bases_dir = self.inner.runtime.layout.bases_dir();

        self.inner
            .runtime
            .snapshot_mgr
            .remove(box_id, name, &container_disk, &bases_dir)?;

        tracing::info!(
            box_id = %self.inner.id(),
            snapshot = %name,
            "Removed snapshot"
        );

        Ok(())
    }

    async fn snapshot_restore(&self, name: &str) -> BoxliteResult<()> {
        validate_snapshot_name(name)?;

        // Refuse restore while the box is active — disk replacement under a running
        // VM would corrupt state and potentially lose data.
        {
            let state = self.inner.state.read();
            if state.status.is_active() {
                return Err(BoxliteError::InvalidState(
                    "Cannot restore snapshot while box is running. Stop the box first.".into(),
                ));
            }
        }

        let _lock = self.inner.disk_ops.lock().await;

        let box_id = self.inner.id().as_str();
        let disks_dir = self.inner.config.box_home.join("disks");

        self.inner
            .runtime
            .snapshot_mgr
            .restore_disks(box_id, name, &disks_dir)?;

        tracing::info!(
            box_id = %self.inner.id(),
            snapshot = %name,
            "Restored snapshot"
        );

        Ok(())
    }
}

#[async_trait::async_trait]
impl crate::runtime::backend::SnapshotBackend for LocalSnapshotBackend {
    async fn create(&self, options: SnapshotOptions, name: &str) -> BoxliteResult<SnapshotInfo> {
        self.snapshot_create(name, options).await
    }

    async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.snapshot_list().await
    }

    async fn get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        self.snapshot_get(name).await
    }

    async fn remove(&self, name: &str) -> BoxliteResult<()> {
        self.snapshot_remove(name).await
    }

    async fn restore(&self, name: &str) -> BoxliteResult<()> {
        self.snapshot_restore(name).await
    }
}

/// Recover from a mid-snapshot crash by restoring disks if a pending marker exists.
///
/// If `.snapshot_pending` exists in `box_home`, reads the marker JSON and
/// attempts to move snapshot disks back to their original locations.
pub(crate) fn recover_pending_snapshot(box_home: &Path) {
    let marker_path = box_home.join(".snapshot_pending");
    if !marker_path.exists() {
        return;
    }

    tracing::warn!(
        box_home = %box_home.display(),
        "Found pending snapshot marker — attempting crash recovery"
    );

    let marker_content = match std::fs::read_to_string(&marker_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "Failed to read snapshot marker {}: {}. Deleting corrupt marker.",
                marker_path.display(),
                e
            );
            let _ = std::fs::remove_file(&marker_path);
            return;
        }
    };

    let marker: serde_json::Value = match serde_json::from_str(&marker_content) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "Invalid JSON in snapshot marker {}: {}. Deleting corrupt marker.",
                marker_path.display(),
                e
            );
            let _ = std::fs::remove_file(&marker_path);
            return;
        }
    };

    // Current-style marker: snapshot_dir + container_disk.
    // Legacy-style marker: bases_dir + container_disk (pre-per-box migration).
    let snapshot_dir = marker.get("snapshot_dir").and_then(|v| v.as_str());
    let bases_dir = marker.get("bases_dir").and_then(|v| v.as_str());
    let container_disk = marker.get("container_disk").and_then(|v| v.as_str());

    if let Some(container_path) = container_disk {
        let container_path = PathBuf::from(container_path);

        if let Some(snap_dir_str) = snapshot_dir {
            // Current-style: snapshot_dir based recovery.
            let snap_dir = PathBuf::from(snap_dir_str);
            let snap_container = snap_dir.join(disk_filenames::CONTAINER_DISK);

            if !container_path.exists() && snap_container.exists() {
                // Crash happened after rename but before COW child creation.
                // The snapshot is incomplete — move the disk back to restore the box.
                match std::fs::rename(&snap_container, &container_path) {
                    Ok(()) => {
                        tracing::info!(
                            "Recovered container disk from pending snapshot: {} → {}",
                            snap_container.display(),
                            container_path.display()
                        );
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to recover container disk: {}. Manual recovery needed.",
                            e
                        );
                    }
                }
                // Incomplete snapshot — clean up its directory.
                if snap_dir.exists() {
                    let _ = std::fs::remove_dir_all(&snap_dir);
                }
            } else if container_path.exists() && snap_container.exists() {
                // Both exist: crash happened after COW child was created but before
                // the marker was deleted. Validate that the COW child actually backs
                // to the expected snapshot disk before declaring success.
                let backing_ok = crate::disk::read_backing_file_path(&container_path)
                    .ok()
                    .flatten()
                    .and_then(|bp| {
                        let backing = PathBuf::from(bp);
                        let expected = snap_container.canonicalize().ok()?;
                        let actual = backing.canonicalize().ok()?;
                        Some(actual == expected)
                    })
                    .unwrap_or(false);

                if backing_ok {
                    tracing::info!(
                        "Snapshot completed successfully before crash. Keeping snapshot dir: {}",
                        snap_dir.display()
                    );
                } else {
                    tracing::warn!(
                        snap_dir = %snap_dir.display(),
                        "Container disk does not back to expected snapshot. \
                         Preserving both files for manual inspection."
                    );
                }
            } else if !container_path.exists() && !snap_container.exists() {
                // Neither disk exists — unrecoverable state. Clean up snapshot dir.
                if snap_dir.exists() {
                    let _ = std::fs::remove_dir_all(&snap_dir);
                }
            }
            // else: container_path exists but snap_container doesn't — snapshot
            // was never created (marker written but rename never happened). Just
            // clean up marker (done below).
        } else if let Some(bases_dir_str) = bases_dir {
            // Legacy-style: find the most recently created .qcow2 file in bases/
            if !container_path.exists() {
                let bases = PathBuf::from(bases_dir_str);
                if let Ok(entries) = std::fs::read_dir(&bases) {
                    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().is_some_and(|ext| ext == "qcow2")
                            && let Ok(meta) = path.metadata()
                            && let Ok(modified) = meta.modified()
                            && newest.as_ref().is_none_or(|(_, t)| modified > *t)
                        {
                            newest = Some((path, modified));
                        }
                    }
                    if let Some((newest_file, _)) = newest {
                        match std::fs::rename(&newest_file, &container_path) {
                            Ok(()) => {
                                tracing::info!(
                                    "Recovered container disk from bases: {} → {}",
                                    newest_file.display(),
                                    container_path.display()
                                );
                            }
                            Err(e) => {
                                tracing::error!(
                                    "Failed to recover container disk: {}. Manual recovery needed.",
                                    e
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = std::fs::remove_file(&marker_path);
    tracing::info!(
        box_home = %box_home.display(),
        "Pending snapshot recovery complete"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── recover_pending_snapshot tests ────────────────────────────────

    #[test]
    fn test_recover_pending_snapshot_restores_disk() {
        let dir = tempfile::TempDir::new().unwrap();
        let box_home = dir.path();

        // Simulate current-style marker with snapshot_dir
        let snap_dir = box_home.join("snapshots").join("test-snap");
        std::fs::create_dir_all(&snap_dir).unwrap();

        let disks_dir = box_home.join("disks");
        std::fs::create_dir_all(&disks_dir).unwrap();

        let container_disk = disks_dir.join(disk_filenames::CONTAINER_DISK);
        let snap_container = snap_dir.join(disk_filenames::CONTAINER_DISK);

        // Simulate crash: disk moved to snapshot dir, no COW child created.
        std::fs::write(&snap_container, b"disk-data").unwrap();
        assert!(!container_disk.exists());

        // Write marker.
        let marker = serde_json::json!({
            "snapshot_dir": snap_dir.to_string_lossy(),
            "container_disk": container_disk.to_string_lossy(),
        });
        std::fs::write(box_home.join(".snapshot_pending"), marker.to_string()).unwrap();

        recover_pending_snapshot(box_home);

        // Disk should be restored.
        assert!(container_disk.exists());
        assert_eq!(std::fs::read(&container_disk).unwrap(), b"disk-data");
        // Marker should be gone.
        assert!(!box_home.join(".snapshot_pending").exists());
        // Snapshot dir should be cleaned up.
        assert!(!snap_dir.exists());
    }

    #[test]
    fn test_recover_pending_snapshot_noop_when_no_marker() {
        let dir = tempfile::TempDir::new().unwrap();
        // No marker file — should be a no-op.
        recover_pending_snapshot(dir.path());
        // Just verify no crash.
    }

    #[test]
    fn test_recover_pending_snapshot_handles_corrupt_marker() {
        let dir = tempfile::TempDir::new().unwrap();
        let box_home = dir.path();

        // Write invalid JSON marker.
        std::fs::write(box_home.join(".snapshot_pending"), "not-json{{{").unwrap();

        recover_pending_snapshot(box_home);

        // Marker should be deleted despite being corrupt.
        assert!(!box_home.join(".snapshot_pending").exists());
    }

    #[test]
    fn test_recover_pending_snapshot_preserves_completed_snapshot() {
        let dir = tempfile::TempDir::new().unwrap();
        let box_home = dir.path();

        // Simulate successful snapshot: both container disk AND snapshot disk exist.
        // This means the crash happened after COW child creation but before
        // the marker was deleted. The snapshot is valid.
        let snap_dir = box_home.join("snapshots").join("completed-snap");
        std::fs::create_dir_all(&snap_dir).unwrap();

        let disks_dir = box_home.join("disks");
        std::fs::create_dir_all(&disks_dir).unwrap();

        let container_disk = disks_dir.join(disk_filenames::CONTAINER_DISK);
        let snap_container = snap_dir.join(disk_filenames::CONTAINER_DISK);

        // Both files exist (snapshot completed successfully before crash).
        std::fs::write(&container_disk, b"cow-child").unwrap();
        std::fs::write(&snap_container, b"snapshot-base").unwrap();

        let marker = serde_json::json!({
            "snapshot_dir": snap_dir.to_string_lossy(),
            "container_disk": container_disk.to_string_lossy(),
        });
        std::fs::write(box_home.join(".snapshot_pending"), marker.to_string()).unwrap();

        recover_pending_snapshot(box_home);

        // Both disks should still exist.
        assert!(container_disk.exists(), "COW child should be preserved");
        assert!(snap_container.exists(), "Snapshot disk should be preserved");
        // Snapshot directory should NOT be deleted (BUG 3 fix).
        assert!(snap_dir.exists(), "Snapshot dir should be preserved");
        // Marker should be gone.
        assert!(!box_home.join(".snapshot_pending").exists());
    }
}
