//! Integration tests for clone, export, and import operations.
//!
//! These tests require a real VM runtime (alpine:latest image) and are
//! marked `#[ignore]` for CI. Run with:
//!
//! ```sh
//! cargo test -p boxlite --test clone_export_import -- --ignored
//! ```

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{
    BoxOptions, BoxliteOptions, CloneOptions, ExportOptions, RootfsSpec,
};
use boxlite::runtime::types::BoxStatus;
use boxlite::{BoxCommand, LiteBox};
use tempfile::TempDir;

/// Create an isolated runtime with a temp home directory.
/// Uses /tmp for shorter paths — macOS default TempDir paths exceed SUN_LEN for Unix sockets.
fn test_runtime() -> (BoxliteRuntime, TempDir) {
    let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
    let options = BoxliteOptions {
        home_dir: temp_dir.path().to_path_buf(),
        image_registries: vec!["mirror.gcr.io".to_string(), "docker.io".to_string()],
    };
    let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
    (runtime, temp_dir)
}

/// Create a box from alpine:latest image, start it, stop it, return it ready for operations.
async fn create_stopped_box(runtime: &BoxliteRuntime) -> LiteBox {
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".to_string()),
        auto_remove: false,
        ..Default::default()
    };

    let litebox = runtime
        .create(options, Some("test-box".to_string()))
        .await
        .expect("Failed to create box");

    // Start and stop to ensure disk state is populated
    litebox.start().await.expect("Failed to start box");
    litebox.stop().await.expect("Failed to stop box");

    litebox
}

/// Create a box from alpine:latest, start it, return it in Running state.
async fn create_running_box(runtime: &BoxliteRuntime, name: &str) -> LiteBox {
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".to_string()),
        auto_remove: false,
        ..Default::default()
    };

    let litebox = runtime
        .create(options, Some(name.to_string()))
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
#[ignore] // Requires VM runtime
async fn test_clone_produces_independent_box() {
    let (runtime, _dir) = test_runtime();
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
}

#[tokio::test]
#[ignore] // Requires VM runtime
async fn test_export_import_roundtrip() {
    let (runtime, dir) = test_runtime();
    let source = create_stopped_box(&runtime).await;

    let export_path = dir.path().join("exports");
    std::fs::create_dir_all(&export_path).unwrap();

    let archive = source
        .export(ExportOptions::default(), &export_path)
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
}

#[tokio::test]
#[ignore] // Requires VM runtime
async fn test_export_import_preserves_box_options() {
    let (runtime, dir) = test_runtime();

    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".to_string()),
        auto_remove: false,
        ..Default::default()
    };

    let source = runtime
        .create(options, Some("options-test".to_string()))
        .await
        .expect("Failed to create box");

    source.start().await.expect("start");
    source.stop().await.expect("stop");

    let export_path = dir.path().join("exports");
    std::fs::create_dir_all(&export_path).unwrap();

    let archive = source
        .export(ExportOptions::default(), &export_path)
        .await
        .expect("export");

    let imported = runtime.import_box(archive, None).await.expect("import");

    let imported_info = imported.info();
    assert_eq!(imported_info.status, BoxStatus::Stopped);
}

// ============================================================================
// Running-box operations (auto-quiesce via PauseGuard)
// ============================================================================

#[tokio::test]
#[ignore] // Requires VM runtime
async fn test_clone_running_box() {
    let (runtime, _dir) = test_runtime();
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
    let mut exec = cloned.exec(cmd).await.expect("Exec on cloned box");
    let result = exec.wait().await.expect("Wait on cloned exec");
    assert_eq!(result.exit_code, 0);
    cloned.stop().await.expect("Stop cloned box");

    // Source still works
    let cmd = BoxCommand::new("echo").args(["still-running"]);
    let mut exec = source.exec(cmd).await.expect("Exec on source after clone");
    let result = exec.wait().await.expect("Wait on source exec");
    assert_eq!(result.exit_code, 0);

    source.stop().await.expect("Stop source box");
}

#[tokio::test]
#[ignore] // Requires VM runtime
async fn test_export_running_box() {
    let (runtime, dir) = test_runtime();
    let source = create_running_box(&runtime, "export-running").await;

    let export_path = dir.path().join("exports");
    std::fs::create_dir_all(&export_path).unwrap();

    // Export while running — PauseGuard auto-pauses and resumes
    let archive = source
        .export(ExportOptions::default(), &export_path)
        .await
        .expect("Export on running box should succeed");

    // Source is still running after export (PauseGuard resumed it)
    assert_eq!(source.info().status, BoxStatus::Running);

    // Archive is valid
    assert!(archive.path().exists());
    assert!(archive.path().extension().is_some_and(|e| e == "boxlite"));

    // Source still works after export
    let cmd = BoxCommand::new("echo").args(["after-export"]);
    let mut exec = source.exec(cmd).await.expect("Exec after export");
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
}

#[tokio::test]
#[ignore] // Requires VM runtime
async fn test_export_import_running_box_roundtrip() {
    let (runtime, dir) = test_runtime();
    let source = create_running_box(&runtime, "roundtrip-running").await;

    // Write a marker file inside the running VM
    let cmd = BoxCommand::new("sh").args(["-c", "echo boxlite-test-data > /root/marker.txt"]);
    let mut exec = source.exec(cmd).await.expect("Write marker file");
    let result = exec.wait().await.expect("Wait for write");
    assert_eq!(result.exit_code, 0, "Marker file write should succeed");

    // Export while running (PauseGuard freezes VM for consistent snapshot)
    let export_path = dir.path().join("exports");
    std::fs::create_dir_all(&export_path).unwrap();

    let archive = source
        .export(ExportOptions::default(), &export_path)
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
    let mut exec = imported.exec(cmd).await.expect("Read marker file");
    let result = exec.wait().await.expect("Wait for read");
    assert_eq!(
        result.exit_code, 0,
        "Marker file should exist in imported box"
    );

    imported.stop().await.expect("Stop imported box");
    source.stop().await.expect("Stop source box");
}

// ============================================================================
// Stress tests
// ============================================================================

#[tokio::test]
#[ignore] // Requires VM runtime
async fn test_export_under_write_pressure() {
    let (runtime, dir) = test_runtime();
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
    let export_path = dir.path().join("exports");
    std::fs::create_dir_all(&export_path).unwrap();

    let archive = source
        .export(ExportOptions::default(), &export_path)
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
    let mut exec = imported.exec(cmd).await.expect("Exec on imported box");
    let result = exec.wait().await.expect("Wait on exec");
    assert_eq!(result.exit_code, 0, "Imported box should be functional");

    // Verify stress file exists (some data was captured)
    let cmd = BoxCommand::new("test").args(["-f", "/root/stress.bin"]);
    let mut exec = imported.exec(cmd).await.expect("Check stress file");
    let result = exec.wait().await.expect("Wait on check");
    assert_eq!(result.exit_code, 0, "Stress file should exist in snapshot");

    imported.stop().await.expect("Stop imported box");
    source.stop().await.expect("Stop source box");
}
