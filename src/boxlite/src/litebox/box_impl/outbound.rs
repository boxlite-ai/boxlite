//! Runtime ownership of revision publication and durable pending attempts.

use super::*;
use crate::net::{
    CompleteOutboundObservation, CompleteOutboundPolicy, CompleteOutboundSnapshot,
    CompleteOutboundStatus, OutboundAdmission, OutboundApplicationState, OutboundCapabilities,
    OutboundReplaceOutcome, OutboundReplacement, OutboundRevision, OutboundSnapshot,
    OutboundStatus,
};
use crate::runtime::options::OutboundNetworkConfig;

// Bound observation independently of an updater and of custom backend behavior.
const STATUS_READBACK_TIMEOUT: Duration = Duration::from_secs(10);

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

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompleteOutboundControl {
    pub committed: CompleteOutboundSnapshot,
    pub pending: Option<CompleteOutboundAttempt>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompleteOutboundAttempt {
    pub expected: OutboundRevision,
    pub candidate: CompleteOutboundSnapshot,
    pub possible: OutboundCapabilities,
    pub restoration: Option<CompleteOutboundSnapshot>,
}

impl CompleteOutboundControl {
    pub(crate) fn validate(&self) -> BoxliteResult<()> {
        self.committed.validate_installed()?;
        if let Some(attempt) = &self.pending {
            attempt.candidate.validate_installed()?;
            if attempt.candidate.revision == attempt.expected
                || attempt.candidate.revision == OutboundRevision::initial()
            {
                return Err(BoxliteError::InvalidArgument(
                    "invalid pending outbound revision".into(),
                ));
            }
            if let Some(restoration) = &attempt.restoration
                && (restoration.revision == OutboundRevision::initial()
                    || restoration.revision == attempt.candidate.revision
                    || restoration.revision == self.committed.revision
                    || restoration.policy != self.committed.policy
                    || restoration.admission != self.committed.admission)
            {
                return Err(BoxliteError::InvalidArgument(
                    "invalid outbound restoration identity".into(),
                ));
            }
        }
        Ok(())
    }

    pub(super) fn from_legacy(
        committed: OutboundSnapshot,
        legacy: Option<&OutboundControl>,
    ) -> Self {
        Self {
            committed: committed.into(),
            pending: legacy
                .and_then(|control| control.pending.as_ref())
                .map(|attempt| CompleteOutboundAttempt {
                    expected: attempt.expected.clone(),
                    candidate: attempt.candidate.clone().into(),
                    possible: OutboundCapabilities::default(),
                    restoration: None,
                }),
        }
    }

    pub(crate) fn requirements(&self) -> OutboundCapabilities {
        let mut required = self.committed.requirements();
        if let Some(pending) = &self.pending {
            required = required
                .union(pending.possible)
                .union(pending.candidate.requirements());
            if let Some(restoration) = &pending.restoration {
                required = required.union(restoration.requirements());
            }
        }
        required
    }

    pub(crate) fn legacy(&self) -> Option<(OutboundNetworkConfig, OutboundControl)> {
        if self.requirements() != OutboundCapabilities::default() {
            return None;
        }
        let pending = match &self.pending {
            None => None,
            Some(pending) if pending.restoration.is_none() => Some(PendingOutbound {
                expected: pending.expected.clone(),
                candidate: pending.candidate.legacy().ok()?,
            }),
            Some(_) => return None,
        };
        let snapshot = self.committed.legacy().ok()?;
        Some((
            snapshot.policy,
            OutboundControl {
                revision: snapshot.revision,
                pending,
            },
        ))
    }
}

impl CompleteOutboundAttempt {
    fn confirmation(&self) -> &CompleteOutboundSnapshot {
        self.restoration.as_ref().unwrap_or(&self.candidate)
    }
}

impl BoxImpl {
    pub(super) fn read_complete_control(
        &self,
    ) -> BoxliteResult<(BoxState, CompleteOutboundControl)> {
        let (state, legacy, complete) = self.runtime.box_manager.outbound_state(&self.config.id)?;
        let control = complete.unwrap_or_else(|| {
            CompleteOutboundControl::from_legacy(
                self.snapshot_from_state(&state, legacy.as_ref()),
                legacy.as_ref(),
            )
        });
        Ok((state, control))
    }

    pub(super) async fn read_complete_outbound_status(
        &self,
    ) -> BoxliteResult<CompleteOutboundStatus> {
        let (state, control) = self.read_complete_control()?;
        let mut status = CompleteOutboundStatus {
            persisted: control.committed,
            observed: None,
            pending_revision: control
                .pending
                .as_ref()
                .map(|attempt| attempt.confirmation().revision.clone()),
            observation_error: None,
            application_state: OutboundApplicationState::Uncertain,
        };
        if state.status != BoxStatus::Running {
            status.observation_error = Some("box is not running".into());
            return Ok(status);
        }
        let backend = match self.observation_backend(
            &state,
            &status.persisted.policy.mode,
            &status.persisted.policy.allow_net,
        ) {
            Ok(backend) => backend,
            Err(BoxliteError::InvalidState(error)) => {
                status.observation_error = Some(error);
                return Ok(status);
            }
            Err(error) => return Err(error),
        };
        match tokio::time::timeout(
            STATUS_READBACK_TIMEOUT,
            backend.complete_outbound_snapshot(),
        )
        .await
        {
            Ok(Ok((observation, _))) => {
                status.application_state = match observation.application_state {
                    OutboundApplicationState::Pending => OutboundApplicationState::Pending,
                    OutboundApplicationState::Confirmed
                        if status.pending_revision.is_none()
                            && observation.snapshot == status.persisted =>
                    {
                        OutboundApplicationState::Confirmed
                    }
                    _ => OutboundApplicationState::Uncertain,
                };
                status.observed = Some(observation);
            }
            Ok(Err(error @ BoxliteError::Unsupported(_))) => return Err(error),
            Ok(Err(error)) => status.observation_error = Some(error.to_string()),
            Err(_) => {
                status.observation_error =
                    Some("outbound status readback timed out after 10s".into())
            }
        }
        Ok(status)
    }

    pub(super) fn observation_backend(
        &self,
        state: &BoxState,
        mode: &crate::runtime::options::NetworkMode,
        allow_net: &[String],
    ) -> BoxliteResult<Arc<dyn NetworkBackend>> {
        let backend = if let Some(live) = self.live.get() {
            let cached = self.state.read();
            if cached.status != BoxStatus::Running
                || cached.pid != state.pid
                || cached.started_at != state.started_at
            {
                return Err(BoxliteError::InvalidState(
                    "Box handle belongs to an earlier VM; use runtime.get()".into(),
                ));
            }
            live.network.clone()
        } else if matches!(
            self.config.options.network,
            crate::runtime::options::NetworkSpec::Disabled
        ) {
            None
        } else {
            let config = crate::net::NetworkBackendConfig {
                outbound_disabled: *mode == crate::runtime::options::NetworkMode::Disabled,
                allow_net: allow_net.to_vec(),
                socket_path: self.layout.net_backend_socket_path(),
                secrets: self.config.options.secrets.clone(),
                ca_dir: self.layout.ca_dir(),
                rate_limit: self.config.options.advanced.network_rate_limit,
            };
            self.runtime.network_factory.create(&config).map(Arc::from)
        };
        backend.ok_or_else(|| BoxliteError::Unsupported("box networking is disabled".into()))
    }

    pub(super) async fn replace_complete_outbound_control(
        &self,
        policy: CompleteOutboundPolicy,
        revision: OutboundRevision,
        expected: Option<OutboundRevision>,
    ) -> BoxliteResult<OutboundReplaceOutcome> {
        policy.validate()?;
        if revision == OutboundRevision::initial() || expected.as_ref() == Some(&revision) {
            return Err(BoxliteError::InvalidArgument(
                "candidate outbound revision must be fresh".into(),
            ));
        }

        // A complete replacement can change whether a source may be copied.
        self.with_disk_admission(self.with_operation(async {
            if self.shutdown_token.is_cancelled() || self.state.read().status != BoxStatus::Running {
                return Err(BoxliteError::InvalidState("outbound policy updates require a running box".into()));
            }
            let store = &self.runtime.box_manager;
            let (state, legacy, complete) = store.outbound_state(&self.config.id)?;
            if self.has_hosted_outbound_owner(complete.is_some())? {
                return Err(complete_only());
            }
            let mut control = complete.clone().unwrap_or_else(|| CompleteOutboundControl::from_legacy(
                self.snapshot_from_state(&state, legacy.as_ref()), legacy.as_ref(),
            ));
            let live = self.ensure_booted_locked().await?;
            let backend = live.network.as_deref().ok_or_else(|| BoxliteError::Unsupported("box networking is disabled".into()))?;
            let (observed, capabilities) = backend.complete_outbound_snapshot().await?;

            let mut reconciled = false;
            if let Some(attempt) = &control.pending
                && confirms(&observed, attempt.confirmation())
            {
                let committed = attempt.confirmation().clone();
                self.confirm_complete_outbound(&committed)?;
                control = CompleteOutboundControl { committed, pending: None };
                reconciled = true;
            }
            if let Some(expected) = &expected {
                if expected != &control.committed.revision {
                    return Ok(OutboundReplaceOutcome::PreconditionFailed);
                }
                if control.pending.is_some() || !confirms(&observed, &control.committed) {
                    return Err(BoxliteError::InvalidState("conditional replace requires confirmed matching outbound state".into()));
                }
            }
            if observed.snapshot.revision == revision {
                return Err(BoxliteError::InvalidArgument("candidate outbound revision must be fresh".into()));
            }

            let possible = control.requirements().union(observed.snapshot.requirements());
            if possible.deny && policy.deny_net.is_none() {
                return Err(BoxliteError::InvalidArgument("deny_net is required while outbound denies may be active".into()));
            }
            let candidate = if control.committed.ipv6.is_some() {
                control.committed.prepare_replacement(&policy, revision)?
            } else {
                let admission = if possible.admission { OutboundAdmission::ExtendedIpv4 } else { OutboundAdmission::Legacy };
                policy.prepare(admission, revision)?
            };
            let deny_supplied = policy.deny_net.is_some();
            let mut required = possible.union(candidate.requirements());
            required.deny |= deny_supplied;
            capabilities.require(required)?;
            let versioned = required != OutboundCapabilities::default();
            prepare_ipv6_enable(backend, &live.guest_session, &observed.snapshot, &candidate).await?;
            let mut restoration = control.committed.clone();
            restoration.revision = OutboundRevision::fresh();
            candidate.encode_replacement(deny_supplied, false, versioned)?;
            restoration.encode_replacement(false, true, versioned)?;

            let expected_live = observed.snapshot.revision;
            let mut reserved = CompleteOutboundControl {
                committed: control.committed.clone(),
                pending: Some(CompleteOutboundAttempt {
                    expected: expected_live.clone(), candidate: candidate.clone(), possible, restoration: None,
                }),
            };
            store.save_complete_outbound(&self.config.id, &reserved)?;
            let result = apply_complete(backend, &expected_live, &candidate, deny_supplied, false, versioned).await;
            if matches!(result, Ok(OutboundReplaceOutcome::PreconditionFailed) | Err(BoxliteError::Unsupported(_))) {
                if complete.is_some() || reconciled {
                    store.save_complete_outbound(&self.config.id, &control)?;
                } else {
                    store.restore_legacy_outbound(&self.config.id, &state, legacy.as_ref())?;
                }
                return result;
            }
            if let Err(error) = result
                && !backend_confirms(backend, &candidate).await
            {
                return Err(BoxliteError::Network(format!("outbound application is uncertain: {error}")));
            }
            #[cfg(test)]
            if let Some(entered) = &self.outbound_before_persist {
                entered.notify_one();
                std::future::pending::<()>().await;
            }
            if let Err(error) = self.confirm_complete_outbound(&candidate) {
                if let Some(pending) = &mut reserved.pending {
                    pending.restoration = Some(restoration.clone());
                }
                store.save_complete_outbound(&self.config.id, &reserved).map_err(|restore_error| {
                    restoration_write_error("restoration intent write", &error, restore_error)
                })?;
                let restored = match prepare_ipv6_enable(backend, &live.guest_session, &candidate, &restoration).await {
                    Ok(()) => apply_complete(backend, &candidate.revision, &restoration, false, true, versioned).await,
                    Err(error) => Err(error),
                };
                if !matches!(restored, Ok(OutboundReplaceOutcome::Applied))
                    && !backend_confirms(backend, &restoration).await
                {
                    return Err(BoxliteError::InvalidState(format!("outbound persistence failed ({error}); restoration is uncertain ({restored:?})")));
                }
                self.confirm_complete_outbound(&restoration).map_err(|restore_error| {
                    restoration_write_error("restored snapshot commit", &error, restore_error)
                })?;
                return Err(error);
            }
            Ok(OutboundReplaceOutcome::Applied)
        })).await
    }

    fn confirm_complete_outbound(&self, snapshot: &CompleteOutboundSnapshot) -> BoxliteResult<()> {
        let committed = CompleteOutboundControl {
            committed: snapshot.clone(),
            pending: None,
        };
        self.runtime
            .box_manager
            .save_complete_outbound(&self.config.id, &committed)?;
        self.state.write().outbound_policy = snapshot.legacy().ok().map(|snapshot| snapshot.policy);
        Ok(())
    }

    pub(super) fn persisted_outbound(&self) -> BoxliteResult<OutboundSnapshot> {
        let (state, control, complete) =
            self.runtime.box_manager.outbound_state(&self.config.id)?;
        if complete.is_some() {
            return Err(complete_only());
        }
        Ok(self.snapshot_from_state(&state, control.as_ref()))
    }

    pub(super) fn snapshot_from_state(
        &self,
        state: &BoxState,
        control: Option<&OutboundControl>,
    ) -> OutboundSnapshot {
        OutboundSnapshot {
            policy: state
                .outbound_policy
                .clone()
                .unwrap_or_else(|| (&self.config.options.network).into()),
            revision: control
                .map_or_else(OutboundRevision::initial, |value| value.revision.clone()),
        }
    }

    pub(super) async fn read_outbound_status(&self) -> BoxliteResult<OutboundStatus> {
        // GET must remain readable while an updater owns the operation lock.
        // Policy/control come from one SQLite row version; no reconciliation occurs here.
        let (state, control, complete) =
            self.runtime.box_manager.outbound_state(&self.config.id)?;
        if complete.is_some() {
            return Err(complete_only());
        }
        let mut status = OutboundStatus {
            persisted: self.snapshot_from_state(&state, control.as_ref()),
            pending_revision: control
                .as_ref()
                .and_then(|value| value.pending.as_ref())
                .map(|pending| pending.candidate.revision.clone()),
            observed: None,
            application_state: OutboundApplicationState::Uncertain,
            observation_error: None,
        };
        if state.status != BoxStatus::Running {
            status.observation_error = Some("box is not running".into());
            return Ok(status);
        }
        let backend = match self.observation_backend(
            &state,
            &status.persisted.policy.mode,
            &status.persisted.policy.allow_net,
        ) {
            Ok(backend) => backend,
            Err(BoxliteError::InvalidState(error)) => {
                status.observation_error = Some(error);
                return Ok(status);
            }
            Err(error) => return Err(error),
        };
        let observation =
            tokio::time::timeout(STATUS_READBACK_TIMEOUT, backend.outbound_snapshot())
                .await
                .unwrap_or_else(|_| {
                    Err(BoxliteError::Network(
                        "outbound status readback timed out after 10s".into(),
                    ))
                });
        match observation {
            Err(error @ BoxliteError::Unsupported(_)) => return Err(error),
            Err(error) => status.observation_error = Some(error.to_string()),
            Ok(observed) => {
                status.application_state = match observed.application_state {
                    OutboundApplicationState::Pending => OutboundApplicationState::Pending,
                    OutboundApplicationState::Confirmed
                        if status.pending_revision.is_none()
                            && observed.snapshot == status.persisted =>
                    {
                        OutboundApplicationState::Confirmed
                    }
                    _ => OutboundApplicationState::Uncertain,
                };
                status.observed = Some(observed);
            }
        }
        Ok(status)
    }

    pub(super) async fn replace_outbound_control(
        &self,
        candidate: OutboundSnapshot,
        expected: Option<OutboundRevision>,
    ) -> BoxliteResult<OutboundReplaceOutcome> {
        crate::net::require_legacy_outbound_write(&candidate.policy)?;
        self.with_operation(async {
            if self.shutdown_token.is_cancelled() || self.state.read().status != BoxStatus::Running {
                return Err(BoxliteError::InvalidState("outbound policy updates require a running box".into()));
            }
            let manager = &self.runtime.box_manager;
            let (state, mut control, complete) = manager.outbound_state(&self.config.id)?;
            if complete.is_some() || self.has_hosted_outbound_owner(false)? {
                return Err(complete_only());
            }
            let mut previous = self.snapshot_from_state(&state, control.as_ref());
            let live = self.ensure_booted_locked().await?;
            let backend = live.network.as_deref().ok_or_else(|| BoxliteError::Unsupported("box networking is disabled".into()))?;
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
            // Test-only cancellation point after the ACK, before durable commit.
            #[cfg(test)]
            if let Some(entered) = &self.outbound_before_persist {
                entered.notify_one();
                std::future::pending::<()>().await;
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

fn restoration_write_error(
    step: &str,
    publication_error: &BoxliteError,
    restore_error: BoxliteError,
) -> BoxliteError {
    match restore_error {
        BoxliteError::Database(details) => BoxliteError::Database(format!(
            "outbound persistence failed ({publication_error}); {step} failed ({details}); application is uncertain"
        )),
        other => other,
    }
}

pub(super) fn confirms(
    observation: &CompleteOutboundObservation,
    candidate: &CompleteOutboundSnapshot,
) -> bool {
    observation.application_state == OutboundApplicationState::Confirmed
        && observation.snapshot == *candidate
}

pub(super) async fn backend_confirms(
    backend: &dyn NetworkBackend,
    candidate: &CompleteOutboundSnapshot,
) -> bool {
    backend
        .complete_outbound_snapshot()
        .await
        .is_ok_and(|(observed, _)| confirms(&observed, candidate))
}

pub(super) async fn prepare_ipv6_enable(
    backend: &dyn NetworkBackend,
    guest: &crate::portal::GuestSession,
    previous: &CompleteOutboundSnapshot,
    next: &CompleteOutboundSnapshot,
) -> BoxliteResult<()> {
    let Some(plan) = &next.ipv6 else {
        return Ok(());
    };
    if previous.policy.mode != crate::runtime::options::NetworkMode::Disabled
        || next.policy.mode != crate::runtime::options::NetworkMode::Enabled
    {
        return Ok(());
    }
    let readiness = backend.ipv6_readiness().await?;
    if readiness.plan != *plan || readiness.revision != previous.revision {
        return Err(BoxliteError::Network(
            "Guest IPv6 challenge differs from disabled snapshot".into(),
        ));
    }
    guest
        .guest()
        .await?
        .confirm_ipv6(readiness.guest_check())
        .await?;
    backend.confirm_ipv6_readiness(&readiness).await
}

pub(super) async fn apply_complete(
    backend: &dyn NetworkBackend,
    expected: &OutboundRevision,
    candidate: &CompleteOutboundSnapshot,
    deny_supplied: bool,
    restore: bool,
    versioned: bool,
) -> BoxliteResult<OutboundReplaceOutcome> {
    if versioned {
        backend
            .replace_complete_outbound_snapshot(expected, candidate, deny_supplied, restore)
            .await
    } else {
        let replacement = OutboundReplacement::new(expected.clone(), candidate.legacy()?)?;
        backend.replace_outbound_snapshot(&replacement).await
    }
}

fn complete_only() -> BoxliteError {
    BoxliteError::Unsupported("outbound policy requires the complete policy interface".into())
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
