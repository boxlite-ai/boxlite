//! Lifecycle admission, state refresh, and observer reports for one box.

use super::*;
use crate::lock::LockGuard;
use crate::runtime::rt_impl::RuntimeImpl;

#[derive(Clone, Copy)]
pub(crate) struct BoxRun {
    pub pid: u32,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub(crate) enum BoxEvent {
    Exited { health_checked: bool },
    Health { healthy: bool, retries: u32 },
}

pub(super) enum StopReason {
    Requested,
    Exited { health_checked: bool },
}

impl BoxImpl {
    pub(crate) async fn with_operation<F, R>(&self, operation: F) -> BoxliteResult<R>
    where
        F: Future<Output = BoxliteResult<R>>,
    {
        let lock_id = self.state.read().lock_id.ok_or_else(|| {
            BoxliteError::Internal(format!("box {} is missing lock_id", self.id()))
        })?;
        let locker = self.runtime.lock_manager.retrieve(lock_id)?;
        let _guard = LockGuard::new_async(locker.as_ref()).await;
        let current = self.runtime.box_manager.update_box(self.id())?;
        {
            let mut state = self.state.write();
            if self.live.initialized()
                && current.status == BoxStatus::Running
                && (state.status != BoxStatus::Running
                    || state.pid != current.pid
                    || state.started_at != current.started_at)
            {
                return Err(BoxliteError::Stopped(
                    "Box handle belongs to an earlier VM; use runtime.get()".into(),
                ));
            }
            *state = current;
        }
        operation.await
    }

    pub(crate) fn try_with_operation<F, R>(
        runtime: &RuntimeImpl,
        id: &BoxID,
        operation: F,
    ) -> BoxliteResult<R>
    where
        F: FnOnce() -> BoxliteResult<R>,
    {
        let locker = runtime.box_locker(id)?;
        let _guard = locker
            .as_ref()
            .map(|locker| {
                LockGuard::try_new(locker.as_ref()).ok_or_else(|| {
                    BoxliteError::InvalidState(format!(
                        "box {id} has an operation in progress; retry removal"
                    ))
                })
            })
            .transpose()?;
        operation()
    }

    pub(crate) async fn apply_observation(
        &self,
        run: BoxRun,
        event: BoxEvent,
    ) -> BoxliteResult<Option<super::super::HealthStatus>> {
        self.with_operation(async {
            let current = self.state.read().clone();
            if self.shutdown_token.is_cancelled()
                || current.started_at != run.started_at
                || (current.status.is_active() && current.pid != Some(run.pid))
            {
                return Ok(None);
            }
            match event {
                BoxEvent::Exited { health_checked } => {
                    self.finish_stop(StopReason::Exited { health_checked })?;
                    Ok(None)
                }
                BoxEvent::Health { healthy, retries } => {
                    if current.status != BoxStatus::Running {
                        return Ok(None);
                    }
                    let mut state = self.state.write();
                    if healthy {
                        if state.health_status.state == crate::HealthState::Healthy
                            && state.health_status.failures == 0
                        {
                            return Ok(Some(state.health_status));
                        }
                        state.mark_health_check_success();
                    } else {
                        tracing::warn!(box_id = %self.id(), "Health check probe failed");
                        state.mark_health_check_failure(retries);
                    }
                    self.runtime.box_manager.save_box(self.id(), &state)?;
                    Ok(Some(state.health_status))
                }
            }
        })
        .await
    }
}
