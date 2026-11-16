//! Runtime ownership of revision publication and durable pending attempts.

use super::*;
use crate::net::{
    OutboundApplicationState, OutboundReplaceOutcome, OutboundReplacement, OutboundRevision,
    OutboundSnapshot,
};
use crate::runtime::options::OutboundNetworkConfig;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OutboundControl {
    pub revision: OutboundRevision,
    pub pending: Option<PendingOutbound>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingOutbound {
    pub expected: OutboundRevision,
    pub candidate: OutboundSnapshot,
}

impl BoxImpl {
    pub(super) fn persisted_outbound(&self) -> BoxliteResult<OutboundSnapshot> {
        let control = self.runtime.box_manager.outbound_control(&self.config.id)?;
        Ok(OutboundSnapshot {
            policy: self
                .state
                .read()
                .outbound_policy
                .clone()
                .unwrap_or_else(|| (&self.config.options.network).into()),
            revision: control.map_or_else(OutboundRevision::initial, |value| value.revision),
        })
    }

    pub(super) async fn replace_outbound_control(
        &self,
        candidate: OutboundSnapshot,
        expected: Option<OutboundRevision>,
    ) -> BoxliteResult<OutboundReplaceOutcome> {
        candidate.policy.validate()?;
        self.with_operation(async {
            if self.shutdown_token.is_cancelled() || self.state.read().status != BoxStatus::Running {
                return Err(BoxliteError::InvalidState("outbound policy updates require a running box".into()));
            }
            let live = self.ensure_booted_locked().await?;
            let backend = live.network.as_deref().ok_or_else(|| BoxliteError::Unsupported("box networking is disabled".into()))?;
            let manager = &self.runtime.box_manager;
            let mut control = manager.outbound_control(&self.config.id)?;
            let mut previous = self.persisted_outbound()?;
            let observed = match backend.outbound_snapshot().await {
                Ok(value) => value,
                Err(BoxliteError::Unsupported(_)) if expected.is_none() && control.is_none() => {
                    return self.replace_legacy_outbound(backend, &candidate.policy).await;
                }
                Err(error) => return Err(error),
            };
            // A matching completed attempt can recover a lost ACK or a crash
            // before final persistence. Reading its old expected ID cannot.
            if let Some(pending) = control.as_ref().and_then(|value| value.pending.as_ref())
                && observed.application_state == OutboundApplicationState::Confirmed && observed.snapshot == pending.candidate {
                self.confirm_outbound(&pending.candidate)?;
                previous = pending.candidate.clone();
                control = Some(OutboundControl { revision: previous.revision.clone(), pending: None });
            }
            if let Some(expected) = &expected {
                if expected != &previous.revision {
                    return Ok(OutboundReplaceOutcome::PreconditionFailed);
                }
                if control.as_ref().is_some_and(|value| value.pending.is_some())
                    || observed.application_state != OutboundApplicationState::Confirmed
                    || observed.snapshot != previous
                {
                    return Err(BoxliteError::InvalidState("outbound application is uncertain; conditional replacement requires confirmed matching live and persisted state".into()));
                }
            }
            let replacement = OutboundReplacement::new(observed.snapshot.revision, candidate.clone())?;
            let pending = OutboundControl {
                revision: previous.revision.clone(),
                pending: Some(PendingOutbound { expected: replacement.expected().clone(), candidate: candidate.clone() }),
            };
            // Persist before external work: cancellation and process death must
            // leave evidence that the old revision may still change later.
            manager.save_outbound_control(&self.config.id, Some(&pending), None)?;
            match backend.replace_outbound_snapshot(&replacement).await {
                Ok(OutboundReplaceOutcome::PreconditionFailed) => {
                    manager.save_outbound_control(&self.config.id, control.as_ref(), None)?;
                    return Ok(OutboundReplaceOutcome::PreconditionFailed);
                }
                Err(error @ BoxliteError::Unsupported(_)) => {
                    manager.save_outbound_control(&self.config.id, control.as_ref(), None)?;
                    return Err(error);
                }
                Err(error) => {
                    if let Err(readback) = read_confirmed_candidate(backend, &candidate).await {
                        return Err(BoxliteError::Network(format!("outbound application is uncertain ({error}); readback did not confirm completion ({readback})")));
                    }
                }
                Ok(OutboundReplaceOutcome::Applied) => {}
            }
            if let Err(error) = self.confirm_outbound(&candidate) {
                return self.restore_outbound(backend, previous, &candidate, error).await;
            }
            Ok(OutboundReplaceOutcome::Applied)
        }).await
    }

    fn confirm_outbound(&self, snapshot: &OutboundSnapshot) -> BoxliteResult<()> {
        let control = OutboundControl {
            revision: snapshot.revision.clone(),
            pending: None,
        };
        self.runtime.box_manager.save_outbound_control(
            &self.config.id,
            Some(&control),
            Some(&snapshot.policy),
        )?;
        self.state.write().outbound_policy = Some(snapshot.policy.clone());
        Ok(())
    }

    async fn restore_outbound(
        &self,
        backend: &dyn NetworkBackend,
        mut previous: OutboundSnapshot,
        candidate: &OutboundSnapshot,
        persistence_error: BoxliteError,
    ) -> BoxliteResult<OutboundReplaceOutcome> {
        // Compensation is permitted only after confirmed application. Its
        // fresh identity prevents an old precondition becoming valid again.
        previous.revision = OutboundRevision::fresh();
        let restoration = OutboundReplacement::new(candidate.revision.clone(), previous.clone())?;
        let result = backend.replace_outbound_snapshot(&restoration).await;
        let restored = matches!(result, Ok(OutboundReplaceOutcome::Applied))
            || result.is_err() && read_confirmed_candidate(backend, &previous).await.is_ok();
        if !restored {
            return Err(BoxliteError::InvalidState(format!(
                "outbound persistence failed ({persistence_error}); conditional restoration could not be confirmed ({result:?}); application is uncertain"
            )));
        }
        if let Err(error) = self.confirm_outbound(&previous) {
            return Err(BoxliteError::InvalidState(format!(
                "outbound persistence failed ({persistence_error}); restoration persistence failed ({error}); application is uncertain"
            )));
        }
        Err(persistence_error)
    }

    async fn replace_legacy_outbound(
        &self,
        backend: &dyn NetworkBackend,
        policy: &OutboundNetworkConfig,
    ) -> BoxliteResult<OutboundReplaceOutcome> {
        let previous = backend.outbound().await?;
        backend.set_outbound(policy).await?;
        if let Err(error) = self
            .runtime
            .box_manager
            .save_outbound(&self.config.id, policy)
        {
            if let Err(rollback) = backend.set_outbound(&previous).await {
                return Err(BoxliteError::InvalidState(format!(
                    "outbound policy persistence failed ({error}); rollback failed ({rollback}); live policy is uncertain, retry the complete update"
                )));
            }
            return Err(error);
        }
        self.state.write().outbound_policy = Some(policy.clone());
        Ok(OutboundReplaceOutcome::Applied)
    }
}

async fn read_confirmed_candidate(
    backend: &dyn NetworkBackend,
    candidate: &OutboundSnapshot,
) -> BoxliteResult<()> {
    let observed = backend.outbound_snapshot().await?;
    if observed.application_state == OutboundApplicationState::Confirmed
        && observed.snapshot == *candidate
    {
        return Ok(());
    }
    Err(BoxliteError::InvalidState(format!(
        "observed outbound revision {} in phase {:?} does not confirm candidate {}",
        observed.snapshot.revision, observed.application_state, candidate.revision
    )))
}
