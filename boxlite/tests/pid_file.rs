//! Integration tests for PID file lifecycle.
//!
//! Tests the PID file as single source of truth for process tracking:
//! - PID file creation, correctness, and deletion
//! - Cleanup on stop, force remove, and box directory removal
//! - Process validation via is_same_process

mod common;

use boxlite::BoxliteRuntime;
use boxlite::litebox::BoxCommand;
use boxlite::runtime::options::BoxliteOptions;
use boxlite::runtime::types::BoxStatus;
use boxlite::util::{is_process_alive, is_same_process, read_pid_file};
use std::path::{Path, PathBuf};

// ============================================================================
// LOCAL HELPERS
// ============================================================================

/// Get the PID file path for a box under the given home directory.
fn pid_file_path(home_dir: &Path, box_id: &str) -> PathBuf {
    home_dir.join("boxes").join(box_id).join("shim.pid")
}

// ============================================================================
// BASIC FUNCTIONALITY (P0)
// ============================================================================

#[tokio::test]
async fn pid_file_created_on_box_start() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    // Run command to start the box
    let _ = handle.exec(BoxCommand::new("true")).await;

    // Verify PID file exists
    let pf = pid_file_path(&home.path, handle.id().as_str());
    assert!(pf.exists(), "PID file should exist after run");

    // Cleanup
    handle.stop().await.unwrap();
    runtime.remove(handle.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn pid_file_contains_correct_pid() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    // Start a long-running command
    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pf = pid_file_path(&home.path, handle.id().as_str());
    let pid_from_file = read_pid_file(&pf).expect("Should read PID file");

    // Verify process is actually running
    assert!(
        is_process_alive(pid_from_file),
        "PID {} should be a running process",
        pid_from_file
    );

    // Verify it's our boxlite-shim
    assert!(
        is_same_process(pid_from_file, handle.id().as_str()),
        "PID {} should belong to boxlite-shim for box {}",
        pid_from_file,
        handle.id()
    );

    // Cleanup
    handle.stop().await.unwrap();
    runtime.remove(handle.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn pid_file_deleted_on_normal_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pf = pid_file_path(&home.path, handle.id().as_str());
    assert!(pf.exists(), "PID file should exist before stop");

    handle.stop().await.unwrap();

    assert!(!pf.exists(), "PID file should be deleted after stop");

    // Cleanup
    runtime.remove(handle.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn pid_matches_box_info() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pf = pid_file_path(&home.path, handle.id().as_str());
    let pid_from_file = read_pid_file(&pf).expect("Should read PID file");

    let info = runtime
        .get_info(handle.id().as_str())
        .await
        .unwrap()
        .expect("Box should exist");

    assert_eq!(
        info.pid,
        Some(pid_from_file),
        "BoxInfo.pid should match PID file"
    );

    // Cleanup
    handle.stop().await.unwrap();
    runtime.remove(handle.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn pid_available_immediately_after_run() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Create and start box
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    // IMMEDIATELY check - no delay (this is the race condition fix)
    let info = runtime
        .get_info(handle.id().as_str())
        .await
        .unwrap()
        .expect("Box should exist");

    assert!(
        info.pid.is_some(),
        "PID should be available immediately after run"
    );
    assert_eq!(info.status, BoxStatus::Running, "Status should be Running");

    // PID file should also exist immediately
    let pf = pid_file_path(&home.path, handle.id().as_str());
    assert!(pf.exists(), "PID file should exist immediately");

    // Cleanup
    handle.stop().await.unwrap();
    runtime.remove(handle.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn pid_file_path_is_correct() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    let _ = handle.exec(BoxCommand::new("true")).await;

    // Expected path: {home}/boxes/{box_id}/shim.pid
    let expected = pid_file_path(&home.path, handle.id().as_str());
    assert!(expected.exists(), "PID file should be at expected path");

    // Verify no PID file in wrong locations
    let wrong1 = home.path.join("shim.pid");
    let wrong2 = home.path.join("boxes").join("shim.pid");
    assert!(!wrong1.exists(), "No PID file at home root");
    assert!(!wrong2.exists(), "No PID file at boxes root");

    // Cleanup
    handle.stop().await.unwrap();
    runtime.remove(handle.id().as_str(), false).await.unwrap();
}

// ============================================================================
// CLEANUP (P1)
// ============================================================================

#[tokio::test]
async fn force_remove_deletes_pid_file() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
    let box_id = handle.id().to_string();

    let pf = pid_file_path(&home.path, &box_id);
    assert!(pf.exists());

    // Force remove while running
    runtime.remove(&box_id, true).await.unwrap();

    assert!(!pf.exists(), "PID file should be deleted on force remove");
}

#[tokio::test]
async fn box_directory_cleanup_includes_pid_file() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    let box_id = handle.id().to_string();
    let _ = handle.exec(BoxCommand::new("true")).await;
    handle.stop().await.unwrap();

    runtime.remove(&box_id, false).await.unwrap();

    // Entire box directory should be gone
    let box_dir = home.path.join("boxes").join(&box_id);
    assert!(!box_dir.exists(), "Box directory should be removed");
}

// ============================================================================
// PROCESS VALIDATION (P1)
// ============================================================================

#[tokio::test]
async fn is_same_process_validates_boxlite_shim() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pf = pid_file_path(&home.path, handle.id().as_str());
    let pid = read_pid_file(&pf).unwrap();

    // Should be true for actual shim
    assert!(
        is_same_process(pid, handle.id().as_str()),
        "is_same_process should return true for actual shim process"
    );

    // Should be false for current test process
    assert!(
        !is_same_process(std::process::id(), handle.id().as_str()),
        "is_same_process should return false for non-shim process"
    );

    // Cleanup
    handle.stop().await.unwrap();
    runtime.remove(handle.id().as_str(), false).await.unwrap();
}
