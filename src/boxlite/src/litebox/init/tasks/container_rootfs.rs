//! Task: Container rootfs preparation.
//!
//! Pulls container image and prepares container rootfs:
//! - Disk-based: Creates ext4 disk image from merged layers (fast boot)
//! - Overlayfs: Extracts layers for guest-side overlayfs (flexible)
//!
//! For restart (reuse_rootfs=true), opens existing COW disk instead of creating new.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::{BackingFormat, Disk, DiskFormat, Qcow2Helper};
use crate::images::{ContainerImageConfig, ImageDiskManager};
use crate::litebox::init::types::{ContainerRootfsPrepResult, USE_DISK_ROOTFS, USE_OVERLAYFS};
use crate::pipeline::PipelineTask;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::RootfsSpec;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub struct ContainerRootfsTask;

#[async_trait]
impl PipelineTask<InitCtx> for ContainerRootfsTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (
            rootfs_spec,
            env,
            runtime,
            layout,
            reuse_rootfs,
            disk_size_gb,
            entrypoint_override,
            cmd_override,
            user_override,
        ) = {
            let ctx = ctx.lock().await;
            let layout = ctx
                .layout
                .clone()
                .ok_or_else(|| BoxliteError::Internal("filesystem task must run first".into()))?;
            let mut env = ctx.config.options.env.clone();
            // Inject secret placeholder env vars (e.g., BOXLITE_SECRET_OPENAI=<BOXLITE_SECRET:openai>).
            // The MITM proxy substitutes real values at the network boundary.
            env.extend(ctx.config.options.secrets.iter().map(|s| s.env_pair()));

            (
                ctx.config.options.rootfs.clone(),
                env,
                ctx.runtime.clone(),
                layout,
                ctx.reuse_rootfs,
                ctx.config.options.disk_size_gb,
                ctx.config.options.entrypoint.clone(),
                ctx.config.options.cmd.clone(),
                ctx.config.options.user.clone(),
            )
        };

        let (container_image_config, disk) = run_container_rootfs(
            &rootfs_spec,
            &env,
            &runtime,
            &layout,
            reuse_rootfs,
            disk_size_gb,
            entrypoint_override.as_deref(),
            cmd_override.as_deref(),
            user_override.as_deref(),
        )
        .await
        .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        let mut ctx = ctx.lock().await;
        ctx.container_image_config = Some(container_image_config);
        ctx.container_disk = Some(disk);

        Ok(())
    }

    fn name(&self) -> &str {
        "container_rootfs_prep"
    }
}

/// Pull image and prepare rootfs, then create or reuse COW disk.
#[allow(clippy::too_many_arguments)]
async fn run_container_rootfs(
    rootfs_spec: &RootfsSpec,
    env: &[(String, String)],
    runtime: &SharedRuntimeImpl,
    layout: &BoxFilesystemLayout,
    reuse_rootfs: bool,
    disk_size_gb: Option<u64>,
    entrypoint_override: Option<&[String]>,
    cmd_override: Option<&[String]>,
    user_override: Option<&str>,
) -> BoxliteResult<(ContainerImageConfig, Disk)> {
    let disk_path = layout.disk_path();

    // For restart, reuse existing COW disk — but only if it is still intact.
    if reuse_rootfs {
        tracing::info!(
            disk_path = %disk_path.display(),
            "Restart mode: reusing existing container rootfs disk"
        );

        if !disk_path.exists() {
            return Err(BoxliteError::Storage(format!(
                "Cannot restart: container rootfs disk not found at {}",
                disk_path.display()
            )));
        }

        // A host crash can tear the COW overlay: an L2 mapping persists while its
        // data cluster was never written, so the guest reads zeros and the ext4
        // mount fails with EBADMSG on every restart — a death loop, because we
        // previously reopened the torn overlay blindly. Validate cluster
        // integrity first; on damage, discard it and fall through to rebuild a
        // fresh COW from the image base.
        if reuse_intact_container_rootfs(&disk_path)? {
            let disk = Disk::new(disk_path.clone(), DiskFormat::Qcow2, true);

            // Load container config
            let image = match rootfs_spec {
                RootfsSpec::Image(r) => pull_image(runtime, r).await?,
                RootfsSpec::RootfsPath(path) => {
                    let bundle_dir = std::path::Path::new(path);

                    if !bundle_dir.exists() {
                        return Err(BoxliteError::Storage(format!(
                            "Rootfs path does not exist: {}",
                            path
                        )));
                    }

                    runtime
                        .image_manager
                        .load_from_local(bundle_dir.to_path_buf(), format!("local:{}", path))
                        .await?
                }
            };
            let image_config = image.load_config().await?;
            let mut container_image_config = ContainerImageConfig::from_oci_config(&image_config)?;
            if !env.is_empty() {
                container_image_config.merge_env(env.to_vec());
            }
            apply_user_overrides(
                &mut container_image_config,
                entrypoint_override,
                cmd_override,
                user_override,
            );

            return Ok((container_image_config, disk));
        }
    }

    // Fresh start: pull or load image
    let image = match rootfs_spec {
        RootfsSpec::Image(r) => pull_image(runtime, r).await?,
        RootfsSpec::RootfsPath(path) => {
            let bundle_dir = std::path::Path::new(path);

            if !bundle_dir.exists() {
                return Err(BoxliteError::Storage(format!(
                    "Rootfs path does not exist: {}",
                    path
                )));
            }

            runtime
                .image_manager
                .load_from_local(bundle_dir.to_path_buf(), format!("local:{}", path))
                .await?
        }
    };

    // Prepare rootfs from image
    let rootfs_result = if USE_DISK_ROOTFS {
        prepare_disk_rootfs(&runtime.image_disk_mgr, &image).await?
    } else if USE_OVERLAYFS {
        prepare_overlayfs_layers(&image).await?
    } else {
        return Err(BoxliteError::Storage(
            "Merged rootfs not supported. Use overlayfs or disk rootfs.".into(),
        ));
    };

    let image_config = image.load_config().await?;
    let mut container_image_config = ContainerImageConfig::from_oci_config(&image_config)?;

    if !env.is_empty() {
        container_image_config.merge_env(env.to_vec());
    }
    apply_user_overrides(
        &mut container_image_config,
        entrypoint_override,
        cmd_override,
        user_override,
    );

    let disk = create_cow_disk(&rootfs_result, layout, disk_size_gb)?;

    Ok((container_image_config, disk))
}

/// Decide whether an existing container rootfs COW overlay can be reused on
/// restart, or must be discarded and rebuilt from the image base.
///
/// Returns `Ok(true)` to reuse as-is, `Ok(false)` after removing a structurally
/// torn overlay (the caller rebuilds a fresh COW), or `Err` when reuse must be
/// refused without deleting anything — a transient I/O fault that proves nothing
/// about the overlay's contents.
fn reuse_intact_container_rootfs(disk_path: &std::path::Path) -> BoxliteResult<bool> {
    use crate::disk::qcow2::Qcow2HeaderError;

    let discard = |reason: &str| -> BoxliteResult<bool> {
        tracing::warn!(
            disk_path = %disk_path.display(),
            reason = %reason,
            "Discarding torn container rootfs COW overlay and rebuilding from image base"
        );
        std::fs::remove_file(disk_path).map_err(|remove_err| {
            BoxliteError::Storage(format!(
                "Failed to remove torn container rootfs {} ({}): {}",
                disk_path.display(),
                reason,
                remove_err
            ))
        })?;
        Ok(false)
    };

    // Structural: every cluster the L1/L2 tables reference must physically exist.
    // A crash that truncates the overlay leaves a dangling reference past the
    // file end — the guest reads it as zeros and the mount fails with EBADMSG on
    // every restart. A dangling cluster is purely overlay damage: discard + rebuild.
    match crate::disk::qcow2::probe_overlay_cluster_integrity(disk_path) {
        Ok(()) => Ok(true),
        Err(Qcow2HeaderError::Corrupt(reason)) => discard(&reason),
        Err(Qcow2HeaderError::Io(io)) => Err(BoxliteError::Storage(format!(
            "Cannot read container rootfs {} to validate overlay cluster integrity \
             (I/O error: {io}); refusing to discard a possibly-intact overlay",
            disk_path.display()
        ))),
    }
}

/// Create COW disk from base rootfs.
///
/// # Arguments
/// * `rootfs_result` - Result of rootfs preparation (disk image or layers)
/// * `layout` - Box filesystem layout for disk paths
/// * `disk_size_gb` - Optional user-specified disk size in GB. If set, the COW disk
///   will have this virtual size (or the base disk size, whichever is larger).
fn create_cow_disk(
    rootfs_result: &ContainerRootfsPrepResult,
    layout: &crate::runtime::layout::BoxFilesystemLayout,
    disk_size_gb: Option<u64>,
) -> BoxliteResult<Disk> {
    match rootfs_result {
        ContainerRootfsPrepResult::DiskImage {
            base_disk_path,
            disk_size: base_disk_size,
        } => {
            // Calculate target disk size: use max of user-specified size and base disk size
            let target_disk_size = if let Some(size_gb) = disk_size_gb {
                let user_size_bytes = size_gb * 1024 * 1024 * 1024;
                std::cmp::max(user_size_bytes, *base_disk_size)
            } else {
                *base_disk_size
            };

            let cow_disk_path = layout.disk_path();
            let temp_disk = Qcow2Helper::create_cow_child_disk(
                base_disk_path,
                BackingFormat::Raw,
                &cow_disk_path,
                target_disk_size,
            )?;

            // Make disk persistent so it survives stop/restart
            // create_cow_child_disk returns non-persistent disk, but we want to preserve
            // COW disks across box restarts (only delete on remove)
            let disk_path = temp_disk.leak(); // Prevent cleanup
            let disk = Disk::new(disk_path, DiskFormat::Qcow2, true); // persistent=true

            tracing::info!(
                cow_disk = %cow_disk_path.display(),
                base_disk = %base_disk_path.display(),
                virtual_size_mb = target_disk_size / (1024 * 1024),
                "Created container rootfs COW overlay (persistent)"
            );

            Ok(disk)
        }
        ContainerRootfsPrepResult::Layers { .. } => Err(BoxliteError::Internal(
            "Layers mode requires overlayfs - disk creation not applicable".into(),
        )),
        ContainerRootfsPrepResult::Merged(_) => {
            Err(BoxliteError::Internal("Merged mode not supported".into()))
        }
    }
}

/// Apply user overrides to container image config (entrypoint, CMD, and user).
fn apply_user_overrides(
    config: &mut ContainerImageConfig,
    entrypoint_override: Option<&[String]>,
    cmd_override: Option<&[String]>,
    user_override: Option<&str>,
) {
    if let Some(ep) = entrypoint_override {
        config.entrypoint = ep.to_vec();
    }
    if let Some(cmd) = cmd_override {
        config.cmd = cmd.to_vec();
    }
    if let Some(user) = user_override {
        config.user = user.to_string();
    }
}

async fn pull_image(
    runtime: &crate::runtime::SharedRuntimeImpl,
    image_ref: &str,
) -> BoxliteResult<crate::images::ImageObject> {
    // ImageManager has internal locking - direct access
    runtime.image_manager.pull(image_ref).await
}

async fn prepare_overlayfs_layers(
    image: &crate::images::ImageObject,
) -> BoxliteResult<ContainerRootfsPrepResult> {
    let layer_paths = image.layer_extracted().await?;

    if layer_paths.is_empty() {
        return Err(BoxliteError::Storage(
            "No layers found for overlayfs".into(),
        ));
    }

    let layers_dir = layer_paths[0]
        .parent()
        .ok_or_else(|| BoxliteError::Storage("Layer path has no parent directory".into()))?
        .to_path_buf();

    let layer_names: Vec<String> = layer_paths
        .iter()
        .map(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string()
        })
        .collect();

    tracing::info!(
        "Prepared {} layers for guest-side overlayfs",
        layer_names.len()
    );

    Ok(ContainerRootfsPrepResult::Layers {
        layers_dir,
        layer_names,
    })
}

/// Prepare disk-based rootfs from image via ImageDiskManager.
///
/// Delegates to ImageDiskManager which handles caching, layer merging,
/// and ext4 creation with staged atomic install.
async fn prepare_disk_rootfs(
    image_disk_mgr: &ImageDiskManager,
    image: &crate::images::ImageObject,
) -> BoxliteResult<ContainerRootfsPrepResult> {
    let disk = image_disk_mgr.get_or_create(image).await?;

    let disk_path = disk.path().to_path_buf();
    let disk_size = std::fs::metadata(&disk_path)
        .map(|m| m.len())
        .unwrap_or(64 * 1024 * 1024);

    // Ownership stays with cache — prevent drop cleanup
    let _ = disk.leak();

    Ok(ContainerRootfsPrepResult::DiskImage {
        base_disk_path: disk_path,
        disk_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use tempfile::TempDir;

    const CLUSTER_SIZE: u64 = 1 << 16; // boxlite qcow2 uses 64 KiB clusters

    /// Build a real boxlite container COW overlay (via production code), then tear
    /// it the exact way a host crash tore the prod overlays: an L2 entry maps a
    /// virtual cluster to a host offset at the file's physical end, so the data
    /// cluster it references was never written. Returns the torn overlay path.
    fn write_torn_container_overlay(dir: &std::path::Path) -> PathBuf {
        let base = dir.join("base.raw");
        std::fs::write(&base, vec![0u8; (CLUSTER_SIZE * 2) as usize]).unwrap();

        let overlay = dir.join("disk.qcow2");
        let disk = Qcow2Helper::create_cow_child_disk(
            &base,
            BackingFormat::Raw,
            &overlay,
            CLUSTER_SIZE * 2,
        )
        .unwrap();
        disk.leak(); // keep the file on disk past Drop

        // Append a fresh L2 table cluster, point L1[0] at it, and point L2[0] at
        // the (new) end of file — a data cluster that physically does not exist.
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&overlay)
            .unwrap();
        let mut hdr = [0u8; 48];
        f.read_exact(&mut hdr).unwrap();
        let cluster_bits = u32::from_be_bytes(hdr[20..24].try_into().unwrap());
        let cluster_size = 1u64 << cluster_bits;
        let l1_offset = u64::from_be_bytes(hdr[40..48].try_into().unwrap());

        let l2_table_off = f.metadata().unwrap().len();
        f.seek(SeekFrom::Start(l2_table_off)).unwrap();
        f.write_all(&vec![0u8; cluster_size as usize]).unwrap();
        let torn_data_off = f.metadata().unwrap().len(); // == EOF; data never written

        const COPIED: u64 = 1 << 63;
        f.seek(SeekFrom::Start(l1_offset)).unwrap();
        f.write_all(&(l2_table_off | COPIED).to_be_bytes()).unwrap();
        f.seek(SeekFrom::Start(l2_table_off)).unwrap();
        f.write_all(&(torn_data_off | COPIED).to_be_bytes())
            .unwrap();
        f.sync_all().unwrap();

        overlay
    }

    #[test]
    fn test_reuse_discards_torn_container_overlay_so_it_rebuilds() {
        let dir = TempDir::new().unwrap();
        let overlay = write_torn_container_overlay(dir.path());
        assert!(overlay.exists());

        // The death-loop site. Before this fix the restart path did no validation
        // and would reopen the torn overlay, looping on EBADMSG forever. The fix
        // detects the dangling cluster, removes the file, and returns false so the
        // caller rebuilds a fresh COW from the image base.
        let reused = reuse_intact_container_rootfs(&overlay).unwrap();
        assert!(!reused, "torn overlay must be discarded, not reused");
        assert!(
            !overlay.exists(),
            "torn overlay must be removed so a fresh COW is rebuilt"
        );
    }

    #[test]
    fn test_reuse_keeps_intact_container_overlay() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("base.raw");
        let base_file = std::fs::File::create(&base).unwrap();
        base_file.set_len(CLUSTER_SIZE * 2).unwrap();
        base_file.sync_all().unwrap();
        let overlay = dir.path().join("disk.qcow2");
        Qcow2Helper::create_cow_child_disk(&base, BackingFormat::Raw, &overlay, CLUSTER_SIZE * 2)
            .unwrap()
            .leak();

        let reused = reuse_intact_container_rootfs(&overlay).unwrap();
        assert!(reused, "an intact overlay must be reused");
        assert!(overlay.exists(), "intact overlay must be kept");
    }
}
