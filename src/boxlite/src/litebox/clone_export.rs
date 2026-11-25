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
    fn options_for_copy(&self) -> BoxliteResult<crate::runtime::options::BoxOptions> {
        let mut options = self.config.options.clone();
        let state = self.runtime.box_manager.update_box(self.id())?;
        options.disk_size_gb = state.disk_size_gb.or(options.disk_size_gb);
        if let Some(policy) = state.outbound_policy {
            options.network = policy.try_into()?;
        }
        Ok(options)
    }

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
    ///   C. Provision each clone atomically with its layer dependency.
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
        let source_admission =
            Arc::new(crate::lock::OwnedLockGuard::new_async(self.disk_locker()?).await);
        self.ensure_box_exists()?;
        (async {
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
                let staging_disks = temp.path().join("disks");
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

                staging_dirs.push(temp);
            }

            // Phase C: Provision each clone and record base disk refs.
            // Each clone's disk is a copy of this one, so it runs the same build.
            // Read before the loop: the state lock must not be held across an await.
            let resolved_image = self.state.read().resolved_image.clone();
            let copy_options = self.options_for_copy()?;
            let mut clones = Vec::with_capacity(count);
            for (i, staging) in staging_dirs.into_iter().enumerate() {
                // Keep the TempDir alive until provisioning moves it to the final box home.
                // On failure, it and all remaining staging dirs are cleaned up on drop.
                let litebox = rt
                    .provision_box(
                        staging.path().to_path_buf(),
                        names.get(i).cloned(),
                        copy_options.clone(),
                        BoxStatus::Stopped,
                        resolved_image.clone(),
                        Some(crate::runtime::rt_impl::CloneDependency {
                            base_disk_id: layer.id.clone(),
                            source_admission: Arc::clone(&source_admission),
                        }),
                    )
                    .await?;

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
        })
        .await
    }

    pub(crate) async fn export_box(
        &self,
        options: crate::runtime::options::ExportOptions,
        dest: &std::path::Path,
    ) -> BoxliteResult<crate::runtime::options::BoxArchive> {
        if options.include_memory {
            return self.export_full_checkpoint(dest).await;
        }

        let t0 = Instant::now();
        self.with_disk_admission(async {
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
            let config_options = self.options_for_copy()?;
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
        })
        .await
    }

    async fn export_full_checkpoint(
        &self,
        dest: &std::path::Path,
    ) -> BoxliteResult<crate::runtime::options::BoxArchive> {
        use crate::runtime::options::NetworkMode;

        if !self.config.options.secrets.is_empty() {
            return Err(BoxliteError::Unsupported(
                "full memory checkpoint export is not supported for boxes with secrets".into(),
            ));
        }
        let t0 = Instant::now();
        let platform = super::archive::current_checkpoint_platform().ok_or_else(|| {
            BoxliteError::Unsupported(
                "full memory checkpoint export is only supported on macos-aarch64-hvf and linux-x86_64-kvm".into(),
            )
        })?;
        let captured = self.capture_full_checkpoint_to_dir().await?;

        let config_name = self.config.name.clone();
        let mut config_options = self.config.options.clone();
        if let Some(policy) = &captured.outbound_policy
            && policy.mode == NetworkMode::Enabled
        {
            config_options.network = policy.clone().try_into()?;
        }
        // A runtime egress block belongs in checkpoint metadata, not the NIC config.
        let box_id_str = self.id().to_string();
        let container_id_str = self.config.container.id.as_str().to_owned();
        let dest = dest.to_path_buf();

        let result = tokio::task::spawn_blocking(move || {
            do_export_full_finalize(
                captured,
                config_name.as_deref(),
                &config_options,
                &box_id_str,
                &container_id_str,
                platform,
                &dest,
            )
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("Export finalize task panicked: {}", e)))?;

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            ok = result.is_ok(),
            "export_box (full checkpoint) completed"
        );

        result
    }
}

fn resolve_export_output_path(
    dest: &std::path::Path,
    config_name: Option<&str>,
) -> std::path::PathBuf {
    if dest.is_dir() {
        let name = config_name.unwrap_or("box");
        dest.join(format!("{}.boxlite", name))
    } else {
        dest.to_path_buf()
    }
}

fn image_name_for_export(
    config_options: &crate::runtime::options::BoxOptions,
) -> BoxliteResult<String> {
    match &config_options.rootfs {
        crate::runtime::options::RootfsSpec::Image(img) => Ok(img.clone()),
        crate::runtime::options::RootfsSpec::RootfsPath(path) => Ok(path.clone()),
        crate::runtime::options::RootfsSpec::Checkpoint(_) => Err(BoxliteError::Unsupported(
            crate::runtime::checkpoints::UNSUPPORTED_ON_LOCAL.into(),
        )),
    }
}

/// Intermediate result from flatten phase, passed to finalize phase.
struct FlattenResult {
    temp_dir: tempfile::TempDir,
    flat_container: std::path::PathBuf,
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

    let flatten_ms = t_flatten.elapsed().as_millis() as u64;

    Ok(FlattenResult {
        temp_dir,
        flat_container,
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
        ArchiveManifest, MANIFEST_FILENAME, archive_version_for_options, build_zstd_tar_archive,
        sha256_file,
    };

    let output_path = resolve_export_output_path(dest, config_name);

    let t_checksum = Instant::now();
    let container_disk_checksum = sha256_file(&flatten.flat_container)?;
    let checksum_ms = t_checksum.elapsed().as_millis() as u64;

    let image = image_name_for_export(config_options)?;

    let manifest = ArchiveManifest {
        version: archive_version_for_options(config_options),
        box_name: config_name.map(|s| s.to_string()),
        image,
        box_options: Some(config_options.clone()),
        guest_disk_checksum: String::new(),
        container_disk_checksum,
        memory_checkpoint: None,
        exported_at: chrono::Utc::now().to_rfc3339(),
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| BoxliteError::Internal(format!("Failed to serialize manifest: {}", e)))?;
    let manifest_path = flatten.temp_dir.path().join(MANIFEST_FILENAME);
    std::fs::write(&manifest_path, manifest_json)?;

    let t_archive = Instant::now();
    build_zstd_tar_archive(&output_path, &manifest_path, &flatten.flat_container, 3)?;
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

fn do_export_full_finalize(
    captured: super::box_impl::CapturedFullCheckpoint,
    config_name: Option<&str>,
    config_options: &crate::runtime::options::BoxOptions,
    box_id_str: &str,
    container_id_str: &str,
    platform: &str,
    dest: &std::path::Path,
) -> BoxliteResult<crate::runtime::options::BoxArchive> {
    use super::archive::{
        ArchiveManifest, MANIFEST_FILENAME, MEMORY_CHECKPOINT_ARCHIVE_VERSION,
        MemoryCheckpointArchiveMetadata, build_zstd_tar_archive_with_memory, sha256_file,
    };

    let output_path = resolve_export_output_path(dest, config_name);

    let t_checksum = Instant::now();
    let container_disk_checksum = sha256_file(&captured.disk_path)?;
    let vmstate_checksum = sha256_file(&captured.vmstate_path)?;
    let guest_rootfs_checksum = sha256_file(&captured.guest_rootfs_path)?;
    let checksum_ms = t_checksum.elapsed().as_millis() as u64;

    let image = image_name_for_export(config_options)?;

    let manifest = ArchiveManifest {
        version: MEMORY_CHECKPOINT_ARCHIVE_VERSION,
        box_name: config_name.map(|s| s.to_string()),
        image,
        box_options: Some(config_options.clone()),
        guest_disk_checksum: String::new(),
        container_disk_checksum,
        memory_checkpoint: Some(MemoryCheckpointArchiveMetadata {
            platform: platform.to_string(),
            container_id: container_id_str.to_string(),
            vmstate_checksum,
            vmstate_size_bytes: captured.vmstate_size_bytes,
            guest_rootfs_checksum,
            outbound_disabled: captured.outbound_policy.as_ref().is_some_and(|policy| {
                policy.mode == crate::runtime::options::NetworkMode::Disabled
            }),
        }),
        exported_at: chrono::Utc::now().to_rfc3339(),
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| BoxliteError::Internal(format!("Failed to serialize manifest: {}", e)))?;
    let manifest_path = captured.staging_dir.path().join(MANIFEST_FILENAME);
    std::fs::write(&manifest_path, manifest_json)?;

    let t_archive = Instant::now();
    build_zstd_tar_archive_with_memory(
        &output_path,
        &manifest_path,
        &captured.disk_path,
        &captured.vmstate_path,
        &captured.guest_rootfs_path,
        3,
    )?;
    let archive_ms = t_archive.elapsed().as_millis() as u64;

    tracing::info!(
        box_id = %box_id_str,
        output = %output_path.display(),
        vmstate_size_bytes = captured.vmstate_size_bytes,
        checksum_ms,
        archive_ms,
        "Exported box with full memory checkpoint to archive"
    );

    Ok(crate::runtime::options::BoxArchive::new(output_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::options::{BoxOptions, BoxliteOptions, ExportOptions, Secret};
    use crate::runtime::rt_impl::RuntimeImpl;

    #[tokio::test]
    async fn full_export_rejects_boxes_with_secrets_before_capture() {
        let home = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().join("runtime"),
            ..Default::default()
        })
        .unwrap();
        let mut options = BoxOptions::default();
        options.secrets.push(Secret {
            name: "test".into(),
            hosts: vec!["example.com".into()],
            placeholder: "dummy".into(),
            value: "test-value".into(),
            headers: Some([("x-test".into(), "{value}".into())].into()),
        });
        let handle = runtime.create(options, None).await.unwrap();
        let error = handle
            .export(ExportOptions::full(), home.path())
            .await
            .unwrap_err();
        assert!(
            matches!(error, BoxliteError::Unsupported(ref message)
            if message == "full memory checkpoint export is not supported for boxes with secrets"),
            "{error:?}"
        );
    }
}
