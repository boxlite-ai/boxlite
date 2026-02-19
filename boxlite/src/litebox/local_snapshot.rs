//! Local `BoxImpl` implementation for snapshot/clone/export operations.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::LiteBox;
use crate::db::SnapshotStore;
use crate::db::snapshots::SnapshotInfo;
use crate::disk::constants::dirs as disk_dirs;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::qemu_img;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::box_impl::BoxImpl;
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::litebox::state::BoxStatus;
use crate::runtime::ArchiveManifest;
use crate::runtime::constants::filenames as rt_filenames;
use crate::runtime::options::{CloneOptions, ExportOptions, SnapshotOptions};
use crate::runtime::types::{BoxID, BoxState, ContainerID};
use crate::vmm::VmmKind;

const ARCHIVE_VERSION: u32 = 2;
const MANIFEST_FILENAME: &str = "manifest.json";

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
        self.inner.require_stopped_for("snapshot")?;

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

        {
            let mut state = self.inner.state.write();
            state.transition_to(BoxStatus::Snapshotting)?;
            self.inner
                .runtime
                .box_manager
                .save_box(self.inner.id(), &state)?;
        }

        let result = self.do_snapshot_create(name, &box_home, &container_disk, &guest_disk);

        {
            let mut state = self.inner.state.write();
            state.force_status(BoxStatus::Stopped);
            let _ = self
                .inner
                .runtime
                .box_manager
                .save_box(self.inner.id(), &state);
        }

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
        self.inner.require_stopped_for("snapshot remove")?;

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
            && let (Ok(backing), Ok(snap_canonical)) = (
                read_backing_file(&container_disk),
                snap_container.canonicalize(),
            )
            && backing == snap_canonical
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
        self.inner.require_stopped_for("snapshot restore")?;

        let box_id = self.inner.id().as_str();
        let store = self.snapshot_store();

        let info = store.get_by_name(box_id, name)?.ok_or_else(|| {
            BoxliteError::NotFound(format!(
                "snapshot '{}' not found for box '{}'",
                name, box_id
            ))
        })?;

        {
            let mut state = self.inner.state.write();
            state.transition_to(BoxStatus::Restoring)?;
            self.inner
                .runtime
                .box_manager
                .save_box(self.inner.id(), &state)?;
        }

        let result = self.do_snapshot_restore(&info);

        {
            let mut state = self.inner.state.write();
            state.force_status(BoxStatus::Stopped);
            let _ = self
                .inner
                .runtime
                .box_manager
                .save_box(self.inner.id(), &state);
        }

        result
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

        let qcow2 = Qcow2Helper::new();

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

        if let Err(e) = qcow2.create_cow_child_disk(
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

            if let Err(e) = qcow2.create_cow_child_disk(
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
        let qcow2 = Qcow2Helper::new();

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

        qcow2.create_cow_child_disk(
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

            qcow2.create_cow_child_disk(
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

impl BoxImpl {
    pub(crate) async fn clone_box(
        &self,
        options: CloneOptions,
        name: &str,
    ) -> BoxliteResult<LiteBox> {
        self.require_stopped_for("clone")?;

        let rt = Arc::clone(&self.runtime);
        let src_home = self.config.box_home.clone();

        let (src_container, src_guest) = if let Some(ref snap_name) = options.from_snapshot {
            let snap_dir = src_home.join(disk_dirs::SNAPSHOTS_DIR).join(snap_name);
            if !snap_dir.exists() {
                return Err(BoxliteError::NotFound(format!(
                    "snapshot '{}' not found for box '{}'",
                    snap_name,
                    self.id()
                )));
            }
            (
                snap_dir.join(disk_filenames::CONTAINER_DISK),
                snap_dir.join(disk_filenames::GUEST_ROOTFS_DISK),
            )
        } else {
            (
                src_home.join(disk_filenames::CONTAINER_DISK),
                src_home.join(disk_filenames::GUEST_ROOTFS_DISK),
            )
        };

        if !src_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                src_container.display()
            )));
        }

        let box_id = BoxID::new();
        let container_id = ContainerID::new();
        let now = Utc::now();

        let box_home = rt.layout.boxes_dir().join(box_id.as_str());
        let socket_path = rt_filenames::unix_socket_path(rt.layout.home_dir(), box_id.as_str());
        let ready_socket_path = box_home.join("sockets").join("ready.sock");

        std::fs::create_dir_all(&box_home).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create box directory {}: {}",
                box_home.display(),
                e
            ))
        })?;

        let dst_container = box_home.join(disk_filenames::CONTAINER_DISK);
        let clone_result = if options.cow {
            clone_cow(&src_container, &dst_container, &src_guest, &box_home)
        } else {
            clone_full_copy(&src_container, &dst_container, &src_guest, &box_home)
        };

        if let Err(e) = clone_result {
            let _ = std::fs::remove_dir_all(&box_home);
            return Err(e);
        }

        let config = BoxConfig {
            id: box_id.clone(),
            name: Some(name.to_string()),
            created_at: now,
            container: ContainerRuntimeConfig { id: container_id },
            options: self.config.options.clone(),
            engine_kind: VmmKind::Libkrun,
            transport: boxlite_shared::Transport::unix(socket_path),
            box_home,
            ready_socket_path,
        };

        let mut state = BoxState::new();
        state.set_status(BoxStatus::Stopped);

        let lock_id = rt.lock_manager.allocate()?;
        state.set_lock_id(lock_id);

        if let Err(e) = rt.box_manager.add_box(&config, &state) {
            let _ = rt.lock_manager.free(lock_id);
            let _ = std::fs::remove_dir_all(&config.box_home);
            return Err(e);
        }

        tracing::info!(
            box_id = %config.id,
            source_id = %self.id(),
            cow = %options.cow,
            "Cloned box"
        );

        let litebox = rt.get(box_id.as_str()).await?.ok_or_else(|| {
            BoxliteError::Internal("Cloned box not found after persist".to_string())
        })?;

        if options.start_after_clone {
            litebox.start().await?;
        }

        Ok(litebox)
    }

    pub(crate) async fn export_box(
        &self,
        options: ExportOptions,
        dest: &Path,
    ) -> BoxliteResult<PathBuf> {
        self.require_stopped_for("export")?;

        {
            let mut state = self.state.write();
            state.transition_to(BoxStatus::Exporting)?;
            self.runtime.box_manager.save_box(self.id(), &state)?;
        }

        let result = self.do_export_box(&options, dest);

        {
            let mut state = self.state.write();
            state.force_status(BoxStatus::Stopped);
            let _ = self.runtime.box_manager.save_box(self.id(), &state);
        }

        result
    }

    fn require_stopped_for(&self, operation: &str) -> BoxliteResult<()> {
        let state = self.state.read();
        if !state.status.is_stopped() {
            return Err(BoxliteError::InvalidState(format!(
                "box '{}' must be stopped for {} (current status: {})",
                self.id(),
                operation,
                state.status
            )));
        }
        Ok(())
    }

    fn do_export_box(&self, options: &ExportOptions, dest: &Path) -> BoxliteResult<PathBuf> {
        let box_home = &self.config.box_home;
        let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
        let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

        if !container_disk.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                container_disk.display()
            )));
        }

        let output_path = if dest.is_dir() {
            let name = self.config.name.as_deref().unwrap_or("box");
            dest.join(format!("{}.boxsnap", name))
        } else {
            dest.to_path_buf()
        };

        let temp_dir = tempfile::tempdir_in(self.runtime.layout.temp_dir()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create temp directory: {}", e))
        })?;

        let flat_container = temp_dir.path().join(disk_filenames::CONTAINER_DISK);
        qemu_img::convert(&container_disk, &flat_container)?;

        let flat_guest = if guest_disk.exists() {
            let flat = temp_dir.path().join(disk_filenames::GUEST_ROOTFS_DISK);
            qemu_img::convert(&guest_disk, &flat)?;
            Some(flat)
        } else {
            None
        };

        let container_disk_checksum = sha256_file(&flat_container)?;
        let guest_disk_checksum = match flat_guest {
            Some(ref fg) => sha256_file(fg)?,
            None => String::new(),
        };

        let image = match &self.config.options.rootfs {
            crate::runtime::options::RootfsSpec::Image(img) => img.clone(),
            crate::runtime::options::RootfsSpec::RootfsPath(path) => path.clone(),
        };

        let manifest = ArchiveManifest {
            version: ARCHIVE_VERSION,
            box_name: self.config.name.clone(),
            image,
            guest_disk_checksum,
            container_disk_checksum,
            exported_at: Utc::now().to_rfc3339(),
        };

        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| BoxliteError::Internal(format!("Failed to serialize manifest: {}", e)))?;
        let manifest_path = temp_dir.path().join(MANIFEST_FILENAME);
        std::fs::write(&manifest_path, manifest_json)?;

        if options.compress {
            build_zstd_tar_archive(
                &output_path,
                &manifest_path,
                &flat_container,
                flat_guest.as_deref(),
                options.compression_level,
            )?;
        } else {
            build_tar_archive(
                &output_path,
                &manifest_path,
                &flat_container,
                flat_guest.as_deref(),
            )?;
        }

        tracing::info!(
            box_id = %self.id(),
            output = %output_path.display(),
            compressed = %options.compress,
            "Exported box to archive"
        );

        Ok(output_path)
    }
}

fn clone_cow(
    src_container: &Path,
    dst_container: &Path,
    src_guest: &Path,
    box_home: &Path,
) -> BoxliteResult<()> {
    let qcow2 = Qcow2Helper::new();
    let container_size = Qcow2Helper::qcow2_virtual_size(src_container)?;

    qcow2.create_cow_child_disk(
        src_container,
        BackingFormat::Qcow2,
        dst_container,
        container_size,
    )?;

    if src_guest.exists() {
        let guest_size = Qcow2Helper::qcow2_virtual_size(src_guest)?;
        let dst_guest = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);
        qcow2.create_cow_child_disk(src_guest, BackingFormat::Qcow2, &dst_guest, guest_size)?;
    }

    Ok(())
}

fn clone_full_copy(
    src_container: &Path,
    dst_container: &Path,
    src_guest: &Path,
    box_home: &Path,
) -> BoxliteResult<()> {
    qemu_img::full_copy(src_container, dst_container)?;

    if src_guest.exists() {
        let dst_guest = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);
        qemu_img::full_copy(src_guest, &dst_guest)?;
    }

    Ok(())
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

fn read_backing_file(disk_path: &Path) -> BoxliteResult<PathBuf> {
    use std::io::Read;
    use std::io::Seek;

    let mut file = std::fs::File::open(disk_path).map_err(|e| {
        BoxliteError::Storage(format!("Failed to open {}: {}", disk_path.display(), e))
    })?;

    let mut header = [0u8; 32];
    file.read_exact(&mut header).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read header from {}: {}",
            disk_path.display(),
            e
        ))
    })?;

    let backing_offset = u64::from_be_bytes([
        header[8], header[9], header[10], header[11], header[12], header[13], header[14],
        header[15],
    ]);
    let backing_size = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);

    if backing_offset == 0 || backing_size == 0 {
        return Err(BoxliteError::Storage(format!(
            "No backing file in {}",
            disk_path.display()
        )));
    }

    file.seek(std::io::SeekFrom::Start(backing_offset))
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to seek to backing file path in {}: {}",
                disk_path.display(),
                e
            ))
        })?;

    let mut buf = vec![0u8; backing_size as usize];
    file.read_exact(&mut buf).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read backing file path from {}: {}",
            disk_path.display(),
            e
        ))
    })?;

    let path_str = String::from_utf8(buf).map_err(|e| {
        BoxliteError::Storage(format!(
            "Invalid backing file path in {}: {}",
            disk_path.display(),
            e
        ))
    })?;

    Ok(PathBuf::from(path_str))
}

fn build_tar_archive(
    output_path: &Path,
    manifest_path: &Path,
    container_disk: &Path,
    guest_disk: Option<&Path>,
) -> BoxliteResult<()> {
    let file = std::fs::File::create(output_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create archive file {}: {}",
            output_path.display(),
            e
        ))
    })?;

    let mut builder = tar::Builder::new(file);
    append_archive_files(&mut builder, manifest_path, container_disk, guest_disk)?;
    builder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finalize archive: {}", e)))?;

    Ok(())
}

fn build_zstd_tar_archive(
    output_path: &Path,
    manifest_path: &Path,
    container_disk: &Path,
    guest_disk: Option<&Path>,
    compression_level: i32,
) -> BoxliteResult<()> {
    let file = std::fs::File::create(output_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create archive file {}: {}",
            output_path.display(),
            e
        ))
    })?;

    let encoder = zstd::Encoder::new(file, compression_level)
        .map_err(|e| BoxliteError::Storage(format!("Failed to create zstd encoder: {}", e)))?;

    let mut builder = tar::Builder::new(encoder);
    append_archive_files(&mut builder, manifest_path, container_disk, guest_disk)?;

    let encoder = builder
        .into_inner()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finalize tar: {}", e)))?;
    encoder
        .finish()
        .map_err(|e| BoxliteError::Storage(format!("Failed to finish zstd compression: {}", e)))?;

    Ok(())
}

fn append_archive_files<W: Write>(
    builder: &mut tar::Builder<W>,
    manifest_path: &Path,
    container_disk: &Path,
    guest_disk: Option<&Path>,
) -> BoxliteResult<()> {
    builder
        .append_path_with_name(manifest_path, MANIFEST_FILENAME)
        .map_err(|e| BoxliteError::Storage(format!("Failed to add manifest to archive: {}", e)))?;

    builder
        .append_path_with_name(container_disk, disk_filenames::CONTAINER_DISK)
        .map_err(|e| {
            BoxliteError::Storage(format!("Failed to add container disk to archive: {}", e))
        })?;

    if let Some(guest) = guest_disk {
        builder
            .append_path_with_name(guest, disk_filenames::GUEST_ROOTFS_DISK)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to add guest rootfs disk to archive: {}", e))
            })?;
    }

    Ok(())
}

fn sha256_file(path: &Path) -> BoxliteResult<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to open {} for checksum: {}",
            path.display(),
            e
        ))
    })?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read {} for checksum: {}",
                path.display(),
                e
            ))
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(format!("sha256:{:x}", hasher.finalize()))
}
