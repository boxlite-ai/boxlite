//! Clone and export operations for BoxImpl.

use std::sync::Arc;
use std::time::Instant;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::box_impl::BoxImpl;
use crate::runtime::types::BoxStatus;

// ============================================================================
// CLONE / EXPORT OPERATIONS
// ============================================================================

impl BoxImpl {
    pub(crate) async fn clone_box(
        &self,
        _options: crate::runtime::options::CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<crate::LiteBox> {
        let t0 = Instant::now();
        let _lock = self.disk_ops.lock().await;

        let rt = Arc::clone(&self.runtime);
        let src_home = self.config.box_home.clone();

        let src_container = src_home.join(crate::disk::constants::filenames::CONTAINER_DISK);
        let src_guest = src_home.join(crate::disk::constants::filenames::GUEST_ROOTFS_DISK);

        if !src_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                src_container.display()
            )));
        }

        // Create a temporary box_home directory for the clone.
        // provision_box will take ownership; we clean up on disk-copy failure.
        let temp_box_home = tempfile::tempdir_in(rt.layout.boxes_dir()).map_err(|e| {
            BoxliteError::Storage(format!("Failed to create temp box directory: {}", e))
        })?;
        #[allow(deprecated)] // into_path renamed to keep() in newer tempfile
        let box_home = temp_box_home.into_path();

        // Quiesce the VM during disk copy for point-in-time consistency.
        let dst_container = box_home.join(crate::disk::constants::filenames::CONTAINER_DISK);
        let clone_result = self
            .with_quiesce_async(async {
                crate::disk::Qcow2Helper::clone_disk_pair(
                    &src_container,
                    &dst_container,
                    &src_guest,
                    &box_home,
                )
            })
            .await;

        if let Err(e) = clone_result {
            let _ = std::fs::remove_dir_all(&box_home);
            return Err(e);
        }

        let litebox = rt
            .provision_box(
                box_home,
                name,
                self.config.options.clone(),
                BoxStatus::Stopped,
            )
            .await?;

        tracing::info!(
            box_id = %litebox.id(),
            source_id = %self.id(),
            elapsed_ms = t0.elapsed().as_millis() as u64,
            "Cloned box (COW)"
        );

        Ok(litebox)
    }

    pub(crate) async fn export_box(
        &self,
        _options: crate::runtime::options::ExportOptions,
        dest: &std::path::Path,
    ) -> BoxliteResult<crate::runtime::options::BoxArchive> {
        let t0 = Instant::now();
        let _lock = self.disk_ops.lock().await;

        let box_home = self.config.box_home.clone();
        let runtime_layout = self.runtime.layout.clone();

        // Phase 1: Flatten disks inside quiesce bracket (VM paused only for this).
        // Flatten reads live qcow2 chains and must see consistent disk state.
        let flatten_result = self
            .with_quiesce_async(async {
                let bh = box_home.clone();
                let rl = runtime_layout.clone();
                tokio::task::spawn_blocking(move || do_export_flatten(&bh, &rl))
                    .await
                    .map_err(|e| {
                        BoxliteError::Internal(format!("Export flatten task panicked: {}", e))
                    })?
            })
            .await?;

        // Phase 2: Checksum + manifest + archive run with VM resumed.
        // These only read static temp files, no disk consistency needed.
        let config_name = self.config.name.clone();
        let config_options = self.config.options.clone();
        let box_id_str = self.id().to_string();
        let dest = dest.to_path_buf();

        let result = tokio::task::spawn_blocking(move || {
            do_export_finalize(
                flatten_result,
                config_name.as_deref(),
                &config_options,
                &box_id_str,
                &dest,
            )
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("Export finalize task panicked: {}", e)))?;

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            ok = result.is_ok(),
            "export_box completed"
        );

        result
    }
}

/// Intermediate result from flatten phase, passed to finalize phase.
struct FlattenResult {
    temp_dir: tempfile::TempDir,
    flat_container: std::path::PathBuf,
    flat_guest: Option<std::path::PathBuf>,
    flatten_ms: u64,
}

/// Phase 1: Flatten qcow2 disk chains into standalone images.
/// Runs inside the quiesce bracket — this is the only part that needs disk consistency.
fn do_export_flatten(
    box_home: &std::path::Path,
    runtime_layout: &crate::runtime::layout::FilesystemLayout,
) -> BoxliteResult<FlattenResult> {
    use crate::disk::Qcow2Helper;
    use crate::disk::constants::filenames as disk_filenames;

    let container_disk = box_home.join(disk_filenames::CONTAINER_DISK);
    let guest_disk = box_home.join(disk_filenames::GUEST_ROOTFS_DISK);

    if !container_disk.exists() {
        return Err(BoxliteError::Storage(format!(
            "Container disk not found at {}",
            container_disk.display()
        )));
    }

    let temp_dir = tempfile::tempdir_in(runtime_layout.temp_dir())
        .map_err(|e| BoxliteError::Storage(format!("Failed to create temp directory: {}", e)))?;

    let t_flatten = Instant::now();
    let flat_container = temp_dir.path().join(disk_filenames::CONTAINER_DISK);
    Qcow2Helper::flatten(&container_disk, &flat_container)?;

    let flat_guest = if guest_disk.exists() {
        let flat = temp_dir.path().join(disk_filenames::GUEST_ROOTFS_DISK);
        Qcow2Helper::flatten(&guest_disk, &flat)?;
        Some(flat)
    } else {
        None
    };
    let flatten_ms = t_flatten.elapsed().as_millis() as u64;

    Ok(FlattenResult {
        temp_dir,
        flat_container,
        flat_guest,
        flatten_ms,
    })
}

/// Phase 2: Checksum, manifest, and archive.
/// Runs after the VM resumes — only reads static temp files.
fn do_export_finalize(
    flatten: FlattenResult,
    config_name: Option<&str>,
    config_options: &crate::runtime::options::BoxOptions,
    box_id_str: &str,
    dest: &std::path::Path,
) -> BoxliteResult<crate::runtime::options::BoxArchive> {
    use crate::archive::{
        ARCHIVE_VERSION, ArchiveManifest, MANIFEST_FILENAME, build_zstd_tar_archive, sha256_file,
    };

    let output_path = if dest.is_dir() {
        let name = config_name.unwrap_or("box");
        dest.join(format!("{}.boxlite", name))
    } else {
        dest.to_path_buf()
    };

    let t_checksum = Instant::now();
    let container_disk_checksum = sha256_file(&flatten.flat_container)?;
    let guest_disk_checksum = match flatten.flat_guest {
        Some(ref fg) => sha256_file(fg)?,
        None => String::new(),
    };
    let checksum_ms = t_checksum.elapsed().as_millis() as u64;

    let image = match &config_options.rootfs {
        crate::runtime::options::RootfsSpec::Image(img) => img.clone(),
        crate::runtime::options::RootfsSpec::RootfsPath(path) => path.clone(),
    };

    let manifest = ArchiveManifest {
        version: ARCHIVE_VERSION,
        box_name: config_name.map(|s| s.to_string()),
        image,
        box_options: Some(config_options.clone()),
        guest_disk_checksum,
        container_disk_checksum,
        exported_at: chrono::Utc::now().to_rfc3339(),
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| BoxliteError::Internal(format!("Failed to serialize manifest: {}", e)))?;
    let manifest_path = flatten.temp_dir.path().join(MANIFEST_FILENAME);
    std::fs::write(&manifest_path, manifest_json)?;

    let t_archive = Instant::now();
    build_zstd_tar_archive(
        &output_path,
        &manifest_path,
        &flatten.flat_container,
        flatten.flat_guest.as_deref(),
        3,
    )?;
    let archive_ms = t_archive.elapsed().as_millis() as u64;

    tracing::info!(
        box_id = %box_id_str,
        output = %output_path.display(),
        flatten_ms = flatten.flatten_ms,
        checksum_ms,
        archive_ms,
        "Exported box to archive"
    );

    Ok(crate::runtime::options::BoxArchive::new(output_path))
}
