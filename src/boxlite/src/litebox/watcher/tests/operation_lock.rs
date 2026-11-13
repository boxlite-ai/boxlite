use super::*;
use crate::lock::LockGuard;
use crate::runtime::options::{BoxOptions, BoxliteOptions};
use crate::runtime::types::BoxStatus;

async fn watched_box() -> (tempfile::TempDir, Arc<BoxImpl>, BoxWatcher) {
    watched_box_with_policy(false).await
}

async fn watched_box_with_policy(removes: bool) -> (tempfile::TempDir, Arc<BoxImpl>, BoxWatcher) {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    })
    .unwrap();
    let handle = runtime
        .create(
            BoxOptions {
                detach: true,
                auto_delete: Some(u32::from(removes)),
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
    // This process has really exited before the watcher's exit callback runs.
    let mut process = std::process::Command::new("true").spawn().unwrap();
    let pid = process.id();
    process.wait().unwrap();
    let started_at = {
        let mut state = bx.state.write();
        state.mark_started();
        state.status = BoxStatus::Running;
        state.pid = Some(pid);
        runtime.box_manager.save_box(bx.id(), &state).unwrap();
        state.started_at
    };
    let watcher = BoxWatcher::new(&bx, pid, started_at, None);
    (home, bx, watcher)
}

#[tokio::test]
async fn cached_health_observation_reads_only_admission_state() {
    let (_home, bx, watcher) = watched_box().await;
    let store = bx.runtime.box_manager.store();
    store.reset_read_counts();

    let health = bx
        .runtime
        .apply_box_observation(
            bx.id(),
            watcher.observed_run(),
            BoxEvent::Health {
                healthy: true,
                retries: 0,
            },
        )
        .await
        .unwrap();

    assert!(health.is_some());
    assert_eq!(store.read_counts(), (0, 1));
}

#[tokio::test]
async fn uncached_health_observation_loads_facade_and_admission_state() {
    let (_home, bx, watcher) = watched_box().await;
    bx.runtime
        .invalidate_box_impl(bx.id(), bx.config.name.as_deref());
    let store = bx.runtime.box_manager.store();
    store.reset_read_counts();

    let health = bx
        .runtime
        .apply_box_observation(
            bx.id(),
            watcher.observed_run(),
            BoxEvent::Health {
                healthy: true,
                retries: 0,
            },
        )
        .await
        .unwrap();

    assert!(health.is_some());
    assert_eq!(store.read_counts(), (1, 2));
}

#[tokio::test]
async fn cached_health_observation_drops_deleted_box() {
    let (_home, bx, watcher) = watched_box().await;
    // Delete only the row, leaving the facade cached and its entity lock intact.
    bx.runtime.box_manager.remove_box(bx.id()).unwrap();
    let store = bx.runtime.box_manager.store();
    store.reset_read_counts();

    let health = bx
        .runtime
        .apply_box_observation(
            bx.id(),
            watcher.observed_run(),
            BoxEvent::Health {
                healthy: true,
                retries: 0,
            },
        )
        .await
        .unwrap();

    assert!(health.is_none());
    // Cache-first resolution proves itself here: only the admission refresh read state,
    // and no config load happened for a facade the cache already held.
    assert_eq!(store.read_counts(), (0, 1));
}

#[tokio::test]
async fn watcher_exit_waits_for_entity_lock() {
    let (_home, bx, mut watcher) = watched_box().await;
    let locker = bx
        .runtime
        .lock_manager
        .retrieve(bx.state.read().lock_id.unwrap())
        .unwrap();
    let guard = LockGuard::new(locker.as_ref());
    let exit = watcher.on_shim_exit();
    tokio::pin!(exit);
    let waiting = futures::poll!(&mut exit).is_pending();
    let persisted = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    drop(guard);
    assert!(waiting, "watcher bypassed the entity lock");
    exit.await;
    assert_eq!(persisted.status, BoxStatus::Running);
    assert_eq!(
        bx.runtime.box_manager.update_box(bx.id()).unwrap().status,
        BoxStatus::Stopped
    );
}

#[tokio::test]
async fn watcher_exit_preserves_a_newer_run() {
    let (_home, bx, mut watcher) = watched_box().await;
    let mut newer = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    newer.mark_started();
    newer.started_at = newer.started_at.map(|at| at + chrono::Duration::seconds(1));
    newer.pid = Some(std::process::id());
    bx.runtime.box_manager.save_box(bx.id(), &newer).unwrap();
    watcher.on_shim_exit().await;
    let persisted = bx.runtime.box_manager.update_box(bx.id()).unwrap();
    assert_eq!(
        persisted.status,
        BoxStatus::Running,
        "old watcher overwrote the newer run"
    );
    assert_eq!(persisted.pid, newer.pid);
    assert_eq!(persisted.started_at, newer.started_at);
}

#[tokio::test]
async fn exit_cleanup_survives_dropping_all_box_handles() {
    let (_home, bx, mut watcher) = watched_box_with_policy(true).await;
    let runtime = bx.runtime.clone();
    let id = bx.id().clone();
    let weak = Arc::downgrade(&bx);
    drop(bx);
    assert!(weak.upgrade().is_none(), "watcher retained the box facade");
    watcher.on_shim_exit().await;
    assert!(runtime.box_manager.box_by_id(&id).unwrap().is_none());
    assert_eq!(
        runtime
            .runtime_metrics
            .boxes_stopped
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[tokio::test]
async fn health_delivery_and_repeated_exit_use_the_box_facade() {
    let (_home, bx, mut watcher) = watched_box().await;
    let runtime = bx.runtime.clone();
    let id = bx.id().clone();
    let run = watcher.observed_run();
    drop(bx);
    let health = runtime
        .apply_box_observation(
            &id,
            run,
            BoxEvent::Health {
                healthy: false,
                retries: 2,
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(health.failures, 1);
    assert_eq!(
        runtime.box_manager.update_box(&id).unwrap().status,
        BoxStatus::Running
    );
    // A later user handle may arm another observer; duplicate exit reports are idempotent.
    let handle = runtime.get(id.as_str()).await.unwrap().unwrap();
    watcher.on_shim_exit().await;
    let stopped = runtime.box_manager.update_box(&id).unwrap();
    assert_eq!(stopped.status, BoxStatus::Stopped);
    runtime
        .apply_box_observation(
            &id,
            run,
            BoxEvent::Exited {
                health_checked: false,
            },
        )
        .await
        .unwrap();
    let repeated = runtime.box_manager.update_box(&id).unwrap();
    assert_eq!(repeated.status, stopped.status);
    assert_eq!(repeated.exit_code, stopped.exit_code);
    assert_eq!(
        runtime
            .runtime_metrics
            .boxes_stopped
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
    drop(handle);
}

#[tokio::test]
async fn retained_handle_stop_is_idempotent_after_natural_auto_removal() {
    let (_home, bx, watcher) = watched_box_with_policy(true).await;
    watcher.spawn().await.expect("watcher task");
    assert!(
        bx.runtime.box_manager.box_by_id(bx.id()).unwrap().is_none(),
        "the production watcher must complete automatic removal first"
    );

    bx.stop()
        .await
        .expect("stop must remain idempotent after natural automatic removal");
}

#[tokio::test]
async fn retained_handle_stop_preserves_unrelated_missing_state() {
    let (_home, bx, watcher) = watched_box_with_policy(false).await;
    watcher.spawn().await.expect("watcher task");
    assert_eq!(
        bx.runtime.box_manager.update_box(bx.id()).unwrap().status,
        BoxStatus::Stopped
    );
    assert!(!bx.shutdown_token.is_cancelled());
    bx.runtime.remove_box(bx.id(), false).unwrap();

    assert!(
        matches!(bx.stop().await, Err(BoxliteError::NotFound(_))),
        "separate removal without completed auto-removal must remain visible"
    );
}
