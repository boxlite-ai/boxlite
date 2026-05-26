//! Task: Guest rootfs preparation.
//!
//! Lazily initializes the bootstrap guest rootfs as a disk image (shared across all boxes).
//! Then creates or reuses per-box COW overlay disk.
//!
//! ## Init rootfs source
//!
//! The init rootfs is built **locally** from an empty source tree — `mke2fs`
//! produces a fresh ext4 image and `inject_file_into_ext4` writes the
//! `boxlite-guest` binary into `/boxlite/bin/`. There is no network pull,
//! no docker.io dependency, and no external base image of any kind. See
//! `GuestRootfsManager::get_or_create_init_rootfs` and issue #591 for the
//! migration rationale.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::{BackingFormat, Disk, DiskFormat, Qcow2Helper};
use crate::pipeline::PipelineTask;
use crate::rootfs::guest::{GuestRootfs, Strategy};
use crate::runtime::constants::init_rootfs;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::rt_impl::SharedRuntimeImpl;
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
    reuse_rootfs: bool,
) -> BoxliteResult<Option<Disk>> {
    // First, get or create the shared base guest rootfs
    let guest_rootfs = runtime
        .guest_rootfs
        .get_or_try_init(|| async {
            tracing::info!("Initializing bootstrap guest rootfs (first time only)");

            let env = vec![("PATH".to_string(), init_rootfs::PATH_ENV.to_string())];
            let guest_rootfs = runtime
                .guest_rootfs_mgr
                .get_or_create_init_rootfs(env)
                .await?;

            tracing::info!("Bootstrap guest rootfs ready: {:?}", guest_rootfs.strategy);

            Ok::<_, BoxliteError>(guest_rootfs)
        })
        .await?
        .clone();

    // Now create or reuse the per-box COW disk
    let (_updated_guest_rootfs, disk) =
        create_or_reuse_cow_disk(&guest_rootfs, layout, reuse_rootfs)?;

    Ok(disk)
}

/// Create new COW disk or reuse existing one for restart.
fn create_or_reuse_cow_disk(
    guest_rootfs: &GuestRootfs,
    layout: &BoxFilesystemLayout,
    reuse_rootfs: bool,
) -> BoxliteResult<(GuestRootfs, Option<Disk>)> {
    let guest_rootfs_disk_path = layout.guest_rootfs_disk_path();

    if reuse_rootfs && guest_rootfs_disk_path.exists() {
        // Validate backing chain is intact before reusing.
        // A broken chain (e.g. from a failed migration or deleted cache) would cause
        // a cryptic hypervisor failure — catch it early with a clear error.
        if let Ok(Some(backing)) =
            crate::disk::qcow2::read_backing_file_path(&guest_rootfs_disk_path)
            && !std::path::Path::new(&backing).exists()
        {
            return Err(BoxliteError::Storage(format!(
                "Guest rootfs {} has missing backing file: {}. \
                 This may indicate a broken migration or deleted cache file. \
                 The box cannot start until the backing file is restored.",
                guest_rootfs_disk_path.display(),
                backing
            )));
        }

        // Restart: reuse existing COW disk
        tracing::info!(
            disk_path = %guest_rootfs_disk_path.display(),
            "Restart mode: reusing existing guest rootfs disk"
        );

        // Open existing disk as persistent
        let disk = Disk::new(guest_rootfs_disk_path.clone(), DiskFormat::Qcow2, true);

        // Update guest_rootfs with the COW disk path
        let mut updated = guest_rootfs.clone();
        if let Strategy::Disk { ref disk_path, .. } = guest_rootfs.strategy {
            updated.strategy = Strategy::Disk {
                disk_path: disk_path.clone(), // Keep base path reference
                device_path: None,            // Will be set by VmmSpawnTask
            };
        }

        return Ok((updated, Some(disk)));
    } else if reuse_rootfs {
        // Guest rootfs disk missing (e.g., clone or snapshot-restore).
        // Fall through to create a fresh COW overlay from the shared cache.
        tracing::info!(
            disk_path = %guest_rootfs_disk_path.display(),
            "Guest rootfs disk missing on restart, recreating from cache"
        );
    }

    // Fresh start: create new COW disk
    if let Strategy::Disk { ref disk_path, .. } = guest_rootfs.strategy {
        let base_disk_path = disk_path;

        // Get base disk size
        let base_size = std::fs::metadata(base_disk_path)
            .map(|m| m.len())
            .unwrap_or(512 * 1024 * 1024);

        // Point the COW overlay directly at the shared rootfs cache.
        // Disk images are data (read by the hypervisor, not executed on the host),
        // so sharing the backing file is safe — no Spectre-class concerns.
        let temp_disk = Qcow2Helper::create_cow_child_disk(
            base_disk_path,
            BackingFormat::Raw,
            &guest_rootfs_disk_path,
            base_size,
        )?;

        // Make disk persistent so it survives stop/restart
        let disk_path_owned = temp_disk.leak();
        let disk = Disk::new(disk_path_owned, DiskFormat::Qcow2, true);

        tracing::info!(
            cow_disk = %guest_rootfs_disk_path.display(),
            base_disk = %base_disk_path.display(),
            "Created guest rootfs COW overlay (persistent)"
        );

        // Update guest_rootfs with COW disk path
        let mut updated = guest_rootfs.clone();
        updated.strategy = Strategy::Disk {
            disk_path: guest_rootfs_disk_path,
            device_path: None, // Will be set by VmmSpawnTask
        };

        Ok((updated, Some(disk)))
    } else {
        // Non-disk strategy - no COW disk needed
        Ok((guest_rootfs.clone(), None))
    }
}
