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
        let db = rt.box_manager.db();
        let shared_root =
            crate::db::shared_disk::disk_row(&db, &source_box_id)?.map(|(root, _)| root);
        let mut staging_dirs = Vec::with_capacity(count);
        let mut clone_ids = Vec::with_capacity(count);
        for _ in 0..count {
            let clone_id = crate::runtime::id::BoxIDMint::mint();
            let temp = tempfile::tempdir_in(rt.layout.boxes_dir()).map_err(|e| {
                BoxliteError::Storage(format!("Failed to create temp box directory: {}", e))
            })?;
            #[allow(deprecated)]
            let staging = temp.into_path();

            let staging_disks = staging.join("disks");
            std::fs::create_dir_all(&staging_disks).map_err(|e| {
                BoxliteError::Storage(format!("Failed to create staging disks dir: {}", e))
            })?;

            // Commit the clone's disk row while the ext4 is still ready, then
            // write its qcow2. parent is the new base; root stays the ext4.
            if let Some(root) = &shared_root
                && !crate::db::shared_disk::commit_disk(
                    &db,
                    clone_id.as_str(),
                    root,
                    layer.id.as_str(),
                )?
            {
                return Err(BoxliteError::InvalidState(format!(
                    "refusing to clone: ext4 {root} is not ready"
                )));
            }
            // Container overlay → shared base (qcow2 backing qcow2)
            // leak() prevents the Disk RAII guard from deleting the file on drop —
            // the child is the clone's persistent disk and must outlive this function.
            if let Err(err) = Qcow2Helper::create_cow_child_disk(
                &shared_container,
                BackingFormat::Qcow2,
                &staging_disks.join(disk_filenames::CONTAINER_DISK),
                container_vsize,
            )
            .map(|disk| {
                disk.leak();
            }) {
                if shared_root.is_some() {
                    match crate::db::shared_disk::delete_disk_if_free(&db, clone_id.as_str())? {
                        crate::db::shared_disk::DiskDelete::Blocked => {
                            return Err(crate::db::shared_disk::blocked_disk(clone_id.as_str()));
                        }
                        crate::db::shared_disk::DiskDelete::Removed
                        | crate::db::shared_disk::DiskDelete::Absent => {}
                    }
                }
                return Err(err);
            }

            staging_dirs.push(staging);
            clone_ids.push(clone_id);
        }

        // Phase C: Provision each clone and record base disk refs.
        let mut clones = Vec::with_capacity(count);
        for i in 0..staging_dirs.len() {
            let staging = staging_dirs[i].clone();
            let litebox = match rt
                .provision_box(
                    staging,
                    names.get(i).cloned(),
                    self.config.options.clone(),
                    BoxStatus::Stopped,
                    Some(clone_ids[i].clone()),
                )
                .await
            {
                Ok(lb) => lb,
                Err(e) => {
                    // Drop this clone and any later one that never provisioned.
                    // Already-provisioned clones stay. A disk row is deleted only
                    // when its qcow2 is gone and nothing parents it.
                    for j in i..staging_dirs.len() {
                        abandon_unprovisioned_clone(&db, clone_ids[j].as_str(), &staging_dirs[j])?;
                    }
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

/// Drop a clone that never became a box. Leave the qcow2 in place when some
/// `disk.parent` still points at `id`. Otherwise remove the staging directory
/// and delete the disk row only after that file is gone.
fn abandon_unprovisioned_clone(
    db: &crate::db::Database,
    id: &str,
    staging: &std::path::Path,
) -> BoxliteResult<()> {
    if crate::db::shared_disk::child_blocks(db, id)? {
        return Ok(());
    }
    let qcow = staging.join("disks").join(disk_filenames::CONTAINER_DISK);
    let _ = std::fs::remove_dir_all(staging);
    if qcow.exists() {
        return Ok(());
    }
    match crate::db::shared_disk::delete_disk_if_free(db, id)? {
        crate::db::shared_disk::DiskDelete::Blocked => {
            Err(crate::db::shared_disk::blocked_disk(id))
        }
        crate::db::shared_disk::DiskDelete::Removed
        | crate::db::shared_disk::DiskDelete::Absent => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::ContainerID;
    use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
    use crate::litebox::state::BoxState;
    use crate::runtime::id::BoxIDMint;
    use crate::runtime::options::{BoxOptions, BoxliteOptions};
    use crate::runtime::rt_impl::RuntimeImpl;

    fn write_qcow2(path: &std::path::Path) {
        let mut buf = vec![0u8; 1024];
        buf[0..4].copy_from_slice(&0x514649fbu32.to_be_bytes());
        buf[4..8].copy_from_slice(&3u32.to_be_bytes());
        buf[24..32].copy_from_slice(&(1024u64 * 1024 * 1024).to_be_bytes());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, buf).unwrap();
    }

    #[tokio::test]
    async fn provision_failure_drops_clone_disk_rows_whose_files_are_gone() {
        let home = tempfile::TempDir::new().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            image_registries: vec![],
        })
        .unwrap();
        let source_id = BoxIDMint::mint();
        let box_home = runtime.layout.boxes_dir().join(source_id.as_str());
        write_qcow2(&box_home.join("disks").join(disk_filenames::CONTAINER_DISK));
        let db = runtime.box_manager.db();
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('ext4key1', '/tmp/ext4', 'ready', '{}')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES (?1, 'ext4key1', 'ext4key1')",
                [source_id.as_str()],
            )
            .unwrap();

        let taken_id = BoxIDMint::mint();
        let taken = BoxConfig {
            id: taken_id,
            name: Some("taken".into()),
            created_at: chrono::Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions::default(),
            engine_kind: crate::vmm::VmmKind::Libkrun,
            box_home: runtime.layout.boxes_dir().join("taken-home"),
        };
        runtime
            .box_manager
            .add_box(&taken, &BoxState::new())
            .unwrap();

        let source = BoxImpl::new(
            BoxConfig {
                id: source_id.clone(),
                name: Some("source".into()),
                created_at: chrono::Utc::now(),
                container: ContainerRuntimeConfig {
                    id: ContainerID::new(),
                },
                options: BoxOptions::default(),
                engine_kind: crate::vmm::VmmKind::Libkrun,
                box_home,
            },
            BoxState::new(),
            Arc::clone(&runtime),
            runtime.shutdown_token.child_token(),
        );

        let err = match source
            .clone_boxes(
                crate::runtime::options::CloneOptions {},
                2,
                vec!["taken".into(), "later".into()],
            )
            .await
        {
            Ok(_) => panic!("provision should fail on the duplicate name"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("taken"),
            "expected the duplicate-name provision failure, got {err}"
        );

        let base_id: String = db
            .conn()
            .query_row(
                "SELECT parent FROM disk WHERE id = ?1",
                [source_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let leftover: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM disk WHERE parent = ?1 AND id != ?2",
                rusqlite::params![base_id, source_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            leftover, 0,
            "provision failure left {leftover} clone disk rows after the qcow2 was abandoned"
        );
    }
}
