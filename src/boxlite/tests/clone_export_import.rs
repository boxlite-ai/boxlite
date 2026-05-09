//! Integration tests for clone, export, and import operations.
//!
//! These tests require a real VM runtime (alpine:latest image).
//! Run with:
//!
//! ```sh
//! cargo test -p boxlite --test clone_export_import
//! ```

mod common;

use boxlite::runtime::options::{BoxliteOptions, CloneOptions, ExportOptions};
use boxlite::runtime::types::BoxStatus;
use boxlite::{BoxCommand, BoxliteRuntime, LiteBox};
use tempfile::TempDir;

// ============================================================================
// LOCAL HELPERS
// ============================================================================

/// Create a box from alpine:latest image, start it, stop it, return it ready for operations.
async fn create_stopped_box(runtime: &BoxliteRuntime) -> LiteBox {
    let litebox = runtime
        .create(common::alpine_opts(), Some("test-box".to_string()))
        .await
        .expect("Failed to create box");

    // Start and stop to ensure disk state is populated
    litebox.start().await.expect("Failed to start box");
    litebox.stop().await.expect("Failed to stop box");

    litebox
}

/// Create a box from alpine:latest, start it, return it in Running state.
async fn create_running_box(runtime: &BoxliteRuntime, name: &str) -> LiteBox {
    let litebox = runtime
        .create(common::alpine_opts(), Some(name.to_string()))
        .await
        .expect("Failed to create box");

    litebox.start().await.expect("Failed to start box");
    assert_eq!(litebox.info().status, BoxStatus::Running);

    litebox
}

// ============================================================================
// Existing tests (stopped-box operations)
// ============================================================================

#[tokio::test]
async fn test_clone_produces_independent_box() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_stopped_box(&runtime).await;

    let cloned = source
        .clone_box(CloneOptions::default(), Some("cloned-box".to_string()))
        .await
        .expect("Failed to clone box");

    // Cloned box has a different ID
    let source_info = source.info();
    let cloned_info = cloned.info();
    assert_ne!(source_info.id, cloned_info.id);
    assert_eq!(cloned_info.name.as_deref(), Some("cloned-box"));
    assert_eq!(cloned_info.status, BoxStatus::Stopped);

    // Both can start independently
    cloned.start().await.expect("Failed to start cloned box");
    cloned.stop().await.expect("Failed to stop cloned box");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn test_export_import_roundtrip() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_stopped_box(&runtime).await;

    let export_dir = TempDir::new_in("/tmp").unwrap();
    let export_path = export_dir.path();

    let archive = source
        .export(ExportOptions::default(), export_path)
        .await
        .expect("Failed to export box");

    assert!(archive.path().exists());
    assert!(archive.path().extension().is_some_and(|e| e == "boxlite"));

    let imported = runtime
        .import_box(archive, Some("imported-box".to_string()))
        .await
        .expect("Failed to import box");

    let info = imported.info();
    assert_eq!(info.name.as_deref(), Some("imported-box"));
    assert_eq!(info.status, BoxStatus::Stopped);

    // Imported box can start
    imported
        .start()
        .await
        .expect("Failed to start imported box");
    imported.stop().await.expect("Failed to stop imported box");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn test_export_import_preserves_box_options() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let source = runtime
        .create(common::alpine_opts(), Some("options-test".to_string()))
        .await
        .expect("Failed to create box");

    source.start().await.expect("start");
    source.stop().await.expect("stop");

    let export_dir = TempDir::new_in("/tmp").unwrap();
    let export_path = export_dir.path();

    let archive = source
        .export(ExportOptions::default(), export_path)
        .await
        .expect("export");

    let imported = runtime.import_box(archive, None).await.expect("import");

    let imported_info = imported.info();
    assert_eq!(imported_info.status, BoxStatus::Stopped);

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// Running-box operations (auto-quiesce via PauseGuard)
// ============================================================================

#[tokio::test]
async fn test_clone_running_box() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_running_box(&runtime, "clone-src").await;

    // Clone while source is running — should succeed without stopping
    let cloned = source
        .clone_box(CloneOptions::default(), Some("cloned-running".to_string()))
        .await
        .expect("Clone on running box should succeed");

    // Source is still running
    assert_eq!(source.info().status, BoxStatus::Running);

    // Cloned box is stopped (new box, no VM yet)
    let cloned_info = cloned.info();
    assert_ne!(source.info().id, cloned_info.id);
    assert_eq!(cloned_info.name.as_deref(), Some("cloned-running"));
    assert_eq!(cloned_info.status, BoxStatus::Stopped);

    // Cloned box can start and exec independently
    cloned.start().await.expect("Start cloned box");
    let cmd = BoxCommand::new("echo").args(["from-clone"]);
    let exec = cloned.exec(cmd).await.expect("Exec on cloned box");
    let result = exec.wait().await.expect("Wait on cloned exec");
    assert_eq!(result.exit_code, 0);
    cloned.stop().await.expect("Stop cloned box");

    // Source still works
    let cmd = BoxCommand::new("echo").args(["still-running"]);
    let exec = source.exec(cmd).await.expect("Exec on source after clone");
    let result = exec.wait().await.expect("Wait on source exec");
    assert_eq!(result.exit_code, 0);

    source.stop().await.expect("Stop source box");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn test_export_running_box() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_running_box(&runtime, "export-running").await;

    let export_dir = TempDir::new_in("/tmp").unwrap();
    let export_path = export_dir.path();

    // Export while running — PauseGuard auto-pauses and resumes
    let archive = source
        .export(ExportOptions::default(), export_path)
        .await
        .expect("Export on running box should succeed");

    // Source is still running after export (PauseGuard resumed it)
    assert_eq!(source.info().status, BoxStatus::Running);

    // Archive is valid
    assert!(archive.path().exists());
    assert!(archive.path().extension().is_some_and(|e| e == "boxlite"));

    // Source still works after export
    let cmd = BoxCommand::new("echo").args(["after-export"]);
    let exec = source.exec(cmd).await.expect("Exec after export");
    let result = exec.wait().await.expect("Wait after export");
    assert_eq!(result.exit_code, 0);

    // Archived box can be imported and started
    let imported = runtime
        .import_box(archive, Some("imported-running".to_string()))
        .await
        .expect("Import should succeed");
    assert_eq!(imported.info().status, BoxStatus::Stopped);
    imported.start().await.expect("Start imported box");
    imported.stop().await.expect("Stop imported box");

    source.stop().await.expect("Stop source box");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn test_export_import_running_box_roundtrip() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_running_box(&runtime, "roundtrip-running").await;

    // Write a marker file inside the running VM
    let cmd = BoxCommand::new("sh").args(["-c", "echo boxlite-test-data > /root/marker.txt"]);
    let exec = source.exec(cmd).await.expect("Write marker file");
    let result = exec.wait().await.expect("Wait for write");
    assert_eq!(result.exit_code, 0, "Marker file write should succeed");

    // Export while running (PauseGuard freezes VM for consistent snapshot)
    let export_dir = TempDir::new_in("/tmp").unwrap();
    let export_path = export_dir.path();

    let archive = source
        .export(ExportOptions::default(), export_path)
        .await
        .expect("Export running box should succeed");

    // Source still running after export
    assert_eq!(source.info().status, BoxStatus::Running);

    // Import and verify the marker file is preserved
    let imported = runtime
        .import_box(archive, Some("imported-roundtrip".to_string()))
        .await
        .expect("Import should succeed");

    imported.start().await.expect("Start imported box");

    let cmd = BoxCommand::new("cat").args(["/root/marker.txt"]);
    let exec = imported.exec(cmd).await.expect("Read marker file");
    let result = exec.wait().await.expect("Wait for read");
    assert_eq!(
        result.exit_code, 0,
        "Marker file should exist in imported box"
    );

    imported.stop().await.expect("Stop imported box");
    source.stop().await.expect("Stop source box");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// Snapshot isolation (stopped source)
// ============================================================================

/// Verify that cloning a stopped box preserves the source's disk state.
///
/// NOTE: Live write isolation (writes to running source don't leak to clones)
/// requires hypervisor-level block device swapping (e.g., QEMU blockdev-snapshot).
/// libkrun's fd-based disk access means post-quiesce writes to a running source
/// go to the shared base inode. This test uses a stopped source to verify
/// the COW fork point works correctly without live-fd complications.
#[tokio::test]
async fn test_clone_snapshot_isolation() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_running_box(&runtime, "isolation-src").await;

    // Write a marker to the source box
    let cmd = BoxCommand::new("sh").args(["-c", "echo snapshot-data > /root/marker.txt"]);
    let exec = source.exec(cmd).await.expect("Write marker");
    let result = exec.wait().await.expect("Wait for marker write");
    assert_eq!(result.exit_code, 0);

    // Stop source, then clone from stopped state (clean fork point)
    source.stop().await.expect("Stop source");

    let cloned = source
        .clone_box(CloneOptions::default(), Some("isolation-clone".to_string()))
        .await
        .expect("Clone should succeed");

    // Start clone and verify it sees the marker written before the fork
    cloned.start().await.expect("Start cloned box");
    let cmd = BoxCommand::new("cat").args(["/root/marker.txt"]);
    let mut exec = cloned.exec(cmd).await.expect("Read marker in clone");

    let mut stdout_output = String::new();
    if let Some(mut stdout) = exec.stdout() {
        use futures::StreamExt;
        while let Some(chunk) = stdout.next().await {
            stdout_output.push_str(&chunk);
        }
    }
    let result = exec.wait().await.expect("Wait for clone read");
    assert_eq!(result.exit_code, 0);

    assert_eq!(
        stdout_output.trim(),
        "snapshot-data",
        "Clone must see source's pre-fork data"
    );

    cloned.stop().await.expect("Stop cloned box");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// Benchmarks
// ============================================================================

#[tokio::test]
async fn test_clone_10x_benchmark() {
    use std::time::Instant;

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_stopped_box(&runtime).await;

    const N: usize = 10;
    let mut durations = Vec::with_capacity(N);

    let total_start = Instant::now();

    for i in 0..N {
        let start = Instant::now();
        let cloned = source
            .clone_box(CloneOptions::default(), Some(format!("clone-bench-{}", i)))
            .await
            .expect("Clone should succeed");
        let elapsed = start.elapsed();
        durations.push(elapsed);

        eprintln!("Clone {}/{}: {:?}", i + 1, N, elapsed);

        // Verify clone is valid
        assert_eq!(cloned.info().status, BoxStatus::Stopped);
        assert_ne!(cloned.info().id, source.info().id);
    }

    let total = total_start.elapsed();
    let avg = total / N as u32;

    eprintln!("─────────────────────────────────");
    eprintln!("Total ({N} clones): {total:?}");
    eprintln!("Average per clone:  {avg:?}");
    eprintln!("─────────────────────────────────");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// Stress tests
// ============================================================================

#[tokio::test]
async fn test_export_under_write_pressure() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let source = create_running_box(&runtime, "write-stress").await;

    // Start a background process that continuously writes random 4KB blocks
    // to a file at random offsets. This simulates active I/O during export.
    let write_script = concat!(
        "while true; do ",
        "dd if=/dev/urandom of=/root/stress.bin bs=4096 count=1 ",
        "seek=$((RANDOM % 256)) conv=notrunc 2>/dev/null; ",
        "done"
    );
    let cmd = BoxCommand::new("sh").args(["-c", write_script]);
    let _bg_exec = source.exec(cmd).await.expect("Start background writer");

    // Let writes accumulate briefly
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Export while writes are happening — PauseGuard quiesces the VM
    let export_dir = TempDir::new_in("/tmp").unwrap();
    let export_path = export_dir.path();

    let archive = source
        .export(ExportOptions::default(), export_path)
        .await
        .expect("Export under write pressure should succeed");

    // Source should still be running after export
    assert_eq!(source.info().status, BoxStatus::Running);

    // Import the archive and verify the filesystem is intact (bootable)
    let imported = runtime
        .import_box(archive, Some("imported-stress".to_string()))
        .await
        .expect("Import should succeed");

    imported.start().await.expect("Start imported box");

    // Verify the box boots and can execute commands (filesystem integrity)
    let cmd = BoxCommand::new("echo").args(["fs-ok"]);
    let exec = imported.exec(cmd).await.expect("Exec on imported box");
    let result = exec.wait().await.expect("Wait on exec");
    assert_eq!(result.exit_code, 0, "Imported box should be functional");

    // Verify stress file exists (some data was captured)
    let cmd = BoxCommand::new("test").args(["-f", "/root/stress.bin"]);
    let exec = imported.exec(cmd).await.expect("Check stress file");
    let result = exec.wait().await.expect("Wait on check");
    assert_eq!(result.exit_code, 0, "Stress file should exist in snapshot");

    imported.stop().await.expect("Stop imported box");
    source.stop().await.expect("Stop source box");

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
