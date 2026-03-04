//! Integration tests for health check functionality.
//!
//! # Prerequisites
//!
//! These tests require a real VM environment:
//! 1. Build the runtime: `make runtime-debug`
//! 2. Run with: `cargo test -p boxlite --test health_check -- --test-threads=1`

mod common;

use boxlite::litebox::HealthState;
use boxlite::runtime::advanced_options::{AdvancedBoxOptions, HealthCheckOptions};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use boxlite::runtime::types::BoxStatus;
use common::box_test::BoxTestBase;
use std::process::Command;
use std::time::Duration;
use tokio::time::sleep;

/// Build `BoxOptions` with health check enabled.
fn health_check_opts(
    interval: Duration,
    timeout: Duration,
    retries: u32,
    start_period: Duration,
) -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        advanced: AdvancedBoxOptions {
            health_check: Some(HealthCheckOptions {
                interval,
                timeout,
                retries,
                start_period,
            }),
            ..Default::default()
        },
        auto_remove: false,
        ..Default::default()
    }
}

// ============================================================================
// CORE INTEGRATION TESTS
// ============================================================================

#[tokio::test]
async fn health_check_transitions_to_healthy_after_startup() {
    let t = BoxTestBase::with_options(health_check_opts(
        Duration::from_secs(2),
        Duration::from_secs(1),
        2,
        Duration::from_secs(1),
    ))
    .await;

    // Start the box
    t.bx.start().await.expect("Failed to start box");

    // Initially in Starting state during start_period
    let info = t
        .runtime
        .get_info(t.bx.id().as_str())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(info.health_status.state, HealthState::Starting);

    // Wait for start period to pass and first health check to complete
    sleep(Duration::from_secs(4)).await;

    // Should transition to Healthy after successful ping
    let info = t
        .runtime
        .get_info(t.bx.id().as_str())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        info.health_status.state,
        HealthState::Healthy,
        "Expected health state to be Healthy, got {:?}",
        info.health_status.state
    );
    assert_eq!(info.health_status.failures, 0);
}

#[tokio::test]
async fn health_check_becomes_unhealthy_when_shim_killed() {
    let t = BoxTestBase::with_options(health_check_opts(
        Duration::from_secs(2),
        Duration::from_secs(1),
        2,
        Duration::from_secs(1),
    ))
    .await;

    let box_id = t.bx.id().clone();

    // Start the box
    t.bx.start().await.expect("Failed to start box");

    // Wait for health check to become healthy
    sleep(Duration::from_secs(4)).await;

    // Verify initial healthy state
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(info.health_status.state, HealthState::Healthy);

    // Find and kill the shim process using BoxInfo
    let shim_pid = info.pid.expect("No shim PID found");
    println!("Killing shim process with PID: {}", shim_pid);

    Command::new("kill")
        .arg("-9")
        .arg(shim_pid.to_string())
        .output()
        .expect("Failed to kill shim process");

    // Wait for health check to detect the failure
    sleep(Duration::from_secs(5)).await;

    // Box should be stopped
    let info = t.runtime.get_info(box_id.as_str()).await.unwrap().unwrap();
    assert_eq!(
        info.status,
        BoxStatus::Stopped,
        "Expected box status to be Stopped, got {:?}",
        info.status
    );

    // Health status should indicate failures or unhealthy state
    let health_status = info.health_status;
    println!(
        "Health status after shim killed: state={:?}, failures={}",
        health_status.state, health_status.failures
    );
    assert!(
        health_status.state == HealthState::Unhealthy || health_status.failures > 0,
        "Expected unhealthy state or failures, got state={:?}, failures={}",
        health_status.state,
        health_status.failures
    );
}
