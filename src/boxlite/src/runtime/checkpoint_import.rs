//! Import of a BoxCheckpoint file as a new, paused box.
//!
//! Everything in the file is checked before anything box-owned exists. The
//! new box gets a new host identity (ID, home, sockets, gvproxy socket,
//! console log); the guest keeps its own (container ID, PIDs, execution IDs).
//! The shim restores the VM paused: no kernel, no Guest.Init, no
//! Container.Init or Container.Start, no ready wait. The box is published
//! only once the owner reports it paused and every restored disk and share
//! copy is accounted for. Any failure stops the shim this attempt spawned
//! and then removes only what the attempt created; nothing is published.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::litebox::LiteBox;
use crate::litebox::checkpoint::archive::{self, Manifest};
use crate::litebox::checkpoint::{RestoredDisk, RestoredStorage};
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::litebox::init::{checkpoint_import_spec, read_tail, spawn_vm};
use crate::lock::LockId;
use crate::runtime::constants::mount_tags;
use crate::runtime::id::{BoxID, BoxIDMint};
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::{BoxOptions, CheckpointImportOptions};
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::types::{BoxState, BoxStatus, ContainerID};
use crate::vmm::checkpoint::support::{self, Host};
use crate::vmm::checkpoint::{ControlClient, ControlRequest, ImportLaunch, VmRunState};
use crate::vmm::controller::VmmHandler;
use crate::vmm::{ExitInfo, InstanceSpec, VmmKind};

/// How long the shim may take to restore the image. A multi-GB image is
/// read in full, so this is generous; a shim that dies ends the wait at once.
const IMPORT_START_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STATE_POLL: Duration = Duration::from_millis(100);
/// How much of a dead import shim's stderr the operator log keeps.
const SHIM_STDERR_TAIL: u64 = 16 * 1024;
/// How long a failed attempt waits for its shim to be gone before it
/// removes anything.
const SHIM_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
/// A volume's host path until its restored copy exists.
const PENDING_COPY: &str = "/nonexistent/boxlite-restored-volume";

/// Starts the shim that restores the image. A seam for tests; production
/// spawns the jailed `boxlite-shim`.
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait ImportLauncher: Send + Sync {
    async fn launch(
        &self,
        box_id: &BoxID,
        spec: &InstanceSpec,
        options: &BoxOptions,
        layout: &BoxFilesystemLayout,
    ) -> BoxliteResult<Box<dyn VmmHandler>>;
}

struct ShimLauncher;

#[async_trait]
impl ImportLauncher for ShimLauncher {
    async fn launch(
        &self,
        box_id: &BoxID,
        spec: &InstanceSpec,
        options: &BoxOptions,
        layout: &BoxFilesystemLayout,
    ) -> BoxliteResult<Box<dyn VmmHandler>> {
        spawn_vm(box_id, spec, options, layout).await
    }
}

fn invalid(why: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Storage(format!("invalid checkpoint: {why}"))
}

/// Import the checkpoint at `path` as a new box, paused.
pub(crate) async fn import_checkpoint(
    runtime: &SharedRuntimeImpl,
    path: &Path,
    options: CheckpointImportOptions,
) -> BoxliteResult<LiteBox> {
    import_with(runtime, path, options, &ShimLauncher).await
}

pub(crate) async fn import_with(
    runtime: &SharedRuntimeImpl,
    path: &Path,
    import: CheckpointImportOptions,
    launcher: &dyn ImportLauncher,
) -> BoxliteResult<LiteBox> {
    support::check_host(Host::current())?;

    // Verify everything into a private staging directory first.
    let staging = tempfile::Builder::new()
        .prefix("checkpoint-import-")
        .tempdir_in(runtime.layout.temp_dir())
        .map_err(|e| BoxliteError::Storage(format!("checkpoint staging directory: {e}")))?;
    let staged = staging.path().join("vm.krunvm");
    let (manifest, share_payloads) = {
        let (path, staged) = (path.to_path_buf(), staged.clone());
        tokio::task::spawn_blocking(move || archive::read(&path, &staged))
            .await
            .map_err(|e| BoxliteError::Internal(format!("checkpoint read task failed: {e}")))??
    };
    let options = verified_options(&manifest, share_payloads)?;
    let container_id = ContainerID::parse(&manifest.guest.container_id)
        .ok_or_else(|| invalid("the guest's container ID is malformed"))?;

    // The new box's resources, owned by this attempt until it is published.
    let box_id = BoxIDMint::mint();
    let layout = runtime.layout.box_layout(box_id.as_str(), false)?;
    std::fs::create_dir(layout.root()).map_err(|e| {
        BoxliteError::Storage(format!("create box home {}: {e}", layout.root().display()))
    })?;
    let mut attempt = Attempt {
        runtime: runtime.clone(),
        layout: layout.clone(),
        handler: None,
        lock: None,
        armed: true,
    };
    layout.prepare()?;
    let restored = layout.prepare_restored_dir()?;
    let image = layout.prepare_checkpoint_dir()?.join("import.krunvm");
    crate::litebox::archive::move_file(&staged, &image)?;
    let launch = ImportLaunch {
        image: image.clone(),
        disk_dir: Some(restored.join("disks")),
        fs_dir: Some(restored.join("fs")),
        console_output: layout.console_output_path(),
    };
    // The network backend is the box's control client for the new gvproxy;
    // the reattach after resume creates its own.
    let (spec, _network) = checkpoint_import_spec(
        &box_id,
        &options,
        &layout,
        runtime,
        manifest.boot.outbound_policy.as_ref(),
        launch,
    )?;
    let handler = launcher.launch(&box_id, &spec, &options, &layout).await?;
    let pid = handler.pid();
    attempt.handler = Some(handler);

    let control = ControlClient::new(layout.control_socket_path());
    wait_paused(&control, pid, &layout).await?;
    // libkrun reads the image only while it restores.
    let _ = std::fs::remove_file(&image);
    let (storage, copies) = restored_storage(&control, &manifest, &restored).await?;

    // External shares become the box's own copies; the source paths mean
    // nothing on this host and are never read.
    let mut options = options;
    for (index, volume) in options.volumes.iter_mut().enumerate() {
        let copy = copies
            .get(&archive::volume_tag(index))
            .ok_or_else(|| invalid(format_args!("no restored copy of volume {index}")))?;
        volume.host_path = copy.to_string_lossy().into_owned();
    }
    let config = BoxConfig {
        id: box_id.clone(),
        name: import.name,
        created_at: chrono::Utc::now(),
        container: ContainerRuntimeConfig { id: container_id },
        options,
        engine_kind: VmmKind::Libkrun,
        box_home: layout.root().to_path_buf(),
    };
    let mut state = BoxState::new();
    state.set_status(BoxStatus::Paused);
    state.set_pid(Some(pid));
    state.outbound_policy = manifest.boot.outbound_policy.clone();
    state.checkpoint_guest = Some(manifest.guest.clone());
    state.restored_storage = Some(storage);
    let lock = runtime.lock_manager.allocate()?;
    attempt.lock = Some(lock);
    state.set_lock_id(lock);

    // Publishing is the last step, and nothing after it fails or waits: an
    // import dropped before it leaves nothing behind.
    runtime.box_manager.add_box(&config, &state)?;
    let (box_impl, inserted) = runtime.get_or_create_box_impl(config, state);
    if !inserted {
        // A live handle of another box holds the name.
        if let Err(e) = runtime.box_manager.remove_box(&box_id) {
            tracing::warn!(box_id = %box_id, error = %e, "Failed to unpublish the failed import");
        }
        return Err(BoxliteError::InvalidArgument(
            "box with this name already exists".into(),
        ));
    }
    // The handle keeps the shim's watchdog keepalive; resuming reattaches
    // through the ordinary plan, which checks the guest's identity.
    box_impl.hold_imported_shim(attempt.publish());
    tracing::info!(box_id = %box_id, source = %manifest.source_box_id, "Imported checkpoint (paused)");
    Ok(crate::runtime::rt_impl::litebox_from_impl(box_impl))
}

/// The box options the checkpoint carries, checked as this host would
/// check a new box's, against the image's devices and file size limit.
fn verified_options(manifest: &Manifest, share_payloads: u64) -> BoxliteResult<BoxOptions> {
    let mut options = manifest.boot.options.clone();
    if !options.advanced.checkpoint_enabled {
        return Err(invalid("its box options are not checkpoint-enabled"));
    }
    if !options.mounts.is_empty() || options.volumes.iter().any(|v| v.managed_volume.is_some()) {
        return Err(invalid(
            "typed mounts and managed volumes cannot be restored",
        ));
    }
    // The source host's volume paths mean nothing here and are never read;
    // the restored copies replace them once they exist.
    for volume in &mut options.volumes {
        volume.host_path = PENDING_COPY.to_string();
    }
    options.sanitize().map_err(|error| match error {
        BoxliteError::Unsupported(_) => error,
        error => invalid(format_args!("box options: {error}")),
    })?;
    manifest.layout.check_for(&options)?;
    // The jailed shim writes every restored disk and share file under this
    // limit; a larger one would kill it half-way.
    let limit = options.shim_file_size_limit();
    let largest = manifest
        .layout
        .disks
        .iter()
        .map(|disk| disk.bytes)
        .chain([share_payloads])
        .max()
        .unwrap_or(0);
    if largest > limit {
        return Err(invalid(format_args!(
            "a restored file of up to {largest} bytes exceeds the box's file size limit of {limit}"
        )));
    }
    Ok(options)
}

/// Wait until the owner reports the restored VM paused. The shim dying,
/// any other state, or the deadline fails the import.
async fn wait_paused(
    control: &ControlClient,
    pid: u32,
    layout: &BoxFilesystemLayout,
) -> BoxliteResult<()> {
    let deadline = Instant::now() + IMPORT_START_TIMEOUT;
    loop {
        if !crate::util::is_process_alive(pid) {
            // A failed import removes the box directory and the shim's stderr
            // with it, so its tail (libkrun's reason) goes to the operator log.
            if let Some(tail) = read_tail(&layout.stderr_file_path(), SHIM_STDERR_TAIL) {
                tracing::error!("checkpoint import shim stderr (tail):\n{tail}");
            }
            let why = ExitInfo::from_file(&layout.exit_file_path())
                .map(|info| format!(": {info:?}"))
                .unwrap_or_default();
            return Err(BoxliteError::Engine(format!(
                "the shim exited before the checkpoint was restored{why}"
            )));
        }
        // Not served yet, or no answer: ask again.
        if let Ok(reply) = control.send(&ControlRequest::State).await
            && reply.error.is_none()
        {
            match reply.state {
                VmRunState::Paused if reply.in_flight.is_none() => return Ok(()),
                VmRunState::Configured | VmRunState::Starting | VmRunState::Paused => {}
                state => {
                    return Err(BoxliteError::Engine(format!(
                        "the restored VM is {state}, not paused"
                    )));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(BoxliteError::Engine(format!(
                "the checkpoint was not restored within {}s",
                IMPORT_START_TIMEOUT.as_secs()
            )));
        }
        tokio::time::sleep(STATE_POLL).await;
    }
}

/// The copies libkrun handed over: each disk at `restored/disks/disk-<i>.raw`
/// with the image's length, and each share's root as the owner reports it,
/// a real directory inside `restored/fs`.
async fn restored_storage(
    control: &ControlClient,
    manifest: &Manifest,
    restored: &Path,
) -> BoxliteResult<(RestoredStorage, HashMap<String, PathBuf>)> {
    let fs_root = restored
        .join("fs")
        .canonicalize()
        .map_err(|e| invalid(format_args!("restored shares: {e}")))?;
    let mut copies = HashMap::new();
    for share in &manifest.layout.shares {
        let reply = control
            .send(&ControlRequest::RestoredShare {
                tag: share.tag.clone(),
            })
            .await
            .map_err(|e| BoxliteError::Engine(format!("restored share {}: {e}", share.tag)))?;
        let path = match (reply.error, reply.share) {
            (None, Some(path)) => path,
            (Some(failure), _) => {
                return Err(BoxliteError::Engine(format!(
                    "restored share {}: {}",
                    share.tag, failure.message
                )));
            }
            (None, None) => return Err(BoxliteError::Engine("restored share: no path".into())),
        };
        // Canonical already (no link anywhere on the way), a directory, and
        // inside this box's restored tree.
        let real = path.canonicalize().ok();
        let is_dir = std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir());
        if real.as_deref() != Some(path.as_path()) || !is_dir || !path.starts_with(&fs_root) {
            return Err(BoxliteError::Engine(format!(
                "restored share {} at {} is not a directory inside {}",
                share.tag,
                path.display(),
                fs_root.display()
            )));
        }
        copies.insert(share.tag.clone(), path);
    }

    let mut disks = Vec::new();
    for (index, disk) in manifest.layout.disks.iter().enumerate() {
        let path = restored.join("disks").join(format!("disk-{index}.raw"));
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| BoxliteError::Engine(format!("restored disk {}: {e}", path.display())))?;
        if !meta.is_file() || meta.len() != disk.bytes {
            return Err(BoxliteError::Engine(format!(
                "restored disk {} is not a {}-byte file",
                path.display(),
                disk.bytes
            )));
        }
        disks.push(RestoredDisk {
            path,
            format: crate::vmm::DiskFormat::Raw,
            read_only: disk.read_only,
        });
    }
    let shared_dir = copies
        .get(mount_tags::SHARED)
        .cloned()
        .ok_or_else(|| invalid("no restored copy of the box's shared tree"))?;
    let storage = RestoredStorage {
        disks,
        shared_dir,
        container_image_config: manifest.boot.container_image_config.clone(),
    };
    Ok((storage, copies))
}

/// What an import created, removed again unless the box is published.
struct Attempt {
    runtime: SharedRuntimeImpl,
    layout: BoxFilesystemLayout,
    handler: Option<Box<dyn VmmHandler>>,
    lock: Option<LockId>,
    armed: bool,
}

impl Attempt {
    /// The box is published: keep everything and hand the shim over.
    fn publish(mut self) -> Box<dyn VmmHandler> {
        self.armed = false;
        self.handler
            .take()
            .expect("an attempt is published only after its shim started")
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // The shim goes first: until it is gone it may still write the
        // restored tree.
        if let Some(mut handler) = self.handler.take() {
            let pid = handler.pid();
            if let Err(e) = handler.stop() {
                tracing::warn!(pid, error = %e, "Failed to stop the import's shim");
            }
            let deadline = Instant::now() + SHIM_EXIT_TIMEOUT;
            while crate::util::is_process_alive(pid) {
                if Instant::now() >= deadline {
                    tracing::error!(
                        pid,
                        home = %self.layout.root().display(),
                        "The failed import's shim is still alive; leaving its files in place"
                    );
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        if let Some(lock) = self.lock.take()
            && let Err(e) = self.runtime.lock_manager.free(lock)
        {
            tracing::warn!(error = %e, "Failed to free the import's lock");
        }
        if let Err(e) = self.layout.cleanup() {
            tracing::warn!(error = %e, "Failed to remove the failed import's box home");
        }
    }
}

#[cfg(test)]
#[path = "checkpoint_import_tests.rs"]
mod tests;
