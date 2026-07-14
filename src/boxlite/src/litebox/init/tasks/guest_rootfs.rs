//! Task: Guest rootfs preparation.
//!
//! Lazily initializes the bootstrap guest rootfs as a disk image (shared across all boxes).
//! Then creates or reuses per-box COW overlay disk.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::{BackingFormat, Disk, DiskFormat, Qcow2Helper};
use crate::images::ImageDiskManager;
use crate::pipeline::PipelineTask;
use crate::rootfs::guest::{GuestRootfs, GuestRootfsManager, Strategy};
use crate::runtime::constants::images;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;

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

    if reuse_rootfs && guest_rootfs_disk_path.exists() {
        if validate_reusable_guest_rootfs_disk(&guest_rootfs_disk_path)? {
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
        }
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

fn validate_reusable_guest_rootfs_disk(guest_rootfs_disk_path: &Path) -> BoxliteResult<bool> {
    // Validate backing chain is intact before reusing.
    // A broken chain (e.g. from a failed migration or deleted cache) would cause
    // a cryptic hypervisor failure — catch it early with a clear error.
    use crate::disk::qcow2::Qcow2HeaderError;
    match crate::disk::qcow2::read_backing_file_path_checked(guest_rootfs_disk_path) {
        Ok(Some(backing)) if !Path::new(&backing).exists() => Err(BoxliteError::Storage(format!(
            "Guest rootfs {} has missing backing file: {}. \
                 This may indicate a broken migration or deleted cache file. \
                 The box cannot start until the backing file is restored.",
            guest_rootfs_disk_path.display(),
            backing
        ))),
        // Header and backing chain are intact, but a clean header does not prove
        // the *contents* survived. A host crash can tear the overlay's in-flight
        // writes (e.g. the ext4 journal), leaving an unmountable filesystem behind
        // a perfectly valid qcow2 header — so the box would fail to boot forever on
        // every restart. Probe the assembled guest filesystem before reusing it.
        Ok(_) => validate_reusable_guest_rootfs_contents(guest_rootfs_disk_path),
        // Structurally corrupt overlay: its data is already unreadable, so discard
        // it and recreate a fresh COW from the shared cache.
        Err(Qcow2HeaderError::Corrupt(reason)) => {
            tracing::warn!(
                disk_path = %guest_rootfs_disk_path.display(),
                reason = %reason,
                "Discarding corrupt guest rootfs COW overlay and recreating from cache"
            );
            std::fs::remove_file(guest_rootfs_disk_path).map_err(|remove_err| {
                BoxliteError::Storage(format!(
                    "Failed to remove corrupt guest rootfs {} ({}): {}",
                    guest_rootfs_disk_path.display(),
                    reason,
                    remove_err
                ))
            })?;
            Ok(false)
        }
        // Transient/system I/O fault: we cannot tell whether the overlay is intact,
        // so do NOT delete it — surface the error and let the start be retried.
        Err(Qcow2HeaderError::Io(io)) => Err(BoxliteError::Storage(format!(
            "Cannot read guest rootfs {} to validate its backing chain (I/O error: {io}); \
             refusing to discard a possibly-intact overlay",
            guest_rootfs_disk_path.display()
        ))),
    }
}

/// Probe the per-box guest rootfs overlay and decide whether it can be reused.
///
/// Returns `Ok(true)` to reuse, `Ok(false)` to discard + recreate a fresh overlay
/// from the shared base, or `Err` when reuse must be refused without deleting
/// anything (a transient I/O fault).
fn validate_reusable_guest_rootfs_contents(guest_rootfs_disk_path: &Path) -> BoxliteResult<bool> {
    use crate::disk::qcow2::Qcow2HeaderError;

    let discard = |reason: &str| -> BoxliteResult<bool> {
        tracing::warn!(
            disk_path = %guest_rootfs_disk_path.display(),
            reason = %reason,
            "Discarding guest rootfs COW overlay with unreadable contents and recreating from cache"
        );
        std::fs::remove_file(guest_rootfs_disk_path).map_err(|remove_err| {
            BoxliteError::Storage(format!(
                "Failed to remove corrupt guest rootfs {} ({}): {}",
                guest_rootfs_disk_path.display(),
                reason,
                remove_err
            ))
        })?;
        Ok(false)
    };

    // A structural self-consistency check of the overlay itself: every cluster
    // its L1/L2 tables reference must physically exist in the file. A crash can
    // persist an L2 mapping whose data cluster was never written, leaving a
    // dangling reference past the file's end. libkrun reads that as zeros, so
    // the guest kernel fails the mount with EBADMSG on every restart. A dangling
    // cluster is purely overlay damage, so discard + rebuild.
    match crate::disk::qcow2::probe_overlay_cluster_integrity(guest_rootfs_disk_path) {
        Ok(()) => Ok(true),
        Err(Qcow2HeaderError::Corrupt(reason)) => discard(&reason),
        Err(Qcow2HeaderError::Io(io)) => Err(BoxliteError::Storage(format!(
            "Cannot read guest rootfs {} to validate overlay cluster integrity \
             (I/O error: {io}); refusing to discard a possibly-intact overlay",
            guest_rootfs_disk_path.display()
        ))),
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
    guest_rootfs_mgr
        .get_or_create(base_image, image_disk_mgr, env)
        .await
}

async fn pull_guest_rootfs_image(
    runtime: &SharedRuntimeImpl,
) -> BoxliteResult<crate::images::ImageObject> {
    // ImageManager has internal locking - direct access
    runtime.image_manager.pull(images::INIT_ROOTFS).await
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
    use std::fs::File;
    use std::io::Write;
    use tempfile::TempDir;

    fn test_layout(dir: &TempDir) -> BoxFilesystemLayout {
        let layout = BoxFilesystemLayout::new(
            dir.path().join("boxes").join("box-1"),
            FsLayoutConfig::without_bind_mount(),
            false,
        );
        std::fs::create_dir_all(layout.disks_dir()).unwrap();
        layout
    }

    fn create_base_disk(dir: &TempDir) -> std::path::PathBuf {
        let base_disk_path = dir.path().join("guest-rootfs-base.ext4");
        let file = File::create(&base_disk_path).unwrap();
        file.set_len(1024 * 1024).unwrap();
        file.sync_all().unwrap();
        base_disk_path
    }

    fn test_guest_rootfs(base_disk_path: std::path::PathBuf) -> GuestRootfs {
        GuestRootfs {
            path: base_disk_path
                .parent()
                .expect("base disk has parent")
                .to_path_buf(),
            strategy: Strategy::Disk {
                disk_path: base_disk_path,
                device_path: None,
            },
            kernel: None,
            initrd: None,
            env: Vec::new(),
        }
    }

    fn create_guest_overlay(
        base_disk_path: &std::path::Path,
        guest_rootfs_disk_path: &std::path::Path,
    ) {
        Qcow2Helper::create_cow_child_disk(
            base_disk_path,
            BackingFormat::Raw,
            guest_rootfs_disk_path,
            1024 * 1024,
        )
        .unwrap()
        .leak();
    }

    fn read_guest_overlay_backing(guest_rootfs_disk_path: &std::path::Path) -> String {
        crate::disk::qcow2::read_backing_file_path(guest_rootfs_disk_path)
            .unwrap()
            .unwrap()
    }

    fn write_qcow2_with_backing_bytes(
        guest_rootfs_disk_path: &std::path::Path,
        backing_bytes: &[u8],
    ) {
        let mut buf = vec![0u8; 1024];
        buf[0..4].copy_from_slice(&0x514649fbu32.to_be_bytes());
        buf[4..8].copy_from_slice(&3u32.to_be_bytes());
        buf[8..16].copy_from_slice(&512u64.to_be_bytes());
        buf[16..20].copy_from_slice(&(backing_bytes.len() as u32).to_be_bytes());
        buf[512..512 + backing_bytes.len()].copy_from_slice(backing_bytes);

        let mut file = File::create(guest_rootfs_disk_path).unwrap();
        file.write_all(&buf).unwrap();
    }

    #[test]
    fn test_reuse_keeps_valid_guest_rootfs_overlay() {
        let dir = TempDir::new().unwrap();
        let base_disk_path = create_base_disk(&dir);
        let layout = test_layout(&dir);
        let guest_rootfs_disk_path = layout.guest_rootfs_disk_path();
        create_guest_overlay(&base_disk_path, &guest_rootfs_disk_path);
        let before = std::fs::metadata(&guest_rootfs_disk_path).unwrap();

        let guest_rootfs = test_guest_rootfs(base_disk_path.clone());
        let (_updated, disk) = create_or_reuse_cow_disk(&guest_rootfs, &layout, true).unwrap();

        assert_eq!(disk.unwrap().path(), guest_rootfs_disk_path);
        let after = std::fs::metadata(&guest_rootfs_disk_path).unwrap();
        assert_eq!(after.len(), before.len());
        assert_eq!(after.modified().unwrap(), before.modified().unwrap());
        assert_eq!(
            read_guest_overlay_backing(&guest_rootfs_disk_path),
            base_disk_path.canonicalize().unwrap().display().to_string()
        );
    }

    #[test]
    fn test_reuse_recreates_invalid_guest_rootfs_overlay() {
        let dir = TempDir::new().unwrap();
        let base_disk_path = create_base_disk(&dir);
        let layout = test_layout(&dir);
        let guest_rootfs_disk_path = layout.guest_rootfs_disk_path();
        std::fs::write(&guest_rootfs_disk_path, vec![0u8; 256 * 1024]).unwrap();

        let guest_rootfs = test_guest_rootfs(base_disk_path.clone());
        let (_updated, disk) = create_or_reuse_cow_disk(&guest_rootfs, &layout, true).unwrap();

        assert_eq!(disk.unwrap().path(), guest_rootfs_disk_path);
        assert_eq!(
            read_guest_overlay_backing(&guest_rootfs_disk_path),
            base_disk_path.canonicalize().unwrap().display().to_string()
        );
    }

    #[test]
    fn test_reuse_recreates_too_short_guest_rootfs_overlay() {
        let dir = TempDir::new().unwrap();
        let base_disk_path = create_base_disk(&dir);
        let layout = test_layout(&dir);
        let guest_rootfs_disk_path = layout.guest_rootfs_disk_path();
        std::fs::write(&guest_rootfs_disk_path, [0u8; 10]).unwrap();

        let guest_rootfs = test_guest_rootfs(base_disk_path.clone());
        create_or_reuse_cow_disk(&guest_rootfs, &layout, true).unwrap();

        assert_eq!(
            read_guest_overlay_backing(&guest_rootfs_disk_path),
            base_disk_path.canonicalize().unwrap().display().to_string()
        );
    }

    #[test]
    fn test_reuse_recreates_guest_rootfs_overlay_with_invalid_utf8_backing_path() {
        let dir = TempDir::new().unwrap();
        let base_disk_path = create_base_disk(&dir);
        let layout = test_layout(&dir);
        let guest_rootfs_disk_path = layout.guest_rootfs_disk_path();
        write_qcow2_with_backing_bytes(&guest_rootfs_disk_path, &[0xff, 0xfe, 0xfd]);

        let guest_rootfs = test_guest_rootfs(base_disk_path.clone());
        create_or_reuse_cow_disk(&guest_rootfs, &layout, true).unwrap();

        assert_eq!(
            read_guest_overlay_backing(&guest_rootfs_disk_path),
            base_disk_path.canonicalize().unwrap().display().to_string()
        );
    }

    #[test]
    fn test_io_error_does_not_discard_guest_rootfs_overlay() {
        // A directory at the overlay path makes the header read fail with an I/O
        // error (EISDIR) — not EOF — i.e. a transient/system fault, NOT proof of
        // corruption. validate must surface the error WITHOUT deleting the path,
        // so a momentary I/O blip never destroys a possibly-intact overlay.
        let dir = TempDir::new().unwrap();
        let guest_rootfs_disk_path = dir.path().join("guest-rootfs.qcow2");
        std::fs::create_dir(&guest_rootfs_disk_path).unwrap();

        let err = match validate_reusable_guest_rootfs_disk(&guest_rootfs_disk_path) {
            Ok(_) => panic!("expected an I/O error, not a reuse/discard decision"),
            Err(err) => err,
        };

        assert!(
            format!("{err}").contains("refusing to discard"),
            "I/O failures must not be treated as corruption: {err}"
        );
        assert!(
            guest_rootfs_disk_path.exists(),
            "overlay must not be deleted on an I/O error"
        );
    }

    #[test]
    fn test_reuse_reports_missing_guest_rootfs_backing() {
        let dir = TempDir::new().unwrap();
        let base_disk_path = create_base_disk(&dir);
        let layout = test_layout(&dir);
        let guest_rootfs_disk_path = layout.guest_rootfs_disk_path();
        create_guest_overlay(&base_disk_path, &guest_rootfs_disk_path);
        std::fs::remove_file(&base_disk_path).unwrap();

        let guest_rootfs = test_guest_rootfs(base_disk_path);
        let err = match create_or_reuse_cow_disk(&guest_rootfs, &layout, true) {
            Ok(_) => panic!("expected missing backing file error"),
            Err(err) => err,
        };

        assert!(format!("{err}").contains("has missing backing file"));
        assert!(guest_rootfs_disk_path.exists());
    }
}
