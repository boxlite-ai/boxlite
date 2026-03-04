//! Integration tests for snapshot create and restore operations.
//!
//! These tests verify that snapshot operations preserve bootable box state,
//! specifically that COW child disks are not deleted by `Disk::Drop` after
//! `create_cow_child_disk()` (which returns `Disk { persistent: false }`).
//!
//! Requires a real VM runtime (alpine:latest image).
//! Run with:
//!
//! ```sh
//! cargo test -p boxlite --test snapshot
//! ```

mod common;

use std::path::{Path, PathBuf};

use boxlite::runtime::options::BoxliteOptions;
use boxlite::{BoxCommand, BoxliteRuntime, LiteBox, SnapshotOptions};
use tokio_stream::StreamExt;

// ============================================================================
// LOCAL HELPERS
// ============================================================================

/// Disk filenames matching `boxlite::disk::constants::filenames`.
const CONTAINER_DISK: &str = "disk.qcow2";
const GUEST_ROOTFS_DISK: &str = "guest-rootfs.qcow2";
const SNAPSHOTS_DIR: &str = "snapshots";

/// Return the box directory path: `{home}/boxes/{box_id}`.
fn box_dir(home: &Path, box_id: &str) -> PathBuf {
    home.join("boxes").join(box_id)
}

/// Return the snapshot directory path: `{home}/boxes/{box_id}/snapshots/{name}`.
fn snapshot_dir(home: &Path, box_id: &str, name: &str) -> PathBuf {
    box_dir(home, box_id).join(SNAPSHOTS_DIR).join(name)
}

/// Exec a command, collect stdout, assert exit code 0.
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

/// Create a box from alpine:latest, start it, stop it, return it ready for snapshot operations.
async fn create_stopped_box(runtime: &BoxliteRuntime) -> LiteBox {
    let litebox = runtime
        .create(common::alpine_opts(), Some("test-box".to_string()))
        .await
        .expect("Failed to create box");

    // Start and stop to ensure disk state is populated.
    litebox.start().await.expect("Failed to start box");
    litebox.stop().await.expect("Failed to stop box");

    litebox
}

// ============================================================================
// SNAPSHOT CREATE — disk integrity
// ============================================================================

#[tokio::test]
async fn test_cow_child_disks_exist_after_snapshot_create() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let litebox = create_stopped_box(&runtime).await;
    let box_id = litebox.id().to_string();

    // Precondition: disks exist before snapshot.
    let bdir = box_dir(&home.path, &box_id);
    assert!(
        bdir.join(CONTAINER_DISK).exists(),
        "container disk missing before snapshot"
    );
    assert!(
        bdir.join(GUEST_ROOTFS_DISK).exists(),
        "guest disk missing before snapshot"
    );

    let info = litebox
        .snapshots()
        .create(SnapshotOptions::default(), "ckpt1")
        .await
        .expect("snapshot create failed");
    assert_eq!(info.name, "ckpt1");

    // Snapshot copies must exist in the snapshot directory.
    let sdir = snapshot_dir(&home.path, &box_id, "ckpt1");
    assert!(
        sdir.join(CONTAINER_DISK).exists(),
        "snapshot container disk missing"
    );
    assert!(
        sdir.join(GUEST_ROOTFS_DISK).exists(),
        "snapshot guest disk missing"
    );

    // COW child disks in the box directory must still exist.
    // Bug: create_cow_child_disk() returns Disk(persistent=false); if the caller
    // does not call .leak(), Disk::Drop deletes the newly created file.
    assert!(
        bdir.join(CONTAINER_DISK).exists(),
        "COW child disk.qcow2 deleted by Disk::Drop (missing .leak() in local_snapshot.rs)"
    );
    assert!(
        bdir.join(GUEST_ROOTFS_DISK).exists(),
        "COW child guest-rootfs.qcow2 deleted by Disk::Drop (missing .leak() in local_snapshot.rs)"
    );

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// SNAPSHOT CREATE — box restartable
// ============================================================================

#[tokio::test]
async fn test_box_restartable_after_snapshot_create() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let litebox = create_stopped_box(&runtime).await;

    litebox
        .snapshots()
        .create(SnapshotOptions::default(), "restart_test")
        .await
        .expect("snapshot create failed");

    // Box must be restartable after snapshot create.
    litebox
        .start()
        .await
        .expect("start after snapshot create failed");

    let cmd = BoxCommand::new("echo").args(["alive"]);
    let mut exec = litebox.exec(cmd).await.expect("exec failed");
    let result = exec.wait().await.expect("wait failed");
    assert_eq!(
        result.exit_code, 0,
        "box should be functional after snapshot create"
    );

    litebox.stop().await.expect("stop failed");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// SNAPSHOT RESTORE — disk integrity
// ============================================================================

#[tokio::test]
async fn test_cow_child_disks_exist_after_snapshot_restore() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let litebox = create_stopped_box(&runtime).await;
    let box_id = litebox.id().to_string();

    litebox
        .snapshots()
        .create(SnapshotOptions::default(), "v1")
        .await
        .expect("snapshot create failed");

    litebox
        .snapshots()
        .restore("v1")
        .await
        .expect("snapshot restore failed");

    // COW child disks in the box directory must exist after restore.
    let bdir = box_dir(&home.path, &box_id);
    assert!(
        bdir.join(CONTAINER_DISK).exists(),
        "COW child disk.qcow2 deleted by Disk::Drop after restore (missing .leak())"
    );
    assert!(
        bdir.join(GUEST_ROOTFS_DISK).exists(),
        "COW child guest-rootfs.qcow2 deleted by Disk::Drop after restore (missing .leak())"
    );

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// SNAPSHOT RESTORE — box startable
// ============================================================================

#[tokio::test]
async fn test_box_startable_after_snapshot_restore() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let litebox = create_stopped_box(&runtime).await;

    // Write marker, snapshot, then restore.
    litebox.start().await.expect("start failed");
    let cmd = BoxCommand::new("sh").args(["-c", "echo RESTORE_V1 > /root/ver.txt"]);
    let mut exec = litebox.exec(cmd).await.expect("exec failed");
    exec.wait().await.expect("wait failed");
    litebox.stop().await.expect("stop failed");

    litebox
        .snapshots()
        .create(SnapshotOptions::default(), "restore_boot_test")
        .await
        .expect("snapshot create failed");

    litebox
        .snapshots()
        .restore("restore_boot_test")
        .await
        .expect("snapshot restore failed");

    // Box must be startable after restore, with snapshot state intact.
    litebox.start().await.expect("start after restore failed");

    let out = exec_stdout(&litebox, BoxCommand::new("cat").args(["/root/ver.txt"])).await;
    assert_eq!(
        out.trim(),
        "RESTORE_V1",
        "snapshot restore should preserve filesystem state"
    );

    litebox.stop().await.expect("stop failed");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// SNAPSHOT METADATA — persistence
// ============================================================================

#[tokio::test]
async fn test_snapshot_list_returns_created_snapshot() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let litebox = create_stopped_box(&runtime).await;

    litebox
        .snapshots()
        .create(SnapshotOptions::default(), "persist_test")
        .await
        .expect("snapshot create failed");

    let snapshots = litebox
        .snapshots()
        .list()
        .await
        .expect("snapshot list failed");

    assert!(
        snapshots.iter().any(|s| s.name == "persist_test"),
        "created snapshot not found in list"
    );

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
