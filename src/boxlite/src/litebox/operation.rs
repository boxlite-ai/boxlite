//! Whole-operation ownership across handles and host processes.
use super::box_impl::BoxImpl;
use crate::runtime::{id::BoxID, layout::FilesystemLayout, types::BoxStatus};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub(crate) enum Action {
    Lifecycle,
    Stop,
    DiskCapture,
    Checkpoint,
    DiskRestore,
    SnapshotRemove,
}

/// Independent of VM-lifetime locks; never unlink or recycle its inode.
pub(crate) struct Reservation {
    _file: File,
}

fn lock_path(layout: &FilesystemLayout, id: &BoxID) -> PathBuf {
    layout.home_dir().join("operations").join(id.as_str())
}

impl Reservation {
    pub(crate) fn duplicate(&self) -> BoxliteResult<Self> {
        Ok(Self {
            _file: self
                ._file
                .try_clone()
                .map_err(|e| BoxliteError::Storage(e.to_string()))?,
        })
    }
    pub(crate) fn provision(layout: &FilesystemLayout, id: &BoxID) -> BoxliteResult<()> {
        let path = lock_path(layout, id);
        std::fs::create_dir_all(path.parent().expect("operation lock has a parent"))
            .map_err(|e| BoxliteError::Storage(format!("operation lock directory: {e}")))?;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|e| {
                BoxliteError::Storage(format!("provision operation lock {}: {e}", path.display()))
            })?;
        Ok(())
    }

    pub(crate) fn acquire(layout: &FilesystemLayout, id: &BoxID) -> BoxliteResult<Self> {
        Self::open(&lock_path(layout, id))
    }

    fn open(path: &Path) -> BoxliteResult<Self> {
        let file = OpenOptions::new().read(true).write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)
            .map_err(|e| BoxliteError::InvalidState(format!(
                "operation lock {} unavailable: {e}; stop and explicitly restart this legacy box", path.display())))?;
        if !file
            .metadata()
            .map_err(|e| BoxliteError::Storage(e.to_string()))?
            .is_file()
        {
            return Err(BoxliteError::InvalidState(
                "operation lock is not a regular file".into(),
            ));
        }
        // SAFETY: a separate live open description; closing releases the lock.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(BoxliteError::InvalidState(format!(
                "Busy: another box operation owns the reservation ({})",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self { _file: file })
    }
}

impl BoxImpl {
    pub(crate) async fn reserve(&self, action: Action) -> BoxliteResult<Reservation> {
        let guard = Reservation::acquire(&self.runtime.layout, self.id())?;
        let mut state = self.runtime.box_manager.update_box(self.id())?;
        if !matches!(action, Action::Lifecycle | Action::Stop)
            && !matches!(
                state.status,
                BoxStatus::Running | BoxStatus::Paused | BoxStatus::Stopped
            )
        {
            return Err(BoxliteError::InvalidState(format!(
                "operation refused in {} state",
                state.status
            )));
        }
        let owner = state.start_mode.as_ref().is_some_and(|mode| mode.owns_vm());
        let live_shim = !matches!(
            crate::util::PidFileReader::at(self.layout.pid_file_path()).process_identity(),
            crate::util::ProcessIdentity::Absent
        );
        if owner
            && (state.status.is_active() || live_shim)
            && !matches!(action, Action::Stop | Action::Lifecycle)
        {
            let reply = self
                .checkpoint_control()
                .send(&crate::vmm::checkpoint::ControlRequest::State)
                .await
                .map_err(|e| BoxliteError::Engine(format!("authoritative operation state: {e}")))?;
            if reply.in_flight.is_some() {
                return Err(BoxliteError::InvalidState(
                    "Busy: owner capture or mutation is in progress".into(),
                ));
            }
            use crate::vmm::checkpoint::VmRunState;
            state.force_status(match reply.state {
                VmRunState::Running => BoxStatus::Running,
                VmRunState::Paused => BoxStatus::Paused,
                VmRunState::Stopped | VmRunState::Exited(_) => BoxStatus::Stopped,
                _ => {
                    return Err(BoxliteError::InvalidState(format!(
                        "owner is {}",
                        reply.state
                    )));
                }
            });
        }
        let allowed = match action {
            Action::Lifecycle | Action::Stop => true,
            Action::DiskCapture => matches!(state.status, BoxStatus::Running | BoxStatus::Stopped),
            Action::Checkpoint => state.status == BoxStatus::Paused && owner,
            Action::DiskRestore => state.status == BoxStatus::Stopped,
            Action::SnapshotRemove => true,
        };
        if !allowed {
            return Err(BoxliteError::InvalidState(format!(
                "operation refused in {} state",
                state.status
            )));
        }
        *self.state.write() = state;
        Ok(guard)
    }
}

#[cfg(test)]
#[path = "tests/operation.rs"]
mod tests;
