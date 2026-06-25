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

/// Resolve user-requested volumes into mountable specs.
///
/// Step-2 gate: every `host_path` must canonicalize to a directory under
/// `<home>/volumes/anonymous/` or `<home>/volumes/named/`. The CLI parser
/// produces only these shapes (see `cli::parse_volume_spec` +
/// `materialize_volume`); SDK callers that pass arbitrary host paths
/// (`/etc`, `/root`, …) hit this gate and get a `Config` error. Without
/// the gate, the box could see any host path the shim's uid could read.
///
/// Empty `volumes` slice is always allowed so no-volume boxes spawn
/// cleanly without touching the home dir.
pub fn resolve_user_volumes(
    volumes: &[VolumeSpec],
    home: &std::path::Path,
) -> BoxliteResult<Vec<ResolvedVolume>> {
    let mut resolved = Vec::with_capacity(volumes.len());

    // Canonical roots that the gate allows. We canonicalize once up
    // front — if `<home>` itself doesn't canonicalize (transient FS
    // error, dangling symlink), fall back to the lexical form so the
    // gate still functions; the per-volume `starts_with` check below
    // will simply reject everything until the home dir is healthy.
    let home_canon = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let allowed_anon = home_canon.join("volumes").join("anonymous");
    let allowed_named = home_canon.join("volumes").join("named");

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

        // Structural gate: must be one volume directory deep under a
        // managed root — i.e. `<home>/volumes/anonymous/<id>` or
        // `<home>/volumes/named/<name>`. A bare `starts_with` would
        // also accept the aggregate roots themselves and arbitrary
        // deeper paths (`…/named/myvol/etc/`), letting SDK callers
        // pierce the per-volume isolation contract. The check runs
        // AFTER canonicalize so symlinks pointing out of the managed
        // roots are caught too.
        let parent = resolved_path.parent();
        let is_anon_volume_dir = parent == Some(allowed_anon.as_path());
        let is_named_volume_dir = parent == Some(allowed_named.as_path());
        if !is_anon_volume_dir && !is_named_volume_dir {
            return Err(BoxliteError::Config(format!(
                "Volume host path '{path}' is not a boxlite-managed volume. \
                 Host bind mounts were removed in step 2 — use a named volume \
                 (CLI: `-v <name>:{guest}`) or an anonymous volume \
                 (CLI: `-v {guest}`) instead. Managed roots: '{anon}' and '{named}'.",
                path = resolved_path.display(),
                guest = vol.guest_path,
                anon = allowed_anon.display(),
                named = allowed_named.display(),
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
/// On drop (when armed):
///   1. stops the VM handler if started,
///   2. preserves on-disk diagnostic files (intentional — line 201 comment),
///   3. marks the box as `Failed` with `error_reason` so the record survives
///      for retry/inspection (canonical pattern: Daytona ERROR, Kata startVM
///      defer, containerd status.ExitCode, Docker SetError+CheckpointTo),
///   4. increments the failure counter.
///
/// The caller is expected to call `set_last_error()` before the error
/// propagates so Drop can record what went wrong.
pub struct CleanupGuard {
    runtime: SharedRuntimeImpl,
    box_id: BoxID,
    layout: Option<BoxFilesystemLayout>,
    handler: Option<Box<dyn VmmHandler>>,
    armed: bool,
    /// Captured cause for the eventual `Failed` state. Populated by the init
    /// pipeline caller via `set_last_error()` before the error propagates.
    /// `None` if Drop fires without an explicit cause — falls back to a
    /// generic placeholder in that case.
    last_error: Option<String>,
}

impl CleanupGuard {
    pub fn new(runtime: SharedRuntimeImpl, box_id: BoxID) -> Self {
        Self {
            runtime,
            box_id,
            layout: None,
            handler: None,
            armed: true,
            last_error: None,
        }
    }

    /// Capture the error that caused init to fail.
    ///
    /// Call this immediately before propagating the error out of the init
    /// pipeline. Stores `err.to_string()` so we don't need `Clone` on
    /// `BoxliteError`.
    pub fn set_last_error(&mut self, err: &BoxliteError) {
        self.last_error = Some(err.to_string());
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

        let reason = self
            .last_error
            .as_deref()
            .unwrap_or("box initialization failed (no cause captured)");

        tracing::warn!(box_id = %self.box_id, reason = %reason, "Box initialization failed, cleaning up");

        // Stop handler if started
        if let Some(ref mut handler) = self.handler
            && let Err(e) = handler.stop()
        {
            tracing::warn!("Failed to stop handler during cleanup: {}", e);
        }

        // DON'T cleanup filesystem - preserve diagnostic files for debugging
        if let Some(ref layout) = self.layout {
            tracing::error!(
                "Box failed. Diagnostic files preserved at:\n  {}\n\nTo destroy: issue DESTROY_SANDBOX or `boxlite rm {}`",
                layout.root().display(),
                self.box_id
            );
        }

        // Preserve the box record in the DB with status=Failed + error_reason.
        // Canonical pattern across Daytona / Kata / containerd / Docker:
        //   "persistent records survive init failure; only ephemeral runtime
        //    artifacts are torn down. Deletion is user-initiated."
        // Replaces the previous unconditional remove_box() which silently
        // orphaned on-disk state and lost the user's sandbox.
        match self.runtime.box_manager.update_box(&self.box_id) {
            Ok(mut state) => {
                state.mark_failed(reason);
                if let Err(e) = self.runtime.box_manager.save_box(&self.box_id, &state) {
                    tracing::warn!(
                        box_id = %self.box_id,
                        "Failed to persist Failed state during cleanup: {}", e
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    box_id = %self.box_id,
                    "Could not load state to mark Failed (record may have been deleted concurrently): {}", e
                );
            }
        }

        // Increment failure counter (existing Prometheus metric).
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

    /// Build a fake `<home>/volumes/<kind>/<id>` dir on disk and return
    /// `(home, host_path_string)` so resolve_user_volumes can see a
    /// path that lives under one of its allowed roots.
    fn make_managed_volume(home: &std::path::Path, kind: &str, id: &str) -> String {
        let p = home.join("volumes").join(kind).join(id);
        std::fs::create_dir_all(&p).unwrap();
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn resolve_volume_anonymous_under_home_succeeds() {
        let home = tempfile::tempdir().unwrap();
        let host_path = make_managed_volume(home.path(), "anonymous", "01J000");
        let volumes = vec![VolumeSpec {
            host_path: host_path.clone(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let resolved = resolve_user_volumes(&volumes, home.path()).expect("anon under home OK");
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].tag, "uservol0");

        use std::os::unix::fs::MetadataExt;
        let expected_uid = std::fs::metadata(&host_path).unwrap().uid();
        let expected_gid = std::fs::metadata(&host_path).unwrap().gid();
        assert_eq!(resolved[0].owner_uid, expected_uid);
        assert_eq!(resolved[0].owner_gid, expected_gid);
    }

    #[test]
    fn resolve_volume_named_under_home_succeeds() {
        let home = tempfile::tempdir().unwrap();
        let host_path = make_managed_volume(home.path(), "named", "myvol");
        let volumes = vec![VolumeSpec {
            host_path,
            guest_path: "/data".to_string(),
            read_only: true,
        }];

        let resolved = resolve_user_volumes(&volumes, home.path()).expect("named under home OK");
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].read_only);
    }

    /// **Side B for the runtime gate.** Deleting the
    /// `if !resolved_path.starts_with(&allowed_anon) && ... { Err }`
    /// branch in `resolve_user_volumes` flips this red — the test
    /// names a real host directory (the system tempdir) that is NOT
    /// under `<home>/volumes/`, and the gate is what stops it.
    #[test]
    fn resolve_volume_rejects_non_managed_host_path() {
        let home = tempfile::tempdir().unwrap();
        // tempdir() lives under /tmp, which is NOT under home/volumes/.
        let outside = tempfile::tempdir().unwrap();
        let volumes = vec![VolumeSpec {
            host_path: outside.path().to_str().unwrap().to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let err = resolve_user_volumes(&volumes, home.path())
            .expect_err("non-managed host path must be rejected");
        let msg = err.to_string();
        assert!(
            msg.contains("not a boxlite-managed volume"),
            "expected managed-volume rejection; got {msg}"
        );
        assert!(
            msg.contains("named volume") && msg.contains("anonymous"),
            "error must point at the supported alternatives; got {msg}"
        );
    }

    /// Aggregate-root escape (coderabbitai #639 finding):
    /// `<home>/volumes/named` itself must NOT pass the gate, because
    /// mounting the aggregate root would let the box see every named
    /// volume on the host. Reverting the per-volume-dir check (going
    /// back to `starts_with`) flips this red.
    #[test]
    fn resolve_volume_aggregate_root_rejected() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("volumes").join("named")).unwrap();
        std::fs::create_dir_all(home.path().join("volumes").join("anonymous")).unwrap();

        for root in ["named", "anonymous"] {
            let aggregate = home.path().join("volumes").join(root);
            let volumes = vec![VolumeSpec {
                host_path: aggregate.to_str().unwrap().to_string(),
                guest_path: "/data".to_string(),
                read_only: false,
            }];
            let err = match resolve_user_volumes(&volumes, home.path()) {
                Err(e) => e,
                Ok(_) => panic!("aggregate root {root:?} must be rejected; got Ok"),
            };
            assert!(
                err.to_string().contains("not a boxlite-managed volume"),
                "aggregate root {root:?} rejection must use the managed-volume message; got {err}"
            );
        }
    }

    /// Sub-volume descendant escape (same coderabbitai finding):
    /// `<home>/volumes/named/myvol/etc/` (a path one level deeper
    /// than a named volume directory) must NOT pass — the box would
    /// be mounting a sub-tree of someone else's volume.
    #[test]
    fn resolve_volume_deep_descendant_rejected() {
        let home = tempfile::tempdir().unwrap();
        let vol_dir = home.path().join("volumes").join("named").join("myvol");
        let deep = vol_dir.join("etc");
        std::fs::create_dir_all(&deep).unwrap();

        let volumes = vec![VolumeSpec {
            host_path: deep.to_str().unwrap().to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];
        let result = resolve_user_volumes(&volumes, home.path());
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("deep descendant must be rejected; got Ok"),
        };
        assert!(
            err.to_string().contains("not a boxlite-managed volume"),
            "deep descendant rejection must use the managed-volume message; got {err}"
        );
    }

    /// Symlink escape: a host_path that lives lexically under
    /// `<home>/volumes/` but symlinks out to /etc must be rejected
    /// because we canonicalize before the `starts_with` check.
    #[test]
    fn resolve_volume_symlink_escape_rejected() {
        let home = tempfile::tempdir().unwrap();
        let escape_target = tempfile::tempdir().unwrap();
        // Place the symlink under home/volumes/named/escapevol → outside.
        let link_dir = home.path().join("volumes").join("named");
        std::fs::create_dir_all(&link_dir).unwrap();
        let link_path = link_dir.join("escapevol");
        std::os::unix::fs::symlink(escape_target.path(), &link_path).unwrap();

        let volumes = vec![VolumeSpec {
            host_path: link_path.to_str().unwrap().to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let err = resolve_user_volumes(&volumes, home.path())
            .expect_err("symlink out of managed roots must be rejected");
        assert!(err.to_string().contains("not a boxlite-managed volume"));
    }

    #[test]
    fn resolve_volume_nonexistent_path_errors() {
        let home = tempfile::tempdir().unwrap();
        let volumes = vec![VolumeSpec {
            host_path: "/nonexistent/path/12345".to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let result = resolve_user_volumes(&volumes, home.path());
        assert!(result.is_err());
    }

    #[test]
    fn resolve_volume_file_not_dir_errors() {
        let home = tempfile::tempdir().unwrap();
        // Plant a regular file under home/volumes/named/badvol so the
        // managed-root check passes and the file/dir check is exercised.
        let dir = home.path().join("volumes").join("named");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("badvol");
        std::fs::write(&f, b"hi").unwrap();
        let volumes = vec![VolumeSpec {
            host_path: f.to_str().unwrap().to_string(),
            guest_path: "/data".to_string(),
            read_only: false,
        }];

        let result = resolve_user_volumes(&volumes, home.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not a directory"));
    }

    #[test]
    fn resolve_volume_empty_slice_ok() {
        let home = tempfile::tempdir().unwrap();
        let resolved = resolve_user_volumes(&[], home.path()).unwrap();
        assert!(resolved.is_empty());
    }

    /// Reverting Drop to call `remove_box` (the pre-fix behavior) flips this red:
    /// `update_box` would return `NotFound` because the row was deleted.
    #[test]
    fn cleanup_guard_drop_persists_failed_state_and_keeps_record() {
        use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
        use crate::runtime::id::BoxID;
        use crate::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
        use crate::runtime::rt_impl::RuntimeImpl;
        use crate::runtime::types::{BoxState, BoxStatus, ContainerID};
        use crate::vmm::VmmKind;
        use boxlite_test_utils::home::PerTestBoxHome;
        use chrono::Utc;
        use std::path::PathBuf;

        let home = PerTestBoxHome::isolated_in("/tmp");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .expect("create runtime");

        let box_id = BoxID::parse("01HJK4TNRPQSXYZ8WM6NCVT9CG1").unwrap();
        let config = BoxConfig {
            id: box_id.clone(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("test:latest".to_string()),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: PathBuf::from("/tmp/box"),
        };
        runtime
            .box_manager
            .add_box(&config, &BoxState::new())
            .expect("seed Configured box");

        // Capture the Display string from production's BoxliteError so the
        // assertion below is on data routed through production code, not on
        // a literal the test body invented.
        let err =
            BoxliteError::Engine("Box CL84LvGx7RBE failed to start: timeout after 30s".to_string());
        let err_display = err.to_string();

        {
            let mut guard = CleanupGuard::new(runtime.clone(), box_id.clone());
            guard.set_last_error(&err);
            // Drop fires here: armed=true by default.
        }

        // Assertion 1: record was NOT deleted (the original bug).
        assert!(
            runtime.box_manager.has_box(&box_id).unwrap(),
            "CleanupGuard::drop must preserve the box record"
        );

        // Assertion 2: state is Failed (production transitioned it).
        let persisted = runtime.box_manager.update_box(&box_id).unwrap();
        assert_eq!(persisted.status, BoxStatus::Failed);

        // Assertion 3: error_reason carries the BoxliteError's Display string,
        // having round-tripped through set_last_error -> Drop -> mark_failed ->
        // save_box -> load_state.
        let reason = persisted
            .error_reason
            .as_deref()
            .expect("error_reason populated by Drop");
        assert!(
            reason.contains(&err_display),
            "error_reason should round-trip BoxliteError::Display; got {reason:?}"
        );
    }
}
