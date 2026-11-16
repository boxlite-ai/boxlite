//! Coordinator cancellation at the real gvproxy ACK / SQLite commit boundary.
//! The VM and guest session are fixtures; the backend, IPC and store are real.
use super::*;
use crate::net::gvproxy::{GvproxyBackend, GvproxyInstance, control_socket_path};
use crate::net::{
    OutboundApplicationState, OutboundReplaceOutcome, OutboundReplacement, OutboundRevision,
    OutboundSnapshot,
};
use crate::runtime::backend::BoxNetworkBackend;
use crate::runtime::options::{NetworkMode, OutboundNetworkConfig};

fn candidate(revision: &str, mode: NetworkMode) -> OutboundSnapshot {
    OutboundSnapshot {
        policy: OutboundNetworkConfig {
            mode,
            ..Default::default()
        },
        revision: OutboundRevision::parse(revision).unwrap(),
    }
}

fn reacquire(original: &BoxImpl) -> BoxImpl {
    BoxImpl::new(
        original.config.clone(),
        original
            .runtime
            .box_manager
            .update_box(original.id())
            .unwrap(),
        original.runtime.clone(),
        original.runtime.shutdown_token.child_token(),
    )
}

fn attach_test_vm(bx: &BoxImpl, original: &BoxImpl, backend: &GvproxyBackend) {
    let live = LiveState::new(
        Box::new(InfoTestHandler(0)),
        original.live.get().unwrap().guest_session.clone(),
        Some(Box::new(backend.clone())),
        None,
        BoxMetricsStorage::new(),
        Disk::new(
            bx.layout.disks_dir().join("recovered.qcow2"),
            DiskFormat::Qcow2,
            true,
        ),
        None,
        #[cfg(target_os = "linux")]
        None,
    );
    assert!(bx.live.set(live).is_ok());
}

async fn wait_for_cleanup(config: &NetworkBackendConfig) {
    let control = control_socket_path(&config.socket_path);
    tokio::time::timeout(Duration::from_secs(5), async {
        while config.socket_path.exists() || control.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("backend sockets must be removed before restart");
}

async fn recovery_after_ack(restart_backend: bool) {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let original = &fixture.box_impl;
    original.layout.prepare().unwrap();
    let config = NetworkBackendConfig {
        outbound_disabled: false,
        socket_path: original.layout.net_backend_socket_path(),
        allow_net: vec![],
        secrets: vec![],
        ca_dir: original.layout.ca_dir(),
        rate_limit: Default::default(),
    };
    let backend = GvproxyBackend::from_config(&config);
    let initial = original.outbound_snapshot().await.unwrap();
    let (instance, _) =
        GvproxyInstance::from_config_with_revision(&backend.spec(), &initial.revision).unwrap();
    let entered = Arc::new(Notify::new());
    let mut coordinator = reacquire(original);
    coordinator.outbound_before_persist = Some(entered.clone());
    attach_test_vm(&coordinator, original, &backend);
    let applied = candidate("acknowledged-b", NetworkMode::Disabled);
    let mut update = Box::pin(coordinator.replace_outbound_snapshot(
        OutboundReplacement::new(initial.revision.clone(), applied.clone()).unwrap(),
    ));
    tokio::select! {
        _ = entered.notified() => {}
        result = &mut update => panic!("update passed the crash point: {result:?}"),
        _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("backend ACK was not observed"),
    }
    let observed = backend.outbound_snapshot().await.unwrap();
    assert_eq!(
        observed.application_state,
        OutboundApplicationState::Confirmed
    );
    assert_eq!(observed.snapshot, applied);
    assert_eq!(coordinator.outbound_snapshot().await.unwrap(), initial);
    drop(update); // Lose the coordinator before confirm_outbound; releases the Box lock.
    drop(coordinator);

    let instance = if restart_backend {
        drop(instance);
        wait_for_cleanup(&config).await;
        GvproxyInstance::from_config_with_revision(&backend.spec(), &initial.revision)
            .unwrap()
            .0
    } else {
        instance
    };
    let recovered = reacquire(original);
    assert!(!recovered.live.initialized());
    let status = recovered.outbound_status().await.unwrap();
    assert!(
        !recovered.live.initialized(),
        "status must not boot or attach a VM"
    );
    assert_eq!(status.persisted, initial);
    assert_eq!(status.pending_revision, Some(applied.revision.clone()));
    assert_eq!(
        status.application_state,
        OutboundApplicationState::Uncertain
    );
    let observed = status.observed.unwrap();
    assert_eq!(
        observed.application_state,
        OutboundApplicationState::Confirmed
    );
    assert_eq!(
        observed.snapshot,
        if restart_backend {
            initial.clone()
        } else {
            applied.clone()
        }
    );
    let pending = recovered
        .runtime
        .box_manager
        .outbound_control(recovered.id())
        .unwrap()
        .unwrap();
    assert_eq!(
        pending.pending.unwrap().candidate,
        applied,
        "GET must retain recovery evidence"
    );

    attach_test_vm(&recovered, original, &backend);
    let next = candidate("new-intent-c", NetworkMode::Enabled);
    let conditional = recovered
        .replace_outbound_snapshot(
            OutboundReplacement::new(initial.revision.clone(), next.clone()).unwrap(),
        )
        .await;
    if restart_backend {
        assert!(
            conditional.is_err(),
            "old live revision does not prove the pending attempt completed"
        );
        assert_eq!(
            recovered
                .replace_outbound_control(next.clone(), None)
                .await
                .unwrap(),
            OutboundReplaceOutcome::Applied
        );
    } else {
        assert_eq!(
            conditional.unwrap(),
            OutboundReplaceOutcome::PreconditionFailed
        );
        assert_eq!(recovered.outbound_snapshot().await.unwrap(), applied);
    }
    let status = recovered.outbound_status().await.unwrap();
    assert_eq!(
        status.application_state,
        OutboundApplicationState::Confirmed
    );
    assert!(status.pending_revision.is_none());
    assert_eq!(
        status.persisted,
        if restart_backend { next } else { applied }
    );
    assert_eq!(status.observed.unwrap().snapshot, status.persisted);
    drop(instance);
    wait_for_cleanup(&config).await;
}

#[tokio::test]
async fn outbound_recovery_after_ack_with_surviving_backend() {
    recovery_after_ack(false).await;
}

#[tokio::test]
async fn outbound_recovery_after_ack_with_restarted_backend() {
    recovery_after_ack(true).await;
}
