//! Refresh and validate operation state against the persisted record and VM owner.
use super::box_impl::BoxImpl;
use crate::runtime::types::BoxStatus;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

#[derive(Clone, Copy)]
pub(crate) enum Action {
    Lifecycle,
    Stop,
    DiskCapture,
    Checkpoint,
    DiskRestore,
    ArchiveRestore,
    SnapshotRemove,
    #[cfg_attr(
        all(not(target_os = "linux"), not(test)),
        expect(dead_code, reason = "online resize requires Linux/KVM")
    )]
    Resize,
}

impl BoxImpl {
    pub(crate) async fn check_operation(&self, action: Action) -> BoxliteResult<()> {
        let mut state = self.runtime.box_manager.update_box(self.id())?;
        let initializing_archive =
            matches!(action, Action::ArchiveRestore) && state.status == BoxStatus::Configured;
        if !initializing_archive
            && !matches!(action, Action::Lifecycle | Action::Stop)
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
            Action::Resize => state.status == BoxStatus::Running,
            Action::DiskRestore => state.status == BoxStatus::Stopped,
            Action::ArchiveRestore => {
                matches!(state.status, BoxStatus::Configured | BoxStatus::Stopped)
            }
            Action::SnapshotRemove => true,
        };
        if !allowed {
            return Err(BoxliteError::InvalidState(format!(
                "operation refused in {} state",
                state.status
            )));
        }
        *self.state.write() = state;
        Ok(())
    }
}

#[cfg(test)]
#[path = "tests/operation.rs"]
mod tests;
