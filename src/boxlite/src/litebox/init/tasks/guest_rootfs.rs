//! Task: Guest rootfs preparation.
//!
//! Lazily initializes the bootstrap guest rootfs as a shared, read-only disk image.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::Disk;
use crate::images::ImageDiskManager;
use crate::pipeline::PipelineTask;
use crate::rootfs::guest::{GuestRootfs, GuestRootfsManager};
use crate::runtime::constants::images;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::vmm::guest_artifacts::GuestArtifacts;
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub struct GuestRootfsTask;

#[async_trait]
impl PipelineTask<InitCtx> for GuestRootfsTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (runtime, layout, reuse_rootfs) = {
            let ctx = ctx.lock().await;
            let layout = ctx
                .layout
                .clone()
                .ok_or_else(|| BoxliteError::Internal("filesystem task must run first".into()))?;
            (ctx.runtime.clone(), layout, ctx.reuse_rootfs)
        };

        let disk = run_guest_rootfs(&runtime, &layout, reuse_rootfs)
            .await
            .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        let mut ctx = ctx.lock().await;
        ctx.guest_disk = disk;

        Ok(())
    }

    fn name(&self) -> &str {
        "guest_rootfs_init"
    }
}

/// Get or initialize bootstrap guest rootfs, then create/reuse per-box COW disk.
async fn run_guest_rootfs(
    runtime: &SharedRuntimeImpl,
    layout: &BoxFilesystemLayout,
    _reuse_rootfs: bool,
) -> BoxliteResult<Option<Disk>> {
    // Initialize the shared minimal guest rootfs (the default boot rootfs).
    let _ = runtime
        .guest_rootfs
        .get_or_try_init(|| async {
            tracing::info!("Initializing minimal guest rootfs (first time only)");

            let artifacts = GuestArtifacts::get()?;
            let guest_rootfs = runtime
                .guest_rootfs_mgr
                .get_or_create_minimal(artifacts)
                .await?;

            tracing::info!("Minimal guest rootfs ready: {:?}", guest_rootfs.strategy);

            Ok::<_, BoxliteError>(guest_rootfs)
        })
        .await?;

    // The guest rootfs is now read-only (attached directly, no per-box COW
    // overlay). Remove any overlay left over from an older release.
    remove_legacy_guest_rootfs_overlay(layout)?;

    // No per-box COW disk anymore.
    Ok(None)
}

/// Remove a per-box guest-rootfs overlay left over from a release that still
/// created one. The minimal rootfs is shared and read-only, so the overlay is
/// obsolete; a re-created box boots from the shared base regardless.
fn remove_legacy_guest_rootfs_overlay(layout: &BoxFilesystemLayout) -> BoxliteResult<()> {
    let legacy_overlay = layout.guest_rootfs_disk_path();
    if !legacy_overlay.exists() {
        return Ok(());
    }

    tracing::info!(
        disk_path = %legacy_overlay.display(),
        "Removing legacy guest rootfs overlay (guest rootfs is now read-only)"
    );
    std::fs::remove_file(&legacy_overlay).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to remove legacy guest rootfs overlay {}: {}",
            legacy_overlay.display(),
            e
        ))
    })
}

/// Prepare guest rootfs as a versioned disk image.
///
/// Uses the two-stage pipeline:
/// 1. `ImageDiskManager`: pure image layers → ext4 disk (cached by image digest)
/// 2. `GuestRootfsManager`: image disk + boxlite-guest → versioned rootfs (cached by digest+guest hash)
#[allow(dead_code)] // OCI boot path, kept for a possible future switch back
async fn prepare_guest_rootfs(
    guest_rootfs_mgr: &GuestRootfsManager,
    image_disk_mgr: &ImageDiskManager,
    base_image: &crate::images::ImageObject,
    env: Vec<(String, String)>,
) -> BoxliteResult<GuestRootfs> {
    guest_rootfs_mgr
        .get_or_create(base_image, image_disk_mgr, env)
        .await
}

#[allow(dead_code)] // OCI boot path, kept for a possible future switch back
async fn pull_guest_rootfs_image(
    runtime: &SharedRuntimeImpl,
) -> BoxliteResult<crate::images::ImageObject> {
    // ImageManager has internal locking - direct access
    runtime.image_manager.pull(images::INIT_ROOTFS).await
}

#[allow(dead_code)] // OCI boot path, kept for a possible future switch back
async fn extract_env_from_image(
    image: &crate::images::ImageObject,
) -> BoxliteResult<Vec<(String, String)>> {
    let image_config = image.load_config().await?;

    let env: Vec<(String, String)> = if let Some(config) = image_config.config() {
        if let Some(envs) = config.env() {
            envs.iter()
                .filter_map(|e| {
                    let parts: Vec<&str> = e.splitn(2, '=').collect();
                    if parts.len() == 2 {
                        Some((parts[0].to_string(), parts[1].to_string()))
                    } else {
                        None
                    }
                })
                .collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::layout::FsLayoutConfig;

    fn test_layout(box_dir: &std::path::Path) -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(
            box_dir.to_path_buf(),
            FsLayoutConfig::without_bind_mount(),
            false,
        )
    }

    #[test]
    fn removes_existing_legacy_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let layout = test_layout(dir.path());
        let overlay = layout.guest_rootfs_disk_path();
        std::fs::create_dir_all(overlay.parent().unwrap()).unwrap();
        std::fs::write(&overlay, b"legacy overlay").unwrap();
        assert!(overlay.exists());

        remove_legacy_guest_rootfs_overlay(&layout).unwrap();

        assert!(!overlay.exists());
    }

    #[test]
    fn noop_when_no_legacy_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let layout = test_layout(dir.path());

        remove_legacy_guest_rootfs_overlay(&layout).unwrap();
    }
}
