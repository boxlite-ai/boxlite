//! Local `BoxImpl` implementation for snapshot/clone/export operations.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use std::time::Instant;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;

use crate::db::SnapshotStore;
use crate::db::snapshots::SnapshotInfo;
use crate::disk::constants::dirs as disk_dirs;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::box_impl::BoxImpl;
use crate::runtime::options::SnapshotOptions;

/// Validate that a snapshot name is safe (no path traversal, no special chars).
fn validate_snapshot_name(name: &str) -> BoxliteResult<()> {
    if name.is_empty() {
        return Err(BoxliteError::InvalidArgument(
            "Snapshot name cannot be empty".into(),
        ));
    }
    if name.len() > 255 {
        return Err(BoxliteError::InvalidArgument(format!(
            "Snapshot name too long ({} chars, max 255)",
            name.len()
        )));
    }
    if name == "." || name == ".." {
        return Err(BoxliteError::InvalidArgument(format!(
            "Snapshot name '{}' is not allowed",
            name
        )));
    }
    if name.starts_with('.') {
        return Err(BoxliteError::InvalidArgument(
            "Snapshot name cannot start with '.'".into(),
        ));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(BoxliteError::InvalidArgument(
            "Snapshot name contains invalid characters (/, \\, or null byte)".into(),
        ));
    }
    Ok(())
}

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

        let box_home = self.inner.config.box_home.clone();
        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        if !container_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                container_disk.display()
            )));
        }

        let store = self.snapshot_store();
        let box_id = self.inner.id().as_str();
        if store.get_by_name(box_id, name)?.is_some() {
            return Err(BoxliteError::AlreadyExists(format!(
                "snapshot '{}' already exists for box '{}'",
                name, box_id
            )));
        }

        // Quiesce VM for point-in-time snapshot consistency.
        let result = self
            .inner
            .with_quiesce_async(async {
                self.do_snapshot_create(name, &box_home, &container_disk, &guest_disk)
            })
            .await;

        tracing::info!(
            box_id = %self.inner.id(),
            snapshot = %name,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            ok = result.is_ok(),
            "snapshot_create completed"
        );

        result
    }

    async fn snapshot_list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.snapshot_store().list(self.inner.id().as_str())
    }

    async fn snapshot_get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        validate_snapshot_name(name)?;
        self.snapshot_store()
            .get_by_name(self.inner.id().as_str(), name)
    }

    async fn snapshot_remove(&self, name: &str) -> BoxliteResult<()> {
        validate_snapshot_name(name)?;
        let _lock = self.inner.disk_ops.lock().await;

        let box_id = self.inner.id().as_str();
        let store = self.snapshot_store();

        let info = store.get_by_name(box_id, name)?.ok_or_else(|| {
            BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                name, box_id
            ))
        })?;

        let snapshot_dir = PathBuf::from(&info.snapshot_dir);
        let snap_container = snapshot_dir.join(disk_filenames::CONTAINER_DISK);
        let container_disk = self
            .inner
            .config
            .box_home
            .join(disk_filenames::CONTAINER_DISK);

        if container_disk.exists()
            && snap_container.exists()
            && let (Ok(Some(backing)), Ok(snap_canonical)) = (
                crate::disk::read_backing_file_path(&container_disk),
                snap_container.canonicalize(),
            )
            && Path::new(&backing) == snap_canonical
        {
            return Err(BoxliteError::InvalidState(
                "Cannot remove snapshot: current disk depends on this snapshot. \
                 Restore a different snapshot first."
                    .to_string(),
            ));
        }

        if snapshot_dir.exists() {
            std::fs::remove_dir_all(&snapshot_dir).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to remove snapshot directory {}: {}",
                    snapshot_dir.display(),
                    e
                ))
            })?;
        }

        store.remove_by_name(box_id, name)?;

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
        let store = self.snapshot_store();

        let info = store.get_by_name(box_id, name)?.ok_or_else(|| {
            BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                name, box_id
            ))
        })?;

        self.do_snapshot_restore(&info)
    }

    fn snapshot_store(&self) -> SnapshotStore {
        SnapshotStore::new(self.inner.runtime.box_manager.db())
    }

    fn do_snapshot_create(
        &self,
        name: &str,
        box_home: &Path,
        container_disk: &Path,
        guest_disk: &Path,
    ) -> BoxliteResult<SnapshotInfo> {
        let snapshot_dir = box_home.join(disk_dirs::SNAPSHOTS_DIR).join(name);
        std::fs::create_dir_all(&snapshot_dir).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create snapshot directory {}: {}",
                snapshot_dir.display(),
                e
            ))
        })?;

        let container_virtual_size = Qcow2Helper::qcow2_virtual_size(container_disk)?;
        let guest_virtual_size = if guest_disk.exists() {
            Qcow2Helper::qcow2_virtual_size(guest_disk)?
        } else {
            0
        };

        // Write crash-recovery marker before moving disks (point of no return).
        let pending_marker = box_home.join(".snapshot_pending");
        let marker_data = serde_json::json!({
            "snapshot_dir": snapshot_dir.to_string_lossy(),
            "container_disk": container_disk.to_string_lossy(),
            "guest_disk": guest_disk.to_string_lossy(),
        });
        std::fs::write(&pending_marker, marker_data.to_string()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to write snapshot marker: {}", e))
        })?;

        let snap_container = snapshot_dir.join(disk_filenames::CONTAINER_DISK);
        std::fs::rename(container_disk, &snap_container).map_err(|e| {
            BoxliteError::Storage(format!("Failed to move container disk to snapshot: {}", e))
        })?;

        if let Err(e) = Qcow2Helper::create_cow_child_disk(
            &snap_container,
            BackingFormat::Qcow2,
            container_disk,
            container_virtual_size,
        ) {
            let mut rollback_errors = Vec::new();
            if let Err(re) = std::fs::rename(&snap_container, container_disk) {
                rollback_errors.push(format!("restore container disk: {}", re));
            }
            if let Err(re) = std::fs::remove_dir_all(&snapshot_dir) {
                rollback_errors.push(format!("remove snapshot dir: {}", re));
            }
            if !rollback_errors.is_empty() {
                tracing::error!(
                    box_id = %self.inner.id(),
                    rollback_errors = ?rollback_errors,
                    "Snapshot rollback partially failed"
                );
                return Err(BoxliteError::Storage(format!(
                    "Snapshot failed AND rollback partially failed: {}. Original error: {}. Box may need manual recovery.",
                    rollback_errors.join("; "),
                    e
                )));
            }
            let _ = std::fs::remove_file(&pending_marker);
            return Err(e);
        }

        if guest_disk.exists() {
            let snap_guest = snapshot_dir.join(disk_filenames::GUEST_ROOTFS_DISK);
            std::fs::rename(guest_disk, &snap_guest).map_err(|e| {
                BoxliteError::Storage(format!("Failed to move guest disk to snapshot: {}", e))
            })?;

            if let Err(e) = Qcow2Helper::create_cow_child_disk(
                &snap_guest,
                BackingFormat::Qcow2,
                guest_disk,
                guest_virtual_size,
            ) {
                let mut rollback_errors = Vec::new();
                if let Err(re) = std::fs::remove_file(container_disk) {
                    rollback_errors.push(format!("remove container COW child: {}", re));
                }
                if let Err(re) = std::fs::rename(&snap_container, container_disk) {
                    rollback_errors.push(format!("restore container disk: {}", re));
                }
                if let Err(re) = std::fs::rename(&snap_guest, guest_disk) {
                    rollback_errors.push(format!("restore guest disk: {}", re));
                }
                if let Err(re) = std::fs::remove_dir_all(&snapshot_dir) {
                    rollback_errors.push(format!("remove snapshot dir: {}", re));
                }
                if !rollback_errors.is_empty() {
                    tracing::error!(
                        box_id = %self.inner.id(),
                        rollback_errors = ?rollback_errors,
                        "Snapshot rollback partially failed"
                    );
                    return Err(BoxliteError::Storage(format!(
                        "Snapshot failed AND rollback partially failed: {}. Original error: {}. Box may need manual recovery.",
                        rollback_errors.join("; "),
                        e
                    )));
                }
                let _ = std::fs::remove_file(&pending_marker);
                return Err(e);
            }
        }

        let size_bytes = dir_size(&snapshot_dir);

        let record = SnapshotInfo {
            id: ulid::Ulid::new().to_string(),
            box_id: self.inner.id().as_str().to_string(),
            name: name.to_string(),
            created_at: Utc::now().timestamp(),
            snapshot_dir: snapshot_dir.to_string_lossy().to_string(),
            guest_disk_bytes: guest_virtual_size,
            container_disk_bytes: container_virtual_size,
            size_bytes,
        };
        self.snapshot_store().save(&record)?;

        // Snapshot complete — remove crash-recovery marker.
        let _ = std::fs::remove_file(&pending_marker);

        tracing::info!(
            box_id = %self.inner.id(),
            snapshot = %name,
            "Created external COW snapshot"
        );

        Ok(record)
    }

    fn do_snapshot_restore(&self, info: &SnapshotInfo) -> BoxliteResult<()> {
        let box_home = &self.inner.config.box_home;
        let snapshot_dir = PathBuf::from(&info.snapshot_dir);

        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let snap_container = snapshot_dir.join(disk_filenames::CONTAINER_DISK);

        if !snap_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Snapshot container disk not found at {}",
                snap_container.display()
            )));
        }

        if container_disk.exists() {
            std::fs::remove_file(&container_disk).map_err(|e| {
                BoxliteError::Storage(format!("Failed to remove current container disk: {}", e))
            })?;
        }

        Qcow2Helper::create_cow_child_disk(
            &snap_container,
            BackingFormat::Qcow2,
            &container_disk,
            info.container_disk_bytes,
        )?;

        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);
        let snap_guest = snapshot_dir.join(disk_filenames::GUEST_ROOTFS_DISK);

        if snap_guest.exists() {
            if guest_disk.exists() {
                std::fs::remove_file(&guest_disk).map_err(|e| {
                    BoxliteError::Storage(format!("Failed to remove current guest disk: {}", e))
                })?;
            }

            Qcow2Helper::create_cow_child_disk(
                &snap_guest,
                BackingFormat::Qcow2,
                &guest_disk,
                info.guest_disk_bytes,
            )?;
        }

        tracing::info!(
            box_id = %self.inner.id(),
            snapshot = %info.name,
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

    let snapshot_dir = marker.get("snapshot_dir").and_then(|v| v.as_str());
    let container_disk = marker.get("container_disk").and_then(|v| v.as_str());
    let guest_disk = marker.get("guest_disk").and_then(|v| v.as_str());

    if let (Some(snap_dir), Some(container_path)) = (snapshot_dir, container_disk) {
        let snap_dir = PathBuf::from(snap_dir);
        let container_path = PathBuf::from(container_path);

        // If container disk is missing but exists in snapshot dir, restore it.
        let snap_container = snap_dir.join(disk_filenames::CONTAINER_DISK);
        if !container_path.exists() && snap_container.exists() {
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
        }

        // Same for guest disk.
        if let Some(guest_path) = guest_disk {
            let guest_path = PathBuf::from(guest_path);
            let snap_guest = snap_dir.join(disk_filenames::GUEST_ROOTFS_DISK);
            if !guest_path.exists() && snap_guest.exists() {
                match std::fs::rename(&snap_guest, &guest_path) {
                    Ok(()) => {
                        tracing::info!(
                            "Recovered guest disk from pending snapshot: {} → {}",
                            snap_guest.display(),
                            guest_path.display()
                        );
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to recover guest disk: {}. Manual recovery needed.",
                            e
                        );
                    }
                }
            }
        }

        // Clean up the (possibly partially created) snapshot directory.
        if snap_dir.exists() {
            let _ = std::fs::remove_dir_all(&snap_dir);
        }
    }

    let _ = std::fs::remove_file(&marker_path);
    tracing::info!(
        box_home = %box_home.display(),
        "Pending snapshot recovery complete"
    );
}

fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_snapshot_name tests ──────────────────────────────────

    #[test]
    fn test_validate_snapshot_name_rejects_path_traversal() {
        assert!(validate_snapshot_name("../etc").is_err());
        assert!(validate_snapshot_name("../../root").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_absolute() {
        assert!(validate_snapshot_name("/etc/shadow").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_backslash() {
        assert!(validate_snapshot_name("foo\\bar").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_null_byte() {
        assert!(validate_snapshot_name("foo\0bar").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_dot_prefix() {
        assert!(validate_snapshot_name(".hidden").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_empty() {
        assert!(validate_snapshot_name("").is_err());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_long() {
        let long_name = "a".repeat(256);
        assert!(validate_snapshot_name(&long_name).is_err());
    }

    #[test]
    fn test_validate_snapshot_name_accepts_valid() {
        assert!(validate_snapshot_name("my-snap_v2.1").is_ok());
        assert!(validate_snapshot_name("UPPER").is_ok());
        assert!(validate_snapshot_name("123").is_ok());
        assert!(validate_snapshot_name(&"a".repeat(255)).is_ok());
    }

    #[test]
    fn test_validate_snapshot_name_rejects_dot_and_dotdot() {
        assert!(validate_snapshot_name(".").is_err());
        assert!(validate_snapshot_name("..").is_err());
    }

    // ── recover_pending_snapshot tests ────────────────────────────────

    #[test]
    fn test_recover_pending_snapshot_restores_disk() {
        let dir = tempfile::TempDir::new().unwrap();
        let box_home = dir.path();

        let snap_dir = box_home.join("snapshots").join("test-snap");
        std::fs::create_dir_all(&snap_dir).unwrap();

        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let snap_container = snap_dir.join(disk_filenames::CONTAINER_DISK);

        // Simulate crash: disk moved to snapshot dir, no COW child created.
        std::fs::write(&snap_container, b"disk-data").unwrap();
        assert!(!container_disk.exists());

        // Write marker.
        let marker = serde_json::json!({
            "snapshot_dir": snap_dir.to_string_lossy(),
            "container_disk": container_disk.to_string_lossy(),
            "guest_disk": box_home.join(disk_filenames::GUEST_ROOTFS_DISK).to_string_lossy(),
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
}
