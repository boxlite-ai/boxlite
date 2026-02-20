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
        self.snapshot_store()
            .get_by_name(self.inner.id().as_str(), name)
    }

    async fn snapshot_remove(&self, name: &str) -> BoxliteResult<()> {
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
            let _ = std::fs::rename(&snap_container, container_disk);
            let _ = std::fs::remove_dir_all(&snapshot_dir);
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
                let _ = std::fs::remove_file(container_disk);
                let _ = std::fs::rename(&snap_container, container_disk);
                let _ = std::fs::rename(&snap_guest, guest_disk);
                let _ = std::fs::remove_dir_all(&snapshot_dir);
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

fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}
