//! Integration tests for PID file functionality.
//!
//! Tests the PID file as single source of truth for process tracking:
//! - PID file created in pre_exec (after fork, before exec)
//! - Recovery uses PID file instead of DB
//! - Detached boxes survive parent exit and can be recovered
//!
//! Test categories:
//! - P0 (Critical): Basic functionality, Detach mode, Recovery scenarios
//! - P1 (Important): Edge cases, Cleanup, Process validation

use boxlite::BoxliteRuntime;
use boxlite::litebox::BoxCommand;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite::runtime::types::BoxStatus;
use boxlite::util::{is_process_alive, is_same_process, read_pid_file};
use std::path::PathBuf;
use tempfile::TempDir;

// ============================================================================
// TEST FIXTURES
// ============================================================================

/// Test context with isolated runtime, temp directory access, and automatic cleanup.
struct TestContext {
    runtime: BoxliteRuntime,
    home_dir: PathBuf,
    _temp_dir: TempDir, // Dropped after test
}

impl TestContext {
    fn new() -> Self {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let home_dir = temp_dir.path().to_path_buf();
        let options = BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
        Self {
            runtime,
            home_dir,
            _temp_dir: temp_dir,
        }
    }

    /// Get the PID file path for a box.
    fn pid_file_path(&self, box_id: &str) -> PathBuf {
        self.home_dir.join("boxes").join(box_id).join("shim.pid")
    }
}

// ============================================================================
// CATEGORY 1: BASIC FUNCTIONALITY (P0)
// ============================================================================

#[tokio::test]
async fn pid_file_created_on_box_start() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    // Run command to start the box
    let _ = handle.exec(BoxCommand::new("true")).await;

    // Verify PID file exists
    let pid_file = ctx.pid_file_path(handle.id().as_str());
    assert!(pid_file.exists(), "PID file should exist after run");

    // Cleanup
    handle.stop().await.unwrap();
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn pid_file_contains_correct_pid() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    // Start a long-running command
    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pid_file = ctx.pid_file_path(handle.id().as_str());
    let pid_from_file = read_pid_file(&pid_file).expect("Should read PID file");

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
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn pid_file_deleted_on_normal_stop() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pid_file = ctx.pid_file_path(handle.id().as_str());
    assert!(pid_file.exists(), "PID file should exist before stop");

    handle.stop().await.unwrap();

    assert!(!pid_file.exists(), "PID file should be deleted after stop");

    // Cleanup
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn pid_matches_box_info() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pid_file = ctx.pid_file_path(handle.id().as_str());
    let pid_from_file = read_pid_file(&pid_file).expect("Should read PID file");

    let info = ctx
        .runtime
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
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn pid_available_immediately_after_run() {
    let ctx = TestContext::new();

    // Create and start box
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    // IMMEDIATELY check - no delay (this is the race condition fix)
    let info = ctx
        .runtime
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
    let pid_file = ctx.pid_file_path(handle.id().as_str());
    assert!(pid_file.exists(), "PID file should exist immediately");

    // Cleanup
    handle.stop().await.unwrap();
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn pid_file_path_is_correct() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("true")).await;

    // Expected path: {home}/boxes/{box_id}/shim.pid
    let expected = ctx.pid_file_path(handle.id().as_str());
    assert!(expected.exists(), "PID file should be at expected path");

    // Verify no PID file in wrong locations
    let wrong1 = ctx.home_dir.join("shim.pid");
    let wrong2 = ctx.home_dir.join("boxes").join("shim.pid");
    assert!(!wrong1.exists(), "No PID file at home root");
    assert!(!wrong2.exists(), "No PID file at boxes root");

    // Cleanup
    handle.stop().await.unwrap();
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .unwrap();
}

// ============================================================================
// CATEGORY 2: DETACH MODE (P0 - Original Issue)
// ============================================================================

#[tokio::test]
async fn detached_box_creates_pid_file() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                detach: true,
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;

    let pid_file = ctx.pid_file_path(handle.id().as_str());
    assert!(pid_file.exists(), "Detached box should have PID file");

    // Cleanup
    ctx.runtime
        .remove(handle.id().as_str(), true)
        .await
        .unwrap();
}

#[tokio::test]
async fn detached_box_survives_runtime_drop() {
    let temp_dir = TempDir::new().unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let box_id: String;
    let original_pid: u32;

    // Create detached box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: true,
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_id = handle.id().to_string();

        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        original_pid = read_pid_file(&pid_file).unwrap();

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
        home_dir,
        image_registries: vec![],
    })
    .unwrap();
    runtime.remove(&box_id, true).await.unwrap();
}

/// Non-detached box should exit when runtime drops (watchdog POLLHUP).
///
/// Symmetric counterpart to `detached_box_survives_runtime_drop`.
/// Verifies the full watchdog chain:
///   Keepalive drop → pipe close → shim POLLHUP → SIGTERM → process exit
#[tokio::test]
async fn non_detached_box_exits_on_runtime_drop() {
    // Use /tmp for shorter paths — macOS default TempDir paths exceed SUN_LEN for Unix sockets.
    let temp_dir = TempDir::new_in("/tmp").unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let original_pid: u32;

    // Create non-detached box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: false, // KEY: non-detached → watchdog active
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        handle
            .exec(BoxCommand::new("sleep").args(["300"]))
            .await
            .unwrap();

        let pid_file = home_dir
            .join("boxes")
            .join(handle.id().as_str())
            .join("shim.pid");
        original_pid = read_pid_file(&pid_file).unwrap();

        // Verify process is running before drop
        assert!(
            is_process_alive(original_pid),
            "Process {} should be alive before runtime drop",
            original_pid
        );

        // Runtime + handler + Keepalive drop here → POLLHUP → shim exit
    }

    // Wait for shim to detect POLLHUP and exit gracefully.
    // The chain: Keepalive drop → pipe close → poll() returns POLLHUP →
    // SIGTERM to self → Guest.Shutdown() RPC → process exit.
    // Allow generous timeout for guest shutdown RPC.
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
async fn detached_box_recoverable_after_restart() {
    let temp_dir = TempDir::new().unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let box_id: String;

    // Create and run detached box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: true,
                    auto_remove: false,
                    ..Default::default()
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
            home_dir,
            image_registries: vec![],
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

#[tokio::test]
async fn multiple_detached_boxes_each_have_pid_file() {
    let ctx = TestContext::new();
    let mut box_ids = Vec::new();

    // Create 3 detached boxes
    for _ in 0..3 {
        let handle = ctx
            .runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: true,
                    auto_remove: false,
                    ..Default::default()
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
        let pid_file = ctx.pid_file_path(box_id);
        assert!(pid_file.exists(), "Box {} should have PID file", box_id);
        let pid = read_pid_file(&pid_file).unwrap();
        assert!(
            pids.insert(pid),
            "Each box should have unique PID, but {} is duplicate",
            pid
        );
    }

    // Cleanup
    for box_id in box_ids {
        ctx.runtime.remove(&box_id, true).await.unwrap();
    }
}

// ============================================================================
// CATEGORY 3: RECOVERY SCENARIOS (P0)
// ============================================================================

#[tokio::test]
async fn recovery_with_live_process() {
    let temp_dir = TempDir::new().unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let box_id: String;
    let original_pid: u32;

    // Create box with detach=true
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: true,
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_id = handle.id().to_string();

        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        original_pid = read_pid_file(&pid_file).unwrap();
    }

    // New runtime should recover
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir,
            image_registries: vec![],
        })
        .unwrap();

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");

        assert_eq!(info.status, BoxStatus::Running);
        assert_eq!(info.pid, Some(original_pid), "PID should match original");

        // Cleanup
        runtime.remove(&box_id, true).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_with_dead_process() {
    let temp_dir = TempDir::new().unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let box_id: String;
    let original_pid: u32;

    // Create box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: true,
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_id = handle.id().to_string();

        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        original_pid = read_pid_file(&pid_file).unwrap();

        // Kill process directly (simulate crash)
        unsafe {
            libc::kill(original_pid as i32, libc::SIGKILL);
        }

        // Wait for process to die
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // New runtime should detect dead process
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");

        assert_eq!(
            info.status,
            BoxStatus::Stopped,
            "Dead process should be marked Stopped"
        );
        assert!(info.pid.is_none(), "Stopped box should have no PID");

        // PID file should be deleted
        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        assert!(
            !pid_file.exists(),
            "Stale PID file should be deleted during recovery"
        );

        // Cleanup
        runtime.remove(&box_id, false).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_with_missing_pid_file() {
    let temp_dir = TempDir::new().unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let box_id: String;

    // Create box and delete PID file
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: true,
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_id = handle.id().to_string();

        // Manually delete PID file
        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        std::fs::remove_file(&pid_file).unwrap();
    }

    // New runtime should handle missing PID file gracefully
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir,
            image_registries: vec![],
        })
        .unwrap();

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");

        assert_eq!(
            info.status,
            BoxStatus::Stopped,
            "Missing PID file should result in Stopped status"
        );

        // Cleanup
        runtime.remove(&box_id, true).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_with_corrupted_pid_file() {
    let temp_dir = TempDir::new().unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let box_id: String;

    // Create box and corrupt PID file
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: true,
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
        box_id = handle.id().to_string();

        // Corrupt PID file
        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        std::fs::write(&pid_file, "not-a-valid-pid").unwrap();
    }

    // New runtime should handle corrupted PID file gracefully
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");

        assert_eq!(
            info.status,
            BoxStatus::Stopped,
            "Corrupted PID file should result in Stopped status"
        );

        // Corrupted PID file should be deleted
        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        assert!(!pid_file.exists(), "Corrupted PID file should be deleted");

        // Cleanup
        runtime.remove(&box_id, true).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_preserves_stopped_boxes() {
    let temp_dir = TempDir::new().unwrap();
    let home_dir = temp_dir.path().to_path_buf();
    let box_id: String;

    // Create and stop box normally
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: vec![],
        })
        .unwrap();

        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let _ = handle.exec(BoxCommand::new("true")).await;
        box_id = handle.id().to_string();

        // Stop normally
        handle.stop().await.unwrap();

        // Verify PID file is gone
        let pid_file = home_dir.join("boxes").join(&box_id).join("shim.pid");
        assert!(!pid_file.exists());
    }

    // New runtime should see stopped box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir,
            image_registries: vec![],
        })
        .unwrap();

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");

        assert_eq!(info.status, BoxStatus::Stopped);
        assert!(info.pid.is_none());

        // Cleanup
        runtime.remove(&box_id, false).await.unwrap();
    }
}

// ============================================================================
// CATEGORY 4: EDGE CASES (P1)
// ============================================================================

#[test]
fn read_pid_file_with_whitespace() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), "  12345\n\n").unwrap();

    let pid = read_pid_file(temp.path()).unwrap();
    assert_eq!(pid, 12345);
}

#[test]
fn read_pid_file_invalid_content_rejected() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), "not-a-pid").unwrap();

    let result = read_pid_file(temp.path());
    assert!(result.is_err());
}

#[test]
fn read_pid_file_empty_rejected() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), "").unwrap();

    let result = read_pid_file(temp.path());
    assert!(result.is_err());
}

#[test]
fn read_pid_file_missing_returns_error() {
    let result = read_pid_file(std::path::Path::new("/nonexistent/shim.pid"));
    assert!(result.is_err());
}

#[test]
fn read_pid_file_large_pid() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), "4194304").unwrap(); // Max PID on Linux

    let pid = read_pid_file(temp.path()).unwrap();
    assert_eq!(pid, 4194304);
}

#[test]
fn read_pid_file_negative_rejected() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), "-1").unwrap();

    let result = read_pid_file(temp.path());
    assert!(result.is_err());
}

#[test]
fn read_pid_file_overflow_rejected() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(temp.path(), "99999999999").unwrap();

    let result = read_pid_file(temp.path());
    assert!(result.is_err());
}

// ============================================================================
// CATEGORY 5: CLEANUP (P1)
// ============================================================================

#[tokio::test]
async fn force_remove_deletes_pid_file() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["300"])).await;
    let box_id = handle.id().to_string();

    let pid_file = ctx.pid_file_path(&box_id);
    assert!(pid_file.exists());

    // Force remove while running
    ctx.runtime.remove(&box_id, true).await.unwrap();

    assert!(
        !pid_file.exists(),
        "PID file should be deleted on force remove"
    );
}

#[tokio::test]
async fn box_directory_cleanup_includes_pid_file() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let box_id = handle.id().to_string();
    let _ = handle.exec(BoxCommand::new("true")).await;
    handle.stop().await.unwrap();

    ctx.runtime.remove(&box_id, false).await.unwrap();

    // Entire box directory should be gone
    let box_dir = ctx.home_dir.join("boxes").join(&box_id);
    assert!(!box_dir.exists(), "Box directory should be removed");
}

// ============================================================================
// CATEGORY 7: PROCESS VALIDATION (P1)
// ============================================================================

#[tokio::test]
async fn is_same_process_validates_boxlite_shim() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let _ = handle.exec(BoxCommand::new("sleep").args(["30"])).await;

    let pid_file = ctx.pid_file_path(handle.id().as_str());
    let pid = read_pid_file(&pid_file).unwrap();

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
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .unwrap();
}

#[test]
fn is_process_alive_true_for_current() {
    assert!(
        is_process_alive(std::process::id()),
        "Current process should be alive"
    );
}

#[test]
fn is_process_alive_false_for_invalid() {
    // Very high PIDs unlikely to exist
    assert!(!is_process_alive(999999999));
    assert!(!is_process_alive(888888888));
}
