//! Controlled backend outcomes with the real Runtime lock and SQLite store.
use super::*;
use crate::litebox::box_impl::outbound::OutboundControl;
use crate::net::{
    OutboundApplicationState, OutboundReplaceOutcome, OutboundReplacement, OutboundRevision,
    OutboundSnapshot, OutboundSnapshotStatus,
};
use crate::runtime::backend::BoxNetworkBackend;
use crate::runtime::options::{NetworkMode, OutboundNetworkConfig};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug)]
enum Reply {
    Ack,
    LostAck,
    BeforeApply,
    Pending,
    Delayed,
    Held,
    Unsupported,
    ReadError,
    NoStatus,
}

#[derive(Clone, Debug)]
struct RevisionBackend {
    observed: Arc<Mutex<OutboundSnapshotStatus>>,
    reply: Arc<Mutex<Reply>>,
    calls: Arc<Mutex<Vec<OutboundReplacement>>>,
    probe: Arc<Mutex<Option<(std::path::PathBuf, String)>>>,
    release: Arc<Semaphore>,
    late: Arc<Mutex<Option<JoinHandle<bool>>>>,
    advance_after_ack: Arc<AtomicBool>,
    entered: Arc<Notify>,
    legacy_calls: Arc<AtomicUsize>,
}

fn snapshot(revision: &str, mode: NetworkMode) -> OutboundSnapshot {
    OutboundSnapshot {
        policy: OutboundNetworkConfig {
            mode,
            ..Default::default()
        },
        revision: OutboundRevision::parse(revision).unwrap(),
    }
}

fn replacement(expected: &str, candidate: OutboundSnapshot) -> OutboundReplacement {
    OutboundReplacement::new(OutboundRevision::parse(expected).unwrap(), candidate).unwrap()
}

#[async_trait::async_trait]
impl NetworkBackend for RevisionBackend {
    async fn outbound_snapshot(&self) -> BoxliteResult<OutboundSnapshotStatus> {
        let reply = *self.reply.lock().unwrap();
        match reply {
            Reply::Unsupported => return Err(BoxliteError::Unsupported("old backend".into())),
            Reply::ReadError => return Err(BoxliteError::Network("backend unavailable".into())),
            Reply::NoStatus => return std::future::pending().await,
            _ => {}
        }
        Ok(self.observed.lock().unwrap().clone())
    }

    async fn outbound(&self) -> BoxliteResult<OutboundNetworkConfig> {
        Ok(self.observed.lock().unwrap().snapshot.policy.clone())
    }

    async fn set_outbound(&self, policy: &OutboundNetworkConfig) -> BoxliteResult<()> {
        self.legacy_calls.fetch_add(1, Ordering::SeqCst);
        self.observed.lock().unwrap().snapshot.policy = policy.clone();
        Ok(())
    }

    async fn replace_outbound_snapshot(
        &self,
        replacement: &OutboundReplacement,
    ) -> BoxliteResult<OutboundReplaceOutcome> {
        let first = self.calls.lock().unwrap().is_empty();
        self.calls.lock().unwrap().push(replacement.clone());
        if first {
            let (path, id) = self.probe.lock().unwrap().clone().unwrap();
            let database = rusqlite::Connection::open(path).unwrap();
            let pending: String = database.query_row("SELECT json_extract(json, '$.outbound_control.pending.candidate.revision') FROM box_state WHERE id = ?1", [&id], |row| row.get(0)).unwrap();
            assert_eq!(
                pending,
                replacement.candidate().revision.as_str(),
                "application started without its durable marker"
            );
        }
        let reply = *self.reply.lock().unwrap();
        if matches!(reply, Reply::Held) {
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
        }
        if matches!(reply, Reply::BeforeApply) {
            return Err(BoxliteError::Network(
                "timeout before known completion".into(),
            ));
        }
        if matches!(reply, Reply::Delayed) {
            let observed = self.observed.clone();
            let release = self.release.clone();
            let replacement = replacement.clone();
            *self.late.lock().unwrap() = Some(tokio::spawn(async move {
                release.acquire().await.unwrap().forget();
                let mut current = observed.lock().unwrap();
                if current.snapshot.revision != *replacement.expected() {
                    return false;
                }
                current.snapshot = replacement.candidate().clone();
                current.application_state = OutboundApplicationState::Confirmed;
                true
            }));
            return Err(BoxliteError::Network(
                "timeout while remote work remains queued".into(),
            ));
        }
        let mut observed = self.observed.lock().unwrap();
        if observed.snapshot.revision != *replacement.expected() {
            return Ok(OutboundReplaceOutcome::PreconditionFailed);
        }
        observed.snapshot = replacement.candidate().clone();
        observed.application_state = if matches!(reply, Reply::Pending) {
            OutboundApplicationState::Pending
        } else {
            OutboundApplicationState::Confirmed
        };
        if self.advance_after_ack.swap(false, Ordering::SeqCst) {
            observed.snapshot = snapshot("newer-live", NetworkMode::Enabled);
        }
        match reply {
            Reply::LostAck | Reply::Pending => {
                Err(BoxliteError::Network("acknowledgement lost".into()))
            }
            _ => Ok(OutboundReplaceOutcome::Applied),
        }
    }

    fn name(&self) -> &'static str {
        "revision-test"
    }
    fn spec(&self) -> crate::net::NetworkBackendSpec {
        panic!("fixture is already booted")
    }
}

async fn fixture(reply: Reply) -> (StartFixture, RevisionBackend) {
    let backend = RevisionBackend {
        observed: Arc::new(Mutex::new(OutboundSnapshotStatus {
            snapshot: snapshot("initial", NetworkMode::Enabled),
            application_state: OutboundApplicationState::Confirmed,
        })),
        reply: Arc::new(Mutex::new(reply)),
        calls: Default::default(),
        probe: Default::default(),
        release: Arc::new(Semaphore::new(0)),
        late: Default::default(),
        advance_after_ack: Default::default(),
        entered: Default::default(),
        legacy_calls: Default::default(),
    };
    let fixture = running_box_for_start_test_with_live(Arc::new(StartGate::default()), |live| {
        live.network = Some(Arc::new(backend.clone()))
    })
    .await;
    *backend.probe.lock().unwrap() = Some((
        fixture.box_impl.runtime.layout.db_dir().join("boxlite.db"),
        fixture.box_impl.id().to_string(),
    ));
    (fixture, backend)
}

fn control(bx: &BoxImpl) -> Option<OutboundControl> {
    bx.runtime.box_manager.outbound_control(bx.id()).unwrap()
}

fn database(bx: &BoxImpl) -> rusqlite::Connection {
    rusqlite::Connection::open(bx.runtime.layout.db_dir().join("boxlite.db")).unwrap()
}

#[tokio::test]
async fn outbound_revision_persists_matching_candidate_and_rejects_stale_writer() {
    let (fixture, backend) = fixture(Reply::Ack).await;
    let bx = &fixture.box_impl;
    let stale_state = bx.state.read().clone();
    let candidate = snapshot("rev-b", NetworkMode::Disabled);
    assert_eq!(
        bx.replace_outbound_snapshot(replacement("initial", candidate.clone()))
            .await
            .unwrap(),
        OutboundReplaceOutcome::Applied
    );
    assert_eq!(bx.outbound_snapshot().await.unwrap(), candidate);
    assert!(control(bx).unwrap().pending.is_none());
    bx.runtime
        .box_manager
        .save_box(bx.id(), &stale_state)
        .unwrap();
    assert_eq!(
        bx.outbound_snapshot().await.unwrap(),
        candidate,
        "stale lifecycle state overwrote control metadata"
    );
    assert_eq!(
        bx.replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-c", NetworkMode::Enabled)
        ))
        .await
        .unwrap(),
        OutboundReplaceOutcome::PreconditionFailed
    );
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
    assert_eq!(
        backend.outbound_snapshot().await.unwrap().snapshot,
        candidate
    );
}

#[tokio::test]
async fn outbound_revision_resolves_lost_ack_only_from_confirmed_matching_candidate() {
    for reply in [Reply::LostAck, Reply::BeforeApply, Reply::Pending] {
        let (fixture, backend) = fixture(reply).await;
        let bx = &fixture.box_impl;
        let candidate = snapshot("rev-b", NetworkMode::Disabled);
        let result = bx
            .replace_outbound_snapshot(replacement("initial", candidate.clone()))
            .await;
        if matches!(reply, Reply::LostAck) {
            assert_eq!(result.unwrap(), OutboundReplaceOutcome::Applied);
            assert_eq!(bx.outbound_snapshot().await.unwrap(), candidate);
            assert!(control(bx).unwrap().pending.is_none());
        } else {
            assert!(result.unwrap_err().to_string().contains("uncertain"));
            assert_eq!(
                bx.outbound_snapshot().await.unwrap().revision.as_str(),
                "initial"
            );
            assert_eq!(control(bx).unwrap().pending.unwrap().candidate, candidate);
            *backend.reply.lock().unwrap() = Reply::Ack;
            assert!(
                bx.replace_outbound_snapshot(replacement(
                    "initial",
                    snapshot("rev-c", NetworkMode::Enabled)
                ))
                .await
                .unwrap_err()
                .to_string()
                .contains("uncertain")
            );
            assert_eq!(
                backend.calls.lock().unwrap().len(),
                1,
                "unresolved attempt was replayed or compensated"
            );
        }
    }
}

#[tokio::test]
async fn outbound_revision_new_complete_intent_fences_a_late_old_request() {
    let (fixture, backend) = fixture(Reply::Delayed).await;
    let bx = &fixture.box_impl;
    assert!(
        bx.replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-b", NetworkMode::Disabled)
        ))
        .await
        .is_err()
    );
    assert!(control(bx).unwrap().pending.is_some());
    *backend.reply.lock().unwrap() = Reply::Ack;
    bx.update_outbound(OutboundNetworkConfig::default())
        .await
        .unwrap();
    let current = bx.outbound_snapshot().await.unwrap();
    backend.release.add_permits(1);
    let late = backend.late.lock().unwrap().take().unwrap();
    assert!(
        !tokio::time::timeout(Duration::from_secs(2), late)
            .await
            .unwrap()
            .unwrap(),
        "old queued request applied after the new intent"
    );
    assert_eq!(backend.outbound_snapshot().await.unwrap().snapshot, current);
    assert!(control(bx).unwrap().pending.is_none());
}

#[tokio::test]
async fn outbound_revision_does_not_apply_when_pending_marker_cannot_be_written() {
    let (fixture, backend) = fixture(Reply::Ack).await;
    let bx = &fixture.box_impl;
    let db = database(bx);
    db.execute_batch("CREATE TRIGGER reject_pending BEFORE UPDATE ON box_state WHEN json_extract(NEW.json, '$.outbound_control.pending') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'pending write rejected'); END;").unwrap();
    assert!(
        bx.replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-b", NetworkMode::Disabled)
        ))
        .await
        .is_err()
    );
    db.execute_batch("DROP TRIGGER reject_pending").unwrap();
    assert!(backend.calls.lock().unwrap().is_empty());
    assert!(control(bx).is_none());
    assert_eq!(
        backend
            .outbound_snapshot()
            .await
            .unwrap()
            .snapshot
            .revision
            .as_str(),
        "initial"
    );
}

#[tokio::test]
async fn outbound_revision_persistence_failure_restores_with_fresh_identity() {
    let (fixture, backend) = fixture(Reply::Ack).await;
    let bx = &fixture.box_impl;
    let db = database(bx);
    db.execute_batch("CREATE TRIGGER reject_candidate BEFORE UPDATE ON box_state WHEN json_extract(NEW.json, '$.outbound_control.revision') = 'rev-b' BEGIN SELECT RAISE(ABORT, 'candidate commit rejected'); END;").unwrap();
    let result = bx
        .replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-b", NetworkMode::Disabled),
        ))
        .await;
    db.execute_batch("DROP TRIGGER reject_candidate").unwrap();
    assert!(matches!(result, Err(BoxliteError::Database(_))));
    let restored = bx.outbound_snapshot().await.unwrap();
    assert_eq!(restored.policy, OutboundNetworkConfig::default());
    assert_ne!(restored.revision.as_str(), "initial");
    assert_ne!(restored.revision.as_str(), "rev-b");
    assert_eq!(
        backend.outbound_snapshot().await.unwrap().snapshot,
        restored
    );
    {
        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].expected().as_str(), "rev-b");
        assert_eq!(calls[1].candidate(), &restored);
    }
    assert_eq!(
        bx.replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-late", NetworkMode::Disabled)
        ))
        .await
        .unwrap(),
        OutboundReplaceOutcome::PreconditionFailed
    );
}

#[tokio::test]
async fn outbound_revision_stale_restoration_preserves_uncertainty() {
    let (fixture, backend) = fixture(Reply::Ack).await;
    let bx = &fixture.box_impl;
    backend.advance_after_ack.store(true, Ordering::SeqCst);
    let db = database(bx);
    db.execute_batch("CREATE TRIGGER reject_candidate BEFORE UPDATE ON box_state WHEN json_extract(NEW.json, '$.outbound_control.revision') = 'rev-b' BEGIN SELECT RAISE(ABORT, 'candidate commit rejected'); END;").unwrap();
    let result = bx
        .replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-b", NetworkMode::Disabled),
        ))
        .await;
    db.execute_batch("DROP TRIGGER reject_candidate").unwrap();
    assert!(result.unwrap_err().to_string().contains("uncertain"));
    assert_eq!(
        backend
            .outbound_snapshot()
            .await
            .unwrap()
            .snapshot
            .revision
            .as_str(),
        "newer-live"
    );
    assert_eq!(
        bx.outbound_snapshot().await.unwrap().revision.as_str(),
        "initial"
    );
    assert_eq!(
        control(bx)
            .unwrap()
            .pending
            .unwrap()
            .candidate
            .revision
            .as_str(),
        "rev-b"
    );
    assert_eq!(
        backend.calls.lock().unwrap().len(),
        2,
        "conditional restoration fell back to an unchecked update"
    );
}

#[tokio::test]
async fn outbound_revision_recovers_completed_pending_attempt_before_next_precondition() {
    let (fixture, backend) = fixture(Reply::Pending).await;
    let bx = &fixture.box_impl;
    let candidate = snapshot("rev-b", NetworkMode::Disabled);
    assert!(
        bx.replace_outbound_snapshot(replacement("initial", candidate.clone()))
            .await
            .is_err()
    );
    backend.observed.lock().unwrap().application_state = OutboundApplicationState::Confirmed;
    assert_eq!(
        bx.replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-c", NetworkMode::Enabled)
        ))
        .await
        .unwrap(),
        OutboundReplaceOutcome::PreconditionFailed
    );
    assert_eq!(bx.outbound_snapshot().await.unwrap(), candidate);
    assert!(control(bx).unwrap().pending.is_none());
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn outbound_revision_serializes_competing_writers_under_the_existing_lock() {
    let (fixture, backend) = fixture(Reply::Held).await;
    let bx = &fixture.box_impl;
    let first = bx.replace_outbound_snapshot(replacement(
        "initial",
        snapshot("rev-b", NetworkMode::Disabled),
    ));
    tokio::pin!(first);
    assert!(futures::poll!(&mut first).is_pending());
    tokio::time::timeout(Duration::from_secs(2), backend.entered.notified())
        .await
        .unwrap();
    let second = bx.replace_outbound_snapshot(replacement(
        "initial",
        snapshot("rev-c", NetworkMode::Enabled),
    ));
    tokio::pin!(second);
    assert!(
        futures::poll!(&mut second).is_pending(),
        "second writer bypassed Runtime ownership"
    );
    backend.release.add_permits(1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), &mut first)
            .await
            .unwrap()
            .unwrap(),
        OutboundReplaceOutcome::Applied
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), &mut second)
            .await
            .unwrap()
            .unwrap(),
        OutboundReplaceOutcome::PreconditionFailed
    );
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn outbound_revision_restoration_persistence_failure_retains_pending_evidence() {
    let (fixture, backend) = fixture(Reply::Ack).await;
    let bx = &fixture.box_impl;
    let db = database(bx);
    db.execute_batch("CREATE TRIGGER reject_confirmation BEFORE UPDATE ON box_state WHEN json_extract(NEW.json, '$.outbound_control.pending') IS NULL BEGIN SELECT RAISE(ABORT, 'confirmation rejected'); END;").unwrap();
    let error = bx
        .replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-b", NetworkMode::Disabled),
        ))
        .await
        .unwrap_err();
    db.execute_batch("DROP TRIGGER reject_confirmation")
        .unwrap();
    assert!(error.to_string().contains("restoration persistence failed"));
    assert!(error.to_string().contains("uncertain"));
    assert_eq!(
        control(bx)
            .unwrap()
            .pending
            .unwrap()
            .candidate
            .revision
            .as_str(),
        "rev-b"
    );
    let observed = backend.outbound_snapshot().await.unwrap();
    assert_eq!(observed.snapshot.policy, OutboundNetworkConfig::default());
    assert_ne!(observed.snapshot.revision.as_str(), "initial");
    assert_eq!(
        bx.outbound_snapshot().await.unwrap().revision.as_str(),
        "initial"
    );
    bx.update_outbound(OutboundNetworkConfig::default())
        .await
        .unwrap();
    assert_eq!(
        bx.outbound_snapshot().await.unwrap(),
        backend.outbound_snapshot().await.unwrap().snapshot
    );
    assert!(control(bx).unwrap().pending.is_none());
}

#[tokio::test]
async fn outbound_revision_old_backend_compatibility_cannot_downgrade_versioned_state() {
    let (fixture, backend) = fixture(Reply::Unsupported).await;
    let bx = &fixture.box_impl;
    assert!(matches!(
        bx.replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-b", NetworkMode::Disabled)
        ))
        .await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert_eq!(backend.legacy_calls.load(Ordering::SeqCst), 0);
    bx.update_outbound(OutboundNetworkConfig {
        mode: NetworkMode::Disabled,
        ..Default::default()
    })
    .await
    .unwrap();
    assert_eq!(backend.legacy_calls.load(Ordering::SeqCst), 1);
    assert!(control(bx).is_none());
    bx.runtime
        .box_manager
        .save_outbound_control(
            bx.id(),
            Some(&OutboundControl {
                revision: OutboundRevision::initial(),
                pending: None,
            }),
            None,
        )
        .unwrap();
    assert!(matches!(
        bx.update_outbound(OutboundNetworkConfig::default()).await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert_eq!(backend.legacy_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn outbound_status_does_not_wait_for_a_pending_writer() {
    let (fixture, backend) = fixture(Reply::Held).await;
    let bx = &fixture.box_impl;
    let facade = crate::litebox::NetworkHandle::new(bx.clone());
    let first = facade.replace_outbound_snapshot(replacement(
        "initial",
        snapshot("rev-b", NetworkMode::Disabled),
    ));
    tokio::pin!(first);
    assert!(futures::poll!(&mut first).is_pending());
    tokio::time::timeout(Duration::from_secs(2), backend.entered.notified())
        .await
        .unwrap();
    let status = tokio::time::timeout(Duration::from_secs(1), facade.outbound_status()).await;
    let persisted = tokio::time::timeout(Duration::from_secs(1), facade.outbound_snapshot()).await;
    backend.release.add_permits(1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), &mut first)
            .await
            .unwrap()
            .unwrap(),
        OutboundReplaceOutcome::Applied
    );
    let status = status.expect("status waited for the update lock").unwrap();
    assert_eq!(
        status.application_state,
        OutboundApplicationState::Uncertain
    );
    assert_eq!(status.pending_revision.unwrap().as_str(), "rev-b");
    assert_eq!(status.persisted.revision.as_str(), "initial");
    assert_eq!(
        persisted
            .expect("persisted read waited for the update lock")
            .unwrap()
            .revision
            .as_str(),
        "initial"
    );
    assert_eq!(
        facade.outbound_status().await.unwrap().application_state,
        OutboundApplicationState::Confirmed
    );
}

#[tokio::test]
async fn outbound_status_reports_confirmed_candidate_as_uncertain_until_persisted() {
    let (fixture, backend) = fixture(Reply::Pending).await;
    let bx = &fixture.box_impl;
    assert!(
        bx.replace_outbound_snapshot(replacement(
            "initial",
            snapshot("rev-b", NetworkMode::Disabled)
        ))
        .await
        .is_err()
    );
    let status = bx.outbound_status().await.unwrap();
    assert_eq!(status.application_state, OutboundApplicationState::Pending);
    backend.observed.lock().unwrap().application_state = OutboundApplicationState::Confirmed;
    let db = database(bx);
    db.execute_batch("CREATE TRIGGER reject_status_writes BEFORE UPDATE ON box_state BEGIN SELECT RAISE(ABORT, 'GET changed state'); END;").unwrap();
    let status = bx.outbound_status().await.unwrap();
    let persisted = bx.outbound_snapshot().await.unwrap();
    db.execute_batch("DROP TRIGGER reject_status_writes")
        .unwrap();
    assert_eq!(
        status.application_state,
        OutboundApplicationState::Uncertain
    );
    assert_eq!(status.persisted.revision.as_str(), "initial");
    assert_eq!(status.observed.unwrap().snapshot.revision.as_str(), "rev-b");
    assert_eq!(persisted.revision.as_str(), "initial");
    assert!(
        control(bx).unwrap().pending.is_some(),
        "GET reconciled a pending attempt"
    );
}

#[tokio::test]
async fn outbound_status_preserves_failures_and_does_not_confirm_stored_configuration_alone() {
    let (fixture, backend) = fixture(Reply::ReadError).await;
    let bx = &fixture.box_impl;
    let status = bx.outbound_status().await.unwrap();
    assert_eq!(
        status.application_state,
        OutboundApplicationState::Uncertain
    );
    assert!(status.observed.is_none());
    assert!(
        status
            .observation_error
            .unwrap()
            .contains("backend unavailable")
    );
    *backend.reply.lock().unwrap() = Reply::Unsupported;
    assert!(matches!(
        bx.outbound_status().await,
        Err(BoxliteError::Unsupported(_))
    ));
    *backend.reply.lock().unwrap() = Reply::Ack;
    backend.observed.lock().unwrap().snapshot = snapshot("divergent", NetworkMode::Disabled);
    assert_eq!(
        bx.outbound_status().await.unwrap().application_state,
        OutboundApplicationState::Uncertain
    );
}

#[tokio::test]
async fn outbound_status_does_not_boot_a_stopped_handle_or_use_an_older_live_epoch() {
    let (fixture, backend) = fixture(Reply::Unsupported).await;
    let bx = &fixture.box_impl;
    let mut state = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    state.started_at = state
        .started_at
        .map(|value| value + chrono::Duration::seconds(1));
    bx.runtime.box_manager.save_box(bx.id(), &state).unwrap();
    let status = bx.outbound_status().await.unwrap();
    assert!(status.observed.is_none());
    assert!(status.observation_error.unwrap().contains("earlier VM"));
    state.force_status(BoxStatus::Stopped);
    bx.runtime.box_manager.save_box(bx.id(), &state).unwrap();
    let recovered = BoxImpl::new(
        bx.config.clone(),
        state,
        bx.runtime.clone(),
        bx.runtime.shutdown_token.child_token(),
    );
    assert!(!recovered.live.initialized());
    let status = recovered.outbound_status().await.unwrap();
    assert_eq!(
        status.application_state,
        OutboundApplicationState::Uncertain
    );
    assert!(status.observation_error.unwrap().contains("not running"));
    assert!(!recovered.live.initialized());
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn outbound_status_bounds_a_backend_that_never_returns() {
    let (fixture, _) = fixture(Reply::NoStatus).await;
    tokio::time::pause();
    let status = fixture.box_impl.outbound_status();
    tokio::pin!(status);
    assert!(futures::poll!(&mut status).is_pending());
    tokio::time::advance(Duration::from_secs(9)).await;
    assert!(futures::poll!(&mut status).is_pending());
    tokio::time::advance(Duration::from_secs(1)).await;
    let status = status.await.unwrap();
    assert_eq!(
        status.application_state,
        OutboundApplicationState::Uncertain
    );
    assert!(status.observed.is_none());
    assert!(
        status
            .observation_error
            .unwrap()
            .contains("timed out after 10s")
    );
}
