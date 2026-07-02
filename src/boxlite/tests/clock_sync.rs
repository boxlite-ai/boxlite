//! Integration tests for guest wall-clock synchronization after quiesce.
//!
//! Simulates post-sleep clock drift by setting the guest clock back, then
//! verifies that a running-box snapshot (quiesce Phase 6) resyncs guest time
//! to the host.
//!
//! Run with:
//!
//! ```sh
//! make test:integration:rust FILTER=clock_sync
//! ```

mod common;

use boxlite::runtime::options::BoxliteOptions;
use boxlite::runtime::types::BoxStatus;
use boxlite::{BoxCommand, BoxliteRuntime, LiteBox, SnapshotOptions};
use tokio_stream::StreamExt;

const DRIFT_SECS: i64 = 3600;
const SYNC_TOLERANCE_SECS: i64 = 5;

async fn exec_stdout(handle: &LiteBox, cmd: BoxCommand) -> String {
    let mut execution = handle.exec(cmd).await.expect("exec failed");

    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }

    let result = execution.wait().await.expect("wait failed");
    assert_eq!(result.exit_code, 0, "command should exit 0");
    stdout
}

async fn guest_unix_secs(handle: &LiteBox) -> i64 {
    let out = exec_stdout(handle, BoxCommand::new("date").arg("+%s")).await;
    out.trim()
        .parse()
        .expect("guest date +%s should parse as i64")
}

fn host_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("host clock before UNIX epoch")
        .as_secs() as i64
}

fn clock_skew_secs(host_secs: i64, guest_secs: i64) -> i64 {
    (host_secs - guest_secs).abs()
}

async fn set_guest_clock_back(handle: &LiteBox, secs: i64) {
    handle
        .simulate_clock_drift_secs(secs)
        .await
        .expect("simulate_clock_drift_secs failed");
}

async fn create_running_box(runtime: &BoxliteRuntime, name: &str) -> LiteBox {
    let litebox = runtime
        .create(common::alpine_opts(), Some(name.to_string()))
        .await
        .expect("Failed to create box");

    litebox.start().await.expect("Failed to start box");
    assert_eq!(litebox.info().status, BoxStatus::Running);

    litebox
}

/// Quiesce on a running box (snapshot create) should resync guest wall clock.
#[tokio::test]
async fn test_quiesce_resyncs_guest_clock_after_drift() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let litebox = create_running_box(&runtime, "clock-sync").await;

    let host_before = host_unix_secs();
    let guest_before = guest_unix_secs(&litebox).await;
    assert!(
        clock_skew_secs(host_before, guest_before) < 120,
        "guest should start roughly aligned with host (skew={}s, host={}, guest={})",
        clock_skew_secs(host_before, guest_before),
        host_before,
        guest_before
    );

    set_guest_clock_back(&litebox, DRIFT_SECS).await;
    let guest_drifted = guest_unix_secs(&litebox).await;
    let host_after_drift = host_unix_secs();
    let drift = host_after_drift - guest_drifted;
    assert!(
        drift >= DRIFT_SECS - 30,
        "guest clock should be ~{DRIFT_SECS}s behind host after date -s (drift={drift}s)"
    );

    litebox
        .snapshots()
        .create(SnapshotOptions::default(), "after-drift")
        .await
        .expect("snapshot on running box should succeed");

    assert_eq!(litebox.info().status, BoxStatus::Running);

    let guest_resynced = guest_unix_secs(&litebox).await;
    let host_after_sync = host_unix_secs();
    let skew = clock_skew_secs(host_after_sync, guest_resynced);
    assert!(
        skew < SYNC_TOLERANCE_SECS,
        "guest clock should realign after quiesce sync (skew={skew}s, host={host_after_sync}, guest={guest_resynced})"
    );

    litebox.stop().await.expect("stop failed");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
