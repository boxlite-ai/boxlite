//! Clone and export operations for BoxImpl.

use std::sync::Arc;
use std::time::Instant;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::box_impl::BoxImpl;
use crate::disk::BaseDiskKind;
use crate::disk::constants::filenames as disk_filenames;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::runtime::types::BoxStatus;

// ============================================================================
// CLONE / EXPORT OPERATIONS
// ============================================================================

impl BoxImpl {
    pub(crate) async fn clone_box(
        &self,
        options: crate::runtime::options::CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<crate::LiteBox> {
        // Single clone delegates to batch clone with count=1.
        let names = match name {
            Some(n) => vec![n],
            None => Vec::new(),
        };
        let mut clones = self.clone_boxes(options, 1, names).await?;
        Ok(clones.remove(0))
    }

    /// Batch clone: create N clones sharing a single base disk layer.
    ///
    /// Three-phase flow (snapshot-as-base):
    ///   A. Inside quiesce bracket (VM paused): create disk layer (rename + COW child).
    ///   B. Outside quiesce bracket (VM resumed): create N thin overlay headers.
    ///   C. Provision each clone and increment layer ref count.
    pub(crate) async fn clone_boxes(
        &self,
        _options: crate::runtime::options::CloneOptions,
        count: usize,
        names: Vec<String>,
    ) -> BoxliteResult<Vec<crate::LiteBox>> {
        if count == 0 {
            return Ok(Vec::new());
        }

        if !names.is_empty() && names.len() != count {
            return Err(BoxliteError::Config(format!(
                "names length ({}) must match count ({})",
                names.len(),
                count
            )));
        }

        let t0 = Instant::now();
        let _lock = self.disk_ops.lock().await;

        let rt = Arc::clone(&self.runtime);
        let src_disks = self.config.box_home.join("disks");
        let src_container = src_disks.join(disk_filenames::CONTAINER_DISK);

        if !src_container.exists() {
            return Err(BoxliteError::Storage(format!(
                "Container disk not found at {}",
                src_container.display()
            )));
        }

        // Phase A: Create shared base layer inside quiesce bracket (VM paused).
        // This is the same operation as snapshot creation: rename + COW child.
        let source_box_id = self.id().to_string();
        let layer = {
            let src_disks = src_disks.clone();
            let source_box_id = source_box_id.clone();

            self.with_quiesce_async(async {
                rt.base_disk_mgr.create_base_disk(
                    &src_disks,
                    BaseDiskKind::CloneBase,
                    None,
                    &source_box_id,
                )
            })
            .await?
        };

        // base_path is a flat file (e.g., bases/{nanoid}.qcow2)
        let shared_container = layer.disk_info.to_path_buf();

        // Read virtual size from the shared base for overlay creation.
        let container_vsize = Qcow2Helper::qcow2_virtual_size(&shared_container)?;

        // Phase B: Create N container overlay headers (VM is resumed, fast).
        // Guest rootfs is NOT cloned — each clone creates its own on first start.
        let mut staging_dirs = Vec::with_capacity(count);
        for _ in 0..count {
            let temp = tempfile::tempdir_in(rt.layout.boxes_dir()).map_err(|e| {
                BoxliteError::Storage(format!("Failed to create temp box directory: {}", e))
            })?;
            #[allow(deprecated)]
            let staging = temp.into_path();

            let staging_disks = staging.join("disks");
            std::fs::create_dir_all(&staging_disks).map_err(|e| {
                BoxliteError::Storage(format!("Failed to create staging disks dir: {}", e))
            })?;

            // Container overlay → shared base (qcow2 backing qcow2)
            // leak() prevents the Disk RAII guard from deleting the file on drop —
            // the child is the clone's persistent disk and must outlive this function.
            Qcow2Helper::create_cow_child_disk(
                &shared_container,
                BackingFormat::Qcow2,
                &staging_disks.join(disk_filenames::CONTAINER_DISK),
                container_vsize,
            )?
            .leak();

            staging_dirs.push(staging);
        }

        // Phase C: Provision each clone and record base disk refs.
        let mut clones = Vec::with_capacity(count);
        for (i, staging) in staging_dirs.into_iter().enumerate() {
            let litebox = match rt
                .provision_box(
                    staging.clone(),
                    names.get(i).cloned(),
                    self.config.options.clone(),
                    BoxStatus::Stopped,
                )
                .await
            {
                Ok(lb) => lb,
                Err(e) => {
                    // Cleanup remaining staging dirs on failure.
                    let _ = std::fs::remove_dir_all(&staging);
                    // Don't clean up already-provisioned clones; they're valid boxes.
                    return Err(e);
                }
            };

            // Record that this clone depends on the shared base disk.
            if let Err(e) = rt
                .base_disk_mgr
                .store()
                .add_ref(&layer.id, litebox.id().as_ref())
            {
                tracing::warn!(
                    clone_id = %litebox.id(),
                    base_disk_id = %layer.id,
                    error = %e,
                    "Failed to record base disk ref for clone"
                );
            }

            clones.push(litebox);
        }

        tracing::info!(
            source_id = %self.id(),
            base_disk_id = %layer.id,
            count = clones.len(),
            elapsed_ms = t0.elapsed().as_millis() as u64,
            "Batch cloned boxes (shared base disk)"
        );

        Ok(clones)
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

    let disks_dir = box_home.join("disks");
    let container_disk = disks_dir.join(disk_filenames::CONTAINER_DISK);
    let guest_disk = disks_dir.join(disk_filenames::GUEST_ROOTFS_DISK);

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
    use super::archive::{
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
