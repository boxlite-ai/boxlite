//! Integration tests for restart policy functionality.
//!
//! # Prerequisites
//!
//! These tests require a real VM environment:
//! 1. Build the runtime: `make runtime:debug`
//! 2. Run with: `cargo test -p boxlite --test restart_policy -- --test-threads=1`

mod common;

use boxlite::StopCause;
use boxlite::runtime::advanced_options::{AdvancedBoxOptions, HealthCheckOptions, RestartPolicy};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use boxlite::runtime::types::BoxStatus;
use common::box_test::BoxTestBase;
use std::process::Command;
use std::time::Duration;
use tokio::time::sleep;

/// Build `BoxOptions` with restart policy enabled.
fn restart_policy_opts(policy: RestartPolicy) -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        advanced: AdvancedBoxOptions {
            restart_policy: Some(policy),
            // Auto-enable health check for restart policy
            ..Default::default()
        },
        auto_remove: false,
        ..Default::default()
    }
}

/// Build `BoxOptions` with both restart policy and custom health check.
fn restart_and_health_opts(policy: RestartPolicy, interval: Duration) -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        advanced: AdvancedBoxOptions {
            restart_policy: Some(policy),
            health_check: Some(HealthCheckOptions {
                interval,
                timeout: Duration::from_secs(5),
                retries: 3,
                start_period: Duration::from_secs(5),
            }),
            ..Default::default()
        },
        auto_remove: false,
        ..Default::default()
    }
}

// ============================================================================
// RESTART POLICY: No
// ============================================================================

#[tokio::test]
async fn restart_policy_no_does_not_restart() {
    let t = BoxTestBase::with_options(restart_policy_opts(RestartPolicy::No)).await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Wait for health check to become healthy
    sleep(Duration::from_secs(5)).await;

    // Verify box is running
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Running);
    let shim_pid = info.pid.expect("No shim PID found");

    // Kill the shim process
    Command::new("kill")
        .arg("-9")
        .arg(shim_pid.to_string())
        .output()
        .expect("Failed to kill shim process");

    // Wait for health check to detect failure
    sleep(Duration::from_secs(8)).await;

    // Box should be stopped, not restarted (No policy)
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(
        info.status,
        BoxStatus::Stopped,
        "Expected box to be Stopped with No restart policy"
    );

    // Verify stop cause
    assert_eq!(info.stop_info.cause, StopCause::CrashedNoPolicy);
    assert_eq!(info.stop_info.restart_count, 1);
}

// ============================================================================
// RESTART POLICY: Always
// ============================================================================

#[tokio::test]
async fn restart_policy_always_restarts_on_crash() {
    let t = BoxTestBase::with_options(restart_and_health_opts(
        RestartPolicy::Always,
        Duration::from_secs(2),
    ))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Wait for health check to become healthy
    sleep(Duration::from_secs(5)).await;

    // Verify box is running
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Running);
    let original_pid = info.pid.expect("No shim PID found");

    // Kill the shim process
    Command::new("kill")
        .arg("-9")
        .arg(original_pid.to_string())
        .output()
        .expect("Failed to kill shim process");

    // Wait for restart to complete (health check interval + restart time)
    sleep(Duration::from_secs(10)).await;

    // Box should be running again with a new PID
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
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
}

// ============================================================================
// RESTART POLICY: OnFailure
// ============================================================================

#[tokio::test]
async fn restart_policy_on_failure_restarts_within_max_retries() {
    let t = BoxTestBase::with_options(restart_and_health_opts(
        RestartPolicy::OnFailure { max_retries: 2 },
        Duration::from_secs(2),
    ))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Wait for health check
    sleep(Duration::from_secs(5)).await;

    // Verify box is running
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Running);

    // First crash
    let shim_pid = info.pid.expect("No shim PID found");
    Command::new("kill")
        .arg("-9")
        .arg(shim_pid.to_string())
        .output()
        .expect("Failed to kill shim process");

    sleep(Duration::from_secs(10)).await;

    // Should restart (restart_count=1 < max_retries=2)
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Running);
    assert_eq!(info.stop_info.restart_count, 1);
}

#[tokio::test]
async fn restart_policy_on_failure_stops_after_max_retries() {
    let t = BoxTestBase::with_options(restart_and_health_opts(
        RestartPolicy::OnFailure { max_retries: 1 },
        Duration::from_secs(2),
    ))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Wait for health check
    sleep(Duration::from_secs(5)).await;

    // First crash
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    let shim_pid = info.pid.expect("No shim PID found");
    Command::new("kill")
        .arg("-9")
        .arg(shim_pid.to_string())
        .output()
        .expect("Failed to kill shim process");

    // Wait for first restart
    sleep(Duration::from_secs(10)).await;

    // Second crash
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    if info.status == BoxStatus::Running {
        let shim_pid = info.pid.expect("No shim PID found");
        Command::new("kill")
            .arg("-9")
            .arg(shim_pid.to_string())
            .output()
            .expect("Failed to kill shim process");

        // Wait for health check to detect and stop
        sleep(Duration::from_secs(10)).await;
    }

    // Should be stopped (max_retries exceeded)
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(
        info.status,
        BoxStatus::Stopped,
        "Expected box to be Stopped after max_retries exceeded"
    );
    assert_eq!(info.stop_info.cause, StopCause::MaxRetriesExceeded);
}

// ============================================================================
// RESTART POLICY: UnlessStopped
// ============================================================================

#[tokio::test]
async fn restart_policy_unless_stopped_restarts_on_crash() {
    let t = BoxTestBase::with_options(restart_and_health_opts(
        RestartPolicy::UnlessStopped,
        Duration::from_secs(2),
    ))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Wait for health check
    sleep(Duration::from_secs(5)).await;

    // Verify running
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Running);
    let shim_pid = info.pid.expect("No shim PID found");

    // Kill the shim
    Command::new("kill")
        .arg("-9")
        .arg(shim_pid.to_string())
        .output()
        .expect("Failed to kill shim process");

    // Wait for restart
    sleep(Duration::from_secs(10)).await;

    // Should be running again
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(
        info.status,
        BoxStatus::Running,
        "Expected box to be Running after auto-restart (UnlessStopped)"
    );
}

#[tokio::test]
async fn restart_policy_unless_stopped_stays_stopped_after_user_stop() {
    let t = BoxTestBase::with_options(restart_and_health_opts(
        RestartPolicy::UnlessStopped,
        Duration::from_secs(2),
    ))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Wait for health check
    sleep(Duration::from_secs(5)).await;

    // Verify running
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Running);

    // User explicitly stops the box
    t.bx.stop().await.expect("Failed to stop box");

    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Stopped);
    assert_eq!(info.stop_info.cause, StopCause::Normal);

    // Wait and verify it stays stopped (UnlessStopped should NOT restart after user stop)
    sleep(Duration::from_secs(5)).await;

    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(
        info.status,
        BoxStatus::Stopped,
        "UnlessStopped should not restart a user-stopped box"
    );
}

// ============================================================================
// RESTART ERROR TRACKING
// ============================================================================

#[tokio::test]
async fn restart_error_cleared_on_success() {
    let t = BoxTestBase::with_options(restart_and_health_opts(
        RestartPolicy::Always,
        Duration::from_secs(2),
    ))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");
    let box_id = t.bx.id().clone();

    // Wait for healthy
    sleep(Duration::from_secs(5)).await;

    // Crash and restart
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    let shim_pid = info.pid.expect("No shim PID found");
    Command::new("kill")
        .arg("-9")
        .arg(shim_pid.to_string())
        .output()
        .expect("Failed to kill shim process");

    sleep(Duration::from_secs(10)).await;

    // Verify running and no error
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.status, BoxStatus::Running);
    assert!(
        info.last_restart_error.is_none(),
        "Expected no restart error after successful restart"
    );
}
