use super::outbound::{
    CompleteOutboundAttempt, CompleteOutboundControl, apply_complete, backend_confirms, confirms,
    prepare_ipv6_enable,
};
use super::*;
use crate::net::{
    CompleteOutboundObservation, CompleteOutboundSnapshot, HostedOutboundAttempt,
    HostedOutboundCommand, HostedOutboundReceipt, OutboundCapabilities, OutboundReplaceOutcome,
    OutboundRevision, PreparedOutboundCreate,
};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
enum Journal {
    Applying {
        attempt: HostedOutboundAttempt,
        previous_protected: bool,
    },
    Applied {
        attempt: HostedOutboundAttempt,
        previous_protected: bool,
    },
    Restoring {
        attempt: HostedOutboundAttempt,
        previous_protected: bool,
        revision: OutboundRevision,
    },
    Restored {
        attempt: HostedOutboundAttempt,
        snapshot: CompleteOutboundSnapshot,
        previous_protected: bool,
    },
    Settled {
        generation: u64,
        attempt_id: OutboundRevision,
        intent_digest: String,
        receipt: HostedOutboundReceipt,
    },
}

impl Journal {
    fn identity(&self) -> (u64, &OutboundRevision) {
        match self {
            Self::Applying { attempt, .. }
            | Self::Applied { attempt, .. }
            | Self::Restoring { attempt, .. }
            | Self::Restored { attempt, .. } => (attempt.generation, &attempt.attempt_id),
            Self::Settled {
                generation,
                attempt_id,
                ..
            } => (*generation, attempt_id),
        }
    }

    fn active_attempt(&self) -> Option<&HostedOutboundAttempt> {
        match self {
            Self::Applying { attempt, .. }
            | Self::Applied { attempt, .. }
            | Self::Restoring { attempt, .. }
            | Self::Restored { attempt, .. } => Some(attempt),
            Self::Settled { .. } => None,
        }
    }

    fn settle(
        attempt: &HostedOutboundAttempt,
        receipt: HostedOutboundReceipt,
    ) -> BoxliteResult<Self> {
        Ok(Self::Settled {
            generation: attempt.generation,
            attempt_id: attempt.attempt_id.clone(),
            intent_digest: attempt_digest(attempt)?,
            receipt,
        })
    }
}

fn attempt_digest(attempt: &HostedOutboundAttempt) -> BoxliteResult<String> {
    let encoded =
        serde_json::to_vec(attempt).map_err(|error| BoxliteError::Database(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

struct RunningOutbound {
    control: CompleteOutboundControl,
    protected: bool,
    backend: Arc<dyn NetworkBackend>,
    observed: CompleteOutboundObservation,
    capabilities: OutboundCapabilities,
}

impl BoxImpl {
    pub(super) async fn hosted_outbound(
        &self,
        command: HostedOutboundCommand,
    ) -> BoxliteResult<HostedOutboundReceipt> {
        self.with_disk_admission(self.with_operation(self.run_hosted_outbound(command)))
            .await
    }

    async fn run_hosted_outbound(
        &self,
        command: HostedOutboundCommand,
    ) -> BoxliteResult<HostedOutboundReceipt> {
        let incarnation = self
            .hosted_outbound_incarnation()
            .ok_or_else(owner_conflict)?;
        let (attempt, action) = match command {
            HostedOutboundCommand::CheckRebuild {
                snapshot,
                pin_backend,
            } => {
                if snapshot.ipv6.is_some()
                    && !crate::net::gvproxy::CloudGuardRuntime::qualifies_ipv6().await?
                {
                    return Err(BoxliteError::Unsupported(
                        "Guest IPv6 requires qualified Cloud inventory v2".into(),
                    ));
                }
                let (state, _, control) =
                    self.runtime.box_manager.outbound_state(&self.config.id)?;
                if self
                    .load_hosted_journal(incarnation)?
                    .is_some_and(|journal| journal.active_attempt().is_some())
                    || !control.is_some_and(|control| {
                        control.pending.is_none() && control.committed == snapshot
                    })
                    || (state.status == BoxStatus::Running
                        && !self.running_outbound().await?.matches_installed(&snapshot))
                {
                    return Err(owner_conflict());
                }
                let rebuild_pin = if pin_backend {
                    Some(
                        crate::vmm::controller::pin_rebuild_shim(
                            self.runtime.layout.home_dir(),
                            snapshot.requirements(),
                        )
                        .await?,
                    )
                } else {
                    None
                };
                return Ok(HostedOutboundReceipt::RebuildReady {
                    snapshot,
                    rebuild_pin,
                });
            }
            HostedOutboundCommand::Prepare {
                previous,
                revision,
                policy,
            } => {
                let running = self.running_outbound().await?;
                if !running.matches_installed(&previous)
                    || revision == previous.revision
                    || revision == OutboundRevision::initial()
                {
                    return Err(owner_conflict());
                }
                let candidate = PreparedOutboundCreate {
                    snapshot: previous.prepare_replacement(&policy, revision)?,
                    deny_present: policy.deny_net.is_some(),
                    rebuild_pin: None,
                };
                running
                    .capabilities
                    .require(replacement_requirements(&previous, &candidate)?)?;
                return Ok(HostedOutboundReceipt::Prepared { candidate });
            }
            HostedOutboundCommand::Apply { attempt } => (attempt, Action::Apply),
            HostedOutboundCommand::Cancel { attempt } => (attempt, Action::Cancel),
            HostedOutboundCommand::Reconcile { attempt } => (attempt, Action::Reconcile),
            HostedOutboundCommand::Restore { attempt, revision } => {
                (attempt, Action::Restore(revision))
            }
            HostedOutboundCommand::Finalize { attempt } => (attempt, Action::Finalize),
        };
        if attempt.incarnation != incarnation
            || attempt.generation == 0
            || attempt.candidate.rebuild_pin.is_some()
            || attempt.previous.revision == attempt.candidate.snapshot.revision
            || attempt.candidate.snapshot.revision == OutboundRevision::initial()
        {
            return Err(owner_conflict());
        }
        attempt.previous.validate_installed()?;
        let required = replacement_requirements(&attempt.previous, &attempt.candidate)?;
        let mut journal = self.load_hosted_journal(incarnation)?;
        if let Some(current) = &journal {
            let (generation, id) = current.identity();
            if generation > attempt.generation
                || (generation == attempt.generation
                    && (id != &attempt.attempt_id
                        || current
                            .active_attempt()
                            .is_some_and(|stored| stored != &attempt)))
                || (generation < attempt.generation && current.active_attempt().is_some())
            {
                return Err(owner_conflict());
            }
            if generation < attempt.generation {
                journal = None;
            }
        }
        if let Some(Journal::Settled {
            intent_digest,
            receipt,
            ..
        }) = &journal
        {
            if &attempt_digest(&attempt)? != intent_digest {
                return Err(owner_conflict());
            }
            if let (Action::Restore(requested), HostedOutboundReceipt::Finalized { snapshot }) =
                (&action, receipt)
                && (snapshot.revision != *requested
                    || snapshot.revision == attempt.candidate.snapshot.revision)
            {
                return Err(owner_conflict());
            }
            return Ok(receipt.clone());
        }

        let running = self.running_outbound().await?;
        match (journal, action) {
            (None, Action::Apply) if running.matches_installed(&attempt.previous) => {
                running.capabilities.require(required)?;
                let applying = Journal::Applying {
                    attempt: attempt.clone(),
                    previous_protected: running.protected,
                };
                let pending = CompleteOutboundControl {
                    committed: attempt.previous.clone(),
                    pending: Some(CompleteOutboundAttempt {
                        expected: attempt.previous.revision.clone(),
                        candidate: attempt.candidate.snapshot.clone(),
                        possible: attempt.previous.requirements(),
                        restoration: None,
                    }),
                };
                self.commit_hosted_journal(incarnation, &applying, Some((&pending, true)))?;
                self.finish_hosted_apply(&attempt, running.protected, &running, required, true)
                    .await
            }
            (None, Action::Cancel | Action::Reconcile)
                if running.matches_installed(&attempt.previous) =>
            {
                self.commit_hosted_journal(
                    incarnation,
                    &Journal::settle(&attempt, HostedOutboundReceipt::Cancelled)?,
                    None,
                )?;
                Ok(HostedOutboundReceipt::Cancelled)
            }
            (
                Some(Journal::Applying {
                    previous_protected, ..
                }),
                action,
            ) => {
                if !running.control.pending.as_ref().is_some_and(|pending| {
                    running.control.committed == attempt.previous
                        && pending.candidate == attempt.candidate.snapshot
                        && pending.restoration.is_none()
                }) {
                    return Err(owner_conflict());
                }
                self.finish_hosted_apply(
                    &attempt,
                    previous_protected,
                    &running,
                    required,
                    matches!(action, Action::Apply | Action::Reconcile),
                )
                .await
            }
            (
                Some(Journal::Applied {
                    previous_protected, ..
                }),
                Action::Restore(revision),
            ) if running.matches_installed(&attempt.candidate.snapshot) => {
                let restored = restoration(&attempt, &revision)?;
                let replay = Journal::Restoring {
                    attempt: attempt.clone(),
                    previous_protected,
                    revision,
                };
                let pending = CompleteOutboundControl {
                    committed: attempt.candidate.snapshot.clone(),
                    // The generic pending type expects restoration to match committed rules.
                    // Hosted restoration has an independently retained predecessor.
                    pending: Some(CompleteOutboundAttempt {
                        expected: attempt.candidate.snapshot.revision.clone(),
                        candidate: restored.clone(),
                        possible: attempt.candidate.snapshot.requirements(),
                        restoration: None,
                    }),
                };
                self.commit_hosted_journal(incarnation, &replay, Some((&pending, true)))?;
                self.finish_hosted_restore(&attempt, previous_protected, &running, restored)
                    .await
            }
            (
                Some(Journal::Restoring {
                    previous_protected,
                    revision,
                    ..
                }),
                Action::Restore(requested),
            ) if revision == requested => {
                self.finish_hosted_restore(
                    &attempt,
                    previous_protected,
                    &running,
                    restoration(&attempt, &revision)?,
                )
                .await
            }
            (
                Some(Journal::Restoring {
                    previous_protected,
                    revision,
                    ..
                }),
                Action::Reconcile,
            ) => {
                self.finish_hosted_restore(
                    &attempt,
                    previous_protected,
                    &running,
                    restoration(&attempt, &revision)?,
                )
                .await
            }
            (Some(Journal::Applied { .. }), action)
                if running.matches_installed(&attempt.candidate.snapshot) =>
            {
                self.hosted_confirmation(&attempt, &attempt.candidate.snapshot, action, None)
            }
            (
                Some(Journal::Restored {
                    snapshot,
                    previous_protected,
                    ..
                }),
                action,
            ) if running.matches_installed(&snapshot)
                && !matches!(&action, Action::Restore(revision) if *revision != snapshot.revision) =>
            {
                self.hosted_confirmation(&attempt, &snapshot, action, Some(previous_protected))
            }
            _ => Ok(HostedOutboundReceipt::Pending),
        }
    }

    async fn running_outbound(&self) -> BoxliteResult<RunningOutbound> {
        let (state, legacy, complete) = self.runtime.box_manager.outbound_state(&self.config.id)?;
        if self.shutdown_token.is_cancelled() || state.status != BoxStatus::Running {
            return Err(BoxliteError::InvalidState(
                "hosted outbound operations require a running Box".into(),
            ));
        }
        let protected = complete.is_some();
        let control = complete.unwrap_or_else(|| {
            CompleteOutboundControl::from_legacy(
                self.snapshot_from_state(&state, legacy.as_ref()),
                legacy.as_ref(),
            )
        });
        let policy = &control.committed.policy;
        let backend = self.observation_backend(&state, &policy.mode, &policy.allow_net)?;
        let (observed, capabilities) = backend.complete_outbound_snapshot().await?;
        Ok(RunningOutbound {
            control,
            protected,
            backend,
            observed,
            capabilities,
        })
    }

    async fn finish_hosted_apply(
        &self,
        attempt: &HostedOutboundAttempt,
        previous_protected: bool,
        running: &RunningOutbound,
        required: OutboundCapabilities,
        replay: bool,
    ) -> BoxliteResult<HostedOutboundReceipt> {
        let candidate = &attempt.candidate.snapshot;
        if !confirms(&running.observed, candidate) {
            if !replay || !confirms(&running.observed, &attempt.previous) {
                return Ok(HostedOutboundReceipt::Pending);
            }
            running.capabilities.require(required)?;
            if candidate.ipv6.is_some() {
                let live = self.ensure_booted_locked().await?;
                prepare_ipv6_enable(
                    running.backend.as_ref(),
                    &live.guest_session,
                    &attempt.previous,
                    candidate,
                )
                .await?;
            }
            let result = apply_complete(
                running.backend.as_ref(),
                &attempt.previous.revision,
                candidate,
                attempt.candidate.deny_present,
                false,
                required != OutboundCapabilities::default(),
            )
            .await;
            if !backend_confirms(running.backend.as_ref(), candidate).await {
                if matches!(
                    result,
                    Ok(OutboundReplaceOutcome::PreconditionFailed)
                        | Err(BoxliteError::Unsupported(_))
                ) && backend_confirms(running.backend.as_ref(), &attempt.previous).await
                {
                    let receipt = HostedOutboundReceipt::Cancelled;
                    self.commit_hosted_snapshot(
                        &attempt.incarnation,
                        &Journal::settle(attempt, receipt.clone())?,
                        &attempt.previous,
                        previous_protected,
                    )?;
                    return Ok(receipt);
                }
                return result.map(|_| HostedOutboundReceipt::Pending);
            }
        }
        let journal = Journal::Applied {
            attempt: attempt.clone(),
            previous_protected,
        };
        self.commit_hosted_snapshot(&attempt.incarnation, &journal, candidate, true)?;
        Ok(HostedOutboundReceipt::Applied {
            snapshot: candidate.clone(),
        })
    }

    async fn finish_hosted_restore(
        &self,
        attempt: &HostedOutboundAttempt,
        previous_protected: bool,
        running: &RunningOutbound,
        restored: CompleteOutboundSnapshot,
    ) -> BoxliteResult<HostedOutboundReceipt> {
        let candidate = &attempt.candidate.snapshot;
        if running.control.committed != *candidate
            || running
                .control
                .pending
                .as_ref()
                .is_some_and(|pending| pending.candidate != restored)
        {
            return Err(owner_conflict());
        }
        if !confirms(&running.observed, &restored) {
            if !confirms(&running.observed, candidate) {
                return Ok(HostedOutboundReceipt::Pending);
            }
            let required = restored.requirements().union(candidate.requirements());
            running.capabilities.require(required)?;
            if restored.ipv6.is_some() {
                let live = self.ensure_booted_locked().await?;
                prepare_ipv6_enable(
                    running.backend.as_ref(),
                    &live.guest_session,
                    candidate,
                    &restored,
                )
                .await?;
            }
            let result = apply_complete(
                running.backend.as_ref(),
                &candidate.revision,
                &restored,
                false,
                true,
                required != OutboundCapabilities::default(),
            )
            .await;
            if !backend_confirms(running.backend.as_ref(), &restored).await {
                return result.map(|_| HostedOutboundReceipt::Pending);
            }
        }
        let journal = Journal::Restored {
            attempt: attempt.clone(),
            snapshot: restored.clone(),
            previous_protected,
        };
        self.commit_hosted_snapshot(&attempt.incarnation, &journal, &restored, true)?;
        Ok(HostedOutboundReceipt::Restored { snapshot: restored })
    }

    fn hosted_confirmation(
        &self,
        attempt: &HostedOutboundAttempt,
        snapshot: &CompleteOutboundSnapshot,
        action: Action,
        restored_protection: Option<bool>,
    ) -> BoxliteResult<HostedOutboundReceipt> {
        if matches!(action, Action::Finalize) {
            let receipt = HostedOutboundReceipt::Finalized {
                snapshot: snapshot.clone(),
            };
            let settled = Journal::settle(attempt, receipt.clone())?;
            if restored_protection == Some(false) {
                self.commit_hosted_snapshot(&attempt.incarnation, &settled, snapshot, false)?;
            } else {
                self.commit_hosted_journal(&attempt.incarnation, &settled, None)?;
            }
            return Ok(receipt);
        }
        if restored_protection.is_some() {
            Ok(HostedOutboundReceipt::Restored {
                snapshot: snapshot.clone(),
            })
        } else {
            Ok(HostedOutboundReceipt::Applied {
                snapshot: snapshot.clone(),
            })
        }
    }

    fn load_hosted_journal(&self, incarnation: &str) -> BoxliteResult<Option<Journal>> {
        self.runtime
            .box_manager
            .hosted_outbound_journal(incarnation)?
            .map(|json| {
                serde_json::from_str(&json)
                    .map_err(|error| BoxliteError::Database(error.to_string()))
            })
            .transpose()
    }

    pub(super) fn has_hosted_outbound_owner(&self, protected: bool) -> BoxliteResult<bool> {
        let Some(incarnation) = self.hosted_outbound_incarnation() else {
            return Ok(false);
        };
        Ok(self
            .load_hosted_journal(incarnation)?
            .is_some_and(|journal| protected || journal.active_attempt().is_some()))
    }

    fn hosted_outbound_incarnation(&self) -> Option<&str> {
        let name = self.config.name.as_deref()?;
        if name
            .strip_prefix("checkpoint-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            // Checkpoint recovery rewrites this reserved environment entry when
            // importing the candidate, before the Runner publishes its target.
            return self
                .config
                .options
                .env
                .iter()
                .find(|(key, _)| key == "BOXLITE_BOX_ID")
                .map(|(_, target)| target.as_str());
        }
        Some(name)
    }

    fn commit_hosted_snapshot(
        &self,
        incarnation: &str,
        journal: &Journal,
        snapshot: &CompleteOutboundSnapshot,
        protected: bool,
    ) -> BoxliteResult<()> {
        let control = CompleteOutboundControl {
            committed: snapshot.clone(),
            pending: None,
        };
        self.commit_hosted_journal(incarnation, journal, Some((&control, protected)))?;
        self.state.write().outbound_policy = if protected {
            None
        } else {
            snapshot.legacy().ok().map(|s| s.policy)
        };
        Ok(())
    }

    fn commit_hosted_journal(
        &self,
        incarnation: &str,
        journal: &Journal,
        control: Option<(&CompleteOutboundControl, bool)>,
    ) -> BoxliteResult<()> {
        let json = serde_json::to_string(journal)
            .map_err(|error| BoxliteError::Database(error.to_string()))?;
        self.runtime.box_manager.commit_hosted_outbound(
            &self.config.id,
            incarnation,
            &json,
            control,
        )
    }
}

enum Action {
    Apply,
    Cancel,
    Reconcile,
    Restore(OutboundRevision),
    Finalize,
}

impl RunningOutbound {
    fn matches_installed(&self, snapshot: &CompleteOutboundSnapshot) -> bool {
        self.control.pending.is_none()
            && self.control.committed == *snapshot
            && confirms(&self.observed, snapshot)
    }
}

fn replacement_requirements(
    previous: &CompleteOutboundSnapshot,
    candidate: &PreparedOutboundCreate,
) -> BoxliteResult<OutboundCapabilities> {
    if !candidate.deny_present && !previous.policy.deny_net.is_empty() {
        return Err(BoxliteError::InvalidArgument(
            "deny_net is required while outbound denies may be active".into(),
        ));
    }
    if previous.requirements().admission && !candidate.snapshot.requirements().admission {
        return Err(BoxliteError::InvalidArgument(
            "replacement cannot demote outbound admission".into(),
        ));
    }
    Ok(previous.requirements().union(candidate.requirements()?))
}

fn restoration(
    attempt: &HostedOutboundAttempt,
    revision: &OutboundRevision,
) -> BoxliteResult<CompleteOutboundSnapshot> {
    if *revision == OutboundRevision::initial()
        || *revision == attempt.previous.revision
        || *revision == attempt.candidate.snapshot.revision
    {
        return Err(owner_conflict());
    }
    let mut restored = attempt.previous.clone();
    restored.revision = revision.clone();
    Ok(restored)
}

fn owner_conflict() -> BoxliteError {
    BoxliteError::InvalidState("hosted outbound operation does not own this Box revision".into())
}
