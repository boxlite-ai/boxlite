//! Integration tests for runtime recovery scenarios.
//!
//! Verifies that BoxliteRuntime correctly recovers box state on restart:
//! live/dead/missing/corrupt processes, stopped boxes, auto-remove cleanup,
//! and orphaned entries.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::StopCause;
use boxlite::litebox::BoxCommand;
use boxlite::runtime::advanced_options::{AdvancedBoxOptions, RestartPolicy};
use boxlite::runtime::id::BoxID;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::runtime::types::BoxStatus;
use boxlite::util::read_pid_file;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use tokio::time::{Duration, sleep};

// ============================================================================
// LOCAL HELPERS
// ============================================================================

/// Get the PID file path for a box under the given home directory.
fn pid_file_path(home_dir: &Path, box_id: &str) -> PathBuf {
    home_dir.join("boxes").join(box_id).join("shim.pid")
}

/// Get the exit file path for a box under the given home directory.
fn exit_file_path(home_dir: &Path, box_id: &str) -> PathBuf {
    home_dir.join("boxes").join(box_id).join("exit")
}

/// Write exit file with given exit code and message.
fn write_exit_file(path: &Path, exit_code: i32, message: &str) {
    let json = format!(
        r#"{{"type":"error","exit_code":{},"message":"{}"}}"#,
        exit_code, message
    );
    std::fs::write(path, json).expect("Failed to write exit file");
}

/// Helper to create OnFailure policy options.
fn on_failure_opts(max_retries: u32) -> BoxOptions {
    BoxOptions {
        advanced: AdvancedBoxOptions {
            restart_policy: Some(RestartPolicy::OnFailure { max_retries }),
            ..Default::default()
        },
        ..common::alpine_opts()
    }
}

/// Helper to create UnlessStopped policy options.
fn unless_stopped_opts() -> BoxOptions {
    BoxOptions {
        advanced: AdvancedBoxOptions {
            restart_policy: Some(RestartPolicy::UnlessStopped),
            ..Default::default()
        },
        ..common::alpine_opts()
    }
}

/// Helper to create Always policy options.
fn always_opts() -> BoxOptions {
    BoxOptions {
        advanced: AdvancedBoxOptions {
            restart_policy: Some(RestartPolicy::Always),
            ..Default::default()
        },
        ..common::alpine_opts()
    }
}

/// Wait for shim.pid to appear.
async fn wait_for_shim_pid(home_dir: &Path, box_id: &str) -> u32 {
    let pid_path = pid_file_path(home_dir, box_id);

    for _ in 0..20 {
        if let Ok(pid) = read_pid_file(&pid_path) {
            return pid;
        }
        sleep(Duration::from_millis(500)).await;
    }

    panic!("shim.pid did not appear for box {}", box_id);
}

/// Manually update box state in database to simulate a crashed box.
fn set_box_state_crashed(home_dir: &Path, box_id: &str, restart_count: u32, stop_cause: &str) {
    let db_path = home_dir.join("db").join("boxes.db");
    let conn = rusqlite::Connection::open(&db_path).expect("Failed to open database");

    // Get current state JSON
    let mut stmt = conn
        .prepare("SELECT json FROM box_state WHERE id = ?1")
        .expect("Failed to prepare select");
    let json: String = stmt
        .query_row([box_id], |row| row.get(0))
        .expect("Failed to get state JSON");
    drop(stmt);

    // Parse and modify state
    let mut state: serde_json::Value = serde_json::from_str(&json).expect("Failed to parse state");
    state["status"] = serde_json::json!(BoxStatus::Crashed.as_str());
    state["pid"] = serde_json::json!(null);
    state["stop_info"]["restart_count"] = serde_json::json!(restart_count);
    state["stop_info"]["cause"] = serde_json::json!(stop_cause);

    let new_json = serde_json::to_string(&state).expect("Failed to serialize state");

    // Update database
    conn.execute(
        "UPDATE box_state SET status = ?1, pid = ?2, json = ?3 WHERE id = ?4",
        rusqlite::params![BoxStatus::Crashed.as_str(), None::<i32>, new_json, box_id],
    )
    .expect("Failed to update state");
}

// ============================================================================
// RECOVERY WITH PROCESS STATE (P0)
// ============================================================================

#[tokio::test]
async fn recovery_with_live_process() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;
    let original_pid: u32;

    // Create box with detach=true
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
    }

    // New runtime should recover
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
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
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;

    // Create box
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
        let original_pid = read_pid_file(&pf).unwrap();

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
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
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
        let pf = pid_file_path(&home.path, &box_id);
        assert!(
            !pf.exists(),
            "Stale PID file should be deleted during recovery"
        );

        // Cleanup
        runtime.remove(&box_id, false).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_with_missing_pid_file() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;

    // Create box and delete PID file
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

        // Manually delete PID file
        let pf = pid_file_path(&home.path, &box_id);
        std::fs::remove_file(&pf).unwrap();
    }

    // New runtime should handle missing PID file gracefully
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
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
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;

    // Create box and corrupt PID file
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

        // Corrupt PID file
        let pf = pid_file_path(&home.path, &box_id);
        std::fs::write(&pf, "not-a-valid-pid").unwrap();
    }

    // New runtime should handle corrupted PID file gracefully
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
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
        let pf = pid_file_path(&home.path, &box_id);
        assert!(!pf.exists(), "Corrupted PID file should be deleted");

        // Cleanup
        runtime.remove(&box_id, true).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_preserves_stopped_boxes() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;

    // Create and stop box normally
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime.create(common::alpine_opts(), None).await.unwrap();

        let _ = handle.exec(BoxCommand::new("true")).await;
        box_id = handle.id().to_string();

        // Stop normally
        handle.stop().await.unwrap();

        // Verify PID file is gone
        let pf = pid_file_path(&home.path, &box_id);
        assert!(!pf.exists());
    }

    // New runtime should see stopped box
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
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
// RECOVERY CLEANUP (P1)
// ============================================================================

#[tokio::test]
async fn recovery_removes_auto_remove_true_boxes() {
    // Test that boxes with auto_remove=true are removed during recovery
    // This simulates a crash scenario where boxes weren't properly cleaned up
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let home_dir = temp_dir.path().to_path_buf();

    let persistent_box_id: BoxID;

    // Create two boxes: one with auto_remove=true, one with auto_remove=false
    {
        let options = BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");

        // Create auto_remove=true box (should be cleaned up on recovery)
        let auto_remove_box = runtime
            .create(common::alpine_opts_auto(), None)
            .await
            .unwrap();

        // Create auto_remove=false box (should persist)
        let persistent_box = runtime.create(common::alpine_opts(), None).await.unwrap();
        persistent_box_id = persistent_box.id().clone();

        // Both boxes should exist before shutdown
        assert!(runtime.exists(auto_remove_box.id().as_str()).await.unwrap());
        assert!(runtime.exists(persistent_box_id.as_str()).await.unwrap());

        // Stop the persistent box normally (it stays in DB)
        persistent_box.stop().await.unwrap();

        // Verify both exist in DB (auto_remove box is still Starting)
        assert_eq!(runtime.list_info().await.unwrap().len(), 2);

        // Drop runtime without stopping auto_remove_box - simulates crash
        // The box will remain in database but should be cleaned on recovery
    }

    // Create new runtime with same home directory (simulates restart)
    {
        let options = BoxliteOptions {
            home_dir,
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime after restart");

        // auto_remove=true box should be removed during recovery
        // auto_remove=false box should be recovered
        let boxes = runtime.list_info().await.unwrap();
        assert_eq!(
            boxes.len(),
            1,
            "Only persistent box should survive recovery"
        );
        assert_eq!(
            boxes[0].id, persistent_box_id,
            "Recovered box should be the persistent one"
        );

        // Cleanup
        runtime
            .remove(persistent_box_id.as_str(), false)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn recovery_removes_orphaned_stopped_boxes_without_directory() {
    // Test that stopped boxes without directories are KEPT during recovery
    // (They might have been created but never started, which is valid).
    // Use PerTestBoxHome::new() so the image cache is available for start().
    let home = boxlite_test_utils::home::PerTestBoxHome::new();

    let box_id: BoxID;
    let box_home: PathBuf;

    // Create a box, stop it (persists), then delete directory
    {
        let options = BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");

        let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
        box_id = litebox.id().clone();
        box_home = home.path.join("boxes").join(box_id.as_str());

        // Start first so stop() persists Stopped status.
        litebox.start().await.unwrap();

        // Stop the box (persists to DB with status=Stopped)
        litebox.stop().await.unwrap();

        // Box should be persisted
        assert!(runtime.exists(box_id.as_str()).await.unwrap());
    }

    // Delete the box's directory (simulating it was never created or manually deleted)
    if box_home.exists() {
        std::fs::remove_dir_all(&box_home).expect("Failed to delete box directory");
    }

    // Create new runtime with same home directory (simulates restart)
    {
        let options = BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime after restart");

        // Stopped box without directory should be KEPT (it might never have been started)
        // Recovery only removes active (Starting/Running) boxes that are missing directories
        let boxes = runtime.list_info().await.unwrap();
        assert_eq!(
            boxes.len(),
            1,
            "Stopped box without directory should be kept"
        );
        assert_eq!(
            boxes[0].id, box_id,
            "Box should be recovered even without directory"
        );
        assert_eq!(
            boxes[0].status,
            BoxStatus::Stopped,
            "Box should remain in Stopped status"
        );

        // Cleanup
        runtime.remove(box_id.as_str(), false).await.unwrap();
    }
}

// ============================================================================
// RECOVERY WITH RESTART POLICY EVALUATION
// ============================================================================

#[tokio::test]
async fn recovery_on_failure_respects_max_retries() {
    // Test: When restart_count >= max_retries, box should NOT auto-restart during recovery
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;
    let shim_pid: u32;

    // Create box with OnFailure policy and max_retries=2
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime.create(on_failure_opts(2), None).await.unwrap();

        handle.start().await.unwrap();
        box_id = handle.id().to_string();
        shim_pid = wait_for_shim_pid(&home.path, &box_id).await;
    }

    // Kill shim and write exit file (non-zero exit to indicate failure)
    unsafe {
        libc::kill(shim_pid as i32, libc::SIGKILL);
    }
    sleep(Duration::from_millis(200)).await;
    write_exit_file(&exit_file_path(&home.path, &box_id), 1, "error");

    // Manually set restart_count to max_retries (2) to simulate exhausted retries
    set_box_state_crashed(&home.path, &box_id, 2, "MaxRetriesExceeded");

    // Recovery should NOT auto-restart because restart_count >= max_retries
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        // Wait a bit for recovery to complete
        sleep(Duration::from_secs(2)).await;

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");

        assert_eq!(
            info.status,
            BoxStatus::Stopped,
            "Box with exhausted max_retries should be Stopped, not restarted"
        );
        assert!(info.pid.is_none(), "Stopped box should have no PID");

        // Verify stop cause indicates max retries exceeded
        assert_eq!(
            info.stop_info.cause,
            StopCause::MaxRetriesExceeded,
            "Stop cause should be MaxRetriesExceeded"
        );

        runtime.remove(&box_id, false).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_unless_stopped_does_not_restart_normal_stop() {
    // Test: UnlessStopped policy should NOT restart if stop cause is Normal
    // (i.e., box was manually stopped, not crashed)
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;
    let shim_pid: u32;

    // Create box with UnlessStopped policy
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime.create(unless_stopped_opts(), None).await.unwrap();

        handle.start().await.unwrap();
        box_id = handle.id().to_string();
        shim_pid = wait_for_shim_pid(&home.path, &box_id).await;
    }

    // Kill shim (simulates a crash, but we will set Normal stop cause)
    unsafe {
        libc::kill(shim_pid as i32, libc::SIGKILL);
    }
    sleep(Duration::from_millis(200)).await;
    write_exit_file(&exit_file_path(&home.path, &box_id), 0, "clean exit");

    // Manually set state to Crashed with Normal stop cause (simulates manual stop)
    set_box_state_crashed(&home.path, &box_id, 0, "Normal");

    // Recovery should NOT auto-restart because stop cause is Normal
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        // Wait a bit for recovery to complete
        sleep(Duration::from_secs(2)).await;

        let info = runtime
            .get_info(&box_id)
            .await
            .unwrap()
            .expect("Box should exist");

        assert_eq!(
            info.status,
            BoxStatus::Stopped,
            "UnlessStopped box with Normal stop cause should not be restarted"
        );
        assert!(info.pid.is_none(), "Stopped box should have no PID");

        runtime.remove(&box_id, false).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_unless_stopped_restarts_on_crash() {
    // Test: UnlessStopped policy SHOULD restart if stop cause is NOT Normal
    // (i.e., box crashed unexpectedly)
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;
    let shim_pid: u32;

    // Create box with UnlessStopped policy
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime.create(unless_stopped_opts(), None).await.unwrap();

        handle.start().await.unwrap();
        box_id = handle.id().to_string();
        shim_pid = wait_for_shim_pid(&home.path, &box_id).await;
    }

    // Kill shim (simulates a crash)
    unsafe {
        libc::kill(shim_pid as i32, libc::SIGKILL);
    }
    sleep(Duration::from_millis(200)).await;
    write_exit_file(&exit_file_path(&home.path, &box_id), 1, "crashed");

    // Manually set state to Crashed with non-Normal stop cause
    set_box_state_crashed(&home.path, &box_id, 0, "CrashedNoPolicy");

    // Recovery SHOULD auto-restart because stop cause is not Normal
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        // Wait for auto-restart
        let mut restarted = false;
        for _ in 0..20 {
            let info = runtime
                .get_info(&box_id)
                .await
                .unwrap()
                .expect("Box should exist");

            if info.status == BoxStatus::Running && info.pid.is_some() {
                restarted = true;
                break;
            }

            sleep(Duration::from_secs(1)).await;
        }

        assert!(
            restarted,
            "UnlessStopped box with crash stop cause should be restarted during recovery"
        );

        runtime.remove(&box_id, true).await.unwrap();
    }
}

#[tokio::test]
async fn recovery_crashed_state_is_evaluated_for_restart() {
    // Test: Box with Crashed status (not just Running) is properly evaluated during recovery
    // This verifies the recover_boxes() handles Crashed/Restarting states correctly
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;
    let shim_pid: u32;

    // Create box with Always policy
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        let handle = runtime.create(always_opts(), None).await.unwrap();

        handle.start().await.unwrap();
        box_id = handle.id().to_string();
        shim_pid = wait_for_shim_pid(&home.path, &box_id).await;
    }

    // Kill shim
    unsafe {
        libc::kill(shim_pid as i32, libc::SIGKILL);
    }
    sleep(Duration::from_millis(200)).await;
    write_exit_file(&exit_file_path(&home.path, &box_id), 1, "crashed");

    // Manually set state to Crashed (simulating the crash handling persisted this state)
    set_box_state_crashed(&home.path, &box_id, 1, "CrashedNoPolicy");

    // Recovery should evaluate the Crashed state and auto-restart (Always policy)
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();

        // Wait for auto-restart
        let mut restarted = false;
        for _ in 0..20 {
            let info = runtime
                .get_info(&box_id)
                .await
                .unwrap()
                .expect("Box should exist");

            if info.status == BoxStatus::Running && info.pid.is_some() {
                restarted = true;
                break;
            }

            sleep(Duration::from_secs(1)).await;
        }

        assert!(
            restarted,
            "Crashed box with Always policy should be restarted during recovery"
        );

        // Verify restart_count was preserved
        let info = runtime.get_info(&box_id).await.unwrap().unwrap();
        assert_eq!(
            info.stop_info.restart_count, 1,
            "restart_count should be preserved from Crashed state"
        );

        runtime.remove(&box_id, true).await.unwrap();
    }
}
