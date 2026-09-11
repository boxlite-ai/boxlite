//! Integration tests for `BoxInfo::started_at`.
//!
//! The timestamp records the most recent box start: the transition into
//! `Running`. It does not describe workload readiness, exit, or completion.

mod common;

use boxlite::runtime::options::BoxliteOptions;
use boxlite::{AttachOptions, BoxliteRuntime};

#[tokio::test]
async fn started_at_tracks_the_running_lifecycle() {
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
        "creating a box must not claim that a lifecycle has started"
    );

    // `attach` initializes the lifecycle without launching the configured main
    // task. Publishing the shim and lifecycle timestamp is one state transition.
    let before_start = chrono::Utc::now();
    let attached = handle
        .attach(AttachOptions::main())
        .await
        .expect("attach to initialized box");
    let running = handle.info().await.expect("inspect running box");
    assert!(
        running.status.is_running(),
        "attach must leave the box Running, or this test is not observing the window"
    );
    assert!(
        running.pid.is_some(),
        "a box that published Running must name its shim"
    );
    let started_at = running
        .started_at
        .expect("entering Running must publish started_at");
    assert!(
        started_at >= before_start,
        "started_at {started_at} predates its Running publication ({before_start})"
    );

    handle.start().await.expect("start box");
    drop(attached);

    let info = handle.info().await.expect("inspect running box");
    assert_eq!(
        info.started_at,
        Some(started_at),
        "launching the configured main task must not rewrite the Running timestamp"
    );

    let _ = handle.stop().await;
    let _ = runtime.remove(box_id.as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn started_at_changes_for_a_fresh_lifecycle() {
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
        .expect("first Running transition must be recorded");

    handle.stop().await.expect("stop first lifecycle");

    assert_eq!(
        handle.info().await.expect("inspect stopped box").started_at,
        Some(first),
        "a stop must preserve when the lifecycle entered Running"
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
    let running_again = restarted
        .info()
        .await
        .expect("inspect second running lifecycle");
    let second = running_again
        .started_at
        .expect("second Running transition must be recorded");

    assert!(
        running_again.pid.is_some(),
        "a restarted box with started_at must name the shim running it"
    );
    assert!(
        second > first,
        "second record timestamp {second} does not follow the first ({first})"
    );

    assert_eq!(
        restarted
            .info()
            .await
            .expect("inspect second lifecycle again")
            .started_at,
        Some(second),
        "the second Running timestamp must remain stable after start returns"
    );

    let _ = restarted.stop().await;
    let _ = runtime.remove(box_id.as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn started_at_is_preserved_when_adopting_the_same_running_shim() {
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
            info.started_at
                .expect("detached box's Running transition must be recorded"),
            info.pid.expect("a running box has a shim pid"),
        )
    };

    // Reattaching to a still-running shim is not a new lifecycle, so the
    // timestamp for entering Running must survive.
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
        "adopting a live shim must not clear or rewrite its Running timestamp"
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
