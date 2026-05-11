//! Integration tests for restart policy functionality.
//!
//! # Prerequisites
//!
//! These tests require a real VM environment:
//! 1. Build the runtime: `make runtime:debug`
//! 2. Run with: `cargo test -p boxlite --test restart_policy -- --test-threads=1`

mod common;

use boxlite::StopCause;
use boxlite::litebox::HealthState;
use boxlite::runtime::advanced_options::{AdvancedBoxOptions, HealthCheckOptions, RestartPolicy};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use boxlite::runtime::types::{BoxInfo, BoxStatus};
use boxlite::{BoxID, BoxliteRuntime};
use common::box_test::BoxTestBase;
use std::process::Command;
use std::time::Duration;
use tokio::time::{MissedTickBehavior, interval, timeout};

const STATUS_POLL_INTERVAL: Duration = Duration::from_millis(500);
const FAST_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const STATUS_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(200);
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_millis(500);
const HEALTH_CHECK_START_PERIOD: Duration = Duration::from_millis(0);

/// Build `BoxOptions` with both restart policy and custom health check.
fn restart_and_health_opts(policy: RestartPolicy) -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        advanced: AdvancedBoxOptions {
            restart_policy: Some(policy),
            health_check: Some(HealthCheckOptions {
                interval: HEALTH_CHECK_INTERVAL,
                timeout: HEALTH_CHECK_TIMEOUT,
                retries: 3,
                start_period: HEALTH_CHECK_START_PERIOD,
            }),
            ..Default::default()
        },
        auto_delete: Some(0),
        ..Default::default()
    }
}

/// Build `BoxOptions` with restart policy only.
fn restart_only_opts(policy: RestartPolicy) -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        advanced: AdvancedBoxOptions {
            restart_policy: Some(policy),
            health_check: None,
            ..Default::default()
        },
        auto_delete: Some(0),
        ..Default::default()
    }
}

async fn wait_for_info(
    runtime: &BoxliteRuntime,
    box_id: &BoxID,
    wait_timeout: Duration,
    description: &str,
    mut predicate: impl FnMut(&BoxInfo) -> bool,
) -> Option<BoxInfo> {
    wait_for_info_polling(
        runtime,
        box_id,
        wait_timeout,
        STATUS_POLL_INTERVAL,
        description,
        &mut predicate,
    )
    .await
}

async fn wait_for_info_polling(
    runtime: &BoxliteRuntime,
    box_id: &BoxID,
    wait_timeout: Duration,
    poll_interval: Duration,
    description: &str,
    mut predicate: impl FnMut(&BoxInfo) -> bool,
) -> Option<BoxInfo> {
    timeout(wait_timeout, async {
        let mut ticker = interval(poll_interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            ticker.tick().await;
            let info = runtime
                .get_info(box_id.as_str())
                .await
                .expect("get box info")
                .unwrap_or_else(|| {
                    panic!("box {} disappeared while waiting for {description}", box_id)
                });

            if predicate(&info) {
                return info;
            }
        }
    })
    .await
    .ok()
}

async fn wait_for_info_fast(
    runtime: &BoxliteRuntime,
    box_id: &BoxID,
    wait_timeout: Duration,
    description: &str,
    predicate: impl FnMut(&BoxInfo) -> bool,
) -> Option<BoxInfo> {
    wait_for_info_polling(
        runtime,
        box_id,
        wait_timeout,
        FAST_STATUS_POLL_INTERVAL,
        description,
        predicate,
    )
    .await
}

async fn expect_info(
    runtime: &BoxliteRuntime,
    box_id: &BoxID,
    description: &str,
    predicate: impl FnMut(&BoxInfo) -> bool,
) -> BoxInfo {
    wait_for_info(runtime, box_id, STATUS_WAIT_TIMEOUT, description, predicate)
        .await
        .unwrap_or_else(|| {
            panic!(
                "timed out after {:?} waiting for {description}",
                STATUS_WAIT_TIMEOUT
            )
        })
}

async fn expect_status(runtime: &BoxliteRuntime, box_id: &BoxID, status: BoxStatus) -> BoxInfo {
    expect_info(runtime, box_id, &format!("status {status}"), |info| {
        info.status == status
    })
    .await
}

async fn expect_restarted(runtime: &BoxliteRuntime, box_id: &BoxID, old_pid: u32) -> BoxInfo {
    expect_info(runtime, box_id, "box restart with a new shim PID", |info| {
        info.status == BoxStatus::Running && info.pid.is_some_and(|pid| pid != old_pid)
    })
    .await
}

fn kill_process(pid: u32) {
    Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .output()
        .expect("Failed to kill shim process");
}

async fn cleanup_box(t: &BoxTestBase, box_id: &BoxID) {
    t.runtime
        .remove(box_id.as_str(), true)
        .await
        .expect("remove restart-policy test box");
    t.runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .expect("shutdown restart-policy test runtime");
}

// ============================================================================
// RESTART POLICY: No
// ============================================================================

#[tokio::test]
async fn restart_policy_no_does_not_restart() {
    let t = BoxTestBase::with_options(restart_and_health_opts(RestartPolicy::No)).await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Verify box is running
    let info = expect_status(&t.runtime, &box_id, BoxStatus::Running).await;
    let shim_pid = info.pid.expect("No shim PID found");

    // Kill the shim process
    kill_process(shim_pid);

    // Box should be stopped, not restarted (No policy)
    let info = expect_status(&t.runtime, &box_id, BoxStatus::Stopped).await;
    assert_eq!(
        info.status,
        BoxStatus::Stopped,
        "Expected box to be Stopped with No restart policy"
    );

    // Verify stop cause
    assert_eq!(info.stop_info.cause, StopCause::CrashedNoPolicy);
    assert_eq!(info.stop_info.restart_count, 1);

    cleanup_box(&t, &box_id).await;
}

// ============================================================================
// RESTART POLICY: Always
// ============================================================================

#[tokio::test]
async fn restart_policy_always_restarts_on_crash() {
    let t = BoxTestBase::with_options(restart_and_health_opts(RestartPolicy::Always)).await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Verify box is running
    let info = expect_status(&t.runtime, &box_id, BoxStatus::Running).await;
    let original_pid = info.pid.expect("No shim PID found");

    // Kill the shim process
    kill_process(original_pid);

    // Box should be running again with a new PID
    let info = expect_restarted(&t.runtime, &box_id, original_pid).await;
    assert_eq!(
        info.status,
        BoxStatus::Running,
        "Expected box to be Running after auto-restart"
    );

    let new_pid = info.pid.expect("No shim PID found after restart");
    assert_ne!(
        original_pid, new_pid,
        "Expected new PID after restart, got same PID"
    );

    // After successful restart, stop_info is reset (restart_count=0, restarted_at set)
    assert_eq!(info.stop_info.restart_count, 0);
    assert!(info.stop_info.restarted_at.is_some());

    cleanup_box(&t, &box_id).await;
}

#[tokio::test]
async fn restart_policy_only_initializes_auto_health_status() {
    let t = BoxTestBase::with_options(restart_only_opts(RestartPolicy::Always)).await;

    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    let info = expect_status(&t.runtime, &box_id, BoxStatus::Running).await;
    assert_eq!(info.health_status.state, HealthState::Starting);
    assert_eq!(info.health_status.failures, 0);
    assert!(
        info.health_status.last_check.is_some(),
        "auto-enabled health check should initialize health status on start"
    );

    cleanup_box(&t, &box_id).await;
}

// ============================================================================
// RESTART POLICY: OnFailure
// ============================================================================

#[tokio::test]
async fn restart_policy_on_failure_restarts_within_max_retries() {
    let t = BoxTestBase::with_options(restart_and_health_opts(RestartPolicy::OnFailure {
        max_retries: 2,
    }))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Verify box is running
    let info = expect_status(&t.runtime, &box_id, BoxStatus::Running).await;

    // First crash
    let shim_pid = info.pid.expect("No shim PID found");
    kill_process(shim_pid);

    // Should restart because the first crash is within the retry budget.
    let info = expect_restarted(&t.runtime, &box_id, shim_pid).await;
    assert_eq!(info.status, BoxStatus::Running);
    assert_eq!(info.stop_info.restart_count, 0);
    assert!(info.stop_info.restarted_at.is_some());

    cleanup_box(&t, &box_id).await;
}

#[tokio::test]
async fn restart_policy_on_failure_zero_retries_stops_on_crash() {
    let t = BoxTestBase::with_options(restart_and_health_opts(RestartPolicy::OnFailure {
        max_retries: 0,
    }))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Crash the shim.
    let info = expect_status(&t.runtime, &box_id, BoxStatus::Running).await;
    let shim_pid = info.pid.expect("No shim PID found");
    kill_process(shim_pid);

    // With zero retries, the first failure exhausts the retry budget.
    let info = expect_status(&t.runtime, &box_id, BoxStatus::Stopped).await;
    assert_eq!(
        info.status,
        BoxStatus::Stopped,
        "Expected box to be Stopped when max_retries is zero"
    );
    assert_eq!(info.stop_info.cause, StopCause::MaxRetriesExceeded);
    assert_eq!(info.stop_info.restart_count, 1);

    cleanup_box(&t, &box_id).await;
}

// ============================================================================
// RESTART POLICY: UnlessStopped
// ============================================================================

#[tokio::test]
async fn restart_policy_unless_stopped_restarts_on_crash() {
    let t = BoxTestBase::with_options(restart_and_health_opts(RestartPolicy::UnlessStopped)).await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Verify running
    let info = expect_status(&t.runtime, &box_id, BoxStatus::Running).await;
    let shim_pid = info.pid.expect("No shim PID found");

    // Kill the shim
    kill_process(shim_pid);

    // Should be running again
    let info = expect_restarted(&t.runtime, &box_id, shim_pid).await;
    assert_eq!(
        info.status,
        BoxStatus::Running,
        "Expected box to be Running after auto-restart (UnlessStopped)"
    );

    cleanup_box(&t, &box_id).await;
}

#[tokio::test]
async fn restart_policy_unless_stopped_stays_stopped_after_user_stop() {
    let t = BoxTestBase::with_options(restart_and_health_opts(RestartPolicy::UnlessStopped)).await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Verify running
    expect_status(&t.runtime, &box_id, BoxStatus::Running).await;

    // User explicitly stops the box
    t.bx.stop().await.expect("Failed to stop box");

    let info = expect_status(&t.runtime, &box_id, BoxStatus::Stopped).await;
    assert_eq!(info.stop_info.cause, StopCause::Normal);

    // Verify it stays stopped (UnlessStopped should NOT restart after user stop)
    assert!(
        wait_for_info(
            &t.runtime,
            &box_id,
            Duration::from_secs(5),
            "unexpected restart after user stop",
            |info| info.status == BoxStatus::Running,
        )
        .await
        .is_none(),
        "UnlessStopped should not restart a user-stopped box"
    );

    let info = expect_status(&t.runtime, &box_id, BoxStatus::Stopped).await;
    assert_eq!(
        info.status,
        BoxStatus::Stopped,
        "UnlessStopped should not restart a user-stopped box"
    );

    cleanup_box(&t, &box_id).await;
}

#[tokio::test]
async fn restart_policy_unless_stopped_user_stop_race_stays_stopped() {
    let t = BoxTestBase::with_options(restart_and_health_opts(RestartPolicy::UnlessStopped)).await;

    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    let info = expect_status(&t.runtime, &box_id, BoxStatus::Running).await;
    let original_pid = info.pid.expect("No shim PID found");

    kill_process(original_pid);

    let stop = timeout(STATUS_WAIT_TIMEOUT, t.bx.stop());
    let crash_or_restart_observed = wait_for_info_fast(
        &t.runtime,
        &box_id,
        STATUS_WAIT_TIMEOUT,
        "crash or restart handling",
        |info| {
            matches!(
                info.status,
                BoxStatus::Crashed | BoxStatus::Restarting | BoxStatus::Stopped
            ) || (info.status == BoxStatus::Running && info.pid != Some(original_pid))
        },
    );

    let (stop_result, observed_info) = tokio::join!(stop, crash_or_restart_observed);
    observed_info.unwrap_or_else(|| {
        panic!(
            "timed out after {:?} waiting for crash or restart handling",
            STATUS_WAIT_TIMEOUT
        )
    });
    stop_result
        .expect("stop timed out while racing with crash handling")
        .expect("stop failed while racing with crash handling");

    let info = expect_status(&t.runtime, &box_id, BoxStatus::Stopped).await;
    assert_eq!(info.stop_info.cause, StopCause::Normal);
    assert!(
        info.pid.is_none(),
        "stopped box should not retain a shim PID"
    );

    assert!(
        wait_for_info(
            &t.runtime,
            &box_id,
            Duration::from_secs(5),
            "unexpected restart after user stop raced with crash recovery",
            |info| info.status == BoxStatus::Running,
        )
        .await
        .is_none(),
        "UnlessStopped should not restart after user stop wins the race"
    );

    cleanup_box(&t, &box_id).await;
}
