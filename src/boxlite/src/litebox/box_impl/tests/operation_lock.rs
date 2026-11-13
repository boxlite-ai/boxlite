use super::*;
use crate::lock::ReadLockGuard;

#[derive(Clone, Debug, Default)]
struct OutboundPolicyBackend(Arc<std::sync::Mutex<crate::runtime::options::OutboundNetworkConfig>>);

#[async_trait::async_trait]
impl NetworkBackend for OutboundPolicyBackend {
    async fn outbound(&self) -> BoxliteResult<crate::runtime::options::OutboundNetworkConfig> {
        Ok(self.0.lock().unwrap().clone())
    }

    async fn set_outbound(
        &self,
        policy: &crate::runtime::options::OutboundNetworkConfig,
    ) -> BoxliteResult<()> {
        *self.0.lock().unwrap() = policy.clone();
        Ok(())
    }

    fn name(&self) -> &'static str {
        "outbound-test"
    }

    fn spec(&self) -> crate::net::NetworkBackendSpec {
        panic!("an already-booted box must not provision networking")
    }
}

#[tokio::test]
async fn outbound_update_does_not_block_stop_on_pending_container_start() {
    use crate::runtime::backend::BoxNetworkBackend;
    use crate::runtime::options::{NetworkMode, OutboundNetworkConfig};

    let gate = Arc::new(StartGate::default());
    let backend = OutboundPolicyBackend::default();
    let fixture = running_box_for_start_test_with_live(Arc::clone(&gate), |live| {
        live.network = Some(Arc::new(backend.clone()));
    })
    .await;
    let bx = &fixture.box_impl;
    bx.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), gate.entered.acquire())
        .await
        .expect("background start did not enter the guest RPC")
        .unwrap()
        .forget();

    let policy = OutboundNetworkConfig {
        mode: NetworkMode::Disabled,
        ..Default::default()
    };
    let mut update = Box::pin(bx.update_outbound(policy.clone()));
    let updated = futures::poll!(&mut update);
    let stopped = tokio::time::timeout(Duration::from_secs(1), bx.stop()).await;
    drop(update);
    // Clean up the pending RPC even when the old implementation blocks stop.
    bx.shutdown_token.cancel();
    wait_for_background_starts(bx, 1).await;

    assert!(
        matches!(stopped, Ok(Ok(()))),
        "outbound held the lifecycle lock while waiting for Container.Start: {stopped:?}"
    );
    assert!(matches!(updated, std::task::Poll::Ready(Ok(()))));
    assert_eq!(backend.outbound().await.unwrap(), policy);
    assert_eq!(
        bx.runtime
            .box_manager
            .update_box(bx.id())
            .unwrap()
            .outbound_policy,
        Some(policy)
    );
    assert!(matches!(
        bx.update_outbound(OutboundNetworkConfig::default()).await,
        Err(BoxliteError::InvalidState(_))
    ));
}

#[tokio::test]
async fn lifecycle_start_waits_for_entity_lock() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let box_impl = &fixture.box_impl;
    let locker = box_impl
        .runtime
        .lock_manager
        .retrieve(box_impl.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let start = box_impl.start();
    tokio::pin!(start);
    assert!(
        futures::poll!(&mut start).is_pending(),
        "start bypassed the entity lock"
    );
    drop(guard);
    start.await.unwrap();
}

#[tokio::test]
async fn lifecycle_stop_waits_before_cancelling() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let box_impl = &fixture.box_impl;
    let locker = box_impl
        .runtime
        .lock_manager
        .retrieve(box_impl.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let stop = box_impl.stop();
    tokio::pin!(stop);
    assert!(futures::poll!(&mut stop).is_pending());
    assert!(
        !box_impl.shutdown_token.is_cancelled(),
        "stop cancelled a box while another operation owns it"
    );
    drop(guard);
    stop.await.unwrap();
}

#[tokio::test]
async fn lifecycle_remove_refuses_busy_box() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let box_impl = &fixture.box_impl;
    let locker = box_impl
        .runtime
        .lock_manager
        .retrieve(box_impl.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let result = box_impl.runtime.remove_box(box_impl.id(), true);
    let retained = box_impl
        .runtime
        .box_manager
        .box_by_id(box_impl.id())
        .unwrap()
        .is_some();
    drop(guard);
    assert!(
        matches!(result, Err(BoxliteError::InvalidState(_))),
        "remove bypassed the entity lock: {result:?}"
    );
    assert!(retained, "busy box was deleted");
}

#[tokio::test]
async fn lifecycle_implicit_boot_waits_for_entity_lock() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = &fixture.box_impl;
    let locker = bx
        .runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let boot = bx.ensure_booted();
    tokio::pin!(boot);
    assert!(
        futures::poll!(&mut boot).is_pending(),
        "implicit boot bypassed entity lock"
    );
    drop(guard);
    boot.await.unwrap();
}

// Compatibility: removing a stopped box must not change the stale handle's error.
#[tokio::test]
async fn stopped_removed_handle_start_still_reports_stopped() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = &fixture.box_impl;
    bx.stop().await.unwrap();
    bx.runtime.remove_box(bx.id(), false).unwrap();
    assert!(matches!(bx.start().await, Err(BoxliteError::Stopped(_))));
    bx.stop().await.unwrap();
}
async fn check_busy_sync_shutdown(retry_with_drop: bool) {
    use crate::lock::ReadLockGuard;
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let (child, id, pid) = running_box_with_standin(&runtime, false, 17, vec![]);
    let locker = runtime
        .lock_manager
        .retrieve(
            runtime
                .box_manager
                .update_box(&id)
                .unwrap()
                .lock_id
                .unwrap(),
        )
        .unwrap();
    let guard = ReadLockGuard::new(locker.as_ref());
    runtime.shutdown_sync();
    let alive = is_process_alive(pid);
    let persisted = runtime.box_manager.update_box(&id).unwrap();
    drop(guard);
    assert!(alive, "synchronous shutdown bypassed the lifecycle lock");
    assert_eq!(persisted.status, BoxStatus::Running);
    if retry_with_drop {
        drop(runtime);
    } else {
        runtime.shutdown_sync();
        assert_eq!(
            runtime.box_manager.update_box(&id).unwrap().status,
            BoxStatus::Stopped
        );
    }
    let alive_after_retry = is_process_alive(pid);
    drop(child);
    assert!(!alive_after_retry, "deferred sync cleanup was not retried");
}

#[tokio::test]
async fn sync_shutdown_respects_a_busy_lifecycle_reader() {
    check_busy_sync_shutdown(false).await;
}

#[tokio::test]
async fn drop_retries_sync_shutdown_after_the_reader_releases() {
    check_busy_sync_shutdown(true).await;
}

async fn check_async_shutdown_retains_drop_cleanup(cancel_shutdown: bool) {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let (child, id, pid) = running_box_with_standin(&runtime, false, 17, vec![]);
    let litebox = runtime.get(id.as_str()).await.unwrap().unwrap();
    let bx = Arc::clone(&litebox.box_backend)
        .as_any_arc()
        .downcast::<BoxImpl>()
        .expect("local box backend");
    let locker = runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let lifecycle_work = ReadLockGuard::new(locker.as_ref());
    let mut shutdown = Box::pin(runtime.shutdown(Some(1)));
    if cancel_shutdown {
        assert!(futures::poll!(&mut shutdown).is_pending());
        drop(shutdown);
    } else {
        assert!(
            shutdown.await.is_err(),
            "shutdown must time out behind lifecycle work"
        );
    }
    let alive_while_locked = is_process_alive(pid);
    drop(lifecycle_work);
    drop(bx);
    drop(litebox);
    drop(runtime);
    let alive_after_drop = is_process_alive(pid);
    drop(child);

    assert!(
        alive_while_locked,
        "shutdown bypassed active lifecycle work"
    );
    assert!(
        !alive_after_drop,
        "incomplete async shutdown disabled final Drop cleanup"
    );
}

#[tokio::test]
async fn drop_retries_after_async_shutdown_timeout() {
    check_async_shutdown_retains_drop_cleanup(false).await;
}

#[tokio::test]
async fn drop_retries_after_async_shutdown_is_cancelled() {
    check_async_shutdown_retains_drop_cleanup(true).await;
}

#[tokio::test]
async fn stop_retries_after_state_persistence_failure() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = &fixture.box_impl;
    let database =
        rusqlite::Connection::open(bx.runtime.layout.db_dir().join("boxlite.db")).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER reject_stop BEFORE UPDATE ON box_state
             BEGIN SELECT RAISE(ABORT, 'injected stop persistence failure'); END;",
        )
        .unwrap();

    assert!(bx.stop().await.is_err());
    assert_eq!(
        bx.runtime.box_manager.update_box(bx.id()).unwrap().status,
        BoxStatus::Running
    );
    database.execute_batch("DROP TRIGGER reject_stop").unwrap();
    bx.stop()
        .await
        .expect("stop must retry the failed state write");
    assert_eq!(
        bx.runtime.box_manager.update_box(bx.id()).unwrap().status,
        BoxStatus::Stopped
    );
}

#[tokio::test]
async fn sync_shutdown_retries_after_missing_lock_is_restored() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let (child, id, pid) = running_box_with_standin(&runtime, false, 17, vec![]);
    let lock_id = runtime
        .box_manager
        .update_box(&id)
        .unwrap()
        .lock_id
        .unwrap();
    runtime.lock_manager.free(lock_id).unwrap();
    runtime.shutdown_sync();
    assert!(
        is_process_alive(pid),
        "shutdown must not bypass the missing lock"
    );

    runtime.lock_manager.allocate_and_retrieve(lock_id).unwrap();
    runtime.shutdown_sync();
    let alive_after_retry = is_process_alive(pid);
    let status = runtime.box_manager.update_box(&id).unwrap().status;
    drop(child);
    assert!(
        !alive_after_retry,
        "missing lock disabled subsequent cleanup"
    );
    assert_eq!(status, BoxStatus::Stopped);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires BOXLITE_REPRO_ROOTFS and a real VM runtime"]
async fn implicit_job_rechecks_after_admission() {
    use crate::runtime::options::{NetworkSpec, VolumeSpec};

    async fn wait_for_runs(marker: &std::path::Path, expected: usize) {
        tokio::time::timeout(Duration::from_secs(15), async {
            while std::fs::read(marker).unwrap_or_default().len() != expected {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("guest did not publish the expected command execution marker");
    }

    let home = TempDir::new_in("/tmp").unwrap();
    let evidence = home.path().join("evidence");
    std::fs::create_dir(&evidence).unwrap();
    let marker = evidence.join("runs");
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    let handle = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::RootfsPath(
                    std::env::var("BOXLITE_REPRO_ROOTFS").expect("set BOXLITE_REPRO_ROOTFS"),
                ),
                detach: false,
                auto_delete: Some(0),
                network: NetworkSpec::Disabled,
                volumes: vec![VolumeSpec::bind_mount(
                    evidence.to_str().unwrap(),
                    "/evidence",
                )],
                cmd: Some(vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf x >> /evidence/runs; exec /bin/sleep 300".into(),
                ]),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let bx = Arc::clone(&handle.box_backend)
        .as_any_arc()
        .downcast::<BoxImpl>()
        .ok()
        .unwrap();
    bx.start().await.expect("control boot");
    wait_for_runs(&marker, 1).await;

    // A recovered facade has the published run but has not attached its LiveState.
    let recovered = BoxImpl::new(
        bx.config.clone(),
        bx.state.read().clone(),
        Arc::clone(&runtime),
        runtime.shutdown_token.child_token(),
    );
    let locker = runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let mut metrics = Box::pin(recovered.metrics());
    assert!(futures::poll!(&mut metrics).is_pending());
    drop(guard);
    bx.stop().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(90), &mut metrics)
        .await
        .expect("implicit operation timed out");
    drop(metrics);
    if result.is_ok() {
        // Container.Start returning does not prove the guest command has run.
        wait_for_runs(&marker, 2).await;
    } else {
        assert!(
            matches!(result, Err(BoxliteError::InvalidState(_))),
            "unexpected boot/setup error: {result:?}"
        );
    }
    let implicit_runs = std::fs::read(&marker).unwrap().len();

    recovered
        .start()
        .await
        .expect("explicit restart remains allowed");
    wait_for_runs(&marker, 2).await;
    recovered.stop().await.unwrap();
    runtime.shutdown(Some(15)).await.unwrap();
    assert_eq!(
        implicit_runs, 1,
        "implicit metrics reran the user's main command after refreshing Stopped"
    );
}
