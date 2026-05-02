//! Integration tests for detach mode behavior.
//!
//! Verifies detached boxes survive runtime drop, non-detached boxes exit
//! via watchdog POLLHUP, and detached boxes can be recovered after restart.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::litebox::BoxCommand;
use boxlite::runtime::options::BoxliteOptions;
use boxlite::runtime::types::BoxStatus;
use boxlite::util::{is_process_alive, read_pid_file};
use std::path::{Path, PathBuf};

// ============================================================================
// LOCAL HELPERS
// ============================================================================

/// Get the PID file path for a box under the given home directory.
fn pid_file_path(home_dir: &Path, box_id: &str) -> PathBuf {
    home_dir.join("boxes").join(box_id).join("shim.pid")
}

// ============================================================================
// DETACH MODE TESTS
// ============================================================================

#[tokio::test]
async fn detached_box_creates_pid_file() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime
        .create(
            boxlite::runtime::options::BoxOptions {
                detach: true,
                ..common::alpine_opts()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;

    let pf = pid_file_path(&home.path, handle.id().as_str());
    assert!(pf.exists(), "Detached box should have PID file");

    // Cleanup
    runtime.remove(handle.id().as_str(), true).await.unwrap();
}

#[tokio::test]
async fn detached_box_survives_runtime_drop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;
    let original_pid: u32;

    // Create detached box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime
            .create(
                boxlite::runtime::options::BoxOptions {
                    detach: true,
                    ..common::alpine_opts()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_id = handle.id().to_string();

        let pf = pid_file_path(&home.path, &box_id);
        original_pid = read_pid_file(&pf).unwrap();

        // Runtime drops here - box should survive
    }

    // Wait a moment
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Verify process still alive
    assert!(
        is_process_alive(original_pid),
        "Detached box process {} should survive runtime drop",
        original_pid
    );

    // Cleanup
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();
    runtime.remove(&box_id, true).await.unwrap();
}

/// Non-detached box should exit when runtime drops (watchdog POLLHUP).
///
/// Symmetric counterpart to `detached_box_survives_runtime_drop`.
/// Verifies the full watchdog chain:
///   Keepalive drop -> pipe close -> shim POLLHUP -> SIGTERM -> process exit
#[tokio::test]
async fn non_detached_box_exits_on_runtime_drop() {
    // Use /tmp for shorter paths -- macOS default TempDir paths exceed SUN_LEN for Unix sockets.
    let home = boxlite_test_utils::home::PerTestBoxHome::new_in("/tmp");
    let home_dir = home.path.clone();
    let original_pid: u32;

    // Create non-detached box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

        handle
            .exec(BoxCommand::new("sleep").args(["300"]))
            .await
            .unwrap();

        let pf = pid_file_path(&home_dir, handle.id().as_str());
        original_pid = read_pid_file(&pf).unwrap();

        // Verify process is running before drop
        assert!(
            is_process_alive(original_pid),
            "Process {} should be alive before runtime drop",
            original_pid
        );

        // Runtime + handler + Keepalive drop here -> POLLHUP -> shim exit
    }

    // Wait for shim to detect POLLHUP and exit gracefully.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if !is_process_alive(original_pid) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // Verify process exited
    assert!(
        !is_process_alive(original_pid),
        "Non-detached box process {} should exit after runtime drop (watchdog POLLHUP)",
        original_pid
    );
}

#[tokio::test]
async fn multiple_detached_boxes_each_have_pid_file() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let mut box_ids = Vec::new();

    // Create 3 detached boxes
    for _ in 0..3 {
        let handle = runtime
            .create(
                boxlite::runtime::options::BoxOptions {
                    detach: true,
                    ..common::alpine_opts()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_ids.push(handle.id().to_string());
    }

    // Verify each has unique PID file with different PID
    let mut pids = std::collections::HashSet::new();
    for box_id in &box_ids {
        let pf = pid_file_path(&home.path, box_id);
        assert!(pf.exists(), "Box {} should have PID file", box_id);
        let pid = read_pid_file(&pf).unwrap();
        assert!(
            pids.insert(pid),
            "Each box should have unique PID, but {} is duplicate",
            pid
        );
    }

    // Cleanup
    for box_id in box_ids {
        runtime.remove(&box_id, true).await.unwrap();
    }
}

// ============================================================================
// DETACH + RECOVERY TEST
// ============================================================================

#[tokio::test]
async fn detached_box_recoverable_after_restart() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;

    // Create and run detached box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime
            .create(
                boxlite::runtime::options::BoxOptions {
                    detach: true,
                    ..common::alpine_opts()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_id = handle.id().to_string();
    }

    // Create NEW runtime - should recover the box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        // Should recover the box
        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should be recovered");

        assert_eq!(
            info.status,
            BoxStatus::Running,
            "Box should be recovered as Running"
        );
        assert!(info.pid.is_some(), "Recovered box should have PID");

        // Should be able to stop it
        let handle = runtime.get(&box_id).await.unwrap().unwrap();
        handle.stop().await.unwrap();

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");
        assert_eq!(info.status, BoxStatus::Stopped);

        // Cleanup
        runtime.remove(&box_id, false).await.unwrap();
    }
}
