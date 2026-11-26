use super::*;
use crate::litebox::protected_boot::{
    BootRecoveryGate, ProtectedBootAttempt, ProtectedBootKey, ProtectedBootOutcome,
    ProtectedBootReceipt, ProtectedBootRequest, ProtectedBootState, ProtectedEpochRequest,
    ProtectedGateRequest, ProtectedRemoveRequest,
};
use crate::litebox::protected_outbound::{
    ProtectedRoutePending, ProtectedRouteSnapshot, ProtectedRouteUpdate,
};
use crate::net::{OutboundReplacement, OutboundRevision, OutboundSnapshot};
use crate::runtime::options::{NetworkMode, NetworkSpec, OutboundNetworkConfig};

#[tokio::test]
#[allow(deprecated)]
async fn protected_v2_retirement_requires_exact_terminated_process() {
    let home = TempDir::new_in("/tmp").unwrap();
    let options = BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        ..Default::default()
    };
    let runtime = RuntimeImpl::new_for_test(options.clone()).unwrap();
    let bx = runtime
        .create(
            BoxOptions {
                network: NetworkSpec::Disabled,
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let id = bx.id().clone();
    let key = ProtectedBootKey {
        runner_id: OutboundRevision::fresh(),
        attempt_id: OutboundRevision::fresh(),
        registration_id: None,
        registration_revision: None,
        policy: bx.network().outbound_snapshot().await.unwrap(),
    };
    let epoch = OutboundRevision::fresh();
    let generation = OutboundRevision::fresh();
    let request = || ProtectedEpochRequest {
        key: key.clone(),
        epoch: epoch.clone(),
        generation: generation.clone(),
    };
    let mut process = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let start_time = crate::util::process_start_time(process.id()).unwrap();
    let mut state = runtime.box_manager.update_box(&id).unwrap();
    state.set_status(BoxStatus::Stopped);
    runtime.box_manager.save_box(&id, &state).unwrap();
    runtime
        .box_manager
        .save_protected_boot(
            &id,
            &ProtectedBootState {
                active: Some(ProtectedBootAttempt {
                    key: key.clone(),
                    epoch: epoch.clone(),
                    spawning: false,
                    owner: Some(crate::util::PidRecord {
                        pid: process.id(),
                        start_time: Some(start_time),
                    }),
                    confirmed: true,
                    recovery_gate: Some(BootRecoveryGate {
                        generation: generation.clone(),
                        seal_requested: false,
                        seal_confirmed: false,
                        released: true,
                        evidence: None,
                    }),
                }),
                ..Default::default()
            },
        )
        .unwrap();

    let stop = bx.stop_protected_epoch(request()).await.unwrap_err();
    let live_retire = bx
        .retire_terminated_protected_epoch(request())
        .await
        .unwrap_err();
    process.kill().unwrap();
    process.wait().unwrap();
    assert!(stop.to_string().contains("exact sealed epoch"));
    assert!(live_retire.to_string().contains("cannot prove termination"));
    let wrong_epoch = ProtectedEpochRequest {
        epoch: OutboundRevision::fresh(),
        ..request()
    };
    assert!(
        bx.retire_terminated_protected_epoch(wrong_epoch)
            .await
            .is_err()
    );

    let retired = bx
        .retire_terminated_protected_epoch(request())
        .await
        .unwrap();
    assert_eq!(retired.boot.outcome, ProtectedBootOutcome::Retired);
    assert_eq!(retired.boot.epoch.as_ref(), Some(&epoch));
    assert!(retired.evidence.installed.is_none());

    drop(bx);
    runtime.shutdown_token.cancel();
    drop(runtime);
    let reopened = RuntimeImpl::new_for_test(options).unwrap();
    let bx = reopened.get(id.as_str()).await.unwrap().unwrap();
    let replay = bx
        .retire_terminated_protected_epoch(request())
        .await
        .unwrap();
    assert_eq!(replay.boot, retired.boot);
    assert_eq!(replay.generation, generation);
}

#[tokio::test]
async fn ordinary_box_name_does_not_require_protected_launch() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        ..Default::default()
    })
    .unwrap();
    let name = "protected-allocation-0123456789abcdef0123456789abcdef";
    let options = BoxOptions {
        rootfs: RootfsSpec::RootfsPath(home.path().join("missing-rootfs").display().to_string()),
        ..Default::default()
    };
    let bx = runtime.create(options, Some(name.into())).await.unwrap();
    let error = bx.start().await.unwrap_err();
    assert!(
        error.to_string().contains("missing-rootfs"),
        "ordinary start should reach its local rootfs selection, got {error}"
    );
}

#[tokio::test]
#[allow(deprecated)]
async fn protected_boot_removal_keeps_exact_retry_proof_across_runtime_reopen() {
    let home = TempDir::new_in("/tmp").unwrap();
    let options = BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    };
    let runtime = RuntimeImpl::new_for_test(options.clone()).unwrap();
    let name = crate::BoxID::parse("cloud-protected-fixture").unwrap();
    let box_options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        network: NetworkSpec::Disabled,
        auto_remove: false,
        ..Default::default()
    };
    let bx = runtime
        .create(box_options.clone(), Some(name.to_string()))
        .await
        .unwrap();
    let id = bx.id().clone();
    let key = ProtectedBootKey {
        runner_id: OutboundRevision::fresh(),
        attempt_id: OutboundRevision::fresh(),
        registration_id: None,
        registration_revision: None,
        policy: bx.network().outbound_snapshot().await.unwrap(),
    };
    let epoch = OutboundRevision::fresh();
    let retired = ProtectedBootReceipt {
        key: key.clone(),
        epoch: Some(epoch.clone()),
        outcome: ProtectedBootOutcome::Retired,
    };
    runtime
        .box_manager
        .save_protected_boot(
            &id,
            &ProtectedBootState {
                retired: vec![retired.clone()],
                removable_attempt: Some(key.attempt_id.clone()),
                ..Default::default()
            },
        )
        .unwrap();

    assert!(runtime.remove(id.as_str(), true).is_err());
    let wrong = ProtectedRemoveRequest {
        key: key.clone(),
        epoch: Some(OutboundRevision::fresh()),
        runner_box_name: None,
        exact_native_id: false,
    };
    assert!(runtime.remove_retired_protected(&id, &wrong).is_err());
    assert!(runtime.box_manager.box_by_id(&id).unwrap().is_some());
    let request = ProtectedRemoveRequest {
        key,
        epoch: Some(epoch),
        runner_box_name: None,
        exact_native_id: false,
    };
    assert_eq!(
        runtime.remove_retired_protected(&name, &request).unwrap(),
        retired
    );
    assert!(runtime.box_manager.box_by_id(&id).unwrap().is_none());
    drop(bx);
    runtime.shutdown_token.cancel();
    drop(runtime);
    let reopened = RuntimeImpl::new_for_test(options).unwrap();
    assert_eq!(
        reopened.remove_retired_protected(&name, &request).unwrap(),
        retired
    );
    assert!(reopened.remove_retired_protected(&name, &wrong).is_err());
    let new_box = reopened
        .create(box_options, Some(name.to_string()))
        .await
        .unwrap();
    assert_ne!(new_box.id(), &id);
    assert_eq!(
        reopened.remove_retired_protected(&name, &request).unwrap(),
        retired
    );
    assert!(
        reopened
            .box_manager
            .box_by_id(new_box.id())
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
#[allow(deprecated)]
async fn protected_boot_retirement_refuses_ineligible_boxes_without_changing_egress() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    for (network, auto_remove) in [
        (NetworkSpec::default(), false),
        (NetworkSpec::Disabled, true),
    ] {
        let bx = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    network,
                    auto_remove,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        let key = ProtectedBootKey {
            runner_id: OutboundRevision::fresh(),
            attempt_id: OutboundRevision::fresh(),
            registration_id: Some(OutboundRevision::fresh()),
            registration_revision: Some(OutboundRevision::fresh()),
            policy: bx.network().outbound_snapshot().await.unwrap(),
        };
        let before = key.policy.clone();
        let retirement = bx.retire_protected_boot(key).await;

        assert!(!bx.has_protected_boot().await.unwrap());
        assert_eq!(bx.network().outbound_snapshot().await.unwrap(), before);
        assert!(matches!(retirement, Err(BoxliteError::InvalidState(_))));
    }
}

#[tokio::test]
#[allow(deprecated)]
async fn protected_boot_gate_retirement_requires_durable_seal() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    let bx = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                network: NetworkSpec::Disabled,
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let key = ProtectedBootKey {
        runner_id: OutboundRevision::fresh(),
        attempt_id: OutboundRevision::fresh(),
        registration_id: Some(OutboundRevision::fresh()),
        registration_revision: Some(OutboundRevision::parse("3").unwrap()),
        policy: bx.network().outbound_snapshot().await.unwrap(),
    };
    let epoch = OutboundRevision::fresh();
    let generation = OutboundRevision::fresh();
    let record = ProtectedBootState {
        active: Some(ProtectedBootAttempt {
            key: key.clone(),
            epoch: epoch.clone(),
            spawning: false,
            owner: None,
            confirmed: true,
            recovery_gate: Some(BootRecoveryGate {
                generation: generation.clone(),
                seal_requested: true,
                seal_confirmed: false,
                released: false,
                evidence: None,
            }),
        }),
        retired: vec![],
        outbound: Default::default(),
        removable_attempt: None,
        terminated_epoch: None,
    };
    runtime
        .box_manager
        .save_protected_boot(bx.id(), &record)
        .unwrap();

    let release = bx
        .change_protected_boot_gate(
            ProtectedGateRequest {
                key: key.clone(),
                epoch: epoch.clone(),
                generation,
                outbound: None,
            },
            false,
        )
        .await
        .unwrap_err();
    assert!(release.to_string().contains("gate is retired"));
    let retirement = bx.retire_protected_boot(key.clone()).await.unwrap_err();
    assert!(retirement.to_string().contains("retirement is unconfirmed"));
    let mut saved = runtime
        .box_manager
        .protected_boot(bx.id())
        .unwrap()
        .unwrap();
    let active = saved.active.as_mut().unwrap();
    assert_eq!(active.epoch, epoch);
    assert!(saved.retired.is_empty());
    active.recovery_gate.as_mut().unwrap().seal_confirmed = true;
    let current = ProtectedRouteSnapshot {
        snapshot: key.policy.clone(),
        binding: active.binding(),
    };
    let mut candidate = current.clone();
    candidate.snapshot.revision = OutboundRevision::fresh();
    saved.outbound.pending = Some(ProtectedRoutePending {
        update: ProtectedRouteUpdate {
            attempt_id: OutboundRevision::fresh(),
            predecessor: current,
            candidate,
        },
        dispatched: true,
        restoration: None,
    });
    saved.outbound.unbind_settlement = Some(OutboundRevision::fresh());
    runtime
        .box_manager
        .save_protected_boot(bx.id(), &saved)
        .unwrap();
    let retired = bx.retire_protected_boot(key).await.unwrap();
    assert_eq!(retired.epoch, Some(epoch));
    let saved = runtime
        .box_manager
        .protected_boot(bx.id())
        .unwrap()
        .unwrap();
    assert!(saved.outbound.pending.is_none());
    assert!(saved.outbound.unbind_settlement.is_none());
    assert_eq!(saved.retired, vec![retired]);
}

#[tokio::test]
#[allow(deprecated)]
async fn protected_boot_retirement_survives_orphan_recovery_and_blocks_replay() {
    let home = TempDir::new_in("/tmp").unwrap();
    let options = BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    };
    let runtime = RuntimeImpl::new_for_test(options.clone()).unwrap();
    let bx = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                network: NetworkSpec::Disabled,
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let id = bx.id().clone();
    let mut stale = runtime.box_manager.update_box(&id).unwrap();
    let key = ProtectedBootKey {
        runner_id: OutboundRevision::fresh(),
        attempt_id: OutboundRevision::fresh(),
        registration_id: Some(OutboundRevision::fresh()),
        registration_revision: Some(OutboundRevision::parse("7").unwrap()),
        policy: OutboundSnapshot {
            policy: OutboundNetworkConfig::default(),
            revision: OutboundRevision::fresh(),
        },
    };
    let receipt = bx.retire_protected_boot(key.clone()).await.unwrap();
    assert_eq!(receipt.outcome, ProtectedBootOutcome::Retired);
    assert_eq!(receipt.epoch, None);
    // Model a crash before the ordinary state caught up to the durable retirement.
    let (config, _) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
    assert!(!config.box_home.exists());
    stale.set_status(BoxStatus::Running);
    runtime.box_manager.save_box(&id, &stale).unwrap();
    drop(bx);
    runtime.shutdown_token.cancel();
    drop(runtime);
    let runtime = RuntimeImpl::new_for_test(options).unwrap();
    let bx = runtime
        .get(id.as_str())
        .await
        .unwrap()
        .expect("retain protected Box during orphan recovery");
    assert!(bx.has_protected_boot().await.unwrap());
    assert_eq!(bx.protected_boot_receipt(&key).await.unwrap(), receipt);
    let error = bx
        .bootstrap_protected(ProtectedBootRequest {
            key,
            scheme: Some("https".into()),
            host: Some("proxy.example.com".into()),
            port: Some(443),
            doh_url: "https://resolver.example.com/dns-query".into(),
            doh_address: "1.1.1.1:443".parse().unwrap(),
            credential: None,
            recovery_generation: None,
            restart: false,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("attempt is retired"));
    assert!(
        bx.start()
            .await
            .unwrap_err()
            .to_string()
            .contains("requires an exact protected launch")
    );
    let policy = OutboundNetworkConfig::default();
    let before = bx.network().outbound_snapshot().await.unwrap();
    assert_eq!(before.policy.mode, NetworkMode::Disabled);
    let replacement = OutboundReplacement::new(
        before.revision.clone(),
        OutboundSnapshot {
            policy: policy.clone(),
            revision: OutboundRevision::fresh(),
        },
    )
    .unwrap();
    assert!(
        bx.network()
            .update_outbound(policy)
            .await
            .unwrap_err()
            .to_string()
            .contains("complete authorized route")
    );
    assert!(
        bx.network()
            .replace_outbound_snapshot(replacement)
            .await
            .unwrap_err()
            .to_string()
            .contains("complete authorized route")
    );
    assert_eq!(bx.network().outbound_snapshot().await.unwrap(), before);
    assert_eq!(
        runtime.box_manager.update_box(&id).unwrap().status,
        BoxStatus::Stopped
    );
}
