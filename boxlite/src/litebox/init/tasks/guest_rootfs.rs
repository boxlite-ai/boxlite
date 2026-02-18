//! Task: Guest rootfs preparation.
//!
//! Lazily initializes the bootstrap guest rootfs as a disk image (shared across all boxes).
//! Then creates or reuses per-box COW overlay disk.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::{BackingFormat, Disk, DiskFormat, Qcow2Helper};
use crate::images::ImageDiskManager;
use crate::pipeline::PipelineTask;
use crate::runtime::constants::images;
use crate::runtime::guest_rootfs::{GuestRootfs, Strategy};
use crate::runtime::guest_rootfs_manager::GuestRootfsManager;
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
            tracing::info!(
                "Initializing bootstrap guest rootfs {} (first time only)",
                images::INIT_ROOTFS
            );

            let base_image = pull_guest_rootfs_image(runtime).await?;
            let env = extract_env_from_image(&base_image).await?;
            let guest_rootfs = prepare_guest_rootfs(
                &runtime.guest_rootfs_mgr,
                &runtime.image_disk_mgr,
                &base_image,
                env,
            )
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

    if reuse_rootfs {
        // Restart: reuse existing COW disk
        tracing::info!(
            disk_path = %guest_rootfs_disk_path.display(),
            "Restart mode: reusing existing guest rootfs disk"
        );

        if !guest_rootfs_disk_path.exists() {
            return Err(BoxliteError::Storage(format!(
                "Cannot restart: guest rootfs disk not found at {}",
                guest_rootfs_disk_path.display()
            )));
        }

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
    }

    // Fresh start: create new COW disk
    if let Strategy::Disk { ref disk_path, .. } = guest_rootfs.strategy {
        let base_disk_path = disk_path;

        // Get base disk size
        let base_size = std::fs::metadata(base_disk_path)
            .map(|m| m.len())
            .unwrap_or(512 * 1024 * 1024);

        // Try reflink base rootfs into box_dir so the qcow2 overlay references
        // a box-local path, eliminating the sandbox dependency on home_dir/rootfs/.
        // Reflink is instant on CoW filesystems (APFS, btrfs, xfs); falls back
        // to the external path on ext4/tmpfs where reflink isn't supported.
        let effective_base = reflink_rootfs_base(base_disk_path, layout);

        // Create COW child disk
        let qcow2_helper = Qcow2Helper::new();
        let temp_disk = qcow2_helper.create_cow_child_disk(
            &effective_base,
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

/// Prepare guest rootfs as a versioned disk image.
///
/// Uses the two-stage pipeline:
/// 1. `ImageDiskManager`: pure image layers → ext4 disk (cached by image digest)
/// 2. `GuestRootfsManager`: image disk + boxlite-guest → versioned rootfs (cached by digest+guest hash)
async fn prepare_guest_rootfs(
    guest_rootfs_mgr: &GuestRootfsManager,
    image_disk_mgr: &ImageDiskManager,
    base_image: &crate::images::ImageObject,
    env: Vec<(String, String)>,
) -> BoxliteResult<GuestRootfs> {
    let rootfs_disk = guest_rootfs_mgr
        .get_or_create(base_image, image_disk_mgr)
        .await?;

    let disk_path = rootfs_disk.path().to_path_buf();

    // Ownership transfers to GuestRootfs/OnceCell — prevent drop cleanup
    let _ = rootfs_disk.leak();

    GuestRootfs::new(
        disk_path.clone(),
        Strategy::Disk {
            disk_path,
            device_path: None,
        },
        None,
        None,
        env,
    )
}

async fn pull_guest_rootfs_image(
    runtime: &SharedRuntimeImpl,
) -> BoxliteResult<crate::images::ImageObject> {
    // ImageManager has internal locking - direct access
    runtime.image_manager.pull(images::INIT_ROOTFS).await
}

/// Try to reflink the base rootfs into box_dir for sandbox isolation.
///
/// On CoW filesystems (APFS, btrfs, xfs), this creates a zero-cost clone
/// with a new inode inside the box directory. The qcow2 overlay then
/// references this local path, so the sandbox doesn't need access to
/// `home_dir/rootfs/`.
///
/// Falls back to the original path on filesystems without reflink (ext4, tmpfs).
fn reflink_rootfs_base(
    base_disk_path: &std::path::Path,
    layout: &BoxFilesystemLayout,
) -> std::path::PathBuf {
    let local_base = layout.rootfs_base_path();

    // Skip if local base already exists (e.g. restart with existing reflink)
    if local_base.exists() {
        return local_base;
    }

    match reflink_copy::reflink(base_disk_path, &local_base) {
        Ok(()) => {
            tracing::info!(
                src = %base_disk_path.display(),
                dst = %local_base.display(),
                "Reflinked base rootfs into box_dir (zero-copy)"
            );
            local_base
        }
        Err(e) => {
            tracing::debug!(
                error = %e,
                "Reflink not supported, using external rootfs backing path"
            );
            base_disk_path.to_path_buf()
        }
    }
}

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
    use tempfile::tempdir;

    fn test_layout(box_dir: std::path::PathBuf) -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(box_dir, FsLayoutConfig::without_bind_mount(), false)
    }

    /// When rootfs_base_path() already exists, reflink_rootfs_base returns it
    /// without overwriting. This is critical for restart safety.
    #[test]
    fn test_reflink_rootfs_base_returns_existing_local() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        // Pre-create local base with known content
        std::fs::write(layout.rootfs_base_path(), "existing-local-base").unwrap();

        // Source file with different content
        let base_disk = dir.path().join("original-rootfs.raw");
        std::fs::write(&base_disk, "original-content").unwrap();

        let result = reflink_rootfs_base(&base_disk, &layout);

        // Should return the existing local path without overwriting
        assert_eq!(result, layout.rootfs_base_path());
        assert_eq!(
            std::fs::read_to_string(&result).unwrap(),
            "existing-local-base",
            "Content must NOT be overwritten"
        );
    }

    /// On CoW-capable filesystems (APFS on macOS), reflink succeeds and returns
    /// the box-local path. On unsupported filesystems, falls back to original.
    /// This test handles both outcomes.
    #[test]
    fn test_reflink_rootfs_base_success_or_fallback() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        let base_disk = dir.path().join("rootfs.raw");
        std::fs::write(&base_disk, "rootfs-content-for-reflink-test").unwrap();

        let result = reflink_rootfs_base(&base_disk, &layout);

        // On APFS (macOS dev machines): reflink succeeds → local path
        // On ext4/tmpfs (Linux CI): reflink fails → original path
        if layout.rootfs_base_path().exists() {
            // Reflink succeeded
            assert_eq!(result, layout.rootfs_base_path());
            assert_eq!(
                std::fs::read_to_string(&result).unwrap(),
                "rootfs-content-for-reflink-test"
            );
        } else {
            // Reflink failed — fallback to original
            assert_eq!(result, base_disk);
        }
    }

    /// When the source doesn't exist, reflink fails and returns the original path.
    #[test]
    fn test_reflink_rootfs_base_failure_returns_original() {
        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path().to_path_buf());

        // Source that doesn't exist → reflink will fail
        let nonexistent = dir.path().join("does-not-exist.raw");

        let result = reflink_rootfs_base(&nonexistent, &layout);

        // Must return the original path (fallback)
        assert_eq!(result, nonexistent);
        // Local base must NOT be created
        assert!(
            !layout.rootfs_base_path().exists(),
            "Local base should not exist when reflink fails"
        );
    }
}
