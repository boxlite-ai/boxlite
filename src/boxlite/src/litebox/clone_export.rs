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
        if let Some(policy) = self
            .runtime
            .box_manager
            .update_box(self.id())?
            .outbound_policy
        {
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
        // Each clone's disk is a copy of this one, so it runs the same build.
        // Read before the loop: the guard must not be held across an await.
        let resolved_image = self.state.read().resolved_image.clone();
        let copy_options = self.options_for_copy()?;
        let mut clones = Vec::with_capacity(count);
        for (i, staging) in staging_dirs.into_iter().enumerate() {
            let litebox = match rt
                .provision_box(
                    staging.clone(),
                    names.get(i).cloned(),
                    copy_options.clone(),
                    BoxStatus::Stopped,
                    resolved_image.clone(),
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
    }
}

impl BoxImpl {
    /// Replace this box's container disk with the one an archive carries.
    ///
    /// A stopped or never-started box qualifies. Installing the disk moves a
    /// configured box to Stopped so its first start reuses that disk. The disk
    /// lock excludes start, export and snapshots while it is replaced.
    pub(crate) async fn restore_from_archive(
        &self,
        archive: crate::runtime::options::BoxArchive,
    ) -> BoxliteResult<()> {
        let t0 = Instant::now();
        let _lock = self.disk_ops.lock().await;

        let status = self.state.read().status;
        if !matches!(status, BoxStatus::Stopped | BoxStatus::Configured) {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot restore box {} from an archive while it is {}; stop it first",
                self.config.id,
                status.as_str()
            )));
        }

        let archive_path = archive.path().to_path_buf();
        let layout = self.runtime.layout.clone();
        let disks_dir = self.config.box_home.join("disks");
        tokio::task::spawn_blocking(move || {
            crate::runtime::import::replace_container_disk(&archive_path, &layout, &disks_dir)
        })
        .await
        .map_err(|e| BoxliteError::Internal(format!("Archive restore task panicked: {}", e)))??;

        if status == BoxStatus::Configured {
            let mut restored = self.state.read().clone();
            restored.transition_to(BoxStatus::Stopped)?;
            self.runtime
                .box_manager
                .save_box(&self.config.id, &restored)?;
            *self.state.write() = restored;
        }

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            "Restored box disk from archive"
        );

        Ok(())
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

    let output_path = if dest.is_dir() {
        let name = config_name.unwrap_or("box");
        dest.join(format!("{}.boxlite", name))
    } else {
        dest.to_path_buf()
    };

    let t_checksum = Instant::now();
    let container_disk_checksum = sha256_file(&flatten.flat_container)?;
    let checksum_ms = t_checksum.elapsed().as_millis() as u64;

    let image = match &config_options.rootfs {
        crate::runtime::options::RootfsSpec::Image(img) => img.clone(),
        crate::runtime::options::RootfsSpec::RootfsPath(path) => path.clone(),
    };

    let manifest = ArchiveManifest {
        version: archive_version_for_options(config_options),
        box_name: config_name.map(|s| s.to_string()),
        image,
        box_options: Some(config_options.clone()),
        guest_disk_checksum: String::new(),
        container_disk_checksum,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
    use crate::litebox::state::BoxState;
    use crate::runtime::id::BoxIDMint;
    use crate::runtime::import::{write_test_archive, write_test_disk};
    use crate::runtime::options::{BoxArchive, BoxOptions, BoxliteOptions, RootfsSpec};
    use crate::runtime::rt_impl::RuntimeImpl;
    use crate::runtime::types::ContainerID;
    use crate::vmm::VmmKind;
    use chrono::Utc;
    use tempfile::TempDir;

    /// A box in `status` whose disks hold a container disk ending in
    /// "original" and a guest rootfs overlay, plus an archive of a disk
    /// ending in "restored".
    struct RestoreTarget {
        box_impl: BoxImpl,
        disks_dir: std::path::PathBuf,
        archive: std::path::PathBuf,
        _home: TempDir,
    }

    impl RestoreTarget {
        fn new(status: BoxStatus) -> Self {
            let home = TempDir::new_in("/tmp").unwrap();
            let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
                home_dir: home.path().join("runtime"),
                image_registries: vec![],
                ..Default::default()
            })
            .unwrap();
            std::fs::create_dir_all(runtime.layout.temp_dir()).unwrap();

            let id = BoxIDMint::mint();
            let config = BoxConfig {
                id: id.clone(),
                name: None,
                created_at: Utc::now(),
                container: ContainerRuntimeConfig {
                    id: ContainerID::new(),
                },
                options: BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    ..Default::default()
                },
                engine_kind: VmmKind::Libkrun,
                box_home: runtime.layout.boxes_dir().join(id.as_str()),
            };
            let disks_dir = config.box_home.join("disks");
            std::fs::create_dir_all(&disks_dir).unwrap();
            write_test_disk(
                &disks_dir.join(disk_filenames::CONTAINER_DISK),
                None,
                b"original",
            );
            std::fs::write(disks_dir.join(disk_filenames::GUEST_ROOTFS_DISK), b"guest").unwrap();

            let archive_dir = home.path().join("archive");
            std::fs::create_dir_all(&archive_dir).unwrap();
            let archive = write_test_archive(&archive_dir, None, b"restored", None);

            let mut state = BoxState::new();
            state.status = status;
            runtime.box_manager.add_box(&config, &state).unwrap();
            let box_impl = BoxImpl::new(
                config,
                state,
                runtime.clone(),
                runtime.shutdown_token.child_token(),
            );
            Self {
                box_impl,
                disks_dir,
                archive,
                _home: home,
            }
        }

        fn container_disk(&self) -> Vec<u8> {
            std::fs::read(self.disks_dir.join(disk_filenames::CONTAINER_DISK)).unwrap()
        }

        fn has_guest_overlay(&self) -> bool {
            self.disks_dir
                .join(disk_filenames::GUEST_ROOTFS_DISK)
                .exists()
        }
    }

    #[tokio::test]
    async fn restore_swaps_the_archived_disk_into_a_stopped_box() {
        let target = RestoreTarget::new(BoxStatus::Stopped);

        target
            .box_impl
            .restore_from_archive(BoxArchive::new(&target.archive))
            .await
            .expect("a stopped box takes the archived disk");

        assert!(target.container_disk().ends_with(b"restored"));
        assert!(
            !target.has_guest_overlay(),
            "the guest rootfs overlay is rebuilt on the next start"
        );
    }

    #[tokio::test]
    async fn restore_initializes_a_configured_box_without_starting_it() {
        let target = RestoreTarget::new(BoxStatus::Configured);
        std::fs::remove_dir_all(&target.disks_dir).unwrap();

        target
            .box_impl
            .restore_from_archive(BoxArchive::new(&target.archive))
            .await
            .expect("a new box can receive its disk before first boot");

        assert!(target.container_disk().ends_with(b"restored"));
        let state = target.box_impl.state.read().clone();
        assert_eq!(state.status, BoxStatus::Stopped);
        assert!(state.started_at.is_none());
        let persisted = target
            .box_impl
            .runtime
            .box_manager
            .update_box(&target.box_impl.config.id)
            .unwrap();
        assert_eq!(persisted.status, BoxStatus::Stopped);
        assert!(persisted.started_at.is_none());
    }

    #[tokio::test]
    async fn restore_keeps_a_configured_box_uninitialized_on_invalid_archive() {
        let target = RestoreTarget::new(BoxStatus::Configured);
        std::fs::remove_dir_all(&target.disks_dir).unwrap();
        std::fs::write(&target.archive, b"invalid archive").unwrap();

        assert!(
            target
                .box_impl
                .restore_from_archive(BoxArchive::new(&target.archive))
                .await
                .is_err()
        );

        assert!(!target.disks_dir.exists());
        assert_eq!(target.box_impl.state.read().status, BoxStatus::Configured);
    }

    #[tokio::test]
    async fn restore_refuses_an_active_box() {
        for status in [BoxStatus::Running, BoxStatus::Stopping, BoxStatus::Paused] {
            let target = RestoreTarget::new(status);

            let error = target
                .box_impl
                .restore_from_archive(BoxArchive::new(&target.archive))
                .await
                .expect_err("an active box must not have its disk replaced");

            assert!(
                matches!(error, BoxliteError::InvalidState(_)),
                "{status:?}: {error}"
            );
            assert!(
                target.container_disk().ends_with(b"original"),
                "{status:?}: the disk must be left alone"
            );
            assert!(target.has_guest_overlay(), "{status:?}");
        }
    }
}
