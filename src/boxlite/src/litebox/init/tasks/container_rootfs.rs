//! Task: Container rootfs preparation.
//!
//! Pulls container image and prepares container rootfs:
//! - Disk-based: Creates ext4 disk image from merged layers (fast boot)
//! - Overlayfs: Extracts layers for guest-side overlayfs (flexible)
//!
//! For restart (reuse_rootfs=true), opens existing COW disk instead of creating new.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::{BackingFormat, Disk, DiskFormat, Qcow2Helper};
use crate::images::shared_ext4::{self, ReadyExt4};
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
            working_dir_override,
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
                ctx.config.options.working_dir.clone(),
            )
        };

        let (container_image_config, disk) = run_container_rootfs(
            box_id.as_str(),
            &rootfs_spec,
            &env,
            &runtime,
            &layout,
            reuse_rootfs,
            disk_size_gb,
            entrypoint_override.as_deref(),
            cmd_override.as_deref(),
            user_override.as_deref(),
            working_dir_override.as_deref(),
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
    box_id: &str,
    rootfs_spec: &RootfsSpec,
    env: &[(String, String)],
    runtime: &SharedRuntimeImpl,
    layout: &BoxFilesystemLayout,
    reuse_rootfs: bool,
    disk_size_gb: Option<u64>,
    entrypoint_override: Option<&[String]>,
    cmd_override: Option<&[String]>,
    user_override: Option<&str>,
    working_dir_override: Option<&str>,
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

        if let RootfsSpec::Image(_) = rootfs_spec
            && USE_DISK_ROOTFS
        {
            let ready = shared_ext4::open_restart(&runtime.box_manager.db(), box_id)?;
            let config = apply_config(
                ready.config,
                env,
                entrypoint_override,
                cmd_override,
                user_override,
                working_dir_override,
            );
            return Ok((config, disk));
        }

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
            working_dir_override,
        );

        return Ok((container_image_config, disk));
    }

    if let RootfsSpec::Image(image_ref) = rootfs_spec
        && USE_DISK_ROOTFS
    {
        let ready = prepare_shared_ext4(runtime, image_ref).await?;
        let disk = commit_and_create_cow(runtime, box_id, &ready, layout, disk_size_gb)?;
        let config = apply_config(
            ready.config,
            env,
            entrypoint_override,
            cmd_override,
            user_override,
            working_dir_override,
        );
        return Ok((config, disk));
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
        working_dir_override,
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

fn apply_config(
    mut config: ContainerImageConfig,
    env: &[(String, String)],
    entrypoint_override: Option<&[String]>,
    cmd_override: Option<&[String]>,
    user_override: Option<&str>,
    working_dir_override: Option<&str>,
) -> ContainerImageConfig {
    if !env.is_empty() {
        config.merge_env(env.to_vec());
    }
    apply_user_overrides(
        &mut config,
        entrypoint_override,
        cmd_override,
        user_override,
        working_dir_override,
    );
    config
}

async fn prepare_shared_ext4(
    runtime: &SharedRuntimeImpl,
    image_ref: &str,
) -> BoxliteResult<ReadyExt4> {
    let db = runtime.box_manager.db();
    if let Some(ready) = shared_ext4::choose_start(&db, image_ref)? {
        return Ok(ready);
    }
    let image = runtime.image_manager.pull_metadata(image_ref).await?;
    let (disk_key, path) = runtime.image_disk_mgr.shared_disk(&image);
    let scratch = runtime.image_manager.scratch_files(&image).await;
    let oci = image.load_config().await?;
    let config = ContainerImageConfig::from_oci_config(&oci)?;
    let config_json = serde_json::to_string(&config)
        .map_err(|e| BoxliteError::Image(format!("failed to store guest image config: {e}")))?;
    let image_for_build = image.clone();
    let runtime_for_build = runtime.clone();
    shared_ext4::resolve_for_create(
        &db,
        &runtime.builds,
        image_ref,
        &disk_key,
        &path,
        &config_json,
        &scratch,
        move || {
            let image_for_build = image_for_build.clone();
            let runtime_for_build = runtime_for_build.clone();
            async move {
                let image = runtime_for_build
                    .image_manager
                    .pull(image_for_build.reference())
                    .await?;
                let disk = runtime_for_build
                    .image_disk_mgr
                    .get_or_create(&image)
                    .await?;
                let _ = disk.leak();
                Ok(())
            }
        },
    )
    .await
}

fn commit_and_create_cow(
    runtime: &SharedRuntimeImpl,
    box_id: &str,
    ready: &ReadyExt4,
    layout: &BoxFilesystemLayout,
    disk_size_gb: Option<u64>,
) -> BoxliteResult<Disk> {
    if !ready.path.is_file() {
        return Err(BoxliteError::Storage(format!(
            "refusing to create a qcow2 for {}: ext4 is missing",
            ready.disk_key
        )));
    }
    let db = runtime.box_manager.db();
    if !crate::db::shared_disk::commit_disk(&db, box_id, &ready.disk_key, &ready.disk_key)? {
        return Err(BoxliteError::InvalidState(format!(
            "image disk {} is not ready",
            ready.disk_key
        )));
    }
    let disk_size = std::fs::metadata(&ready.path)
        .map(|meta| meta.len())
        .unwrap_or(64 * 1024 * 1024);
    let prepared = ContainerRootfsPrepResult::DiskImage {
        base_disk_path: ready.path.clone(),
        disk_size,
    };
    match create_cow_disk(&prepared, layout, disk_size_gb) {
        Ok(disk) => Ok(disk),
        Err(err) => match crate::db::shared_disk::delete_disk_if_free(&db, box_id)? {
            crate::db::shared_disk::DiskDelete::Blocked => {
                Err(crate::db::shared_disk::blocked_disk(box_id))
            }
            crate::db::shared_disk::DiskDelete::Removed
            | crate::db::shared_disk::DiskDelete::Absent => Err(err),
        },
    }
}

/// Apply user overrides to container image config (entrypoint, CMD, user,
/// and working dir) — the docker `run` override set, applied to the init
/// process configuration.
fn apply_user_overrides(
    config: &mut ContainerImageConfig,
    entrypoint_override: Option<&[String]>,
    cmd_override: Option<&[String]>,
    user_override: Option<&str>,
    working_dir_override: Option<&str>,
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
    if let Some(wd) = working_dir_override {
        config.working_dir = wd.to_string();
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
    use super::prepare_shared_ext4;
    use crate::runtime::options::{BoxliteOptions, ImageRegistry};
    use crate::runtime::rt_impl::RuntimeImpl;

    /// A dead `building` row that still has its ext4 and a `disk.root` must fail
    /// inside `prepare_shared_ext4` before `pull_metadata`.
    #[tokio::test]
    async fn dead_building_with_a_file_and_disk_root_fails_before_pull() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.clone(),
            image_registries: vec![ImageRegistry::http("127.0.0.1:9").with_search(true)],
        })
        .unwrap();
        let image_ref = "127.0.0.1:9/library/alpine:latest";
        let ext4 = home
            .join("images")
            .join("disk-images")
            .join("alpine-a.ext4");
        std::fs::create_dir_all(ext4.parent().unwrap()).unwrap();
        std::fs::write(&ext4, b"partial").unwrap();
        let db = runtime.box_manager.db();
        db.conn()
            .execute(
                "INSERT INTO image_disk (disk_key, path, state, config) VALUES ('alpine-a', ?1, 'building', '{}')",
                [ext4.to_str().unwrap()],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO image (ref, disk_key) VALUES (?1, 'alpine-a')",
                [image_ref],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO disk (id, root, parent) VALUES ('boxA', 'alpine-a', 'alpine-a')",
                [],
            )
            .unwrap();

        let err = prepare_shared_ext4(&runtime, image_ref).await.unwrap_err();
        assert!(err.to_string().contains("refusing to rebuild"), "{err}");
        assert_eq!(std::fs::read(&ext4).unwrap(), b"partial");
        let state: String = db
            .conn()
            .query_row(
                "SELECT state FROM image_disk WHERE disk_key = 'alpine-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "building");
    }
}
