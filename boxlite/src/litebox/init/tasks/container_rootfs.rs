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
            (
                ctx.config.options.rootfs.clone(),
                ctx.config.options.env.clone(),
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

    // For restart, reuse existing COW disk
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

            let qcow2_helper = Qcow2Helper::new();
            let cow_disk_path = layout.disk_path();
            let temp_disk = qcow2_helper.create_cow_child_disk(
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
