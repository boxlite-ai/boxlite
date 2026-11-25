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

#[tokio::test]
async fn outbound_complete_round_trips_through_sqlite_and_real_gvproxy_restart() {
    use crate::net::{CompleteOutboundPolicy, OutboundAdmission, OutboundBootstrap};

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
    let (instance, _) =
        GvproxyInstance::from_config_with_revision(&backend.spec(), &OutboundRevision::initial())
            .unwrap();
    let box_impl = reacquire(original);
    attach_test_vm(&box_impl, original, &backend);

    let before = box_impl.complete_outbound_status().await.unwrap();
    let padded_prefix = CompleteOutboundPolicy {
        deny_net: Some(vec!["192.0.2.0/024".into()]),
        ..Default::default()
    };
    let rejection = box_impl
        .replace_complete_outbound(padded_prefix, OutboundRevision::fresh(), None)
        .await;
    let after = box_impl.complete_outbound_status().await.unwrap();
    assert_eq!(
        after, before,
        "rejected syntax must leave no pending attempt"
    );
    assert!(matches!(rejection, Err(BoxliteError::InvalidArgument(_))));

    let oversized_legacy = CompleteOutboundPolicy {
        allow_net: vec![format!("{}example.com", " ".repeat(64 << 10))],
        ..Default::default()
    };
    let rejection = box_impl
        .replace_complete_outbound(oversized_legacy, OutboundRevision::fresh(), None)
        .await;
    let after = box_impl.complete_outbound_status().await.unwrap();
    assert_eq!(
        after, before,
        "an oversized legacy request must leave no pending attempt"
    );
    assert!(matches!(rejection, Err(BoxliteError::InvalidArgument(_))));

    let next = OutboundRevision::parse("complete-policy").unwrap();
    let request = CompleteOutboundPolicy {
        allow_net: vec![" EXAMPLE.com:443 ".into()],
        deny_net: Some(vec![format!("{}192.0.2.7/24:443", " ".repeat(64 << 10))]),
        ..Default::default()
    };
    let disk_locker = box_impl.disk_locker().unwrap();
    let copy_admission = crate::lock::LockGuard::new_async(disk_locker.as_ref()).await;
    let mut replacement = Box::pin(box_impl.replace_complete_outbound(
        request,
        next.clone(),
        Some(OutboundRevision::initial()),
    ));
    let while_copying = tokio::time::timeout(Duration::from_millis(500), &mut replacement).await;
    assert!(
        while_copying.is_err(),
        "policy replacement ran during copy admission: {while_copying:?}"
    );
    assert_eq!(box_impl.complete_outbound_status().await.unwrap(), before);
    drop(copy_admission);
    assert_eq!(replacement.await.unwrap(), OutboundReplaceOutcome::Applied);
    let installed = box_impl.complete_outbound_status().await.unwrap();
    assert_eq!(
        installed.application_state,
        OutboundApplicationState::Confirmed
    );
    assert_eq!(installed.persisted.revision, next);
    assert_eq!(
        installed.persisted.admission,
        OutboundAdmission::ExtendedIpv4
    );
    assert_eq!(installed.persisted.policy.allow_net, ["example.com:443"]);
    assert_eq!(installed.persisted.policy.deny_net, ["192.0.2.0/24:443"]);
    assert!(matches!(
        box_impl.outbound_snapshot().await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert!(box_impl.info_from_store().unwrap().network.is_none());

    let reacquired = reacquire(original);
    assert_eq!(
        reacquired.complete_outbound_snapshot().await.unwrap(),
        installed.persisted
    );
    drop(instance);
    wait_for_cleanup(&config).await;
    let launch = OutboundBootstrap {
        requirements: installed.persisted.requirements(),
        snapshot: installed.persisted.clone(),
    };
    let (instance, _) = GvproxyInstance::from_complete_config(&backend.spec(), &launch).unwrap();
    attach_test_vm(&reacquired, original, &backend);
    assert_eq!(
        reacquired.complete_outbound_status().await.unwrap(),
        installed
    );

    let clear = CompleteOutboundPolicy {
        deny_net: Some(vec![]),
        ..Default::default()
    };
    let clear_revision = OutboundRevision::parse("cleared-policy").unwrap();
    assert_eq!(
        reacquired
            .replace_complete_outbound(clear, clear_revision, Some(next))
            .await
            .unwrap(),
        OutboundReplaceOutcome::Applied
    );
    let cleared = reacquired.complete_outbound_status().await.unwrap();
    assert_eq!(
        cleared.application_state,
        OutboundApplicationState::Confirmed
    );
    assert!(cleared.persisted.policy.deny_net.is_empty());
    assert_eq!(cleared.persisted.admission, OutboundAdmission::ExtendedIpv4);
    drop(instance);
    wait_for_cleanup(&config).await;
}

#[tokio::test]
async fn outbound_complete_published_port_survives_fresh_runtime_process() {
    use crate::net::constants::GUEST_IP;
    use crate::net::{CompleteOutboundPolicy, TransportProtocol};

    const READER_HOME: &str = "BOXLITE_TEST_PUBLISHED_PORT_READER_HOME";
    const READER_BOX: &str = "BOXLITE_TEST_PUBLISHED_PORT_READER_BOX";
    const READER_PORT: &str = "BOXLITE_TEST_PUBLISHED_PORT_READER_PORT";
    const GUEST_PORT: u16 = 3000;
    let runtime_at = |home_dir| {
        RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir,
            image_registries: vec![],
            ..Default::default()
        })
        .unwrap()
    };
    if let Some(home) = std::env::var_os(READER_HOME) {
        let runtime = runtime_at(home.into());
        let id = std::env::var(READER_BOX).unwrap();
        let host_port = std::env::var(READER_PORT).unwrap().parse().unwrap();
        let bx = runtime.get(&id).await.unwrap().unwrap();
        assert!(bx.info().await.unwrap().network.is_none());
        assert_eq!(
            bx.network().published_ports().await.unwrap(),
            Some(vec![PublishedPort {
                guest_port: GUEST_PORT,
                host_ip: "127.0.0.1".into(),
                host_port,
                protocol: PortProtocol::Tcp,
            }])
        );
        return;
    }

    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = runtime_at(home.path().to_owned());
    let handle = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                detach: true,
                auto_delete: Some(0),
                ports: vec![PortSpec {
                    guest_port: GUEST_PORT,
                    host_ip: Some("127.0.0.1".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let id = handle.id().clone();
    let (config, mut state) = runtime
        .box_manager
        .lookup_box(id.as_str())
        .unwrap()
        .unwrap();
    drop(handle);
    let shim = ChildGuard(
        std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .unwrap(),
    );
    let pid = shim.0.id();
    state.status = BoxStatus::Running;
    state.pid = Some(pid);
    state.mark_started();
    runtime.box_manager.save_box(&id, &state).unwrap();
    let bx = BoxImpl::new(
        config,
        state,
        runtime.clone(),
        runtime.shutdown_token.child_token(),
    );
    bx.layout.prepare().unwrap();
    PidFileWriter::at(&bx.layout.pid_file_path())
        .unwrap()
        .write_shim(&ShimPidRecord::with_runtime_port_control(PidRecord {
            pid,
            start_time: Some(crate::util::process_start_time(pid).unwrap()),
        }))
        .unwrap();

    let config = NetworkBackendConfig {
        outbound_disabled: false,
        socket_path: bx.layout.net_backend_socket_path(),
        allow_net: vec![],
        secrets: vec![],
        ca_dir: bx.layout.ca_dir(),
        rate_limit: Default::default(),
    };
    let backend = GvproxyBackend::from_config(&config);
    let (instance, _) =
        GvproxyInstance::from_config_with_revision(&backend.spec(), &OutboundRevision::initial())
            .unwrap();
    let assigned = backend
        .expose(
            "127.0.0.1:0",
            &format!("{GUEST_IP}:{GUEST_PORT}"),
            TransportProtocol::Tcp,
        )
        .await
        .unwrap();
    let before = bx.published_ports().await.unwrap().unwrap();
    assert_eq!(before.len(), 1);
    assert_eq!(assigned.local, format!("127.0.0.1:{}", before[0].host_port));
    let (guest, server) = start_stub_guest(Arc::new(StartGate::default())).await;
    let live = LiveState::new(
        Box::new(InfoTestHandler(pid)),
        guest,
        Some(Box::new(backend.clone())),
        None,
        BoxMetricsStorage::new(),
        Disk::new(
            bx.layout.disks_dir().join("reader.qcow2"),
            DiskFormat::Qcow2,
            true,
        ),
        None,
        #[cfg(target_os = "linux")]
        None,
    );
    assert!(bx.live.set(live).is_ok());
    assert_eq!(
        bx.replace_complete_outbound(
            CompleteOutboundPolicy {
                deny_net: Some(vec!["192.0.2.0/24:443".into()]),
                ..Default::default()
            },
            OutboundRevision::fresh(),
            Some(OutboundRevision::initial()),
        )
        .await
        .unwrap(),
        OutboundReplaceOutcome::Applied,
    );
    drop(bx);
    drop(runtime);
    server.abort();

    let module = module_path!().split_once("::").unwrap().1;
    let test = format!("{module}::outbound_complete_published_port_survives_fresh_runtime_process");
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &test])
            .env(READER_HOME, home.path())
            .env(READER_BOX, id.as_str())
            .env(READER_PORT, before[0].host_port.to_string())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(backend.list_forwards().await.unwrap(), [assigned]);
    drop(instance);
    wait_for_cleanup(&config).await;
}

#[tokio::test]
async fn outbound_complete_recovery_after_restoration_ack() {
    use crate::net::{CompleteOutboundPolicy, OutboundAdmission, OutboundBootstrap};

    for restart_backend in [false, true] {
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
        let (instance, _) = GvproxyInstance::from_config_with_revision(
            &backend.spec(),
            &OutboundRevision::initial(),
        )
        .unwrap();
        let mut predecessor = candidate("legacy-predecessor", NetworkMode::Enabled);
        predecessor.policy.allow_net = (0..11)
            .map(|index| format!("host{index}.example"))
            .collect();
        let flat_bytes = serde_json::to_vec(&predecessor.policy).unwrap().len();
        predecessor.policy.allow_net[0].insert_str(0, &" ".repeat(65_500 - flat_bytes));
        let replacement =
            OutboundReplacement::new(OutboundRevision::initial(), predecessor.clone()).unwrap();
        assert_eq!(
            backend
                .replace_outbound_snapshot(&replacement)
                .await
                .unwrap(),
            OutboundReplaceOutcome::Applied
        );
        original
            .runtime
            .box_manager
            .save_outbound_control(
                original.id(),
                Some(&crate::litebox::box_impl::outbound::OutboundControl {
                    revision: predecessor.revision.clone(),
                    pending: None,
                }),
                Some(&predecessor.policy),
            )
            .unwrap();
        let coordinator = reacquire(original);
        attach_test_vm(&coordinator, original, &backend);
        let db = original.runtime.box_manager.db();
        db.conn()
            .execute_batch(
                "CREATE TRIGGER reject_publication BEFORE UPDATE ON box_state
             WHEN json_extract(NEW.json, '$.outbound_policy.outbound_v1.pending') IS NULL
             BEGIN SELECT RAISE(ABORT, 'policy publication interrupted'); END;",
            )
            .unwrap();

        let request = CompleteOutboundPolicy {
            deny_net: Some(vec!["192.0.2.0/24:443".into()]),
            ..Default::default()
        };
        let result = coordinator
            .replace_complete_outbound(
                request,
                OutboundRevision::parse("applied-candidate").unwrap(),
                None,
            )
            .await;
        assert!(
            matches!(result, Err(BoxliteError::Database(_))),
            "{result:?}"
        );
        db.conn()
            .execute_batch("DROP TRIGGER reject_publication")
            .unwrap();
        let (_, control) = coordinator.read_complete_control().unwrap();
        let attempt = control.pending.as_ref().unwrap();
        let restoration = attempt.restoration.as_ref().unwrap();
        assert_eq!(restoration.admission, OutboundAdmission::Legacy);
        assert_eq!(restoration.legacy().unwrap().policy, predecessor.policy);
        assert_ne!(restoration.revision, control.committed.revision);
        let (observed, _) = backend.complete_outbound_snapshot().await.unwrap();
        assert_eq!(&observed.snapshot, restoration);
        assert_eq!(
            observed.application_state,
            OutboundApplicationState::Confirmed
        );
        drop(coordinator);

        let instance = if restart_backend {
            drop(instance);
            wait_for_cleanup(&config).await;
            let bootstrap = OutboundBootstrap {
                snapshot: control.committed.clone(),
                requirements: control.requirements(),
            };
            GvproxyInstance::from_complete_config(&backend.spec(), &bootstrap)
                .unwrap()
                .0
        } else {
            instance
        };
        let reacquired = reacquire(original);
        attach_test_vm(&reacquired, original, &backend);

        let status = reacquired.complete_outbound_status().await.unwrap();
        assert_eq!(
            status.application_state,
            OutboundApplicationState::Uncertain
        );
        assert_eq!(status.persisted, control.committed);
        assert_eq!(
            status.pending_revision.as_ref(),
            Some(&restoration.revision)
        );
        assert_eq!(
            status.observed.unwrap().snapshot,
            if restart_backend {
                control.committed.clone()
            } else {
                restoration.clone()
            }
        );
        let result = reacquired
            .replace_complete_outbound(
                CompleteOutboundPolicy::default(),
                OutboundRevision::fresh(),
                Some(control.committed.revision.clone()),
            )
            .await;
        if restart_backend {
            assert!(matches!(result, Err(BoxliteError::InvalidState(_))));
            assert_eq!(
                reacquired.complete_outbound_snapshot().await.unwrap(),
                control.committed
            );
        } else {
            assert_eq!(result.unwrap(), OutboundReplaceOutcome::PreconditionFailed);
            assert_eq!(
                &reacquired.complete_outbound_snapshot().await.unwrap(),
                restoration
            );
        }
        drop(instance);
        wait_for_cleanup(&config).await;
    }
}
