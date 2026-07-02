//! Integration tests for detach mode behavior.
//!
//! Verifies detached boxes survive runtime drop, non-detached boxes exit
//! via watchdog POLLHUP, and detached boxes can be recovered after restart.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::litebox::BoxCommand;
use boxlite::runtime::options::BoxliteOptions;
use boxlite::runtime::types::BoxStatus;
use boxlite::util::{PidFileReader, is_process_alive};
use std::path::{Path, PathBuf};

// ============================================================================
// LOCAL HELPERS
// ============================================================================

/// Get the PID file path for a box under the given home directory.
fn pid_file_path(home_dir: &Path, box_id: &str) -> PathBuf {
    home_dir.join("boxes").join(box_id).join("shim.pid")
}

/// Count live processes whose argv references `box_id` (Linux `/proc` scan).
///
/// A detached box's whole tree — the outer bwrap launcher, the inner
/// pid-namespace bwrap, the shim, and the VM — carries the unique box id in its
/// bwrap bind paths, so this counts every process in the tree. Used to assert
/// that the production reap path tears the *whole* tree down, not just the
/// recorded outer-bwrap pid.
#[cfg(target_os = "linux")]
fn box_proc_count(box_id: &str) -> usize {
    let mut count = 0;
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return 0;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.parse::<u32>().is_err() {
            continue; // not a pid dir
        }
        if let Ok(cmdline) = std::fs::read(entry.path().join("cmdline"))
            && cmdline
                .windows(box_id.len())
                .any(|w| w == box_id.as_bytes())
        {
            count += 1;
        }
    }
    count
}

#[cfg(target_os = "linux")]
async fn wait_for_box_proc_count_zero(box_id: &str) -> usize {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut count = box_proc_count(box_id);

    while count != 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        count = box_proc_count(box_id);
    }

    count
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
        original_pid = PidFileReader::at(&pf).read().map(|r| r.pid).unwrap();

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
        original_pid = PidFileReader::at(&pf).read().map(|r| r.pid).unwrap();

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
        let pid = PidFileReader::at(&pf).read().map(|r| r.pid).unwrap();
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

/// `runtime.remove(force)` on a detached box must reap its *entire* process
/// tree. `kill_process` only signals the recorded outer bwrap; since #851
/// dropped `--die-with-parent`, the inner pid-ns tree (inner bwrap + shim + VM)
/// survives that. The production fix reaps the box's cgroup. This is the
/// regression guard for the silent orphan VM that `boxlite rm -f` used to leave
/// behind — note `PerTestBoxHome`'s `shim.pid`-based leak check can't see it
/// (force-remove deletes the file), so the explicit `box_proc_count` is the
/// real assertion here.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn detached_box_force_remove_reaps_whole_tree() {
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
    handle
        .exec(BoxCommand::new("sleep").args(["300"]))
        .await
        .expect("start detached sleep workload");
    let box_id = handle.id().to_string();

    assert!(
        box_proc_count(&box_id) > 0,
        "detached box should have a live process tree after start"
    );

    // Production reap path.
    runtime.remove(&box_id, true).await.unwrap();
    let proc_count = wait_for_box_proc_count_zero(&box_id).await;

    assert_eq!(
        proc_count, 0,
        "force remove must reap the whole detached box tree \
         (outer + inner bwrap + shim + VM), not just the recorded pid"
    );
}

/// `box.stop()` on a detached box must reap the full process tree while
/// preserving the box record and disk state for a later start.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn detached_box_stop_reaps_whole_tree_and_keeps_box() {
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
    handle
        .exec(BoxCommand::new("sleep").args(["300"]))
        .await
        .expect("start detached sleep workload");
    let box_id = handle.id().to_string();

    assert!(
        box_proc_count(&box_id) > 0,
        "detached box should have a live process tree after start"
    );

    handle.stop().await.unwrap();
    let proc_count = wait_for_box_proc_count_zero(&box_id).await;

    assert_eq!(
        proc_count, 0,
        "stop must reap the whole detached box tree \
         (outer + inner bwrap + shim + VM), not just the recorded pid"
    );

    let info = runtime
        .get_info(&box_id)
        .await
        .unwrap()
        .expect("stopped box should still exist");
    assert_eq!(info.status, BoxStatus::Stopped);

    runtime.remove(&box_id, false).await.unwrap();
}
