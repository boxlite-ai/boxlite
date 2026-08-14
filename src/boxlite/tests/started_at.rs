//! Integration tests for `BoxInfo::started_at`.
//!
//! The timestamp records when a fresh box lifecycle publishes `Running`. It is
//! boot evidence, not proof that asynchronous `Container.Start` has finished.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::BoxliteOptions;

#[tokio::test]
async fn started_at_tracks_the_booted_shim() {
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
        "creating a container must not claim that a lifecycle was booted"
    );

    // `attach` brings the VM up and stops short of running init. Publishing the
    // new shim and its boot timestamp must be one persisted state transition.
    let before_boot = chrono::Utc::now();
    let attached = handle.attach(None).await.expect("attach to booted box");
    let booted = handle.info().await.expect("inspect booted box");
    assert!(
        booted.status.is_running(),
        "attach must leave the box Running, or this test is not observing the window"
    );
    assert!(
        booted.pid.is_some(),
        "a box that published Running must name its booted shim"
    );
    let booted_at = booted
        .started_at
        .expect("booting a box must publish started_at");
    assert!(
        booted_at >= before_boot,
        "boot timestamp {booted_at} predates the boot that produced it ({before_boot})"
    );

    handle.start().await.expect("start box");
    drop(attached);

    let info = handle.info().await.expect("inspect running box");
    assert_eq!(
        info.started_at,
        Some(booted_at),
        "starting the container must not rewrite the lifecycle's boot timestamp"
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
        .expect("first boot must be recorded");

    handle.stop().await.expect("stop first lifecycle");

    assert_eq!(
        handle.info().await.expect("inspect stopped box").started_at,
        Some(first),
        "a stop must preserve the boot record of the lifecycle that just ended"
    );

    // A spent handle cannot boot another VM, so the restart goes through a
    // fresh one — the same path the runner takes after a box has stopped.
    drop(handle);
    let restarted = runtime
        .get(box_id.as_str())
        .await
        .expect("get a fresh handle")
        .expect("box still exists");

    restarted
        .start()
        .await
        .expect("boot second lifecycle and enqueue Container.Start");
    let booted_again = restarted
        .info()
        .await
        .expect("inspect second booted lifecycle");
    let second = booted_again
        .started_at
        .expect("second boot must be recorded");

    assert!(
        booted_again.pid.is_some(),
        "a restarted box that recorded a boot must name the shim running it"
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
        "background Container.Start must not rewrite the second lifecycle's boot timestamp"
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
            info.started_at.expect("detached boot must be recorded"),
            info.pid.expect("a running box has a shim pid"),
        )
    };

    // Reattaching to a still-running shim is not a new lifecycle, so the boot
    // record that describes it must survive.
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
        "adopting a live shim must not clear or rewrite its boot record"
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
