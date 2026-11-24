//! Exact managed route updates against real SQLite and the gvproxy control socket.

use super::*;
use crate::litebox::protected_boot::{
    BootRecoveryGate, ProtectedBootAttempt, ProtectedBootKey, ProtectedBootState,
};
use crate::litebox::protected_outbound::{
    ProtectedRouteMaterial, ProtectedRouteOperation, ProtectedRouteReceipt, ProtectedRouteRequest,
    ProtectedRouteSnapshot, ProtectedRouteUpdate,
};
use crate::net::gvproxy::{GvproxyInstance, ManagedProxyIdentity};
use crate::net::{OutboundReplacement, OutboundRevision, OutboundSnapshot};
use crate::runtime::backend::BoxNetworkBackend;
use crate::runtime::options::OutboundNetworkConfig;
use crate::util::{PidRecord, process_start_time};

struct ManagedFixture {
    start: StartFixture,
    _bridge: GvproxyInstance,
    _child: ChildGuard,
    runner: OutboundRevision,
    baseline: ProtectedRouteSnapshot,
}

fn material(binding: ManagedProxyIdentity) -> ProtectedRouteMaterial {
    ProtectedRouteMaterial {
        binding,
        scheme: "https".into(),
        host: "8.8.8.8".into(),
        port: 443,
        credential: None,
    }
}

async fn managed_fixture() -> ManagedFixture {
    let runner = OutboundRevision::fresh();
    let key = ProtectedBootKey {
        runner_id: runner.clone(),
        attempt_id: OutboundRevision::fresh(),
        registration_id: Some(OutboundRevision::fresh()),
        registration_revision: Some(OutboundRevision::parse("7").unwrap()),
        policy: OutboundSnapshot {
            revision: OutboundRevision::fresh(),
            policy: OutboundNetworkConfig::default(),
        },
    };
    let child = ChildGuard(
        std::process::Command::new("sleep")
            .arg("120")
            .spawn()
            .unwrap(),
    );
    let pid = child.0.id();
    let boot = ProtectedBootAttempt {
        key,
        epoch: OutboundRevision::fresh(),
        confirmed: true,
        owner: Some(PidRecord {
            pid,
            start_time: Some(process_start_time(pid).unwrap()),
        }),
        spawning: true,
        recovery_gate: Some(BootRecoveryGate {
            generation: OutboundRevision::fresh(),
            seal_requested: false,
            seal_confirmed: false,
            released: true,
            evidence: None,
        }),
    };
    let binding = boot.binding().unwrap();
    let gate = boot.gate_id().unwrap();
    let baseline = ProtectedRouteSnapshot {
        snapshot: boot.key.policy.clone(),
        binding: Some(binding.clone()),
    };
    let route = material(binding).route(
        "https://resolver.example.com/dns-query".into(),
        "1.1.1.1:443".parse().unwrap(),
    );
    let mut bridge = None;
    let start = running_box_for_start_test_with_live(Arc::new(StartGate::default()), |bx, live| {
        let backend = bx.protected_bridge();
        let spec = backend.spec();
        std::fs::create_dir_all(spec.socket_path.parent().unwrap()).unwrap();
        let (instance, _) = GvproxyInstance::from_managed_network(
            &spec,
            &baseline.snapshot,
            Some(&route),
            Some(&gate),
        )
        .unwrap();
        live.network = Some(Arc::new(backend));
        bridge = Some(instance);
    })
    .await;
    let bx = &start.box_impl;
    let mut state = bx.state.read().clone();
    state.set_pid(Some(pid));
    bx.runtime.box_manager.save_box(bx.id(), &state).unwrap();
    *bx.state.write() = state;
    bx.runtime
        .box_manager
        .save_protected_boot(
            bx.id(),
            &ProtectedBootState {
                active: Some(boot),
                ..Default::default()
            },
        )
        .unwrap();
    bx.protected_bridge()
        .change_recovery_gate(
            &gate,
            &baseline.snapshot.revision,
            baseline.binding.as_ref(),
            crate::net::gvproxy::RecoveryGateAction::Release,
        )
        .await
        .unwrap();

    ManagedFixture {
        start,
        _bridge: bridge.unwrap(),
        _child: child,
        runner,
        baseline,
    }
}

impl ManagedFixture {
    async fn request(
        &self,
        command: ProtectedRouteOperation,
    ) -> BoxliteResult<ProtectedRouteReceipt> {
        self.start
            .box_impl
            .protected_outbound(ProtectedRouteRequest {
                runner_id: self.runner.clone(),
                epoch: self.baseline.binding.as_ref().unwrap().epoch.clone(),
                command,
                doh_url: "https://resolver.example.com/dns-query".into(),
                doh_address: "1.1.1.1:443".parse().unwrap(),
            })
            .await
    }

    fn unbind(&self, predecessor: ProtectedRouteSnapshot) -> ProtectedRouteUpdate {
        ProtectedRouteUpdate {
            attempt_id: OutboundRevision::fresh(),
            predecessor,
            candidate: ProtectedRouteSnapshot {
                snapshot: OutboundSnapshot {
                    policy: OutboundNetworkConfig::default(),
                    revision: OutboundRevision::fresh(),
                },
                binding: None,
            },
        }
    }

    async fn apply_unbind(
        &self,
        update: &ProtectedRouteUpdate,
    ) -> BoxliteResult<ProtectedRouteReceipt> {
        self.request(ProtectedRouteOperation::Apply {
            attempt_id: update.attempt_id.clone(),
            route: None,
            predecessor_route: update.predecessor.binding.clone().map(material),
        })
        .await
    }
}

#[tokio::test]
async fn protected_outbound_unbind_fences_both_writes_until_exact_settlement() {
    let fixture = managed_fixture().await;
    let bx = &fixture.start.box_impl;
    let update = fixture.unbind(fixture.baseline.clone());
    fixture
        .request(ProtectedRouteOperation::Prepare {
            update: update.clone(),
        })
        .await
        .unwrap();
    // Drop the applying caller's receipt and settle using independent readback.
    drop(fixture.apply_unbind(&update).await.unwrap());
    let status = fixture
        .request(ProtectedRouteOperation::Inspect)
        .await
        .unwrap();
    assert_eq!(status.durable, update.candidate);
    assert_eq!(status.installed.as_ref(), Some(&status.durable));
    assert_eq!(status.unbind_settlement.as_ref(), Some(&update.attempt_id));
    assert!(status.pending_attempt.is_none());

    let policy = OutboundNetworkConfig::default();
    let plain = OutboundReplacement::new(
        status.durable.snapshot.revision.clone(),
        OutboundSnapshot {
            policy: policy.clone(),
            revision: OutboundRevision::fresh(),
        },
    )
    .unwrap();
    assert!(
        bx.update_outbound(policy)
            .await
            .unwrap_err()
            .to_string()
            .contains("complete authorized route")
    );
    assert!(
        bx.replace_outbound_snapshot(plain.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("complete authorized route")
    );
    assert!(
        fixture
            .request(ProtectedRouteOperation::SettleUnbind {
                attempt_id: update.attempt_id.clone(),
                revision: OutboundRevision::fresh(),
            })
            .await
            .is_err()
    );
    let settled = fixture
        .request(ProtectedRouteOperation::SettleUnbind {
            attempt_id: update.attempt_id.clone(),
            revision: update.candidate.snapshot.revision.clone(),
        })
        .await
        .unwrap();
    assert!(settled.unbind_settlement.is_none());
    assert!(fixture.apply_unbind(&update).await.is_err());
    assert_eq!(
        bx.replace_outbound_snapshot(plain).await.unwrap(),
        crate::net::OutboundReplaceOutcome::Applied
    );
}

#[tokio::test]
async fn protected_outbound_restoration_checks_lineage_before_replacing_unbind() {
    let fixture = managed_fixture().await;
    let failed = fixture.unbind(fixture.baseline.clone());
    fixture
        .request(ProtectedRouteOperation::Prepare {
            update: failed.clone(),
        })
        .await
        .unwrap();
    fixture.apply_unbind(&failed).await.unwrap();
    let mut restored = fixture.baseline.clone();
    restored.snapshot.revision = OutboundRevision::fresh();
    let update = ProtectedRouteUpdate {
        attempt_id: OutboundRevision::fresh(),
        predecessor: failed.candidate.clone(),
        candidate: restored.clone(),
    };
    let mut forged = failed.clone();
    forged.attempt_id = OutboundRevision::fresh();
    assert!(
        fixture
            .request(ProtectedRouteOperation::PrepareRestore {
                update: update.clone(),
                failed: forged
            })
            .await
            .is_err()
    );
    assert!(
        fixture
            .request(ProtectedRouteOperation::Prepare {
                update: update.clone()
            })
            .await
            .is_err()
    );
    let prepared = fixture
        .request(ProtectedRouteOperation::PrepareRestore {
            update: update.clone(),
            failed: failed.clone(),
        })
        .await
        .unwrap();
    assert_eq!(prepared.pending_attempt, Some(update.attempt_id.clone()));
    assert_eq!(prepared.unbind_settlement, Some(failed.attempt_id.clone()));
    assert!(
        fixture
            .request(ProtectedRouteOperation::SettleUnbind {
                attempt_id: failed.attempt_id.clone(),
                revision: failed.candidate.snapshot.revision.clone(),
            })
            .await
            .is_err()
    );
    let receipt = fixture
        .request(ProtectedRouteOperation::Apply {
            attempt_id: update.attempt_id,
            route: restored.binding.clone().map(material),
            predecessor_route: None,
        })
        .await
        .unwrap();
    assert_eq!(receipt.durable, restored);
    assert_eq!(receipt.installed, Some(restored));
    assert!(receipt.pending_attempt.is_none());
    assert!(receipt.unbind_settlement.is_none());
    assert!(fixture.apply_unbind(&failed).await.is_err());
}

#[tokio::test]
async fn protected_outbound_rollback_requires_durable_same_epoch_proof() {
    for reject_restoration in [false, true] {
        let fixture = managed_fixture().await;
        let bx = &fixture.start.box_impl;
        let update = fixture.unbind(fixture.baseline.clone());
        let db = rusqlite::Connection::open(bx.runtime.layout.db_dir().join("boxlite.db")).unwrap();
        db.execute_batch(&format!(
            "CREATE TRIGGER fail_candidate BEFORE UPDATE ON box_state
             WHEN json_extract(NEW.json, '$.outbound_control.revision') = '{}'
             BEGIN SELECT RAISE(ABORT, 'candidate persistence failed'); END;",
            update.candidate.snapshot.revision,
        ))
        .unwrap();
        if reject_restoration {
            db.execute_batch(
                "CREATE TRIGGER fail_restore BEFORE UPDATE ON box_state
                 WHEN json_extract(NEW.json, '$.protected_boot.outbound.rollback') IS NOT NULL
                 BEGIN SELECT RAISE(ABORT, 'restored persistence failed'); END;",
            )
            .unwrap();
        }
        fixture
            .request(ProtectedRouteOperation::Prepare {
                update: update.clone(),
            })
            .await
            .unwrap();
        assert!(matches!(
            fixture.apply_unbind(&update).await,
            Err(BoxliteError::Database(_))
        ));
        let readback = fixture
            .request(ProtectedRouteOperation::Inspect)
            .await
            .unwrap();
        if reject_restoration {
            assert_eq!(readback.pending_attempt.as_ref(), Some(&update.attempt_id));
            assert!(readback.rollback.is_none());
            assert_ne!(readback.installed.as_ref(), Some(&readback.durable));
            assert!(
                fixture
                    .request(ProtectedRouteOperation::Prepare {
                        update: fixture.unbind(readback.durable),
                    })
                    .await
                    .is_err()
            );
            continue;
        }
        let proof = readback.rollback.unwrap();
        assert_eq!(
            readback.epoch,
            fixture.baseline.binding.as_ref().unwrap().epoch
        );
        assert_eq!(proof.failed, update);
        assert_eq!(proof.restored, readback.durable);
        assert_eq!(readback.installed, Some(proof.restored.clone()));
        assert_eq!(proof.restored.binding, fixture.baseline.binding);
        assert_eq!(
            proof.restored.snapshot.policy,
            fixture.baseline.snapshot.policy
        );
        assert_ne!(
            proof.restored.snapshot.revision,
            fixture.baseline.snapshot.revision
        );
        assert!(readback.pending_attempt.is_none());
        assert!(
            fixture
                .request(ProtectedRouteOperation::Prepare {
                    update: update.clone()
                })
                .await
                .is_err()
        );
        assert!(fixture.apply_unbind(&update).await.is_err());

        let next = fixture.unbind(proof.restored);
        fixture
            .request(ProtectedRouteOperation::Prepare {
                update: next.clone(),
            })
            .await
            .unwrap();
        assert_eq!(
            fixture.apply_unbind(&next).await.unwrap().durable,
            next.candidate
        );
    }
}
