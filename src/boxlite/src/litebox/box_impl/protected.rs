//! Protected bootstrap admission under the Box lifecycle lock.

use super::{BoxImpl, BoxStatus};
use crate::litebox::protected_boot::{
    BootRecoveryGate, ProtectedBootAttempt, ProtectedBootKey, ProtectedBootOutcome,
    ProtectedBootReceipt, ProtectedBootRequest, ProtectedEpochRequest, ProtectedGateReceipt,
    ProtectedGateRequest, ProtectedSealedEvidence, ProtectedStoppedEpoch,
    ProtectedTerminationReceipt,
};
use crate::litebox::protected_outbound::ProtectedRouteSnapshot;
use crate::net::gvproxy::{GvproxyBackend, RecoveryGateAction};
use crate::net::{NetworkBackendConfig, OutboundApplicationState, OutboundRevision};
use crate::runtime::options::NetworkSpec;
use crate::util::{PidFileReader, PidRecord, process_start_time};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

impl BoxImpl {
    pub(crate) async fn has_protected_boot(&self) -> BoxliteResult<bool> {
        self.with_operation(async {
            Ok(self
                .runtime
                .box_manager
                .protected_boot(self.id())?
                .is_some())
        })
        .await
    }

    pub(crate) async fn bootstrap_protected(
        &self,
        request: ProtectedBootRequest,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        request.key.validate()?;
        if let Some(allocation) = self.config.options.advanced.runner_allocation() {
            let is_allocation_attempt = allocation == &request.key.attempt_id;
            if request.restart == is_allocation_attempt {
                return Err(conflict("Protected boot does not match the allocation"));
            }
        }
        self.with_operation(async {
            let manager = &self.runtime.box_manager;
            let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
            let key = request.key.clone();
            if record
                .retired
                .iter()
                .any(|receipt| receipt.key.attempt_id == key.attempt_id)
            {
                return Err(conflict("Protected bootstrap attempt is retired"));
            }
            if let Some(active) = record.active.as_ref() {
                if active.key != key
                    || active.recovery_gate.as_ref().map(|gate| &gate.generation)
                        != request.recovery_generation.as_ref()
                {
                    return Err(conflict(
                        "A different protected bootstrap attempt is admitted",
                    ));
                }
                return self.confirm_protected_boot(&key).await;
            }
            {
                let state = self.state.read();
                let restart = request.restart
                    && request.recovery_generation.is_some()
                    && state.status == BoxStatus::Stopped
                    && !self.config.options.removes_on_stop()
                    && (record.retired.iter().any(|retired| retired.epoch.is_some())
                        || (self.config.options.advanced.runner_allocation().is_none()
                            && key.registration_id.is_none()
                            && record.retired.is_empty()));
                if !(restart || self.can_admit_protected_boot(state.status, !record.retired.is_empty()))
                    || record.outbound.pending.is_some()
                    || record.outbound.unbind_settlement.is_some()
                    || state.pid.is_some()
                    || has_shim(&self.layout.pid_file_path())
                {
                    return Err(conflict(
                        "Protected bootstrap requires a fresh Guest network and disabled automatic removal",
                    ));
                }
            }
            let attempt = ProtectedBootAttempt {
                key: key.clone(),
                epoch: OutboundRevision::fresh(),
                spawning: false,
                owner: None,
                confirmed: false,
                recovery_gate: request.recovery_generation.clone().map(|generation| BootRecoveryGate {
                    generation,
                    seal_requested: false,
                    seal_confirmed: false,
                    released: false,
                    evidence: None,
                }),
            };
            let launch = request.into_launch(&attempt)?;
            record.outbound = Default::default();
            record.removable_attempt = None;
            record.active = Some(attempt);
            manager.save_protected_boot(self.id(), &record)?;
            self.start_with_network(Some(launch)).await?;
            self.confirm_protected_boot(&key).await
        })
        .await
    }

    pub(crate) fn runner_allocation(&self) -> Option<crate::net::OutboundRevision> {
        self.config.options.advanced.runner_allocation().cloned()
    }

    pub(crate) fn runner_migration(&self) -> Option<crate::net::OutboundRevision> {
        self.state.read().runner_migration.clone()
    }

    pub(crate) async fn change_protected_gate(
        &self,
        request: ProtectedGateRequest,
        action: RecoveryGateAction,
    ) -> BoxliteResult<ProtectedGateReceipt> {
        self.with_operation(async {
            let manager = &self.runtime.box_manager;
            let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
            if matches!(action, RecoveryGateAction::Seal) {
                return self.seal_protected_gate(&mut record, request).await;
            }
            let initial = record
                .active
                .as_ref()
                .ok_or_else(|| conflict("Missing protected epoch"))?;
            let outbound = self.protected_outbound_durable(&record, initial)?;
            if request
                .outbound
                .as_ref()
                .is_some_and(|claimed| claimed != &outbound)
                || (request.outbound.is_none()
                    && (outbound.snapshot != initial.key.policy
                        || outbound.binding != initial.binding()))
            {
                return Err(conflict("Protected recovery route differs"));
            }
            let attempt = record
                .active
                .as_mut()
                .filter(|attempt| {
                    attempt.confirmed
                        && attempt.key == request.key
                        && attempt.epoch == request.epoch
                })
                .ok_or_else(|| conflict("Protected recovery attempt differs"))?;
            let id = attempt
                .gate_id()
                .filter(|id| id.generation == request.generation)
                .ok_or_else(|| conflict("Protected recovery gate generation differs"))?;
            let gate = attempt
                .recovery_gate
                .as_mut()
                .ok_or_else(|| conflict("Protected recovery gate is missing"))?;
            if gate.seal_requested || record.outbound.pending.is_some() {
                return Err(conflict("Protected recovery gate is retired"));
            }
            let boot = attempt.receipt(ProtectedBootOutcome::Confirmed);
            let backend = self.protected_bridge();
            Self::verify_protected_bridge(
                &backend,
                attempt,
                self.verify_protected_owner(attempt)?,
                &outbound,
            )
            .await?;
            backend
                .change_recovery_gate(
                    &id,
                    &outbound.snapshot.revision,
                    outbound.binding.as_ref(),
                    action,
                )
                .await?;
            let attempt = record
                .active
                .as_mut()
                .ok_or_else(|| conflict("Protected recovery attempt is missing"))?;
            let observed = Self::verify_protected_bridge(
                &backend,
                attempt,
                self.verify_protected_owner(attempt)?,
                &outbound,
            )
            .await?;
            let gate = observed
                .recovery_gate
                .filter(|gate| !gate.closed && !gate.sealed)
                .ok_or_else(|| conflict("Protected recovery gate change is unconfirmed"))?;
            let stored = attempt
                .recovery_gate
                .as_mut()
                .ok_or_else(|| conflict("Protected recovery gate is missing"))?;
            stored.released = true;
            manager.save_protected_boot(self.id(), &record)?;
            Ok(ProtectedGateReceipt {
                boot,
                generation: gate.generation,
                closed: gate.closed,
                sealed: gate.sealed,
                outbound,
                evidence: None,
            })
        })
        .await
    }

    async fn seal_protected_gate(
        &self,
        record: &mut crate::litebox::protected_boot::ProtectedBootState,
        request: ProtectedGateRequest,
    ) -> BoxliteResult<ProtectedGateReceipt> {
        let attempt = record
            .active
            .as_ref()
            .filter(|attempt| {
                attempt.key == request.key
                    && attempt.epoch == request.epoch
                    && attempt
                        .recovery_gate
                        .as_ref()
                        .is_some_and(|gate| gate.generation == request.generation)
            })
            .ok_or_else(|| conflict("Protected recovery attempt differs"))?;
        let boot = attempt.receipt(ProtectedBootOutcome::Confirmed);
        if let Some(evidence) = attempt
            .recovery_gate
            .as_ref()
            .and_then(|gate| gate.evidence.clone())
        {
            return Ok(ProtectedGateReceipt {
                boot,
                generation: request.generation,
                closed: true,
                sealed: true,
                outbound: evidence.durable.clone(),
                evidence: Some(evidence),
            });
        }
        let durable = self.protected_outbound_durable(record, attempt)?;
        let owner = self.verify_protected_owner(attempt)?;
        let id = attempt
            .gate_id()
            .ok_or_else(|| conflict("Protected recovery gate is missing"))?;
        let manager = &self.runtime.box_manager;
        let backend = self.protected_bridge();
        let observed = backend.managed_proxy_status().await?;
        if !observed
            .recovery_gate
            .as_ref()
            .is_some_and(|gate| gate.epoch == id.epoch && gate.generation == id.generation)
            || observed
                .binding
                .as_ref()
                .is_some_and(|binding| binding.epoch != id.epoch)
            || !owns_shim(owner)
        {
            return Err(conflict("Installed protected epoch is unconfirmed"));
        }
        let stored = record
            .active
            .as_mut()
            .and_then(|attempt| attempt.recovery_gate.as_mut())
            .ok_or_else(|| conflict("Protected recovery gate is missing"))?;
        stored.seal_requested = true;
        manager.save_protected_boot(self.id(), record)?;
        backend
            .change_recovery_gate(
                &id,
                &observed.status.snapshot.revision,
                observed.binding.as_ref(),
                RecoveryGateAction::Seal,
            )
            .await?;
        let sealed = backend.managed_proxy_status().await?;
        if !sealed.recovery_gate.as_ref().is_some_and(|gate| {
            gate.epoch == id.epoch && gate.generation == id.generation && gate.closed && gate.sealed
        }) || sealed.status.snapshot != observed.status.snapshot
            || sealed.binding != observed.binding
            || !owns_shim(owner)
        {
            return Err(conflict("Protected epoch sealing is unconfirmed"));
        }
        let evidence = ProtectedSealedEvidence {
            durable: durable.clone(),
            installed: (sealed.status.application_state == OutboundApplicationState::Confirmed)
                .then_some(ProtectedRouteSnapshot {
                    snapshot: sealed.status.snapshot,
                    binding: sealed.binding,
                }),
            pending: record
                .outbound
                .pending
                .as_ref()
                .map(|pending| pending.update.clone()),
            rollback: record.outbound.rollback.clone(),
            unbind_settlement: record.outbound.unbind_settlement.clone(),
            ordinary_pending: manager
                .outbound_control(self.id())?
                .is_some_and(|control| control.pending.is_some()),
        };
        let stored = record
            .active
            .as_mut()
            .and_then(|attempt| attempt.recovery_gate.as_mut())
            .ok_or_else(|| conflict("Protected recovery gate is missing"))?;
        stored.seal_confirmed = true;
        stored.released = false;
        stored.evidence = Some(evidence.clone());
        manager.save_protected_boot(self.id(), record)?;
        Ok(ProtectedGateReceipt {
            boot,
            generation: request.generation,
            closed: true,
            sealed: true,
            outbound: durable,
            evidence: Some(evidence),
        })
    }

    pub(crate) async fn protected_boot_receipt(
        &self,
        key: &ProtectedBootKey,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        self.inspect_protected_boot(key, false).await
    }

    pub(crate) async fn protected_boot_ready(
        &self,
        key: &ProtectedBootKey,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        self.inspect_protected_boot(key, true).await
    }

    async fn inspect_protected_boot(
        &self,
        key: &ProtectedBootKey,
        require_released: bool,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        self.with_operation(async {
            let record = self
                .runtime
                .box_manager
                .protected_boot(self.id())?
                .unwrap_or_default();
            if !require_released
                && let Some(receipt) = record.retired.iter().find(|receipt| &receipt.key == key)
            {
                return Ok(receipt.clone());
            }
            let active = record
                .active
                .as_ref()
                .filter(|active| &active.key == key && active.confirmed)
                .ok_or_else(|| conflict("Protected startup is unconfirmed"))?;
            let expected = self.protected_outbound_durable(&record, active)?;
            let observed = self.verify_protected_boot(active, &expected).await?;
            if require_released
                && (!active.recovery_gate.as_ref().is_some_and(|gate| {
                    gate.released && !gate.seal_requested && !gate.seal_confirmed
                }) || !observed
                    .recovery_gate
                    .as_ref()
                    .is_some_and(|gate| !gate.closed && !gate.sealed))
            {
                return Err(conflict("Protected boot gate is not released"));
            }
            Ok(active.receipt(ProtectedBootOutcome::Confirmed))
        })
        .await
    }

    pub(crate) async fn stop_protected_epoch(
        &self,
        request: ProtectedEpochRequest,
    ) -> BoxliteResult<ProtectedStoppedEpoch> {
        request.key.validate()?;
        self.with_operation(async {
            let record = self.runtime.box_manager.protected_boot(self.id())?;
            let attempt = record
                .as_ref()
                .and_then(|record| record.active.as_ref())
                .filter(|attempt| {
                    attempt.confirmed
                        && attempt.key == request.key
                        && attempt.epoch == request.epoch
                        && attempt.recovery_gate.as_ref().is_some_and(|gate| {
                            gate.generation == request.generation && gate.seal_confirmed
                        })
                })
                .ok_or_else(|| conflict("Protected stop requires the exact sealed epoch"))?;
            if !self.protected_process_stopped(attempt) {
                self.verify_protected_owner(attempt)?;
                self.stop_inner().await?;
            }
            if !self.protected_process_stopped(attempt) {
                return Err(conflict("Protected stop is unconfirmed"));
            }
            Ok(ProtectedStoppedEpoch {
                boot: attempt.receipt(ProtectedBootOutcome::Confirmed),
                generation: request.generation,
            })
        })
        .await
    }

    fn protected_process_stopped(&self, attempt: &ProtectedBootAttempt) -> bool {
        let state = self.state.read();
        state.status == BoxStatus::Stopped
            && state.pid.is_none()
            && attempt
                .owner
                .is_some_and(|owner| owner.start_time.is_some())
            && !has_shim(&self.layout.pid_file_path())
            && termination_confirmed(self.id(), attempt)
    }

    pub(crate) async fn retire_terminated_protected_epoch(
        &self,
        request: ProtectedEpochRequest,
    ) -> BoxliteResult<ProtectedTerminationReceipt> {
        request.key.validate()?;
        self.with_operation(async {
            let manager = &self.runtime.box_manager;
            let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
            if let Some(receipt) = &record.terminated_epoch
                && receipt.boot.key == request.key
                && receipt.boot.epoch.as_ref() == Some(&request.epoch)
                && receipt.generation == request.generation
            {
                return Ok(receipt.clone());
            }
            let attempt = record
                .active
                .as_ref()
                .filter(|attempt| {
                    attempt.confirmed
                        && attempt.key == request.key
                        && attempt.epoch == request.epoch
                        && attempt
                            .recovery_gate
                            .as_ref()
                            .is_some_and(|gate| gate.generation == request.generation)
                })
                .ok_or_else(|| conflict("Protected retirement requires the exact epoch"))?;
            if !self.protected_process_stopped(attempt) {
                return Err(conflict("Protected retirement cannot prove termination"));
            }
            let durable = self.protected_outbound_durable(&record, attempt)?;
            let evidence = ProtectedSealedEvidence {
                durable,
                installed: None,
                pending: record
                    .outbound
                    .pending
                    .as_ref()
                    .map(|pending| pending.update.clone()),
                rollback: record.outbound.rollback.clone(),
                unbind_settlement: record.outbound.unbind_settlement.clone(),
                ordinary_pending: manager
                    .outbound_control(self.id())?
                    .is_some_and(|control| control.pending.is_some()),
            };
            let receipt = ProtectedTerminationReceipt {
                boot: attempt.receipt(ProtectedBootOutcome::Retired),
                generation: request.generation,
                evidence,
            };
            record.active = None;
            record.outbound = Default::default();
            record.removable_attempt = Some(receipt.boot.key.attempt_id.clone());
            record.retired.push(receipt.boot.clone());
            record.terminated_epoch = Some(receipt.clone());
            manager.save_protected_boot(self.id(), &record)?;
            Ok(receipt)
        })
        .await
    }

    pub(crate) async fn retire_protected_boot(
        &self,
        key: ProtectedBootKey,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        key.validate()?;
        self.with_operation(async {
            let manager = &self.runtime.box_manager;
            let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
            if let Some(receipt) = record
                .retired
                .iter()
                .find(|receipt| receipt.key.attempt_id == key.attempt_id)
            {
                return if receipt.key == key {
                    Ok(receipt.clone())
                } else {
                    Err(conflict("Retired attempt identity differs"))
                };
            }
            let state = self.state.read();
            let legacy_unbound_restart = key.registration_id.is_none() && state.status == BoxStatus::Stopped
                && !self.config.options.removes_on_stop();
            if record.active.is_none()
                && !self.can_admit_protected_boot(state.status, !record.retired.is_empty())
                && !legacy_unbound_restart
            {
                return Err(conflict(
                    "Protected bootstrap requires a fresh Guest network and disabled automatic removal",
                ));
            }
            if state.status.is_active()
                || state.pid.is_some()
                || has_shim(&self.layout.pid_file_path())
            {
                return Err(conflict("Protected bootstrap child may still be live"));
            }
            let epoch = match record.active.take() {
                Some(attempt) => {
                    if attempt.key != key
                        || (attempt.confirmed && attempt.recovery_gate.as_ref().is_some_and(|gate| !gate.seal_confirmed))
                        || !termination_confirmed(self.id(), &attempt)
                    {
                        return Err(conflict("Protected bootstrap retirement is unconfirmed"));
                    }
                    // Sealed evidence belongs to the terminated epoch. Keep the retirement receipt
                    // and persisted policy, and discard authorizations that cannot cross a restart.
                    record.outbound = Default::default();
                    Some(attempt.epoch)
                }
                None => None,
            };
            let receipt = ProtectedBootReceipt {
                key,
                epoch,
                outcome: ProtectedBootOutcome::Retired,
            };
            record.removable_attempt = Some(receipt.key.attempt_id.clone());
            record.retired.push(receipt.clone());
            manager.save_protected_boot(self.id(), &record)?;
            Ok(receipt)
        })
        .await
    }

    fn can_admit_protected_boot(&self, status: BoxStatus, has_retirement: bool) -> bool {
        matches!(self.config.options.network, NetworkSpec::Disabled)
            && !self.config.options.removes_on_stop()
            && status.can_start()
            && (has_retirement || status == BoxStatus::Configured)
    }

    async fn confirm_protected_boot(
        &self,
        key: &ProtectedBootKey,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        let manager = &self.runtime.box_manager;
        let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
        let active = record
            .active
            .as_ref()
            .ok_or_else(|| conflict("Missing protected epoch"))?;
        let expected = self.protected_outbound_durable(&record, active)?;
        let attempt = record
            .active
            .as_mut()
            .filter(|attempt| &attempt.key == key)
            .ok_or_else(|| conflict("Protected bootstrap attempt differs"))?;
        self.verify_protected_boot(attempt, &expected).await?;
        let receipt = attempt.receipt(ProtectedBootOutcome::Confirmed);
        if !attempt.confirmed {
            attempt.confirmed = true;
            if attempt.recovery_gate.is_some() {
                record.outbound.committed = Some(expected.clone());
                manager.save_protected_outbound(self.id(), &record, Some(&expected.snapshot))?;
                self.state.write().outbound_policy = Some(expected.snapshot.policy);
            } else {
                manager.save_protected_boot(self.id(), &record)?;
            }
        }
        Ok(receipt)
    }

    pub(super) async fn verify_protected_boot(
        &self,
        attempt: &ProtectedBootAttempt,
        expected: &ProtectedRouteSnapshot,
    ) -> BoxliteResult<crate::net::gvproxy::ManagedProxyStatus> {
        Self::verify_protected_bridge(
            &self.protected_bridge(),
            attempt,
            self.verify_protected_owner(attempt)?,
            expected,
        )
        .await
    }

    pub(super) fn verify_protected_owner(
        &self,
        attempt: &ProtectedBootAttempt,
    ) -> BoxliteResult<PidRecord> {
        let owner = attempt
            .owner
            .ok_or_else(|| conflict("Missing protected bootstrap process owner"))?;
        let state = self.runtime.box_manager.update_box(self.id())?;
        if state.status != BoxStatus::Running || state.pid != Some(owner.pid) || !owns_shim(owner) {
            return Err(conflict("Protected Guest readiness is unconfirmed"));
        }
        Ok(owner)
    }

    pub(super) fn protected_bridge(&self) -> GvproxyBackend {
        GvproxyBackend::from_config(&NetworkBackendConfig {
            outbound_disabled: true,
            socket_path: self.layout.net_backend_socket_path(),
            ca_dir: self.layout.ca_dir(),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            rate_limit: Default::default(),
        })
    }

    async fn verify_protected_bridge(
        backend: &GvproxyBackend,
        attempt: &ProtectedBootAttempt,
        owner: PidRecord,
        expected: &ProtectedRouteSnapshot,
    ) -> BoxliteResult<crate::net::gvproxy::ManagedProxyStatus> {
        let observed = backend.managed_proxy_status().await?;
        let gate_matches = match (attempt.gate_id(), &observed.recovery_gate) {
            (Some(id), Some(gate)) => {
                gate.epoch == id.epoch
                    && gate.generation == id.generation
                    && (attempt.confirmed || (gate.closed && !gate.sealed))
            }
            (None, None) => true,
            _ => false,
        };
        if observed.status.application_state != OutboundApplicationState::Confirmed
            || observed.status.snapshot != expected.snapshot
            || observed.binding != expected.binding
            || !observed
                .capabilities
                .iter()
                .any(|capability| capability == "managed-proxy-v1")
            || !gate_matches
            || !owns_shim(owner)
        {
            return Err(conflict(
                "Installed proxy snapshot does not confirm protected startup",
            ));
        }
        Ok(observed)
    }
}

fn has_shim(path: &std::path::Path) -> bool {
    !matches!(
        PidFileReader::at(path).process_identity(),
        crate::util::ProcessIdentity::Absent
    )
}

fn owns_shim(owner: PidRecord) -> bool {
    owner.start_time.is_some()
        && process_start_time(owner.pid) == owner.start_time
        && crate::util::is_process_alive(owner.pid)
}

fn termination_confirmed(box_id: &crate::BoxID, attempt: &ProtectedBootAttempt) -> bool {
    let Some(owner) = attempt.owner else {
        return !attempt.spawning;
    };
    if owner.pid <= 1 || owns_shim(owner) {
        return false;
    }
    crate::jailer::protected_processes_terminated(box_id, owner.pid)
}

fn conflict(message: &str) -> BoxliteError {
    BoxliteError::InvalidState(message.into())
}
