//! Integration tests for runtime recovery scenarios.
//!
//! Verifies that BoxliteRuntime correctly recovers box state on restart:
//! live/dead/missing/corrupt processes, stopped boxes, auto-remove cleanup,
//! and orphaned entries.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::litebox::BoxCommand;
use boxlite::runtime::id::BoxID;
use boxlite::runtime::options::BoxliteOptions;
use boxlite::runtime::types::BoxStatus;
use boxlite::util::PidFileReader;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

// ============================================================================
// LOCAL HELPERS
// ============================================================================

/// Get the PID file path for a box under the given home directory.
fn pid_file_path(home_dir: &Path, box_id: &str) -> PathBuf {
    home_dir.join("boxes").join(box_id).join("shim.pid")
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
        original_pid = PidFileReader::at(&pf).read().map(|r| r.pid).unwrap();
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
        let original_pid = PidFileReader::at(&pf).read().map(|r| r.pid).unwrap();

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
// RECOVERY CRASH DETECTION (P0)
// ============================================================================

#[tokio::test]
async fn recovery_marks_box_failed_when_exit_file_present() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let box_id: String;

    // Create a box and stop it so the DB has a persisted entry.
    {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .unwrap();
        let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
        let _ = handle.exec(BoxCommand::new("true")).await;
        box_id = handle.id().to_string();
        handle.stop().await.unwrap();
    }

    // Plant a synthetic ExitInfo::Signal JSON simulating a SIGABRT crash.
    let box_dir = home.path.join("boxes").join(&box_id);
    let exit_file = box_dir.join("exit");
    std::fs::write(
        &exit_file,
        r#"{"type":"signal","exit_code":134,"signal":"SIGABRT"}"#,
    )
    .expect("write synthetic exit file");

    // Recovery on a fresh runtime must surface the crash as Failed.
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
            BoxStatus::Failed,
            "Box with exit file present after recovery must be Failed, was {:?}",
            info.status
        );
        assert!(
            info.pid.is_none(),
            "Failed box must have no PID after recovery"
        );

        runtime.remove(&box_id, true).await.unwrap();
    }
}

#[tokio::test]
async fn successful_start_stashes_stale_exit_file() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();

    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box_id = handle.id().to_string();

    // Plant a stale exit file *before* the first start, simulating a leftover
    // artifact from a prior lifecycle that recover_boxes already turned into
    // Failed and we are now retrying.
    let box_dir = home.path.join("boxes").join(&box_id);
    std::fs::create_dir_all(&box_dir).expect("box dir");
    let exit_file = box_dir.join("exit");
    let exit_previous = box_dir.join("exit.previous");
    let payload = r#"{"type":"signal","exit_code":134,"signal":"SIGABRT"}"#;
    std::fs::write(&exit_file, payload).expect("write stale exit file");
    assert!(exit_file.exists(), "stale exit file should exist pre-start");

    // A successful start must archive the stale exit file to exit.previous,
    // freeing the canonical slot for a future crash while preserving the
    // prior crash record for forensics.
    let _ = handle.exec(BoxCommand::new("true")).await.unwrap();
    assert!(
        !exit_file.exists(),
        "successful start must clear the active exit file slot"
    );
    assert!(
        exit_previous.exists(),
        "successful start must stash the prior crash record to exit.previous"
    );
    let stashed = std::fs::read_to_string(&exit_previous).expect("read stash");
    assert_eq!(
        stashed, payload,
        "stashed content must match original exit file"
    );

    handle.stop().await.unwrap();
    runtime.remove(&box_id, true).await.unwrap();
}

// ============================================================================
// RECOVERY CLEANUP (P1)
// ============================================================================

#[tokio::test]
async fn recovery_removes_auto_delete_boxes() {
    // Test that boxes with auto_delete>0 are removed during recovery
    // This simulates a crash scenario where boxes weren't properly cleaned up
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let home_dir = temp_dir.path().to_path_buf();

    let persistent_box_id: BoxID;

    // Create two boxes: one with auto_delete>0, one with auto_delete=0
    {
        let options = BoxliteOptions {
            home_dir: home_dir.clone(),
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");

        // Create auto_delete>0 box (should be cleaned up on recovery)
        let ephemeral_box = runtime
            .create(common::alpine_opts_auto(), None)
            .await
            .unwrap();

        // Create auto_delete=0 box (should persist)
        let persistent_box = runtime.create(common::alpine_opts(), None).await.unwrap();
        persistent_box_id = persistent_box.id().clone();

        // Both boxes should exist before shutdown
        assert!(runtime.exists(ephemeral_box.id().as_str()).await.unwrap());
        assert!(runtime.exists(persistent_box_id.as_str()).await.unwrap());

        // Stop the persistent box normally (it stays in DB)
        persistent_box.stop().await.unwrap();

        // Verify both exist in DB (remove-on-stop box is still Starting)
        assert_eq!(runtime.list_info().await.unwrap().len(), 2);

        // Drop runtime without stopping ephemeral_box - simulates crash
        // The box will remain in database but should be cleaned on recovery
    }

    // Create new runtime with same home directory (simulates restart)
    {
        let options = BoxliteOptions {
            home_dir,
            image_registries: common::test_registries(),
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime after restart");

        // auto_delete>0 box should be removed during recovery
        // auto_delete=0 box should be recovered
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
