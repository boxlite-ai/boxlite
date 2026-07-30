//! Integration tests for the box's `Container.Start` success record.
//!
//! The record is deliberately distinct from `BoxStatus::Running`: booting
//! publishes Running before the guest's separate `Container.Start` RPC runs, so
//! Running alone cannot say whether a box's init was ever launched. The cloud
//! runner reads this record to repair a startup whose job completion was lost,
//! which only works while the record names the shim that is running right now.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::BoxliteOptions;
use std::path::{Path, PathBuf};

/// The record's path, spelled out the way an outside reader derives it — the
/// cloud runner walks the same `{home}/boxes/{box_id}/started` layout from Go,
/// so this must not go through `BoxFilesystemLayout`.
fn started_file(home_dir: &Path, box_id: &str) -> PathBuf {
    home_dir.join("boxes").join(box_id).join("started")
}

/// Read the record as an outside reader would: raw JSON, by field name.
fn read_record(home_dir: &Path, box_id: &str) -> Option<(u32, i64)> {
    let contents = std::fs::read_to_string(started_file(home_dir, box_id)).ok()?;
    let json: serde_json::Value =
        serde_json::from_str(&contents).expect("record must be valid JSON");
    Some((
        json.get("pid")
            .and_then(serde_json::Value::as_u64)
            .expect("record must carry a pid field") as u32,
        json.get("at_unix_ms")
            .and_then(serde_json::Value::as_i64)
            .expect("record must carry an at_unix_ms field"),
    ))
}

#[tokio::test]
async fn start_record_tracks_the_shim_that_launched_init() {
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
        read_record(&home.path, box_id.as_str()).is_none(),
        "creating a container must not claim its init was launched"
    );

    let before_start = chrono::Utc::now().timestamp_millis();
    handle.start().await.expect("start box");

    let (recorded_pid, recorded_at) = read_record(&home.path, box_id.as_str())
        .expect("a successful Container.Start must be recorded");
    let live_pid = handle
        .info()
        .await
        .expect("inspect running box")
        .pid
        .expect("a running box has a shim pid");

    assert_eq!(
        recorded_pid, live_pid,
        "the record must name the shim that is running the box, or a reader cannot tell \
         it apart from a leftover"
    );
    assert!(
        recorded_at >= before_start,
        "record timestamp {recorded_at} predates the start that produced it ({before_start})"
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
    let (first_pid, first_at) =
        read_record(&home.path, box_id.as_str()).expect("first start must be recorded");

    handle.stop().await.expect("stop first lifecycle");

    // A spent handle cannot boot another VM, so the restart goes through a
    // fresh one — the same path the runner takes after a box has stopped.
    drop(handle);
    let restarted = runtime
        .get(box_id.as_str())
        .await
        .expect("get a fresh handle")
        .expect("box still exists");
    restarted.start().await.expect("start second lifecycle");

    let (second_pid, second_at) =
        read_record(&home.path, box_id.as_str()).expect("second start must be recorded");
    let live_pid = restarted
        .info()
        .await
        .expect("inspect restarted box")
        .pid
        .expect("a running box has a shim pid");

    assert_eq!(
        second_pid, live_pid,
        "the record must follow the new shim, not the one the first lifecycle used"
    );
    assert!(
        second_at >= first_at,
        "second record timestamp {second_at} predates the first ({first_at})"
    );
    assert_ne!(
        (first_pid, first_at),
        (second_pid, second_at),
        "the second lifecycle must replace the first record rather than inherit it"
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

    let (box_id, recorded) = {
        let first = BoxliteRuntime::new(options()).expect("create first runtime");
        let mut box_options = common::alpine_opts();
        box_options.detach = true;
        let handle = first
            .create(box_options, Some("start-record-adopt".to_string()))
            .await
            .expect("create detached box");
        handle.start().await.expect("start detached box");
        let box_id = handle.id().clone();
        let recorded =
            read_record(&home.path, box_id.as_str()).expect("detached start must be recorded");
        (box_id, recorded)
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
        read_record(&home.path, box_id.as_str()),
        Some(recorded),
        "adopting a live shim must not clear or rewrite its start record"
    );
    assert_eq!(
        adopted_info.pid,
        Some(recorded.0),
        "the preserved record must still name the shim the adopted box is running"
    );

    let _ = adopted.stop().await;
    let _ = second.remove(box_id.as_str(), true).await;
    let _ = second.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
