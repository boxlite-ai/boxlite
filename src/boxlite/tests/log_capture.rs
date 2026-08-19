//! Integration tests for the durable-capture startup barrier.
//!
//! The barrier is the part of capture that must hold before the workload runs:
//! `begin` on disk, fsynced, or `Container.Init` fails. These tests exercise it
//! against a real guest rather than a mock, because the record's path is derived
//! independently on both sides of the VM boundary.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use std::path::{Path, PathBuf};

/// Locate the captured log without asking the host for the container id: the
/// guest derives this path from its own mount, so a test that reconstructs it
/// from host-side knowledge would pass even if the two sides disagreed.
fn captured_log(home_dir: &Path, box_id: &str) -> Option<PathBuf> {
    let containers = home_dir
        .join("boxes")
        .join(box_id)
        .join("shared")
        .join("containers");
    for entry in std::fs::read_dir(containers).ok()?.flatten() {
        let candidate = entry.path().join("output.log");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[tokio::test]
async fn capture_arms_a_begin_record_the_host_can_read() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime
        .create(
            BoxOptions {
                capture_logs: true,
                cmd: Some(vec!["sleep".into(), "300".into()]),
                ..common::alpine_opts()
            },
            None,
        )
        .await
        .unwrap();

    // Starting is what reaches `Container.Init`, and the barrier runs there.
    handle.start().await.expect("start box");

    let log = captured_log(&home.path, handle.id().as_str())
        .expect("capture must create output.log beside the container's exit file");
    let contents = std::fs::read_to_string(&log).expect("read captured log");

    // One line and nothing more: this slice arms capture, it does not yet stream
    // payload, so anything else here means the writer landed early or `begin`
    // was emitted twice.
    let lines: Vec<&str> = contents.lines().collect();
    assert_eq!(lines.len(), 1, "expected only begin, got {contents:?}");

    let (timestamp, rest) = lines[0].split_once(' ').expect("timestamped record");
    assert!(
        timestamp.ends_with('Z') && timestamp.contains('.'),
        "not RFC3339 with fractional seconds: {timestamp:?}"
    );
    let payload = rest
        .strip_prefix("boxlite F ")
        .expect("metadata rides the private boxlite stream, full frame");
    let record: serde_json::Value = serde_json::from_str(payload).expect("metadata is JSON");
    assert_eq!(record["event"], "begin");
    assert!(
        uuid::Uuid::parse_str(record["run"].as_str().expect("run id is a string")).is_ok(),
        "run id must be the host's UUID: {record:?}"
    );

    runtime.remove(handle.id().as_str(), true).await.unwrap();
}

/// Capture off must leave nothing behind — the file's absence is what tells a
/// reader "never captured" apart from "captured and lost".
#[tokio::test]
async fn no_log_is_created_when_capture_is_off() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime
        .create(
            BoxOptions {
                cmd: Some(vec!["sleep".into(), "300".into()]),
                ..common::alpine_opts()
            },
            None,
        )
        .await
        .unwrap();

    handle.start().await.expect("start box");

    assert!(
        captured_log(&home.path, handle.id().as_str()).is_none(),
        "capture was not requested, so no log may exist"
    );

    runtime.remove(handle.id().as_str(), true).await.unwrap();
}
