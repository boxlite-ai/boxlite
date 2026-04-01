//! Type definitions for initialization pipeline.

use crate::BoxID;
use crate::disk::Disk;
#[cfg(target_os = "linux")]
use crate::fs::BindMountHandle;
use crate::images::ContainerImageConfig;
use crate::litebox::config::BoxConfig;
use crate::portal::GuestSession;
use crate::portal::interfaces::ContainerRootfsInitConfig;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::VolumeSpec;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::vmm::controller::VmmHandler;
use crate::volumes::{ContainerMount, GuestVolumeManager};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

/// Switch between merged and overlayfs rootfs strategies.
/// - true: overlayfs (allows COW writes, keeps layers separate)
/// - false: merged rootfs (all layers merged on host)
pub const USE_OVERLAYFS: bool = true;

/// Switch to disk-based rootfs strategy.
/// - true: create ext4 disk from layers, use qcow2 COW overlay per box
/// - false: use virtiofs + overlayfs (default)
///
/// Disk-based rootfs is faster to start but requires more disk space.
/// When enabled, USE_OVERLAYFS is ignored.
pub const USE_DISK_ROOTFS: bool = true;

/// User-specified volume with resolved paths and generated tag.
#[derive(Debug, Clone)]
pub struct ResolvedVolume {
    pub tag: String,
    pub host_path: PathBuf,
    pub guest_path: String,
    pub read_only: bool,
    /// Owner UID of host directory (for auto-idmap in guest).
    pub owner_uid: u32,
    /// Owner GID of host directory (for auto-idmap in guest).
    pub owner_gid: u32,
}

pub fn resolve_user_volumes(volumes: &[VolumeSpec]) -> BoxliteResult<Vec<ResolvedVolume>> {
    let mut resolved = Vec::with_capacity(volumes.len());

    for (i, vol) in volumes.iter().enumerate() {
        let host_path = PathBuf::from(&vol.host_path);

        if !host_path.exists() {
            return Err(BoxliteError::Config(format!(
                "Volume host path does not exist: {}",
                vol.host_path
            )));
        }

        let resolved_path = host_path.canonicalize().map_err(|e| {
            BoxliteError::Config(format!(
                "Failed to resolve volume path '{}': {}",
                vol.host_path, e
            ))
        })?;

        if !resolved_path.is_dir() {
            return Err(BoxliteError::Config(format!(
                "Volume host path is not a directory: {}",
                vol.host_path
            )));
        }

        let tag = format!("uservol{}", i);

        // Stat host path to get owner UID/GID for auto-idmap in guest
        let (owner_uid, owner_gid) = {
            use std::os::unix::fs::MetadataExt;
            let meta = std::fs::metadata(&resolved_path).map_err(|e| {
                BoxliteError::Config(format!(
                    "Failed to stat volume path '{}': {}",
                    resolved_path.display(),
                    e
                ))
            })?;
            (meta.uid(), meta.gid())
        };

        tracing::debug!(
            tag = %tag,
            host_path = %resolved_path.display(),
            guest_path = %vol.guest_path,
            read_only = vol.read_only,
            owner_uid,
            owner_gid,
            "Resolved user volume"
        );

        resolved.push(ResolvedVolume {
            tag,
            host_path: resolved_path,
            guest_path: vol.guest_path.clone(),
            read_only: vol.read_only,
            owner_uid,
            owner_gid,
        });
    }

    Ok(resolved)
}

/// Result of rootfs preparation - either merged, separate layers, or disk image.
#[derive(Debug)]
pub enum ContainerRootfsPrepResult {
    /// Single merged directory (all layers merged on host)
    #[allow(dead_code)]
    Merged(PathBuf),
    /// Layers for guest-side overlayfs
    #[allow(dead_code)] // Overlayfs mode currently disabled (USE_DISK_ROOTFS=true)
    Layers {
        /// Parent directory containing all extracted layers (mount as single virtiofs share)
        layers_dir: PathBuf,
        /// Subdirectory names for each layer (e.g., "sha256-xxxx")
        layer_names: Vec<String>,
    },
    /// Disk image containing the complete rootfs
    /// The disk is attached as a block device and mounted directly
    DiskImage {
        /// Path to the base ext4 disk image (cached, shared across boxes)
        base_disk_path: PathBuf,
        /// Size of the disk in bytes (for creating COW overlay)
        disk_size: u64,
    },
}

/// RAII guard for cleanup on initialization failure.
///
/// Automatically cleans up resources and increments failure counter
/// if dropped without being disarmed.
pub struct CleanupGuard {
    runtime: SharedRuntimeImpl,
    box_id: BoxID,
    layout: Option<BoxFilesystemLayout>,
    handler: Option<Box<dyn VmmHandler>>,
    armed: bool,
}

impl CleanupGuard {
    pub fn new(runtime: SharedRuntimeImpl, box_id: BoxID) -> Self {
        Self {
            runtime,
            box_id,
            layout: None,
            handler: None,
            armed: true,
        }
    }

    /// Register layout for cleanup on failure.
    pub fn set_layout(&mut self, layout: BoxFilesystemLayout) {
        self.layout = Some(layout);
    }

    /// Register handler for cleanup on failure.
    pub fn set_handler(&mut self, handler: Box<dyn VmmHandler>) {
        self.handler = Some(handler);
    }

    /// Take ownership of handler (for success path).
    pub fn take_handler(&mut self) -> Option<Box<dyn VmmHandler>> {
        self.handler.take()
    }

    /// Get the PID of the VM subprocess, if a handler is registered.
    pub fn handler_pid(&self) -> Option<u32> {
        self.handler.as_ref().map(|h| h.pid())
    }

    /// Disarm the guard (call on success).
    ///
    /// After disarming, Drop will not perform cleanup.
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        tracing::warn!("Box initialization failed, cleaning up");

        // Stop handler if started
        if let Some(ref mut handler) = self.handler
            && let Err(e) = handler.stop()
        {
            tracing::warn!("Failed to stop handler during cleanup: {}", e);
        }

        // DON'T cleanup filesystem - preserve diagnostic files for debugging
        // Log message to user about preserved files
        if let Some(ref layout) = self.layout {
            tracing::error!(
                "Box crashed. Diagnostic files preserved at:\n  {}\n\nTo clean up: rm -rf {}",
                layout.root().display(),
                layout.root().display()
            );
        }

        // Remove from BoxManager (which handles DB delete via database-first pattern)
        // First mark as crashed so remove_box() doesn't fail the active check
        // TODO(@DorianZheng) Check if this is necessary
        if let Ok(mut state) = self.runtime.box_manager.update_box(&self.box_id) {
            state.mark_stop();
            let _ = self.runtime.box_manager.save_box(&self.box_id, &state);
        }
        if let Err(e) = self.runtime.box_manager.remove_box(&self.box_id) {
            tracing::warn!("Failed to remove box from manager during cleanup: {}", e);
        }

        // Increment failure counter
        self.runtime
            .runtime_metrics
            .boxes_failed
            .fetch_add(1, Ordering::Relaxed);
    }
}

/// Initialization pipeline context.
///
/// Contains all inputs and outputs for pipeline tasks.
/// Tasks read from config/runtime and write to Option fields.
pub struct InitPipelineContext {
    pub config: BoxConfig,
    pub runtime: SharedRuntimeImpl,
    pub guard: CleanupGuard,
    pub reuse_rootfs: bool,
    /// Skip waiting for guest ready signal (for reattach to running box).
    pub skip_guest_wait: bool,

    pub layout: Option<BoxFilesystemLayout>,
    pub container_image_config: Option<ContainerImageConfig>,
    pub container_disk: Option<Disk>,
    pub guest_disk: Option<Disk>,
    pub volume_mgr: Option<GuestVolumeManager>,
    pub rootfs_init: Option<ContainerRootfsInitConfig>,
    pub container_mounts: Option<Vec<ContainerMount>>,
    pub guest_session: Option<GuestSession>,
    /// MITM CA cert PEM (set by vmm_spawn, read by guest_init for Container.Init gRPC).
    pub ca_cert_pem: Option<String>,

    #[cfg(target_os = "linux")]
    pub bind_mount: Option<BindMountHandle>,
}

impl InitPipelineContext {
    pub fn new(
        config: BoxConfig,
        runtime: SharedRuntimeImpl,
        reuse_rootfs: bool,
        skip_guest_wait: bool,
    ) -> Self {
        let guard = CleanupGuard::new(runtime.clone(), config.id.clone());
        Self {
            config,
            runtime,
            guard,
            reuse_rootfs,
            skip_guest_wait,
            layout: None,
            container_image_config: None,
            container_disk: None,
            guest_disk: None,
            volume_mgr: None,
            rootfs_init: None,
            container_mounts: None,
            guest_session: None,
            ca_cert_pem: None,
            #[cfg(target_os = "linux")]
            bind_mount: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::options::VolumeSpec;

    #[test]
    fn resolve_volume_gets_owner_uid() {
        let tmp = tempfile::tempdir().unwrap();
        let volumes = vec![VolumeSpec {
            host_path: tmp.path().to_str().unwrap().to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let resolved = resolve_user_volumes(&volumes).unwrap();
        assert_eq!(resolved.len(), 1);

        // owner_uid should be the current user's UID
        use std::os::unix::fs::MetadataExt;
        let expected_uid = std::fs::metadata(tmp.path()).unwrap().uid();
        let expected_gid = std::fs::metadata(tmp.path()).unwrap().gid();

        assert_eq!(resolved[0].owner_uid, expected_uid);
        assert_eq!(resolved[0].owner_gid, expected_gid);
        assert_eq!(resolved[0].tag, "uservol0");
    }

    #[test]
    fn resolve_volume_nonexistent_path_errors() {
        let volumes = vec![VolumeSpec {
            host_path: "/nonexistent/path/12345".to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let result = resolve_user_volumes(&volumes);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_volume_file_not_dir_errors() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let volumes = vec![VolumeSpec {
            host_path: tmp.path().to_str().unwrap().to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let result = resolve_user_volumes(&volumes);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not a directory"));
    }
}
