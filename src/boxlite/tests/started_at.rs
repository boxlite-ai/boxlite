//! Integration tests for `BoxInfo::started_at`.
//!
//! The timestamp is deliberately distinct from `BoxStatus::Running`: booting
//! publishes Running before the guest's separate `Container.Start` RPC runs, so
//! Running alone cannot say whether a box's init was ever launched. The cloud
//! runner reads this to repair a startup whose job completion was lost, which
//! only works while the value describes the lifecycle running right now.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::BoxliteOptions;

#[tokio::test]
async fn started_at_tracks_the_shim_that_launched_init() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime
        .create(common::alpine_opts(), Some("start-record".to_string()))
        .await
        .expect("create box");
    let box_id = handle.id().clone();

    assert!(
        handle
            .info()
            .await
            .expect("inspect created box")
            .started_at
            .is_none(),
        "creating a container must not claim its init was launched"
    );

    // Booting is not starting: `attach` brings the VM up and stops short of
    // running init, which is the state `BoxStatus::Running` cannot tell apart
    // from a box whose init is live — and the whole reason this field exists.
    let attached = handle.attach(None).await.expect("attach to booted box");
    let booted = handle.info().await.expect("inspect booted box");
    assert!(
        booted.status.is_running(),
        "attach must leave the box Running, or this test is not observing the window"
    );
    assert_eq!(
        booted.started_at, None,
        "a booted box whose init was never launched must not report a container start"
    );

    let before_start = chrono::Utc::now();
    handle.start().await.expect("start box");
    drop(attached);

    let info = handle.info().await.expect("inspect running box");
    let started_at = info
        .started_at
        .expect("a successful Container.Start must be recorded");

    assert!(
        info.pid.is_some(),
        "a box that recorded a start must name the shim running it"
    );
    assert!(
        started_at >= before_start,
        "record timestamp {started_at} predates the start that produced it ({before_start})"
    );

    let _ = handle.stop().await;
    let _ = runtime.remove(box_id.as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn a_fresh_lifecycle_replaces_the_previous_record() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime
        .create(
            common::alpine_opts(),
            Some("start-record-restart".to_string()),
        )
        .await
        .expect("create box");
    let box_id = handle.id().clone();

    handle.start().await.expect("start first lifecycle");
    let first = handle
        .info()
        .await
        .expect("inspect first lifecycle")
        .started_at
        .expect("first start must be recorded");

    handle.stop().await.expect("stop first lifecycle");

    assert_eq!(
        handle.info().await.expect("inspect stopped box").started_at,
        Some(first),
        "a stop must leave the record of the run that just ended, the way docker keeps \
         StartedAt on an exited container"
    );

    // A spent handle cannot boot another VM, so the restart goes through a
    // fresh one — the same path the runner takes after a box has stopped.
    drop(handle);
    let restarted = runtime
        .get(box_id.as_str())
        .await
        .expect("get a fresh handle")
        .expect("box still exists");

    restarted.start().await.expect("start second lifecycle");

    let second_info = restarted.info().await.expect("inspect restarted box");
    let second = second_info
        .started_at
        .expect("second start must be recorded");

    assert!(
        second_info.pid.is_some(),
        "a restarted box that recorded a start must name the shim running it"
    );
    assert!(
        second > first,
        "second record timestamp {second} does not follow the first ({first})"
    );

    let _ = restarted.stop().await;
    let _ = runtime.remove(box_id.as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn adopting_the_same_running_shim_preserves_its_record() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let options = || BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    };

    let (box_id, recorded, recorded_pid) = {
        let first = BoxliteRuntime::new(options()).expect("create first runtime");
        let mut box_options = common::alpine_opts();
        box_options.detach = true;
        let handle = first
            .create(box_options, Some("start-record-adopt".to_string()))
            .await
            .expect("create detached box");
        handle.start().await.expect("start detached box");
        let info = handle.info().await.expect("inspect detached box");
        (
            handle.id().clone(),
            info.started_at.expect("detached start must be recorded"),
            info.pid.expect("a running box has a shim pid"),
        )
    };

    // Reattaching to a still-running shim is not a new lifecycle: its init is
    // already running, so the record that describes it must survive.
    let second = BoxliteRuntime::new(options()).expect("create second runtime");
    let adopted = second
        .get(box_id.as_str())
        .await
        .expect("adopt running box")
        .expect("running box exists");
    let adopted_info = adopted.info().await.expect("inspect adopted box");

    assert_eq!(
        adopted_info.started_at,
        Some(recorded),
        "adopting a live shim must not clear or rewrite its start record"
    );
    assert_eq!(
        adopted_info.pid,
        Some(recorded_pid),
        "the preserved record must still describe the shim the adopted box is running"
    );

    let _ = adopted.stop().await;
    let _ = second.remove(box_id.as_str(), true).await;
    let _ = second.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
