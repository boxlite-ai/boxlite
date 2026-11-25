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
async fn execution_discovery_rechecks_state_after_admission() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = &fixture.box_impl;
    let locker = bx
        .runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let mut discovery = Box::pin(bx.list_executions());
    assert!(
        futures::poll!(&mut discovery).is_pending(),
        "execution discovery bypassed lifecycle admission"
    );

    // Another admitted operation stops this run while discovery is queued.
    let mut stopped = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    stopped.force_status(BoxStatus::Stopped);
    bx.runtime.box_manager.save_box(bx.id(), &stopped).unwrap();
    drop(guard);

    let error = tokio::time::timeout(Duration::from_secs(1), discovery)
        .await
        .expect("execution discovery stalled after admission")
        .expect_err("discovery must reject the run stopped while it waited");
    assert!(
        matches!(error, BoxliteError::InvalidState(ref message) if message.contains("is not running")),
        "discovery used the cached guest after the run stopped: {error}"
    );
}

#[tokio::test]
async fn quiesced_disk_work_waits_for_entity_lock() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let handle = runtime
        .create(
            BoxOptions {
                detach: true,
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let bx = handle
        .box_backend
        .clone()
        .as_any_arc()
        .downcast::<BoxImpl>()
        .ok()
        .unwrap();
    let locker = runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let marker = home.path().join("disk-work");
    let mut work = Box::pin(bx.with_quiesce_async(async {
        std::fs::write(&marker, b"snapshot").unwrap();
        Ok(())
    }));
    assert!(
        futures::poll!(&mut work).is_pending(),
        "quiesced disk work bypassed lifecycle admission"
    );
    assert!(!marker.exists(), "disk work ran before lifecycle admission");
    drop(guard);

    tokio::time::timeout(Duration::from_secs(1), work)
        .await
        .expect("quiesced disk work stalled after admission")
        .unwrap();
    assert!(marker.exists(), "admitted disk work did not execute");
    assert!(
        LockGuard::try_new(locker.as_ref()).is_some(),
        "quiesced disk work retained lifecycle admission after returning"
    );
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

#[tokio::test]
async fn disk_lock_serializes_snapshot_markers_across_handles() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let a = runtime
        .create(
            BoxOptions {
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    a.stop().await.unwrap();
    let b = runtime.get(a.id().as_str()).await.unwrap().unwrap();
    assert!(!Arc::ptr_eq(&a.box_backend, &b.box_backend));
    let bx = Arc::clone(&a.box_backend)
        .as_any_arc()
        .downcast::<BoxImpl>()
        .ok()
        .unwrap();
    std::fs::create_dir_all(&bx.config.box_home).unwrap();
    let locker = runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let lifecycle = LockGuard::new(locker.as_ref());
    let snapshots_a = a.snapshots();
    let snapshots_b = b.snapshots();
    let mut first = Box::pin(snapshots_a.create(Default::default(), "first"));
    let mut second = Box::pin(snapshots_b.create(Default::default(), "second"));
    assert!(futures::poll!(&mut first).is_pending());
    let marker_path = bx.config.box_home.join(".snapshot_pending");
    let read_marker = || -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(&marker_path).unwrap()).unwrap()
    };
    let expected = bx.config.box_home.join("snapshots/first");
    assert_eq!(
        read_marker()["snapshot_dir"],
        expected.to_string_lossy().as_ref()
    );
    assert!(futures::poll!(&mut second).is_pending());
    let marker = read_marker();
    // Cancel both waiters before releasing lifecycle admission, even on failure.
    drop(first);
    drop(second);
    drop(lifecycle);
    assert_eq!(marker["snapshot_dir"], expected.to_string_lossy().as_ref());
}

fn disk_test_backend(handle: &crate::LiteBox) -> Arc<BoxImpl> {
    Arc::clone(&handle.box_backend)
        .as_any_arc()
        .downcast::<BoxImpl>()
        .ok()
        .unwrap()
}

async fn persistent_disk_test_box(runtime: &Arc<RuntimeImpl>) -> crate::LiteBox {
    runtime
        .create(
            BoxOptions {
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn disk_lock_memory_namespaces_cancellation_and_error_release() {
    let home = TempDir::new_in("/tmp").unwrap();
    let mut runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let inner = Arc::get_mut(&mut runtime).unwrap();
    inner.lock_manager = Arc::new(crate::lock::InMemoryLockManager::new(16));
    inner.disk_lock_manager = Arc::new(crate::lock::InMemoryLockManager::new(16));
    let a = persistent_disk_test_box(&runtime).await;
    let b = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&a);
    let other = disk_test_backend(&b);
    assert_eq!(runtime.lock_manager.allocated_count().unwrap(), 2);
    assert_eq!(runtime.disk_lock_manager.allocated_count().unwrap(), 2);
    let owner = bx.disk_locker().unwrap();
    let waiter = bx.disk_locker().unwrap();
    let different = other.disk_locker().unwrap();
    let lifecycle = runtime.lock_manager.retrieve(owner.id()).unwrap();
    let held = LockGuard::new_async(owner.as_ref()).await;
    assert!(LockGuard::try_new(waiter.as_ref()).is_none());
    assert!(LockGuard::try_new(different.as_ref()).is_some());
    assert!(LockGuard::try_new(lifecycle.as_ref()).is_some());
    let mut waiting = Box::pin(LockGuard::new_async(waiter.as_ref()));
    assert!(futures::poll!(&mut waiting).is_pending());
    drop(waiting);
    drop(held);
    assert!(LockGuard::try_new(waiter.as_ref()).is_some());
    // The real disk API errors on missing disks; its admission must be released.
    assert!(a.clone_box(Default::default(), None).await.is_err());
    assert!(LockGuard::try_new(waiter.as_ref()).is_some());
}

#[tokio::test]
async fn disk_lock_remove_busy_preserves_files_and_auto_delete_never_waits() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let handle = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&handle);
    std::fs::create_dir_all(&bx.config.box_home).unwrap();
    let evidence = bx.config.box_home.join("keep");
    std::fs::write(&evidence, b"retained").unwrap();
    let locker = bx.disk_locker().unwrap();
    let guard = LockGuard::new_async(locker.as_ref()).await;
    assert!(matches!(
        runtime.remove_box(bx.id(), true),
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(runtime.box_manager.box_by_id(bx.id()).unwrap().is_some());
    assert!(evidence.exists());
    let paths = [
        runtime.layout.locks_dir().join(locker.id().to_string()),
        runtime
            .layout
            .disk_locks_dir()
            .join(locker.id().to_string()),
    ];
    assert!(paths.iter().all(|p| p.exists()));
    drop(guard);
    runtime.remove_box(bx.id(), false).unwrap();
    assert!(!bx.config.box_home.exists());
    assert!(paths.iter().all(|p| !p.exists()));

    let ephemeral = runtime
        .create(
            BoxOptions {
                auto_delete: Some(1),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let bx = disk_test_backend(&ephemeral);
    let disk = bx.disk_locker().unwrap();
    let guard = LockGuard::new_async(disk.as_ref()).await;
    // stop holds lifecycle admission when it attempts automatic removal.
    let mut stop = Box::pin(ephemeral.stop());
    assert!(matches!(
        futures::poll!(&mut stop),
        std::task::Poll::Ready(Err(BoxliteError::InvalidState(_)))
    ));
    drop(stop);
    assert!(runtime.box_manager.box_by_id(bx.id()).unwrap().is_some());
    drop(guard);
    runtime.remove_box(bx.id(), false).unwrap();
}

#[tokio::test]
async fn disk_lock_unlinked_waiter_rejects_removed_owner_after_id_reuse() {
    use std::os::unix::fs::MetadataExt;
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let a = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&a);
    let old = bx.disk_locker().unwrap();
    let path = runtime.layout.disk_locks_dir().join(old.id().to_string());
    let old_inode = std::fs::metadata(&path).unwrap().ino();
    // Retrieve before deletion, but defer admission until after removal wins.
    let (resume, ready) = tokio::sync::oneshot::channel::<()>();
    let mut waiter = Box::pin(async {
        ready.await.unwrap();
        let _guard = LockGuard::new_async(old.as_ref()).await;
        bx.ensure_box_exists()
    });
    assert!(futures::poll!(&mut waiter).is_pending());
    runtime.remove_box(bx.id(), false).unwrap();
    assert!(matches!(
        runtime.disk_lock_manager.retrieve(old.id()),
        Err(BoxliteError::NotFound(_))
    ));
    let b = persistent_disk_test_box(&runtime).await;
    let replacement = disk_test_backend(&b).disk_locker().unwrap();
    assert_eq!(old.id(), replacement.id());
    assert_ne!(old_inode, std::fs::metadata(&path).unwrap().ino());
    let replacement_guard = LockGuard::new_async(replacement.as_ref()).await;
    resume.send(()).unwrap();
    assert!(matches!(waiter.await, Err(BoxliteError::NotFound(_))));
    drop(replacement_guard);
    assert!(matches!(
        a.snapshots().create(Default::default(), "stale").await,
        Err(BoxliteError::NotFound(_))
    ));
    assert!(!bx.config.box_home.join(".snapshot_pending").exists());
}

#[tokio::test]
async fn disk_lock_b1_running_auto_delete_stop_retries_busy_removal() {
    let mut fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = Arc::get_mut(&mut fixture.box_impl).unwrap();
    bx.config.options.auto_delete = Some(1);
    bx.config.options.detach = false;
    bx.runtime.box_manager.remove_box(bx.id()).unwrap();
    bx.runtime
        .box_manager
        .add_box(&bx.config, &bx.state.read())
        .unwrap();
    assert_eq!(bx.state.read().status, BoxStatus::Running);
    let disk_dir = bx.config.box_home.join("disks");
    std::fs::create_dir_all(&disk_dir).unwrap();
    let evidence = disk_dir.join("retained-disk");
    std::fs::write(&evidence, b"disk contents").unwrap();
    let disk = bx.disk_locker().unwrap();
    let paths = [
        bx.runtime.layout.locks_dir().join(disk.id().to_string()),
        bx.runtime
            .layout
            .disk_locks_dir()
            .join(disk.id().to_string()),
    ];
    let guard = LockGuard::new_async(disk.as_ref()).await;
    assert!(matches!(
        bx.stop().await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_eq!(
        bx.runtime.box_manager.update_box(bx.id()).unwrap().status,
        BoxStatus::Stopped
    );
    assert!(evidence.exists());
    assert!(paths.iter().all(|path| path.is_file()));
    drop(guard);
    bx.stop().await.unwrap();
    assert!(
        bx.runtime.box_manager.box_by_id(bx.id()).unwrap().is_none(),
        "second stop returned Ok without completing auto-delete"
    );
    assert!(!bx.config.box_home.exists());
    assert!(paths.iter().all(|path| !path.exists()));
    assert!(bx.auto_removed.load(Ordering::Acquire));
    bx.stop().await.unwrap();
}

#[tokio::test]
async fn disk_lock_natural_exit_auto_delete_waits_for_disk_and_completes() {
    let mut fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = Arc::get_mut(&mut fixture.box_impl).unwrap();
    bx.config.options.auto_delete = Some(1);
    bx.config.options.detach = false;
    bx.state.write().set_pid(Some(u32::MAX));
    bx.runtime.box_manager.remove_box(bx.id()).unwrap();
    bx.runtime
        .box_manager
        .add_box(&bx.config, &bx.state.read())
        .unwrap();
    let run = BoxRun {
        pid: bx.state.read().pid.unwrap(),
        started_at: bx.state.read().started_at,
    };
    std::fs::create_dir_all(bx.config.box_home.join("disks")).unwrap();
    let disk = bx.disk_locker().unwrap();
    let paths = [
        bx.runtime.layout.locks_dir().join(disk.id().to_string()),
        bx.runtime
            .layout
            .disk_locks_dir()
            .join(disk.id().to_string()),
    ];
    let guard = LockGuard::new_async(disk.as_ref()).await;
    let mut observation = Box::pin(bx.apply_observation(
        run,
        BoxEvent::Exited {
            health_checked: false,
        },
    ));
    let initial = futures::poll!(&mut observation);
    assert_eq!(bx.state.read().status, BoxStatus::Stopped);
    assert_eq!(
        bx.runtime.box_manager.update_box(bx.id()).unwrap().status,
        BoxStatus::Stopped
    );
    assert!(bx.config.box_home.is_dir());
    assert!(paths.iter().all(|path| path.is_file()));
    assert!(!bx.auto_removed.load(Ordering::Acquire));
    // Waiting for disk admission must not retain lifecycle admission.
    let lifecycle = bx.runtime.lock_manager.retrieve(disk.id()).unwrap();
    assert!(LockGuard::try_new(lifecycle.as_ref()).is_some());
    drop(guard);

    let cleaned = tokio::time::timeout(Duration::from_secs(5), async {
        let observed = match initial {
            std::task::Poll::Ready(result) => result,
            std::task::Poll::Pending => observation.await,
        };
        while bx.runtime.box_manager.box_by_id(bx.id()).unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        observed
    })
    .await;
    assert!(
        cleaned.is_ok(),
        "natural exit abandoned auto-delete after disk admission became available"
    );
    cleaned.unwrap().unwrap();
    assert!(!bx.config.box_home.exists());
    assert!(paths.iter().all(|path| !path.exists()));
    assert!(bx.auto_removed.load(Ordering::Acquire));
}

#[tokio::test]
async fn disk_lock_c1_auto_delete_missing_lock_is_not_completed_removal() {
    let mut fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = Arc::get_mut(&mut fixture.box_impl).unwrap();
    bx.config.options.auto_delete = Some(1);
    bx.config.options.detach = false;
    bx.runtime.box_manager.remove_box(bx.id()).unwrap();
    bx.runtime
        .box_manager
        .add_box(&bx.config, &bx.state.read())
        .unwrap();
    std::fs::create_dir_all(&bx.config.box_home).unwrap();
    let evidence = bx.config.box_home.join("retained-disk");
    std::fs::write(&evidence, b"disk contents").unwrap();
    let disk = bx.disk_locker().unwrap();
    let disk_path = bx
        .runtime
        .layout
        .disk_locks_dir()
        .join(disk.id().to_string());
    let lifecycle_path = bx.runtime.layout.locks_dir().join(disk.id().to_string());
    let guard = LockGuard::new_async(disk.as_ref()).await;
    assert!(matches!(
        bx.stop().await,
        Err(BoxliteError::InvalidState(_))
    ));
    drop(guard);
    std::fs::remove_file(&disk_path).unwrap();
    let result = bx.stop().await;
    assert!(bx.runtime.box_manager.box_by_id(bx.id()).unwrap().is_some());
    assert!(evidence.exists());
    assert!(!bx.auto_removed.load(Ordering::Acquire));
    assert!(
        matches!(result, Err(BoxliteError::InvalidState(_))),
        "missing disk lock must not report completed removal: {result:?}"
    );
    assert!(matches!(&result, Err(BoxliteError::InvalidState(message))
        if message.contains("disk lock") && message.contains("missing") && message.contains("retry")));
    assert!(matches!(
        bx.runtime.remove_box(bx.id(), false),
        Err(BoxliteError::InvalidState(_))
    ));

    // A missing lifecycle lock must not be mistaken for a missing box row either.
    std::fs::write(&disk_path, b"").unwrap();
    std::fs::remove_file(&lifecycle_path).unwrap();
    assert!(matches!(bx.stop().await, Err(BoxliteError::NotFound(_))));
    assert!(bx.runtime.box_manager.box_by_id(bx.id()).unwrap().is_some());
    std::fs::write(&lifecycle_path, b"").unwrap();
    bx.stop().await.unwrap();
    assert!(bx.runtime.box_manager.box_by_id(bx.id()).unwrap().is_none());
    assert!(!evidence.exists());
    bx.stop().await.unwrap();
}

fn snapshot_restore_test_disk(bx: &BoxImpl) -> std::path::PathBuf {
    let disks = bx.config.box_home.join("disks");
    std::fs::create_dir_all(&disks).unwrap();
    let disk = disks.join("disk.qcow2");
    crate::disk::Qcow2Helper::create_disk(&disk, true)
        .unwrap()
        .leak();
    bx.runtime
        .snapshot_mgr
        .create(&bx.config.box_home, "restore-point", bx.id().as_str())
        .unwrap();
    // Distinguish the current disk from the COW child restore would create.
    std::fs::write(&disk, b"current disk must survive rejected restore").unwrap();
    disk
}

#[tokio::test]
async fn snapshot_restore_rechecks_stale_stopped_state() {
    use crate::runtime::backend::SnapshotBackend;

    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let handle = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&handle);
    bx.state.write().force_status(BoxStatus::Stopped);
    runtime
        .box_manager
        .save_box(bx.id(), &bx.state.read())
        .unwrap();
    let disk = snapshot_restore_test_disk(&bx);
    let before = std::fs::read(&disk).unwrap();
    let mut running = runtime.box_manager.update_box(bx.id()).unwrap();
    running.force_status(BoxStatus::Running);
    runtime.box_manager.save_box(bx.id(), &running).unwrap();
    assert_eq!(bx.state.read().status, BoxStatus::Stopped);

    let snapshots = crate::litebox::LocalSnapshotBackend::new(Arc::clone(&bx));
    let result = snapshots.restore("restore-point").await;
    assert!(
        matches!(&result, Err(BoxliteError::InvalidState(message))
            if message == "Cannot restore snapshot while box is running. Stop the box first."),
        "restore accepted stale Stopped state: {result:?}"
    );
    assert_eq!(
        std::fs::read(&disk).unwrap(),
        before,
        "restore replaced a running box's disk"
    );
}

#[tokio::test]
async fn snapshot_restore_rechecks_running_after_disk_wait() {
    use crate::runtime::backend::SnapshotBackend;

    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = &fixture.box_impl;
    let disk = snapshot_restore_test_disk(bx);
    let before = std::fs::read(&disk).unwrap();
    let running = bx.state.read().clone();
    let mut stopped = running.clone();
    stopped.force_status(BoxStatus::Stopped);
    bx.runtime.box_manager.save_box(bx.id(), &stopped).unwrap();
    let stale = Arc::new(BoxImpl::new(
        bx.config.clone(),
        stopped,
        Arc::clone(&bx.runtime),
        bx.runtime.shutdown_token.child_token(),
    ));
    let snapshots = crate::litebox::LocalSnapshotBackend::new(Arc::clone(&stale));
    let locker = bx.disk_locker().unwrap();
    let owner = LockGuard::new_async(locker.as_ref()).await;
    let mut restore = Box::pin(snapshots.restore("restore-point"));
    assert!(
        futures::poll!(&mut restore).is_pending(),
        "restore bypassed disk admission"
    );

    // Model another handle publishing a booted VM under lifecycle admission.
    // The harness supplies LiveState; start() exercises its real admission path
    // without requiring a VM boot in this host-only test.
    bx.with_operation(async {
        bx.runtime.box_manager.save_box(bx.id(), &running)?;
        *bx.state.write() = running.clone();
        Ok(())
    })
    .await
    .unwrap();
    let started = tokio::time::timeout(Duration::from_secs(1), bx.start()).await;
    bx.shutdown_token.cancel();
    wait_for_background_starts(bx, 1).await;
    assert!(
        matches!(started, Ok(Ok(()))),
        "start blocked behind restore's disk waiter: {started:?}"
    );
    assert_eq!(stale.state.read().status, BoxStatus::Stopped);
    drop(owner);

    let result = tokio::time::timeout(Duration::from_secs(1), restore)
        .await
        .expect("restore stalled after disk admission");
    assert!(
        matches!(&result, Err(BoxliteError::InvalidState(message))
            if message == "Cannot restore snapshot while box is running. Stop the box first."),
        "restore missed Running published while waiting for disk admission: {result:?}"
    );
    assert_eq!(
        std::fs::read(&disk).unwrap(),
        before,
        "queued restore replaced a running box's disk"
    );
}

#[tokio::test]
async fn snapshot_restore_waits_for_lifecycle_while_holding_disk() {
    use crate::runtime::backend::SnapshotBackend;

    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let handle = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&handle);
    bx.state.write().force_status(BoxStatus::Stopped);
    runtime
        .box_manager
        .save_box(bx.id(), &bx.state.read())
        .unwrap();
    let disk = snapshot_restore_test_disk(&bx);
    let before = std::fs::read(&disk).unwrap();
    let locker = runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let lifecycle = LockGuard::new(locker.as_ref());
    let snapshots = crate::litebox::LocalSnapshotBackend::new(Arc::clone(&bx));
    let mut restore = Box::pin(snapshots.restore("restore-point"));
    assert!(
        futures::poll!(&mut restore).is_pending(),
        "restore bypassed lifecycle admission instead of queuing"
    );
    assert!(
        LockGuard::try_new(bx.disk_locker().unwrap().as_ref()).is_none(),
        "restore did not retain disk admission while waiting for lifecycle"
    );
    assert_eq!(std::fs::read(&disk).unwrap(), before);
    drop(lifecycle);
    tokio::time::timeout(Duration::from_secs(1), restore)
        .await
        .expect("restore stalled after lifecycle admission")
        .unwrap();
    assert_ne!(
        std::fs::read(&disk).unwrap(),
        before,
        "stopped restore did not replace the disk"
    );
    assert!(LockGuard::try_new(locker.as_ref()).is_some());
    assert!(LockGuard::try_new(bx.disk_locker().unwrap().as_ref()).is_some());
}

fn create_disk_for_test(bx: &BoxImpl) -> std::path::PathBuf {
    let disk = bx.config.box_home.join("disks/disk.qcow2");
    crate::disk::Qcow2Helper::create_disk(&disk, true)
        .unwrap()
        .leak();
    disk
}

fn assert_disk_admission_released(bx: &BoxImpl) {
    assert!(LockGuard::try_new(bx.disk_locker().unwrap().as_ref()).is_some());
    let lifecycle = bx
        .runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    assert!(LockGuard::try_new(lifecycle.as_ref()).is_some());
}

#[tokio::test]
async fn batch_clone_shares_base_and_records_refs_until_last_removal() {
    enable_disk_operation_logs();
    use crate::disk::{BaseDiskKind, Qcow2Helper, read_backing_file_path};
    use crate::runtime::options::{NetworkMode, OutboundNetworkConfig};

    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&source);
    let disk = create_disk_for_test(&bx);
    let virtual_size = Qcow2Helper::qcow2_virtual_size(&disk).unwrap();
    // Copy the latest persisted policy, not the handle's original options.
    runtime
        .box_manager
        .save_outbound(
            source.id(),
            &OutboundNetworkConfig {
                mode: NetworkMode::Disabled,
                ..Default::default()
            },
        )
        .unwrap();
    let state = runtime.box_manager.update_box(source.id()).unwrap();
    let clones = source
        .clone_boxes(Default::default(), 2, vec!["first".into(), "second".into()])
        .await
        .unwrap();
    let bases = runtime
        .base_disk_mgr
        .store()
        .list_by_box(source.id().as_str(), Some(BaseDiskKind::CloneBase))
        .unwrap();
    assert_eq!(bases.len(), 1);
    let base = &bases[0];
    let backing = read_backing_file_path(&disk).unwrap().unwrap();
    assert_eq!(std::path::Path::new(&backing), base.disk_info().as_path());
    let mut expected_refs = vec![source.id().to_string()];
    assert_eq!(clones.len(), 2);
    for clone in &clones {
        let copy = disk_test_backend(clone);
        let child = copy.config.box_home.join("disks/disk.qcow2");
        assert_eq!(
            read_backing_file_path(&child).unwrap().as_ref(),
            Some(&backing)
        );
        assert_eq!(
            Qcow2Helper::qcow2_virtual_size(&child).unwrap(),
            virtual_size
        );
        assert_eq!(copy.config.options.disk_size_gb, None);
        assert_eq!(copy.state.read().status, BoxStatus::Stopped);
        let policy = OutboundNetworkConfig::from(&copy.config.options.network);
        assert_eq!(Some(policy), state.outbound_policy);
        expected_refs.push(clone.id().to_string());
        assert_disk_admission_released(&copy);
    }
    let mut actual_refs = runtime
        .base_disk_mgr
        .store()
        .dependent_boxes(base.id())
        .unwrap();
    expected_refs.sort();
    actual_refs.sort();
    assert_eq!(actual_refs, expected_refs);
    assert_disk_admission_released(&bx);
    for clone in &clones {
        runtime.remove_box(clone.id(), false).unwrap();
        assert!(base.disk_info().as_path().exists());
    }
    runtime.remove_box(source.id(), false).unwrap();
    assert!(!base.disk_info().as_path().exists());
    assert!(
        runtime
            .base_disk_mgr
            .store()
            .find_by_id(base.id())
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn batch_clone_copy_options_failure_cleans_phase_b_staging() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&source);
    let disk = create_disk_for_test(&bx);

    // Deleting state before cloning would fail Phase A's lifecycle refresh.
    // Delete it only when Phase A records the source's base ref, so Phase A
    // succeeds and options_for_copy fails after all Phase B overlays are built.
    let database = rusqlite::Connection::open(runtime.layout.db_dir().join("boxlite.db")).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER delete_source_state AFTER INSERT ON base_disk_ref
             BEGIN DELETE FROM box_state WHERE id = NEW.box_id; END;",
        )
        .unwrap();
    let error = source
        .clone_boxes(Default::default(), 3, vec![])
        .await
        .err();
    database
        .execute_batch("DROP TRIGGER delete_source_state")
        .unwrap();
    assert!(
        matches!(&error, Some(BoxliteError::NotFound(id)) if id == source.id().as_str()),
        "expected options_for_copy to fail after Phase B: {error:?}"
    );
    let bases = runtime
        .base_disk_mgr
        .store()
        .list_by_box(
            source.id().as_str(),
            Some(crate::disk::BaseDiskKind::CloneBase),
        )
        .unwrap();
    assert_eq!(bases.len(), 1, "Phase A must complete before the failure");
    assert_eq!(
        crate::disk::read_backing_file_path(&disk).unwrap().unwrap(),
        bases[0].disk_info().as_path().to_string_lossy()
    );
    assert_eq!(
        runtime
            .base_disk_mgr
            .store()
            .dependent_boxes(bases[0].id())
            .unwrap(),
        vec![source.id().to_string()]
    );
    assert_disk_admission_released(&bx);
    let box_dirs: std::collections::BTreeSet<_> = std::fs::read_dir(runtime.layout.boxes_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(
        box_dirs,
        std::collections::BTreeSet::from([bx.config.box_home.clone()]),
        "Phase B left staging directories behind after options_for_copy failed"
    );
}

#[tokio::test]
async fn batch_clone_provision_failure_keeps_completed_clone_and_cleans_staging() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&source);
    let disk = create_disk_for_test(&bx);
    assert!(
        source
            .clone_boxes(Default::default(), 0, vec![])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        source
            .clone_boxes(Default::default(), 2, vec!["only-one".into()])
            .await,
        Err(BoxliteError::Config(_))
    ));
    assert!(matches!(
        source.clone_boxes(Default::default(), 3, vec!["duplicate".into(), "duplicate".into(), "never-provisioned".into()]).await,
        Err(BoxliteError::InvalidState(message)) if message.contains("already exists")
    ));
    assert!(runtime.get("never-provisioned").await.unwrap().is_none());
    let completed = runtime.get("duplicate").await.unwrap().unwrap();
    let completed_bx = disk_test_backend(&completed);
    let child = completed_bx.config.box_home.join("disks/disk.qcow2");
    assert_eq!(
        crate::disk::read_backing_file_path(&child).unwrap(),
        crate::disk::read_backing_file_path(&disk).unwrap()
    );
    assert_eq!(runtime.box_manager.all_boxes(true).unwrap().len(), 2);
    assert_eq!(
        std::fs::read_dir(runtime.layout.temp_dir())
            .unwrap()
            .count(),
        0
    );
    assert_disk_admission_released(&bx);
    assert_disk_admission_released(&completed_bx);
    // Failing in the middle must also clean the never-provisioned third overlay.
    let box_dirs: std::collections::BTreeSet<_> = std::fs::read_dir(runtime.layout.boxes_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    let expected_dirs = std::collections::BTreeSet::from([
        bx.config.box_home.clone(),
        completed_bx.config.box_home.clone(),
    ]);
    assert_eq!(
        box_dirs, expected_dirs,
        "unprovisioned clone staging was leaked"
    );
}

#[tokio::test]
async fn export_archive_round_trips_snapshot_chain_and_persisted_options() {
    enable_disk_operation_logs();
    use crate::disk::{Qcow2Helper, read_backing_file_path};
    use crate::litebox::archive::{
        ArchiveManifest, MANIFEST_FILENAME, extract_archive, sha256_file,
    };
    use crate::runtime::options::{NetworkMode, OutboundNetworkConfig};

    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&source);
    let disk = create_disk_for_test(&bx);
    let snapshot = source
        .snapshots()
        .create(Default::default(), "export-point")
        .await
        .unwrap();
    assert_eq!(
        std::path::Path::new(&read_backing_file_path(&disk).unwrap().unwrap())
            .canonicalize()
            .unwrap(),
        snapshot.disk_info.as_path().canonicalize().unwrap()
    );
    let policy = OutboundNetworkConfig {
        mode: NetworkMode::Disabled,
        ..Default::default()
    };
    assert_ne!(
        OutboundNetworkConfig::from(&bx.config.options.network),
        policy
    );
    runtime
        .box_manager
        .save_outbound(source.id(), &policy)
        .unwrap();
    let mut expected_options = bx.config.options.clone();
    expected_options.network = policy.clone().try_into().unwrap();
    let archive = source
        .export(Default::default(), home.path())
        .await
        .unwrap();
    assert!(archive.path().is_file());
    let extracted = TempDir::new_in("/tmp").unwrap();
    extract_archive(archive.path(), extracted.path()).unwrap();
    let manifest: ArchiveManifest =
        serde_json::from_slice(&std::fs::read(extracted.path().join(MANIFEST_FILENAME)).unwrap())
            .unwrap();
    let flat = extracted.path().join("disk.qcow2");
    assert_eq!(
        manifest.container_disk_checksum,
        sha256_file(&flat).unwrap()
    );
    assert_eq!(manifest.box_name, bx.config.name);
    assert_eq!(
        serde_json::to_value(manifest.box_options.as_ref().unwrap()).unwrap(),
        serde_json::to_value(&expected_options).unwrap()
    );
    assert_eq!(
        OutboundNetworkConfig::from(&manifest.box_options.as_ref().unwrap().network),
        policy
    );
    assert!(read_backing_file_path(&flat).unwrap().is_none());
    assert_eq!(
        Qcow2Helper::qcow2_virtual_size(&flat).unwrap(),
        Qcow2Helper::qcow2_virtual_size(&disk).unwrap()
    );
    let imported = runtime
        .import_box(archive, Some("imported".into()))
        .await
        .unwrap();
    let restored = disk_test_backend(&imported);
    assert_ne!(imported.id(), source.id());
    assert_eq!(restored.state.read().status, BoxStatus::Stopped);
    assert_eq!(
        sha256_file(&restored.config.box_home.join("disks/disk.qcow2")).unwrap(),
        manifest.container_disk_checksum
    );
    assert_disk_admission_released(&bx);
    assert_eq!(
        std::fs::read_dir(runtime.layout.temp_dir())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn export_cancellation_and_phase_errors_release_admissions() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&source);
    let dest = home.path().join("archive.boxlite");
    let lifecycle = runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let held = LockGuard::new(lifecycle.as_ref());
    let mut export = Box::pin(source.export(Default::default(), &dest));
    assert!(futures::poll!(&mut export).is_pending());
    assert!(LockGuard::try_new(bx.disk_locker().unwrap().as_ref()).is_none());
    drop(export);
    assert!(LockGuard::try_new(bx.disk_locker().unwrap().as_ref()).is_some());
    assert!(!dest.exists());
    drop(held);

    // Phase 1 fails without a container disk.
    assert!(matches!(
        source.export(Default::default(), &dest).await,
        Err(BoxliteError::Storage(_))
    ));
    assert_disk_admission_released(&bx);
    create_disk_for_test(&bx);
    // Phase 2 fails to create the destination after flatten has completed.
    let invalid_dest = home.path().join("missing-parent/archive.boxlite");
    assert!(
        source
            .export(Default::default(), &invalid_dest)
            .await
            .is_err()
    );
    assert!(!invalid_dest.exists());
    assert_disk_admission_released(&bx);
    assert_eq!(
        std::fs::read_dir(runtime.layout.temp_dir())
            .unwrap()
            .count(),
        0
    );
    source.export(Default::default(), &dest).await.unwrap();
    assert!(
        dest.is_file(),
        "phase failure must not prevent a later export"
    );
}

#[tokio::test]
async fn snapshot_create_restore_remove_and_marker_failure_release_admission() {
    enable_disk_operation_logs();
    use crate::disk::{BackingFormat, Qcow2Helper, read_backing_file_path};

    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&source);
    let disk = create_disk_for_test(&bx);
    let snapshots = source.snapshots();
    let marker = bx.config.box_home.join(".snapshot_pending");
    std::fs::create_dir(&marker).unwrap();
    assert!(matches!(
        snapshots.create(Default::default(), "point").await,
        Err(BoxliteError::Storage(_))
    ));
    assert!(snapshots.list().await.unwrap().is_empty());
    assert_disk_admission_released(&bx);
    std::fs::remove_dir(&marker).unwrap();
    let snapshot = snapshots.create(Default::default(), "point").await.unwrap();
    assert!(!marker.exists());
    assert_eq!(
        snapshots.get(&snapshot.name).await.unwrap().unwrap().id,
        snapshot.id
    );
    assert!(matches!(
        snapshots.create(Default::default(), &snapshot.name).await,
        Err(BoxliteError::AlreadyExists(_))
    ));
    assert_disk_admission_released(&bx);
    let target_size = Qcow2Helper::qcow2_virtual_size(snapshot.disk_info.as_path()).unwrap();
    std::fs::remove_file(&disk).unwrap();
    Qcow2Helper::create_cow_child_disk(
        snapshot.disk_info.as_path(),
        BackingFormat::Qcow2,
        &disk,
        target_size + 4096,
    )
    .unwrap()
    .leak();
    let later = snapshots.create(Default::default(), "later").await.unwrap();
    assert_eq!(
        std::path::Path::new(&read_backing_file_path(&disk).unwrap().unwrap())
            .canonicalize()
            .unwrap(),
        later.disk_info.as_path().canonicalize().unwrap(),
    );
    assert_eq!(
        Qcow2Helper::qcow2_virtual_size(&disk).unwrap(),
        target_size + 4096
    );
    let before_restore = std::fs::read(&disk).unwrap();
    snapshots.restore(&snapshot.name).await.unwrap();
    assert_ne!(std::fs::read(&disk).unwrap(), before_restore);
    assert_eq!(Qcow2Helper::qcow2_virtual_size(&disk).unwrap(), target_size);
    assert_eq!(
        std::path::Path::new(&read_backing_file_path(&disk).unwrap().unwrap())
            .canonicalize()
            .unwrap(),
        snapshot.disk_info.as_path().canonicalize().unwrap()
    );
    snapshots.remove(&later.name).await.unwrap();
    assert!(matches!(
        snapshots.remove(&snapshot.name).await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert_disk_admission_released(&bx);
    // Detach the live disk using the production flattener, making removal safe.
    let flat = runtime.layout.temp_dir().join("flat.qcow2");
    Qcow2Helper::flatten(&disk, &flat).unwrap();
    std::fs::rename(&flat, &disk).unwrap();
    snapshots.remove(&snapshot.name).await.unwrap();
    assert!(snapshots.get(&snapshot.name).await.unwrap().is_none());
    assert!(!snapshot.disk_info.as_path().exists());
    assert_disk_admission_released(&bx);
}

#[tokio::test]
async fn health_observation_is_idempotent_and_ignores_stopped_runs() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = &fixture.box_impl;
    bx.state.write().set_pid(Some(u32::MAX));
    bx.runtime
        .box_manager
        .save_box(bx.id(), &bx.state.read())
        .unwrap();
    let run = BoxRun {
        pid: bx.state.read().pid.unwrap(),
        started_at: bx.state.read().started_at,
    };
    let probe = || BoxEvent::Health {
        healthy: true,
        retries: 1,
    };
    let health = bx.apply_observation(run, probe()).await.unwrap().unwrap();
    assert_eq!(health.state, crate::HealthState::Healthy);
    // An already-healthy result must not need another persistence write.
    let database =
        rusqlite::Connection::open(bx.runtime.layout.db_dir().join("boxlite.db")).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER reject_redundant_health BEFORE UPDATE ON box_state
         BEGIN SELECT RAISE(ABORT, 'redundant health write'); END;",
        )
        .unwrap();
    assert_eq!(
        bx.apply_observation(run, probe()).await.unwrap(),
        Some(health)
    );
    database
        .execute_batch("DROP TRIGGER reject_redundant_health")
        .unwrap();
    bx.stop().await.unwrap();
    // A fresh handle is not cancelled, so admission checks the persisted status.
    let stopped_state = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    let stopped = BoxImpl::new(
        bx.config.clone(),
        stopped_state.clone(),
        Arc::clone(&bx.runtime),
        bx.runtime.shutdown_token.child_token(),
    );
    assert!(
        stopped
            .apply_observation(run, probe())
            .await
            .unwrap()
            .is_none()
    );
    let persisted = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    assert_eq!(persisted.status, BoxStatus::Stopped);
    assert_eq!(persisted.health_status, stopped_state.health_status);
}

#[tokio::test]
async fn disk_admission_rejects_missing_identity_and_exit_cleanup_rechecks_status() {
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = runtime
        .create(
            BoxOptions {
                auto_delete: Some(1),
                detach: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let bx = disk_test_backend(&source);
    let original = bx.state.read().clone();
    bx.state.write().lock_id = None;
    let polled = AtomicBool::new(false);
    let result = bx
        .with_disk_admission(async {
            polled.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
    *bx.state.write() = original;
    assert!(!polled.load(Ordering::SeqCst));
    assert!(
        matches!(result, Err(BoxliteError::Internal(message)) if message.contains("missing lock_id"))
    );
    // A pending exit cleanup must not delete a box whose state no longer
    // qualifies for removal once disk and lifecycle admission are reacquired.
    assert!(bx.config.options.removes_on_stop());
    bx.state.write().force_status(BoxStatus::Stopped);
    runtime
        .box_manager
        .save_box(bx.id(), &bx.state.read())
        .unwrap();
    let lifecycle = runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let held = LockGuard::new(lifecycle.as_ref());
    let mut cleanup = Box::pin(bx.complete_exit_cleanup());
    assert!(futures::poll!(&mut cleanup).is_pending());
    assert!(LockGuard::try_new(bx.disk_locker().unwrap().as_ref()).is_none());
    let mut no_longer_stopped = runtime.box_manager.update_box(bx.id()).unwrap();
    no_longer_stopped.force_status(BoxStatus::Configured);
    runtime
        .box_manager
        .save_box(bx.id(), &no_longer_stopped)
        .unwrap();
    assert_eq!(bx.state.read().status, BoxStatus::Stopped);
    drop(held);
    tokio::time::timeout(Duration::from_secs(1), cleanup)
        .await
        .expect("exit cleanup stalled after lifecycle admission")
        .unwrap();
    assert_eq!(bx.state.read().status, BoxStatus::Configured);
    assert!(
        runtime
            .box_manager
            .box_by_id(source.id())
            .unwrap()
            .is_some()
    );
    assert!(!bx.auto_removed.load(Ordering::Acquire));
    let before = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    let run = BoxRun {
        pid: u32::MAX,
        started_at: before.started_at,
    };
    assert!(
        bx.apply_observation(
            run,
            BoxEvent::Exited {
                health_checked: false
            }
        )
        .await
        .unwrap()
        .is_none()
    );
    assert_eq!(
        bx.runtime.box_manager.update_box(bx.id()).unwrap().status,
        before.status
    );
    assert_disk_admission_released(&bx);
}

#[tokio::test]
async fn disk_lock_running_auto_delete_stop_completes_without_retry() {
    let mut fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let bx = Arc::get_mut(&mut fixture.box_impl).unwrap();
    bx.config.options.auto_delete = Some(1);
    bx.config.options.detach = false;
    bx.runtime.box_manager.remove_box(bx.id()).unwrap();
    bx.runtime
        .box_manager
        .add_box(&bx.config, &bx.state.read())
        .unwrap();
    let disk = create_disk_for_test(bx);
    let id = bx.state.read().lock_id.unwrap();
    bx.stop().await.unwrap();
    assert!(bx.auto_removed.load(Ordering::Acquire));
    assert!(bx.runtime.box_manager.box_by_id(bx.id()).unwrap().is_none());
    assert!(!disk.exists());
    assert!(!bx.runtime.layout.locks_dir().join(id.to_string()).exists());
    assert!(
        !bx.runtime
            .layout
            .disk_locks_dir()
            .join(id.to_string())
            .exists()
    );
    bx.stop().await.unwrap();
}

// Exercise tracing's log-compatible field formatting without installing a
// process-wide tracing subscriber. Other tests may already own the logger.
fn enable_disk_operation_logs() {
    struct Sink;
    impl tracing::log::Log for Sink {
        fn enabled(&self, _: &tracing::log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, _: &tracing::log::Record<'_>) {}
        fn flush(&self) {}
    }
    static LOGGER: Sink = Sink;
    let _ = tracing::log::set_logger(&LOGGER);
    tracing::log::set_max_level(tracing::log::LevelFilter::Trace);
}

#[tokio::test]
async fn stop_commit_tolerates_record_removed_after_lifecycle_admission() {
    enable_disk_operation_logs();
    let home = TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let source = persistent_disk_test_box(&runtime).await;
    let bx = disk_test_backend(&source);
    bx.state.write().force_status(BoxStatus::Failed);
    runtime
        .box_manager
        .save_box(bx.id(), &bx.state.read())
        .unwrap();
    // Internal initialization cleanup may remove the row after admission has
    // refreshed it. Exercise stop's commit phase, not a pre-admission NotFound.
    bx.with_operation(async {
        runtime.box_manager.remove_box(bx.id())?;
        bx.stop_inner().await
    })
    .await
    .unwrap();
    assert_eq!(bx.state.read().status, BoxStatus::Stopped);
    assert!(bx.shutdown_token.is_cancelled());
    assert!(!bx.auto_removed.load(Ordering::Acquire));
    assert!(runtime.box_manager.box_by_id(bx.id()).unwrap().is_none());
    assert_disk_admission_released(&bx);
}

async fn non_detached_test_box() -> (TempDir, SharedRuntimeImpl, crate::LiteBox, Arc<BoxImpl>) {
    let home = TempDir::new_in("/tmp").unwrap();
    let rt = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let handle = rt
        .create(
            BoxOptions {
                detach: false,
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let bx = disk_test_backend(&handle);
    (home, rt, handle, bx)
}

#[tokio::test]
async fn in_flight_start_aborts_and_coordinates_with_shutdown() {
    // 1. Fresh init_live_state aborts when shutdown_token is cancelled and clears starting.
    let (_home, runtime, _handle, bx) = non_detached_test_box().await;
    runtime.shutdown_token.cancel();
    let err = bx.init_live_state(true).await.err().unwrap();
    assert!(matches!(err, BoxliteError::Stopped(_)), "{err:?}");
    assert!(!bx.is_starting());

    // 2. Post-build abort_start_on_shutdown is a no-op before shutdown, then removes
    //    the PID file and disarms CleanupGuard once cancelled.
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let live = fixture.box_impl.live.get().unwrap();
    let pid_file = fixture.box_impl.layout.pid_file_path();
    std::fs::create_dir_all(pid_file.parent().unwrap()).unwrap();
    std::fs::write(&pid_file, "12345\n").unwrap();

    let mut disarmed = false;
    fixture
        .box_impl
        .abort_start_on_shutdown(live, || disarmed = true)
        .await
        .unwrap();
    assert!(pid_file.exists());
    assert!(!disarmed);

    fixture.box_impl.shutdown_token.cancel();
    let err = fixture
        .box_impl
        .abort_start_on_shutdown(live, || disarmed = true)
        .await
        .unwrap_err();
    assert!(matches!(err, BoxliteError::Stopped(_)), "{err:?}");
    assert!(!pid_file.exists());
    assert!(disarmed);

    // 3. Async shutdown waits for an in-flight start whose owner is not yet in DB,
    //    then stops the box once the start commits Running + owner.
    let (_home2, rt2, _handle2, bx2) = non_detached_test_box().await;
    let locker = rt2
        .lock_manager
        .retrieve(bx2.state.read().lock_id.unwrap())
        .unwrap();
    let lock_guard = LockGuard::new(locker.as_ref());
    let starting_guard = StartingGuard::enter(&bx2.starting);

    let mut shutdown = Box::pin(rt2.shutdown(Some(-1)));
    assert!(
        futures::poll!(&mut shutdown).is_pending(),
        "shutdown must wait on a box with an in-flight start instead of skipping it"
    );

    let mut started = rt2.box_manager.update_box(bx2.id()).unwrap();
    started.status = BoxStatus::Running;
    started.mark_started();
    rt2.box_manager.save_box(bx2.id(), &started).unwrap();
    *bx2.state.write() = started;
    drop(starting_guard);
    drop(lock_guard);

    shutdown.await.unwrap();
    let final_state = rt2.box_manager.update_box(bx2.id()).unwrap();
    assert_eq!(final_state.status, BoxStatus::Stopped);
    assert!(final_state.owner.is_none());
}

#[tokio::test]
async fn sync_shutdown_defers_while_local_start_holds_lock_and_retries() {
    let (_home, rt, _handle, bx) = non_detached_test_box().await;
    let locker = rt
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let lock_guard = LockGuard::new(locker.as_ref());
    let starting_guard = StartingGuard::enter(&bx.starting);

    // Busy local start keeps sync cleanup retryable instead of skipping the row.
    rt.shutdown_sync();

    let mut child = std::process::Command::new("sleep")
        .arg("300")
        .spawn()
        .expect("spawn stand-in shim");
    let pid = child.id();

    let mut started = rt.box_manager.update_box(bx.id()).unwrap();
    started.status = BoxStatus::Running;
    started.pid = Some(pid);
    started.mark_started();
    rt.box_manager.save_box(bx.id(), &started).unwrap();
    drop(starting_guard);
    drop(lock_guard);

    rt.shutdown_sync();

    let alive = crate::util::is_process_alive(pid);
    let _ = child.kill();
    let _ = child.wait();
    assert!(!alive);
    let final_state = rt.box_manager.update_box(bx.id()).unwrap();
    assert_eq!(final_state.status, BoxStatus::Stopped);
    assert!(final_state.owner.is_none());
}
