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

#[cfg(all(test, feature = "cloud-runner"))]
mod tests {
    use super::*;
    use crate::litebox::config::RootfsBackend;
    use crate::litebox::init::types::InitPipelineContext;
    use crate::runtime::options::{BoxOptions, BoxliteOptions};
    use crate::runtime::rt_impl::RuntimeImpl;
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn rootfs_task_preserves_restart_disk_and_applies_overrides() {
        let (dir, _, reference) = crate::images::overlaybd::tests::fixture();
        let source = dir.path().join("source");
        std::fs::write(
            source.join("oci-layout"),
            r#"{"imageLayoutVersion":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(
            source.join("index.json"),
            json!({"schemaVersion": 2, "manifests": [{
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": reference.split('@').nth(1).unwrap(), "size": 0
            }]})
            .to_string(),
        )
        .unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: dir.path().join("runtime"),
            image_registries: vec![],
        })
        .unwrap();
        for empty in [false, true] {
            let handle = runtime
                .create(
                    BoxOptions {
                        rootfs: RootfsSpec::RootfsPath(source.to_str().unwrap().into()),
                        auto_delete: Some(0),
                        env: vec![("MESSAGE".into(), "override".into())],
                        entrypoint: Some(if empty {
                            vec![]
                        } else {
                            vec!["/bin/sh".into()]
                        }),
                        cmd: Some(if empty { vec![] } else { vec!["-c".into()] }),
                        user: Some("123:456".into()),
                        working_dir: Some("/work".into()),
                        ..Default::default()
                    },
                    None,
                )
                .await
                .unwrap();
            let (config, _) = runtime.box_manager.box_by_id(handle.id()).unwrap().unwrap();
            let mut context = InitPipelineContext::new(config, runtime.clone(), true, false);
            let layout = runtime
                .layout
                .box_layout(handle.id().as_str(), false)
                .unwrap();
            layout.prepare().unwrap();
            let backing = dir.path().join("backing");
            std::fs::write(&backing, vec![0; 65536]).unwrap();
            Qcow2Helper::create_cow_child_disk(
                &backing,
                BackingFormat::Raw,
                &layout.disk_path(),
                65536,
            )
            .unwrap()
            .leak();
            let before = std::fs::read(layout.disk_path()).unwrap();
            context.layout = Some(layout.clone());
            let ctx = Arc::new(tokio::sync::Mutex::new(context));
            Box::new(ContainerRootfsTask)
                .run(ctx.clone())
                .await
                .unwrap();
            let mut context = ctx.lock().await;
            let image = context.container_image_config.as_ref().unwrap();
            assert_eq!(
                image.entrypoint,
                context.config.options.entrypoint.as_ref().unwrap().clone()
            );
            assert_eq!(
                image.cmd,
                context.config.options.cmd.as_ref().unwrap().clone()
            );
            assert_eq!(image.user, "123:456");
            assert_eq!(image.working_dir, "/work");
            assert_eq!(image.env, ["MESSAGE=override"]);
            assert_eq!(
                context.container_disk.as_ref().unwrap().path(),
                layout.disk_path()
            );
            assert_eq!(std::fs::read(layout.disk_path()).unwrap(), before);
            assert!(context.guard.overlaybd_lease.is_none());
            context.guard.disarm();
        }
    }

    #[tokio::test]
    async fn overlaybd_rootfs_task_rejects_incompatible_context() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: dir.path().into(),
            image_registries: vec![],
        })
        .unwrap();
        let handle = runtime.create(BoxOptions::default(), None).await.unwrap();
        let (mut config, _) = runtime.box_manager.box_by_id(handle.id()).unwrap().unwrap();
        config.rootfs_backend = RootfsBackend::Overlaybd;
        for (rootfs, message) in [
            (
                RootfsSpec::RootfsPath("/unused".into()),
                "requires an image reference",
            ),
            (
                RootfsSpec::Image("example.test/image:latest".into()),
                "requires the cloud runner",
            ),
        ] {
            config.options.rootfs = rootfs;
            let mut context =
                InitPipelineContext::new(config.clone(), runtime.clone(), false, false);
            context.layout = Some(
                runtime
                    .layout
                    .box_layout(handle.id().as_str(), false)
                    .unwrap(),
            );
            let ctx = Arc::new(tokio::sync::Mutex::new(context));
            let error = Box::new(ContainerRootfsTask)
                .run(ctx.clone())
                .await
                .unwrap_err();
            assert!(error.to_string().contains(message), "{error}");
            let mut context = ctx.lock().await;
            assert!(context.container_image_config.is_none() && context.container_disk.is_none());
            assert!(context.guard.overlaybd_lease.is_none());
            context.guard.disarm();
        }
    }
}

#[async_trait]
impl PipelineTask<InitCtx> for ContainerRootfsTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (config, runtime, layout, reuse_rootfs) = {
            let ctx = ctx.lock().await;
            let layout = ctx
                .layout
                .clone()
                .ok_or_else(|| BoxliteError::Internal("filesystem task must run first".into()))?;
            (
                ctx.config.clone(),
                ctx.runtime.clone(),
                layout,
                ctx.reuse_rootfs,
            )
        };
        let options = &config.options;
        let mut env = options.env.clone();
        // Inject secret placeholders after user env; the proxy substitutes real values.
        env.extend(options.secrets.iter().map(|s| s.env_pair()));

        let (mut container_image_config, disk) = async {
            #[cfg(feature = "cloud-runner")]
            if config.rootfs_backend == crate::litebox::config::RootfsBackend::Overlaybd {
                let RootfsSpec::Image(reference) = &options.rootfs else {
                    return Err(BoxliteError::Config(
                        "OverlayBD requires an image reference".into(),
                    ));
                };
                let manager = runtime
                    .overlaybd
                    .as_ref()
                    .ok_or_else(|| {
                        BoxliteError::Unsupported("OverlayBD requires the cloud runner".into())
                    })?
                    .clone();
                let disk_path = layout.disk_path();
                let id = config.id.clone();
                let reference = reference.clone();
                let disk_size_gb = options.disk_size_gb;
                let (mut image_config, disk, lease) = tokio::task::spawn_blocking(move || {
                    manager.prepare(id.as_str(), &reference, &disk_path, disk_size_gb)
                })
                .await
                .map_err(|e| {
                    BoxliteError::Internal(format!("OverlayBD preparation task failed: {e}"))
                })??;
                image_config.merge_env(env);
                ctx.lock().await.guard.overlaybd_lease = Some(lease);
                return Ok((image_config, disk));
            }

            run_container_rootfs(
                &options.rootfs,
                &env,
                &runtime,
                &layout,
                reuse_rootfs,
                options.disk_size_gb,
            )
            .await
            .inspect_err(|e| log_task_error(&box_id, task_name, e))
        }
        .await?;
        apply_user_overrides(
            &mut container_image_config,
            options.entrypoint.as_deref(),
            options.cmd.as_deref(),
            options.user.as_deref(),
            options.working_dir.as_deref(),
        );

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
async fn run_container_rootfs(
    rootfs_spec: &RootfsSpec,
    env: &[(String, String)],
    runtime: &SharedRuntimeImpl,
    layout: &BoxFilesystemLayout,
    reuse_rootfs: bool,
    disk_size_gb: Option<u64>,
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
