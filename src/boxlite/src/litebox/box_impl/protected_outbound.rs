//! Apply complete managed routes under the Box operation lock.

use super::BoxImpl;
use crate::litebox::protected_boot::{ProtectedBootAttempt, ProtectedBootState};
use crate::litebox::protected_outbound::{
    ProtectedRouteOperation, ProtectedRouteOutcome, ProtectedRoutePending, ProtectedRouteReceipt,
    ProtectedRouteRequest, ProtectedRouteRollback, ProtectedRouteSnapshot, ProtectedRouteUpdate,
};
use crate::net::gvproxy::{GvproxyBackend, ManagedProxyRoute};
use crate::net::{OutboundApplicationState, OutboundReplacement, OutboundRevision};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::time::{Duration, Instant};

const STAGE_VALIDITY: Duration = Duration::from_secs(10);

impl BoxImpl {
    pub(crate) async fn protected_outbound(
        &self,
        request: ProtectedRouteRequest,
    ) -> BoxliteResult<ProtectedRouteReceipt> {
        let expires = Instant::now() + STAGE_VALIDITY;
        self.with_operation(async {
            let manager = &self.runtime.box_manager;
            let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
            let attempt = record
                .active
                .as_ref()
                .filter(|attempt| {
                    attempt.confirmed
                        && attempt.key.runner_id == request.runner_id
                        && attempt.epoch == request.epoch
                        && attempt
                            .recovery_gate
                            .as_ref()
                            .is_some_and(|gate| gate.released && !gate.seal_requested)
                })
                .ok_or_else(|| conflict("Protected outbound assignment changed"))?;
            self.verify_protected_owner(attempt)?;
            let backend = self.protected_bridge();
            let current = self.protected_outbound_durable(&record, attempt)?;
            let mut retired_attempt = None;
            let inspect = matches!(&request.command, ProtectedRouteOperation::Inspect);
            match request.command {
                ProtectedRouteOperation::Inspect => {}
                ProtectedRouteOperation::Prepare { update } => {
                    self.prepare_protected_update(&backend, &mut record, current, update, None)
                        .await?;
                }
                ProtectedRouteOperation::PrepareRestore { update, failed } => {
                    self.prepare_protected_update(
                        &backend,
                        &mut record,
                        current,
                        update,
                        Some(failed),
                    )
                    .await?;
                }
                ProtectedRouteOperation::Apply {
                    attempt_id,
                    route,
                    predecessor_route,
                } => {
                    let route = route.map(|material| {
                        material.route(request.doh_url.clone(), request.doh_address)
                    });
                    let predecessor_route = predecessor_route
                        .map(|material| material.route(request.doh_url, request.doh_address));
                    self.apply_protected_update(
                        &backend,
                        &mut record,
                        attempt_id,
                        route,
                        predecessor_route,
                        expires,
                    )
                    .await?;
                }
                ProtectedRouteOperation::RetirePrepared {
                    attempt_id,
                    predecessor,
                } => {
                    let control = &mut record.outbound;
                    if control.outcome(&attempt_id) != Some(ProtectedRouteOutcome::Unapplied) {
                        let can_retire = control.pending.as_ref().is_none_or(|pending| {
                            pending.update.attempt_id == attempt_id
                                && !pending.dispatched
                                && pending.update.predecessor == predecessor
                        });
                        if control.outcome(&attempt_id).is_some()
                            || !can_retire
                            || current != predecessor
                            || self.protected_installed(&backend, attempt).await? != predecessor
                            || manager
                                .outbound_control(self.id())?
                                .is_some_and(|value| value.pending.is_some())
                        {
                            return Err(conflict(
                                "Protected outbound non-application is unconfirmed",
                            ));
                        }
                        control.retire(attempt_id.clone(), ProtectedRouteOutcome::Unapplied);
                        control.pending = None;
                        manager.save_protected_outbound(self.id(), &record, None)?;
                    }
                    retired_attempt = Some(attempt_id);
                }
                ProtectedRouteOperation::SettleUnbind {
                    attempt_id,
                    revision,
                } => {
                    let control = &record.outbound;
                    if control.pending.is_some()
                        || control.outcome(&attempt_id) != Some(ProtectedRouteOutcome::Applied)
                        || control
                            .unbind_settlement
                            .as_ref()
                            .is_some_and(|waiting| waiting != &attempt_id)
                        || current.binding.is_some()
                        || current.snapshot.revision != revision
                        || self.protected_installed(&backend, attempt).await? != current
                    {
                        return Err(conflict("Protected unbind settlement differs"));
                    }
                    record.outbound.unbind_settlement = None;
                    manager.save_protected_outbound(self.id(), &record, None)?;
                }
            }
            let attempt = record
                .active
                .as_ref()
                .ok_or_else(|| conflict("Missing protected epoch"))?;
            let durable = self.protected_outbound_durable(&record, attempt)?;
            let (installed, diagnostic) = self
                .protected_observation(&backend, attempt)
                .await
                .map_or((None, None), |(snapshot, code)| (Some(snapshot), code));
            let proxy_diagnostic = if inspect
                && durable.binding.is_some()
                && installed.as_ref() == Some(&durable)
                && record.outbound.pending.is_none()
                && record.outbound.unbind_settlement.is_none()
            {
                diagnostic
            } else {
                None
            };
            Ok(ProtectedRouteReceipt {
                runner_id: request.runner_id,
                epoch: request.epoch,
                durable,
                installed,
                proxy_diagnostic,
                pending_attempt: record
                    .outbound
                    .pending
                    .map(|pending| pending.update.attempt_id),
                unbind_settlement: record.outbound.unbind_settlement,
                rollback: record.outbound.rollback,
                retired_attempt,
            })
        })
        .await
    }

    pub(super) fn protected_outbound_durable(
        &self,
        record: &ProtectedBootState,
        attempt: &ProtectedBootAttempt,
    ) -> BoxliteResult<ProtectedRouteSnapshot> {
        match record.outbound.committed.as_ref() {
            Some(committed) => Ok(ProtectedRouteSnapshot {
                snapshot: self.persisted_outbound()?,
                binding: committed.binding.clone(),
            }),
            None => Ok(ProtectedRouteSnapshot {
                snapshot: attempt.key.policy.clone(),
                binding: attempt.binding(),
            }),
        }
    }

    async fn prepare_protected_update(
        &self,
        backend: &GvproxyBackend,
        record: &mut ProtectedBootState,
        current: ProtectedRouteSnapshot,
        update: ProtectedRouteUpdate,
        failed: Option<ProtectedRouteUpdate>,
    ) -> BoxliteResult<()> {
        let attempt = record
            .active
            .as_ref()
            .ok_or_else(|| conflict("Missing protected epoch"))?;
        let control = &mut record.outbound;
        if let Some(failed) = &failed {
            let mut expected = failed.predecessor.clone();
            expected.snapshot.revision = update.candidate.snapshot.revision.clone();
            if control.last_applied.as_ref() != Some(failed)
                || update.predecessor != failed.candidate
                || update.candidate != expected
                || update.candidate.snapshot.revision == failed.predecessor.snapshot.revision
            {
                return Err(conflict("Protected restoration lineage differs"));
            }
        }
        if control.outcome(&update.attempt_id).is_some() {
            return Err(conflict("Protected outbound attempt is retired"));
        }
        if let Some(pending) = control.pending.as_ref() {
            return if pending.update == update {
                Ok(())
            } else {
                Err(conflict("A protected outbound attempt is pending"))
            };
        }
        let manager = &self.runtime.box_manager;
        if control.unbind_settlement.as_ref().is_some_and(|marker| {
            failed
                .as_ref()
                .is_none_or(|failed| &failed.attempt_id != marker)
        }) || current != update.predecessor
            || update
                .candidate
                .binding
                .as_ref()
                .is_some_and(|binding| binding.epoch != attempt.epoch)
            || manager
                .outbound_control(self.id())?
                .is_some_and(|value| value.pending.is_some())
            || self.protected_installed(backend, attempt).await? != current
        {
            return Err(conflict("Protected outbound predecessor differs"));
        }
        let _ = OutboundReplacement::new(
            current.snapshot.revision.clone(),
            update.candidate.snapshot.clone(),
        )?;
        control.committed = Some(current.clone());
        control.pending = Some(ProtectedRoutePending {
            update,
            dispatched: false,
            restoration: None,
        });
        manager.save_protected_outbound(self.id(), record, Some(&current.snapshot))
    }

    async fn apply_protected_update(
        &self,
        backend: &GvproxyBackend,
        record: &mut ProtectedBootState,
        attempt_id: OutboundRevision,
        route: Option<ManagedProxyRoute>,
        predecessor_route: Option<ManagedProxyRoute>,
        expires: Instant,
    ) -> BoxliteResult<()> {
        let attempt = record
            .active
            .as_ref()
            .ok_or_else(|| conflict("Missing protected epoch"))?;
        let pending = record
            .outbound
            .pending
            .as_mut()
            .filter(|pending| pending.update.attempt_id == attempt_id && !pending.dispatched)
            .ok_or_else(|| conflict("Protected outbound stage is unavailable"))?;
        if Instant::now() >= expires {
            return self.expire_protected_stage(record, attempt_id);
        }
        let update = pending.update.clone();
        if route.as_ref().map(|route| &route.binding) != update.candidate.binding.as_ref()
            || predecessor_route.as_ref().map(|route| &route.binding)
                != update.predecessor.binding.as_ref()
            || self.protected_installed(backend, attempt).await? != update.predecessor
        {
            return Err(conflict("Protected outbound route material differs"));
        }
        if Instant::now() >= expires {
            return self.expire_protected_stage(record, attempt_id);
        }
        pending.dispatched = true;
        let manager = &self.runtime.box_manager;
        manager.save_protected_outbound(self.id(), record, None)?;
        self.publish_protected_route(
            backend,
            attempt,
            &update.predecessor,
            &update.candidate,
            route.as_ref(),
        )
        .await?;

        let prior_control = record.outbound.clone();
        record.outbound.committed = Some(update.candidate.clone());
        record.outbound.last_applied = Some(update.clone());
        record.outbound.pending = None;
        record
            .outbound
            .retire(attempt_id.clone(), ProtectedRouteOutcome::Applied);
        record.outbound.rollback = None;
        record.outbound.unbind_settlement = (update.predecessor.binding.is_some()
            && update.candidate.binding.is_none())
        .then_some(attempt_id.clone());
        if let Err(persist_error) =
            manager.save_protected_outbound(self.id(), record, Some(&update.candidate.snapshot))
        {
            let saved = manager
                .protected_boot(self.id())?
                .ok_or_else(|| conflict("Missing protected epoch"))?;
            if saved.outbound.pending.is_none()
                && saved.outbound.committed.as_ref() == Some(&update.candidate)
                && saved.outbound.outcome(&update.attempt_id)
                    == Some(ProtectedRouteOutcome::Applied)
            {
                self.state.write().outbound_policy = Some(update.candidate.snapshot.policy.clone());
                return Ok(());
            }
            if !saved
                .active
                .as_ref()
                .is_some_and(|saved| saved.epoch == attempt.epoch)
                || !saved
                    .outbound
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.dispatched && pending.update == update)
                || saved.outbound.committed.as_ref() != Some(&update.predecessor)
            {
                return Err(conflict("Protected outbound persistence is uncertain"));
            }
            record.outbound = prior_control;
            self.restore_protected_update(backend, record, update, predecessor_route.as_ref())
                .await?;
            return Err(persist_error);
        }
        self.state.write().outbound_policy = Some(update.candidate.snapshot.policy);
        Ok(())
    }

    fn expire_protected_stage(
        &self,
        record: &mut ProtectedBootState,
        attempt_id: OutboundRevision,
    ) -> BoxliteResult<()> {
        record.outbound.pending = None;
        record
            .outbound
            .retire(attempt_id, ProtectedRouteOutcome::Unapplied);
        self.runtime
            .box_manager
            .save_protected_outbound(self.id(), record, None)?;
        Err(conflict("Protected outbound material has expired"))
    }

    async fn restore_protected_update(
        &self,
        backend: &GvproxyBackend,
        record: &mut ProtectedBootState,
        update: ProtectedRouteUpdate,
        route: Option<&ManagedProxyRoute>,
    ) -> BoxliteResult<()> {
        let attempt = record
            .active
            .as_ref()
            .ok_or_else(|| conflict("Missing protected epoch"))?;
        if self.protected_installed(backend, attempt).await? != update.candidate {
            return Err(conflict(
                "Protected outbound restoration needs the installed candidate",
            ));
        }
        let mut restored = update.predecessor.clone();
        restored.snapshot.revision = OutboundRevision::fresh();
        let pending = record
            .outbound
            .pending
            .as_mut()
            .ok_or_else(|| conflict("Missing protected restoration lineage"))?;
        pending.restoration = Some(restored.clone());
        let manager = &self.runtime.box_manager;
        manager.save_protected_outbound(self.id(), record, None)?;
        self.publish_protected_route(backend, attempt, &update.candidate, &restored, route)
            .await?;

        record.outbound.pending = None;
        record.outbound.committed = Some(restored.clone());
        record.outbound.last_applied = None;
        record
            .outbound
            .retire(update.attempt_id.clone(), ProtectedRouteOutcome::Restored);
        record.outbound.rollback = Some(ProtectedRouteRollback {
            failed: update,
            restored: restored.clone(),
        });
        manager.save_protected_outbound(self.id(), record, Some(&restored.snapshot))?;
        self.state.write().outbound_policy = Some(restored.snapshot.policy);
        Ok(())
    }

    async fn publish_protected_route(
        &self,
        backend: &GvproxyBackend,
        attempt: &ProtectedBootAttempt,
        before: &ProtectedRouteSnapshot,
        candidate: &ProtectedRouteSnapshot,
        route: Option<&ManagedProxyRoute>,
    ) -> BoxliteResult<()> {
        let replacement =
            OutboundReplacement::new(before.snapshot.revision.clone(), candidate.snapshot.clone())?;
        // An unreliable response can still be followed by exact installed evidence.
        let _response = backend
            .replace_managed_route(&replacement, &attempt.epoch, route)
            .await;
        if self.protected_installed(backend, attempt).await? != *candidate {
            return Err(conflict("Protected outbound application is uncertain"));
        }
        Ok(())
    }

    async fn protected_installed(
        &self,
        backend: &GvproxyBackend,
        attempt: &ProtectedBootAttempt,
    ) -> BoxliteResult<ProtectedRouteSnapshot> {
        Ok(self.protected_observation(backend, attempt).await?.0)
    }

    async fn protected_observation(
        &self,
        backend: &GvproxyBackend,
        attempt: &ProtectedBootAttempt,
    ) -> BoxliteResult<(ProtectedRouteSnapshot, Option<String>)> {
        let owner = self.verify_protected_owner(attempt)?;
        let expected = attempt
            .gate_id()
            .ok_or_else(|| conflict("Missing protected recovery gate"))?;
        let observed = backend.managed_proxy_status().await?;
        if observed.status.application_state != OutboundApplicationState::Confirmed
            || !observed.recovery_gate.as_ref().is_some_and(|gate| {
                gate.epoch == expected.epoch
                    && gate.generation == expected.generation
                    && !gate.closed
                    && !gate.sealed
            })
            || observed
                .binding
                .as_ref()
                .is_some_and(|binding| binding.epoch != expected.epoch)
            || self.verify_protected_owner(attempt)?.pid != owner.pid
        {
            return Err(conflict(
                "Installed protected outbound identity is unconfirmed",
            ));
        }
        let diagnostic = observed.diagnostic_code().map(str::to_owned);
        Ok((
            ProtectedRouteSnapshot {
                snapshot: observed.status.snapshot,
                binding: observed.binding,
            },
            diagnostic,
        ))
    }
}

fn conflict(message: &str) -> BoxliteError {
    BoxliteError::InvalidState(message.into())
}
