//! Local live checkpoint transaction and startup settlement.

use std::fs::{self, File};
use std::io::{self, Write};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::OwnedRwLockWriteGuard;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{BoxImpl, BoxRun};
use crate::db::BoxStore;
use crate::litebox::config::BoxConfig;
use crate::lock::Locker;
use crate::runtime::checkpoints::{CheckpointAction, CheckpointRequest};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::runtime::types::{BoxState, BoxStatus};
use crate::util::{PidFileReader, PidRecord, process::pid_may_be_alive};
use crate::{BoxID, BoxliteError, BoxliteResult};

const PENDING: &str = ".checkpoint_pending";
const MARKER_VERSION: u32 = 1;

pub(crate) trait LiveCheckpointController: Send {
    /// Freeze can return Unsupported only if the guest is unchanged. Export
    /// owns vCPU stop, durable export and restart. Settle is idempotent for the
    /// operation ID and confirms running vCPUs and a thawed guest.
    fn checkpoint(&mut self, request: &CheckpointRequest<'_>) -> BoxliteResult<()>;

    #[cfg(test)]
    fn host_boot_id(&self) -> Option<String> {
        BoxStore::host_boot_id()
    }
}

/// Holds both local and kernel admission and can move to the blocking worker.
struct CheckpointLock {
    locker: Arc<dyn Locker>,
    _gate: Option<OwnedRwLockWriteGuard<()>>,
}

impl CheckpointLock {
    async fn acquire(locker: Arc<dyn Locker>) -> Self {
        let gate = match locker.gate() {
            Some(gate) => Some(gate.clone().write_owned().await),
            None => None,
        };
        while !locker.try_lock() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Self {
            locker,
            _gate: gate,
        }
    }
}

impl Drop for CheckpointLock {
    fn drop(&mut self) {
        self.locker.unlock();
    }
}

pub(crate) fn ensure_no_pending_checkpoint(box_home: &Path) -> BoxliteResult<()> {
    let marker = box_home.join(PENDING);
    if marker_exists(&marker)? {
        return Err(BoxliteError::InvalidState(format!(
            "Unresolved live checkpoint at {}",
            marker.display()
        )));
    }
    Ok(())
}

impl BoxImpl {
    pub(crate) async fn capture_live(self: &Arc<Self>) -> BoxliteResult<PathBuf> {
        let cancelled = self.shutdown_token.child_token();
        let _cancel_on_drop = cancelled.clone().drop_guard();
        let disk = CheckpointLock::acquire(self.disk_locker()?).await;
        let lock_id = self.state.read().lock_id.ok_or_else(|| {
            BoxliteError::Internal(format!("box {} is missing lock_id", self.id()))
        })?;
        let lifecycle = CheckpointLock::acquire(self.runtime.lock_manager.retrieve(lock_id)?).await;
        let source = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            // Finish settlement and rollback under both locks even if the caller
            // or its executor drops the future waiting for this worker.
            let (_disk, _lifecycle) = (disk, lifecycle);
            source.capture_live_locked(&cancelled)
        })
        .await
        .map_err(|error| BoxliteError::Internal(format!("Checkpoint worker: {error}")))?
    }

    fn capture_live_locked(&self, cancelled: &CancellationToken) -> BoxliteResult<PathBuf> {
        let state = self.runtime.box_manager.update_box(self.id())?;
        ensure_no_pending_checkpoint(&self.config.box_home)?;
        check_cancelled(cancelled)?;

        let live = self.live.get();
        {
            let mut cached = self.state.write();
            if live.is_some()
                && state.status == BoxStatus::Running
                && (cached.status != BoxStatus::Running
                    || cached.pid != state.pid
                    || cached.started_at != state.started_at)
            {
                return Err(BoxliteError::Stopped(
                    "Box handle belongs to an earlier VM; use runtime.get()".into(),
                ));
            }
            *cached = state.clone();
        }
        let Some(pid) = state
            .pid
            .filter(|pid| valid_pid(*pid) && state.status == BoxStatus::Running)
        else {
            return Err(BoxliteError::InvalidState(format!(
                "Live checkpoint requires a running box with a shim PID: {}",
                self.id()
            )));
        };
        let unsupported =
            || BoxliteError::Unsupported("live checkpoint is unsupported by this VMM".into());
        let live = live.ok_or_else(unsupported)?;
        let controller = live
            .checkpoint_controller
            .as_ref()
            .ok_or_else(unsupported)?;
        let reader = PidFileReader::at(self.layout.pid_file_path());
        let record = reader
            .verified_shim()
            .map(|shim| shim.identity())
            .filter(|record| record.pid == pid)
            .ok_or_else(|| unverified_shim(self.id()))?;
        let run = BoxRun {
            pid,
            started_at: state.started_at,
        };
        if live
            .handler
            .lock()
            .map_err(|error| {
                BoxliteError::Internal(format!("Checkpoint handler lock poisoned: {error}"))
            })?
            .pid()
            != run.pid
        {
            return Err(unverified_shim(self.id()));
        }
        let mut controller = controller.lock().map_err(|error| {
            BoxliteError::Internal(format!("Checkpoint controller lock poisoned: {error}"))
        })?;

        let verify_run = || {
            let current = self.runtime.box_manager.update_box(self.id())?;
            if current.status != BoxStatus::Running
                || current.pid != Some(run.pid)
                || current.started_at != run.started_at
                || reader.verified_shim().map(|shim| shim.identity()) != Some(record)
            {
                return Err(unverified_shim(self.id()));
            }
            Ok(())
        };
        verify_run()?;
        check_cancelled(cancelled)?;

        #[cfg(not(test))]
        let boot_id = BoxStore::host_boot_id();
        #[cfg(test)]
        let boot_id = controller.host_boot_id();
        let boot_id = boot_id.ok_or_else(|| {
            BoxliteError::InvalidState(format!(
                "Cannot establish checkpoint boot identity for box {}",
                self.id()
            ))
        })?;
        let pending = PendingCheckpoint {
            version: MARKER_VERSION,
            operation_id: Uuid::new_v4().to_string(),
            box_id: self.id().to_string(),
            shim: record,
            boot_id: Some(boot_id),
        };
        let marker = self.config.box_home.join(PENDING);
        let home = self.runtime.layout.home_dir();
        let root = checkpoint_root(home);
        fs::create_dir_all(&root)?;
        File::open(home)?.sync_all()?;
        let staging = pending.staging_dir(&root);
        let final_dir = root.join(&pending.operation_id);

        pending.persist(&marker)?;
        if let Err(error) = fs::DirBuilder::new().mode(0o700).create(&staging) {
            pending.clear(&marker)?;
            return Err(error.into());
        }

        let mut freeze_may_have_taken_effect = false;
        let mut settled = false;
        let result = (|| {
            verify_run()?;
            check_cancelled(cancelled)?;
            let freeze = controller.checkpoint(&pending.request(CheckpointAction::FreezeGuest));
            // Other errors may leave a partially frozen guest.
            freeze_may_have_taken_effect = !matches!(freeze, Err(BoxliteError::Unsupported(_)));
            freeze?;
            check_cancelled(cancelled)?;
            verify_run()?;
            controller.checkpoint(&pending.request(CheckpointAction::ExportAtomic {
                staging_dir: &staging,
            }))?;
            verify_run()?;
            controller.checkpoint(&pending.request(CheckpointAction::Settle))?;
            settled = true;
            File::open(&staging)?.sync_all()?;
            verify_run()?;
            check_cancelled(cancelled)?;
            fs::rename(&staging, &final_dir)?;
            Ok(())
        })();

        if let Err(error) = result {
            if freeze_may_have_taken_effect && !settled {
                let settle = verify_run().and_then(|()| {
                    controller.checkpoint(&pending.request(CheckpointAction::Settle))
                });
                if let Err(settle_error) = settle {
                    return Err(BoxliteError::InvalidState(format!(
                        "Checkpoint {} failed ({error}) and settlement is unresolved: {settle_error}",
                        pending.operation_id
                    )));
                }
            }
            discard_staging(&staging, &root)?;
            pending.clear(&marker)?;
            return Err(error);
        }

        // Once renamed, recovery preserves the final directory even if the
        // process dies before the marker is cleared.
        File::open(&root)?.sync_all()?;
        pending.clear(&marker)?;
        Ok(final_dir)
    }
}

fn check_cancelled(cancelled: &CancellationToken) -> BoxliteResult<()> {
    if cancelled.is_cancelled() {
        return Err(BoxliteError::Stopped(
            "Live checkpoint was cancelled".into(),
        ));
    }
    Ok(())
}

fn valid_pid(pid: u32) -> bool {
    (1..=i32::MAX as u32).contains(&pid)
}

fn unverified_shim(box_id: &BoxID) -> BoxliteError {
    BoxliteError::InvalidState(format!("Cannot verify checkpoint shim for box {box_id}"))
}

fn checkpoint_root(runtime_home: &Path) -> PathBuf {
    runtime_home.join("live-checkpoints")
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingCheckpoint {
    version: u32,
    operation_id: String,
    box_id: String,
    shim: PidRecord,
    boot_id: Option<String>,
}

impl PendingCheckpoint {
    fn request<'a>(&'a self, action: CheckpointAction<'a>) -> CheckpointRequest<'a> {
        CheckpointRequest {
            operation_id: &self.operation_id,
            action,
        }
    }

    fn read(marker: &Path, box_id: &BoxID) -> BoxliteResult<Self> {
        if !fs::symlink_metadata(marker)?.is_file() {
            return Err(BoxliteError::Storage(format!(
                "Checkpoint marker is not a regular file: {}",
                marker.display()
            )));
        }
        let pending: Self = serde_json::from_slice(&fs::read(marker)?)?;
        if pending.version != MARKER_VERSION
            || pending.box_id != box_id.as_str()
            || !valid_pid(pending.shim.pid)
            || pending.shim.start_time.is_none()
            || !Uuid::parse_str(&pending.operation_id)
                .is_ok_and(|id| id.to_string() == pending.operation_id)
        {
            return Err(BoxliteError::Storage(format!(
                "Invalid checkpoint marker at {}",
                marker.display()
            )));
        }
        Ok(pending)
    }

    fn staging_dir(&self, root: &Path) -> PathBuf {
        root.join(format!(".{}.staging", self.operation_id))
    }

    fn persist(&self, marker: &Path) -> BoxliteResult<()> {
        let contents = serde_json::to_vec(self)?;
        let parent = marker.parent().expect("checkpoint marker has a parent");
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(&contents)?;
        file.as_file().sync_all()?;
        file.persist(marker).map_err(|error| error.error)?;
        sync_marker_parent(marker)?;
        Ok(())
    }

    fn clear(&self, marker: &Path) -> BoxliteResult<()> {
        fs::remove_file(marker)?;
        if let Err(error) = sync_marker_parent(marker) {
            // Keep recovery admission closed if unlink durability is unknown.
            if let Err(restore_error) = self.persist(marker) {
                tracing::error!(path = %marker.display(), %restore_error, "Failed to restore checkpoint marker");
            }
            return Err(error.into());
        }
        Ok(())
    }
}

fn sync_marker_parent(marker: &Path) -> io::Result<()> {
    let parent = marker.parent().expect("checkpoint marker has a parent");
    File::open(parent)?.sync_all()
}

fn marker_exists(marker: &Path) -> BoxliteResult<bool> {
    match fs::symlink_metadata(marker) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(BoxliteError::Storage(format!(
            "Cannot inspect checkpoint marker {}: {error}",
            marker.display()
        ))),
    }
}

fn discard_staging(staging: &Path, root: &Path) -> BoxliteResult<()> {
    match fs::remove_dir_all(staging) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match File::open(root) {
        Ok(dir) => dir.sync_all()?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Settle a recorded checkpoint under exclusive runtime startup admission.
pub(crate) fn recover_pending_checkpoint(
    runtime: &RuntimeImpl,
    config: &BoxConfig,
    state: &BoxState,
    pid_file: &Path,
    current_boot_id: Option<&str>,
    settle: impl FnOnce(&CheckpointRequest<'_>, PidRecord) -> BoxliteResult<()>,
) -> BoxliteResult<bool> {
    let marker = config.box_home.join(PENDING);
    if !marker_exists(&marker)? {
        return Ok(false);
    }
    let pending = PendingCheckpoint::read(&marker, &config.id)?;
    let Some((recorded_boot_id, current_boot_id)) = pending.boot_id.as_deref().zip(current_boot_id)
    else {
        return Err(BoxliteError::InvalidState(format!(
            "Cannot establish checkpoint boot identity for box {}",
            config.id
        )));
    };
    if recorded_boot_id != current_boot_id {
        // Clear the stale identity before dropping the marker so later recovery
        // phases cannot adopt or stop a recycled process.
        match fs::remove_file(pid_file) {
            Ok(()) => sync_marker_parent(&marker)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut state = state.clone();
        state.reset_for_reboot();
        runtime.box_manager.save_box(&config.id, &state)?;
    } else {
        let reader = PidFileReader::at(pid_file);
        let pid_record = match fs::symlink_metadata(pid_file) {
            Ok(metadata) if metadata.is_file() => Some(reader.read()?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            _ => return Err(unverified_shim(&config.id)),
        };
        if state.pid != Some(pending.shim.pid)
            || pid_record.is_some_and(|record| record != pending.shim)
        {
            return Err(unverified_shim(&config.id));
        }

        let verified = reader.verified_shim().map(|shim| shim.identity());
        if verified == Some(pending.shim) {
            settle(&pending.request(CheckpointAction::Settle), pending.shim)?;
        } else if pid_may_be_alive(pending.shim.pid) {
            return Err(unverified_shim(&config.id));
        }
    }

    let root = checkpoint_root(runtime.layout.home_dir());
    discard_staging(&pending.staging_dir(&root), &root)?;
    pending.clear(&marker)?;
    Ok(true)
}
