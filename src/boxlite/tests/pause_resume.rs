//! Integration tests for the pause/resume API.
//!
//! Tests the high-level `LiteBox::pause()` and `LiteBox::resume()` methods
//! with a real VM (alpine:latest). Validates state transitions, idempotency,
//! exec rejection while paused, and stop-from-paused.
//!
//! Requires a real VM runtime. Run with:
//!
//! ```sh
//! cargo test -p boxlite --test pause_resume
//! ```

mod common;

use boxlite::runtime::options::BoxliteOptions;
use boxlite::runtime::types::BoxStatus;
use boxlite::{BoxCommand, BoxliteRuntime};

/// Helper: create a runtime with a per-test home directory.
fn test_runtime() -> (boxlite_test_utils::home::PerTestBoxHome, BoxliteRuntime) {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    (home, runtime)
}

#[tokio::test]
async fn pause_freezes_vm_and_resume_restores_it() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-test".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");

    // Verify box is responsive
    let cmd = BoxCommand::new("echo").args(["before-pause"]);
    let mut exec = litebox.exec(cmd).await.expect("exec before pause");
    let result = exec.wait().await.expect("wait before pause");
    assert_eq!(result.exit_code, 0);

    // Pause
    litebox.pause().await.expect("pause box");
    assert_eq!(litebox.info().status, BoxStatus::Paused);

    // Resume
    litebox.resume().await.expect("resume box");
    assert_eq!(litebox.info().status, BoxStatus::Running);

    // Verify box is still responsive after resume
    let cmd = BoxCommand::new("echo").args(["after-resume"]);
    let mut exec = litebox.exec(cmd).await.expect("exec after resume");
    let result = exec.wait().await.expect("wait after resume");
    assert_eq!(result.exit_code, 0);

    litebox.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn exec_rejected_while_paused() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-exec-test".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");
    litebox.pause().await.expect("pause box");

    // Exec should fail with InvalidState
    let cmd = BoxCommand::new("echo").args(["should-fail"]);
    let err = match litebox.exec(cmd).await {
        Err(e) => e,
        Ok(_) => panic!("exec should fail while paused"),
    };
    let msg = err.to_string();
    assert!(
        msg.contains("Paused") || msg.contains("paused") || msg.contains("InvalidState"),
        "Expected InvalidState/Paused error, got: {msg}"
    );

    // Resume and verify exec works again
    litebox.resume().await.expect("resume box");
    let cmd = BoxCommand::new("echo").args(["works-again"]);
    let mut exec = litebox.exec(cmd).await.expect("exec after resume");
    let result = exec.wait().await.expect("wait after resume");
    assert_eq!(result.exit_code, 0);

    litebox.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn pause_is_idempotent() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-idempotent".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");

    // Pause twice — second call should be a no-op
    litebox.pause().await.expect("first pause");
    assert_eq!(litebox.info().status, BoxStatus::Paused);
    litebox.pause().await.expect("second pause (idempotent)");
    assert_eq!(litebox.info().status, BoxStatus::Paused);

    litebox.resume().await.expect("resume");
    litebox.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn resume_is_idempotent() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("resume-idempotent".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");

    // Resume on a Running box should be a no-op
    litebox
        .resume()
        .await
        .expect("resume on running (idempotent)");
    assert_eq!(litebox.info().status, BoxStatus::Running);

    litebox.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn stop_from_paused_state() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-stop".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");
    litebox.pause().await.expect("pause box");
    assert_eq!(litebox.info().status, BoxStatus::Paused);

    // Stop directly from Paused should work
    litebox.stop().await.expect("stop from paused");

    let info = runtime
        .get_info(litebox.id().as_str())
        .await
        .expect("get info")
        .expect("box should exist");
    assert_eq!(info.status, BoxStatus::Stopped);

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn multiple_pause_resume_cycles() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-cycles".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");

    for i in 0..3 {
        litebox
            .pause()
            .await
            .unwrap_or_else(|e| panic!("pause cycle {i}: {e}"));
        assert_eq!(litebox.info().status, BoxStatus::Paused);

        litebox
            .resume()
            .await
            .unwrap_or_else(|e| panic!("resume cycle {i}: {e}"));
        assert_eq!(litebox.info().status, BoxStatus::Running);

        // Verify VM is responsive after each cycle
        let cmd = BoxCommand::new("echo").args([format!("cycle-{i}")]);
        let mut exec = litebox
            .exec(cmd)
            .await
            .unwrap_or_else(|e| panic!("exec cycle {i}: {e}"));
        let result = exec
            .wait()
            .await
            .unwrap_or_else(|e| panic!("wait cycle {i}: {e}"));
        assert_eq!(result.exit_code, 0, "command failed in cycle {i}");
    }

    litebox.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn resume_on_stopped_box_returns_error() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("resume-stopped".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");
    litebox.stop().await.expect("stop box");

    // Resume on a Stopped box should fail
    let err = match litebox.resume().await {
        Err(e) => e,
        Ok(()) => panic!("resume should fail on stopped box"),
    };
    let msg = err.to_string();
    assert!(
        msg.contains("stop") || msg.contains("Stop") || msg.contains("invalidated"),
        "Expected stopped/invalidated error, got: {msg}"
    );

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn copy_into_rejected_while_paused() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-copy-in".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");

    // Create a temp file to copy
    let tmp = std::env::temp_dir().join("boxlite-test-copy-pause");
    std::fs::write(&tmp, b"test").expect("write temp file");

    litebox.pause().await.expect("pause box");

    // copy_into should fail while paused
    let err = match litebox
        .copy_into(&tmp, "/tmp/test", Default::default())
        .await
    {
        Err(e) => e,
        Ok(()) => panic!("copy_into should fail while paused"),
    };
    let msg = err.to_string();
    assert!(
        msg.contains("paused") || msg.contains("Paused"),
        "Expected paused error, got: {msg}"
    );

    // Resume and verify copy works
    litebox.resume().await.expect("resume box");
    litebox
        .copy_into(&tmp, "/tmp/test", Default::default())
        .await
        .expect("copy_into after resume");

    let _ = std::fs::remove_file(&tmp);
    litebox.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn copy_out_rejected_while_paused() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-copy-out".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");

    // Create a file inside the box to copy out
    let cmd = BoxCommand::new("sh").args(["-c", "echo test > /tmp/testfile"]);
    let mut exec = litebox.exec(cmd).await.expect("create file");
    exec.wait().await.expect("wait create file");

    litebox.pause().await.expect("pause box");

    let host_dst = std::env::temp_dir().join("boxlite-test-copy-out-pause");

    // copy_out should fail while paused
    let err = match litebox
        .copy_out("/tmp/testfile", &host_dst, Default::default())
        .await
    {
        Err(e) => e,
        Ok(()) => panic!("copy_out should fail while paused"),
    };
    let msg = err.to_string();
    assert!(
        msg.contains("paused") || msg.contains("Paused"),
        "Expected paused error, got: {msg}"
    );

    // Resume and verify copy works
    litebox.resume().await.expect("resume box");
    litebox
        .copy_out("/tmp/testfile", &host_dst, Default::default())
        .await
        .expect("copy_out after resume");

    let _ = std::fs::remove_file(&host_dst);
    litebox.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn pause_on_stopped_box_returns_error() {
    let (_home, runtime) = test_runtime();

    let litebox = runtime
        .create(common::alpine_opts(), Some("pause-stopped".into()))
        .await
        .expect("create box");

    litebox.start().await.expect("start box");
    litebox.stop().await.expect("stop box");

    // Pause on a Stopped box should fail
    let err = match litebox.pause().await {
        Err(e) => e,
        Ok(()) => panic!("pause should fail on stopped box"),
    };
    let msg = err.to_string();
    assert!(
        msg.contains("stop") || msg.contains("Stop") || msg.contains("invalidated"),
        "Expected stopped/invalidated error, got: {msg}"
    );

    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
