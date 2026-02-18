//! Tests to verify Execution behavior during shutdown scenarios.
//!
//! These tests document current behavior and verify assumptions about
//! how wait(), streams, and shutdown interact.

use boxlite::BoxCommand;
use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite_shared::BoxliteError;
use std::time::Duration;
use tempfile::TempDir;

// ============================================================================
// TEST FIXTURES
// ============================================================================

/// Test context with isolated runtime and automatic cleanup.
struct TestContext {
    runtime: BoxliteRuntime,
    _temp_dir: TempDir,
}

impl TestContext {
    fn new() -> Self {
        // Use /tmp directly to avoid macOS's long temp paths that exceed SUN_LEN
        // for Unix socket paths (limited to ~104 chars)
        let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
        let options = BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
        Self {
            runtime,
            _temp_dir: temp_dir,
        }
    }
}

fn default_box_options() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        ..Default::default()
    }
}

// ============================================================================
// BEHAVIOR VERIFICATION TESTS
// ============================================================================

/// Test 1: What happens to wait() when box.stop() is called?
///
/// Assumption: wait() should eventually return (not hang forever)
/// because the guest process exits when box stops.
#[tokio::test]
async fn test_wait_behavior_on_box_stop() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start a long-running command
    let mut execution = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();

    // Spawn wait() in background
    let wait_handle = tokio::spawn(async move {
        let start = std::time::Instant::now();
        let result = execution.wait().await;
        let elapsed = start.elapsed();
        (result, elapsed)
    });

    // Give exec time to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Stop the box
    let stop_start = std::time::Instant::now();
    handle.stop().await.unwrap();
    let stop_elapsed = stop_start.elapsed();

    // Wait for wait() to return (with timeout to prevent test hanging)
    let wait_result = tokio::time::timeout(Duration::from_secs(30), wait_handle).await;

    println!("=== test_wait_behavior_on_box_stop ===");
    println!("box.stop() took: {:?}", stop_elapsed);

    match wait_result {
        Ok(Ok((result, wait_elapsed))) => {
            println!("wait() took: {:?}", wait_elapsed);
            println!("wait() result: {:?}", result);

            match result {
                Ok(exec_result) => {
                    println!(
                        "wait() returned Ok with exit_code: {}",
                        exec_result.exit_code
                    );
                }
                Err(e) => {
                    println!("wait() returned Err: {}", e);
                    println!("Error variant: {:?}", e);
                }
            }
        }
        Ok(Err(e)) => {
            println!("wait() task panicked: {:?}", e);
        }
        Err(_) => {
            println!("TIMEOUT: wait() did not return within 30 seconds!");
            println!("This indicates the hanging issue exists.");
        }
    }

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test 2: What happens to wait() when runtime.shutdown() is called?
///
/// Assumption: Similar to box.stop(), but may have different timing
/// because shutdown stops all boxes concurrently.
#[tokio::test]
async fn test_wait_behavior_on_runtime_shutdown() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start a long-running command
    let mut execution = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();

    // Spawn wait() in background
    let wait_handle = tokio::spawn(async move {
        let start = std::time::Instant::now();
        let result = execution.wait().await;
        let elapsed = start.elapsed();
        (result, elapsed)
    });

    // Give exec time to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Shutdown runtime
    let shutdown_start = std::time::Instant::now();
    let shutdown_result = ctx.runtime.shutdown(Some(5)).await; // 5s timeout
    let shutdown_elapsed = shutdown_start.elapsed();

    // Wait for wait() to return (with timeout)
    let wait_result = tokio::time::timeout(Duration::from_secs(30), wait_handle).await;

    println!("=== test_wait_behavior_on_runtime_shutdown ===");
    println!(
        "runtime.shutdown() took: {:?}, result: {:?}",
        shutdown_elapsed, shutdown_result
    );

    match wait_result {
        Ok(Ok((result, wait_elapsed))) => {
            println!("wait() took: {:?}", wait_elapsed);
            println!("wait() result: {:?}", result);

            match result {
                Ok(exec_result) => {
                    println!(
                        "wait() returned Ok with exit_code: {}",
                        exec_result.exit_code
                    );
                }
                Err(e) => {
                    println!("wait() returned Err: {}", e);
                }
            }
        }
        Ok(Err(e)) => {
            println!("wait() task panicked: {:?}", e);
        }
        Err(_) => {
            println!("TIMEOUT: wait() did not return within 30 seconds!");
        }
    }
}

/// Test 3: What happens to stdout stream when box stops mid-read?
///
/// Assumption: Stream should EOF (return None) when guest dies.
#[tokio::test]
async fn test_stdout_stream_on_box_stop() {
    use futures::StreamExt;

    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start a command that produces continuous output
    let mut execution = handle
        .exec(BoxCommand::new("sh").args(["-c", "while true; do echo tick; sleep 0.1; done"]))
        .await
        .unwrap();

    let mut stdout = execution.stdout().unwrap();

    // Read a few lines in background
    let read_handle = tokio::spawn(async move {
        let mut lines = Vec::new();
        let mut line_count = 0;

        // Read first 3 lines
        while let Some(line) = stdout.next().await {
            lines.push(line);
            line_count += 1;
            if line_count >= 3 {
                break;
            }
        }

        // Now wait for more (box will be stopped)
        let final_result = tokio::time::timeout(Duration::from_secs(10), stdout.next()).await;
        (lines, final_result)
    });

    // Give some time to read lines
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Stop the box
    handle.stop().await.unwrap();

    let (lines, final_result) = read_handle.await.unwrap();

    println!("=== test_stdout_stream_on_box_stop ===");
    println!("Lines read before stop: {:?}", lines);
    println!("Final stream result after stop: {:?}", final_result);
    // None = EOF, Some(...) = got more data, Timeout = stream hung

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test 4: Can we call exec() on a stopped box?
///
/// Assumption: Should return an error (InvalidState or Stopped).
#[tokio::test]
async fn test_exec_on_stopped_box() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Run a quick command first to ensure box is working
    let mut exec_handle = handle
        .exec(BoxCommand::new("echo").arg("hello"))
        .await
        .unwrap();
    let _ = exec_handle.wait().await;

    // Stop the box
    handle.stop().await.unwrap();

    // Try to exec on stopped box
    let result = handle.exec(BoxCommand::new("echo").arg("hello")).await;

    println!("=== test_exec_on_stopped_box ===");
    println!(
        "exec() on stopped box result: {}",
        if result.is_ok() { "Ok" } else { "Err" }
    );

    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("Got Stopped as expected: {}", msg);
        }
        Err(BoxliteError::InvalidState(msg)) => {
            println!("Got InvalidState: {}", msg);
        }
        Err(e) => {
            println!("Got unexpected error: {:?}", e);
        }
        Ok(_) => {
            println!("Unexpectedly succeeded!");
        }
    }

    // Should be an error
    assert!(result.is_err());

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test 5: What happens to existing Execution when box is stopped?
///
/// This tests the scenario where user has an Execution handle,
/// then box.stop() is called from elsewhere.
#[tokio::test]
async fn test_existing_execution_after_box_stop() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start a quick command and get execution
    let mut execution = handle
        .exec(BoxCommand::new("echo").arg("hello"))
        .await
        .unwrap();

    // Wait for it to complete first
    let result1 = execution.wait().await;
    println!("=== test_existing_execution_after_box_stop ===");
    println!("First wait() result: {:?}", result1);

    // Stop the box
    handle.stop().await.unwrap();

    // Call wait() again on completed execution
    let result2 = execution.wait().await;
    println!("Second wait() result (after box stop): {:?}", result2);
    // Should return cached result

    // Both should succeed with same exit code (cached)
    assert!(result1.is_ok());
    assert!(result2.is_ok());
    assert_eq!(result1.unwrap().exit_code, result2.unwrap().exit_code);

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test 6: Measure actual timing - how long does wait() block after stop?
#[tokio::test]
async fn test_wait_timing_after_stop() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start command that ignores SIGTERM (to test worst case)
    let mut execution = handle
        .exec(BoxCommand::new("sh").args(["-c", "trap '' TERM; sleep 3600"]))
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(500)).await;

    let wait_handle = tokio::spawn(async move {
        let start = std::time::Instant::now();
        let result = execution.wait().await;
        (result, start.elapsed())
    });

    // Stop the box
    let stop_start = std::time::Instant::now();
    let stop_result = handle.stop().await;
    let stop_elapsed = stop_start.elapsed();

    let wait_result = tokio::time::timeout(Duration::from_secs(30), wait_handle).await;

    println!("=== test_wait_timing_after_stop ===");
    println!("Process ignores SIGTERM (worst case scenario)");
    println!("stop() took: {:?}, result: {:?}", stop_elapsed, stop_result);

    match wait_result {
        Ok(Ok((wait_res, wait_elapsed))) => {
            println!("wait() took: {:?}, result: {:?}", wait_elapsed, wait_res);
            println!();
            println!("Key question: Did wait() return immediately when stop() completed,");
            println!("or did it wait for the full process termination?");

            // If wait_elapsed is close to stop_elapsed, wait() returned promptly
            // If wait_elapsed >> stop_elapsed, there's a delay issue
        }
        Ok(Err(e)) => {
            println!("wait() task panicked: {:?}", e);
        }
        Err(_) => {
            println!("TIMEOUT: wait() hung for 30+ seconds");
        }
    }

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test 7: Multiple concurrent executions when box stops
///
/// Tests that all pending wait() calls return when box stops.
#[tokio::test]
async fn test_multiple_executions_on_box_stop() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start multiple long-running commands
    let mut exec1 = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();
    let mut exec2 = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();
    let mut exec3 = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();

    // Spawn wait() for all
    let wait1 = tokio::spawn(async move {
        let start = std::time::Instant::now();
        let result = exec1.wait().await;
        (1, result, start.elapsed())
    });
    let wait2 = tokio::spawn(async move {
        let start = std::time::Instant::now();
        let result = exec2.wait().await;
        (2, result, start.elapsed())
    });
    let wait3 = tokio::spawn(async move {
        let start = std::time::Instant::now();
        let result = exec3.wait().await;
        (3, result, start.elapsed())
    });

    tokio::time::sleep(Duration::from_millis(500)).await;

    // Stop the box
    let stop_start = std::time::Instant::now();
    handle.stop().await.unwrap();
    let stop_elapsed = stop_start.elapsed();

    // Wait for all with timeout
    let results = tokio::time::timeout(
        Duration::from_secs(30),
        futures::future::join_all([wait1, wait2, wait3]),
    )
    .await;

    println!("=== test_multiple_executions_on_box_stop ===");
    println!("box.stop() took: {:?}", stop_elapsed);

    match results {
        Ok(results) => {
            for result in results {
                match result {
                    Ok((id, exec_result, elapsed)) => {
                        println!(
                            "exec{} wait() took {:?}, result: {:?}",
                            id, elapsed, exec_result
                        );
                    }
                    Err(e) => {
                        println!("Task panicked: {:?}", e);
                    }
                }
            }
        }
        Err(_) => {
            println!("TIMEOUT: Some wait() calls did not return within 30s");
        }
    }

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

// ============================================================================
// CANCELLATION TOKEN INTEGRATION TESTS
// ============================================================================

/// Test that running a command returns Stopped error after box.stop().
///
/// This verifies the CancellationToken is properly wired and
/// checked before attempting to run commands.
#[tokio::test]
async fn test_run_command_returns_stopped_error() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Run a quick command to verify box works
    let mut execution = handle
        .exec(BoxCommand::new("echo").arg("hello"))
        .await
        .unwrap();
    let result = execution.wait().await.unwrap();
    assert_eq!(result.exit_code, 0);

    // Stop the box
    handle.stop().await.unwrap();

    // Attempt to run command - should fail with Stopped error
    let result = handle.exec(BoxCommand::new("echo").arg("world")).await;

    println!("=== test_run_command_returns_stopped_error ===");
    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("✓ Got expected Stopped error: {}", msg);
        }
        Err(e) => {
            panic!("Expected Stopped error, got: {:?}", e);
        }
        Ok(_) => {
            panic!("Expected error, but command run succeeded");
        }
    }

    assert!(matches!(result, Err(BoxliteError::Stopped(_))));

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test that start() returns Stopped error after box.stop().
#[tokio::test]
async fn test_start_returns_stopped_error() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Stop the box
    handle.stop().await.unwrap();

    // Attempt start - should fail with Stopped error
    let result = handle.start().await;

    println!("=== test_start_returns_stopped_error ===");
    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("✓ Got expected Stopped error: {}", msg);
        }
        Err(e) => {
            panic!("Expected Stopped error, got: {:?}", e);
        }
        Ok(_) => {
            panic!("Expected error, but start succeeded");
        }
    }

    assert!(matches!(result, Err(BoxliteError::Stopped(_))));

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test that metrics() returns Stopped error after box.stop().
#[tokio::test]
async fn test_metrics_returns_stopped_error() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Stop the box
    handle.stop().await.unwrap();

    // Attempt metrics - should fail with Stopped error
    let result = handle.metrics().await;

    println!("=== test_metrics_returns_stopped_error ===");
    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("✓ Got expected Stopped error: {}", msg);
        }
        Err(e) => {
            panic!("Expected Stopped error, got: {:?}", e);
        }
        Ok(_) => {
            panic!("Expected error, but metrics succeeded");
        }
    }

    assert!(matches!(result, Err(BoxliteError::Stopped(_))));

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test that create() returns Stopped error after runtime.shutdown().
#[tokio::test]
async fn test_create_after_shutdown_returns_stopped() {
    let ctx = TestContext::new();

    // Shutdown runtime
    ctx.runtime.shutdown(Some(5)).await.unwrap();

    // Attempt to create box after shutdown
    let result = ctx.runtime.create(default_box_options(), None).await;

    println!("=== test_create_after_shutdown_returns_stopped ===");
    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("✓ Got expected Stopped error: {}", msg);
        }
        Err(e) => {
            panic!("Expected Stopped error, got: {:?}", e);
        }
        Ok(_) => {
            panic!("Expected error, but create succeeded");
        }
    }

    assert!(matches!(result, Err(BoxliteError::Stopped(_))));
}

/// Test that wait() returns promptly when box is stopped.
///
/// This is the key test for the cancellation token implementation.
/// Before the fix, wait() could hang indefinitely.
/// After the fix, wait() should return within a reasonable time.
#[tokio::test]
async fn test_wait_returns_promptly_on_stop() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start a long-running command
    let mut run = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();

    // Spawn wait() in background with timing
    let wait_handle = tokio::spawn(async move {
        let start = std::time::Instant::now();
        let result = run.wait().await;
        (result, start.elapsed())
    });

    // Give command time to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Stop the box - this should trigger cancellation
    let stop_start = std::time::Instant::now();
    handle.stop().await.unwrap();
    let stop_elapsed = stop_start.elapsed();

    // wait() should return quickly after stop
    let wait_result = tokio::time::timeout(Duration::from_secs(5), wait_handle).await;

    println!("=== test_wait_returns_promptly_on_stop ===");
    println!("box.stop() took: {:?}", stop_elapsed);

    match wait_result {
        Ok(Ok((result, wait_elapsed))) => {
            println!("wait() took: {:?}", wait_elapsed);
            println!("wait() result: {:?}", result);

            // Key assertion: wait() should return reasonably quickly after stop
            // We allow up to 5 seconds, but it should typically be much faster
            assert!(
                wait_elapsed < Duration::from_secs(5),
                "wait() took too long: {:?}",
                wait_elapsed
            );
            println!("✓ wait() returned promptly after box.stop()");
        }
        Ok(Err(e)) => {
            panic!("wait() task panicked: {:?}", e);
        }
        Err(_) => {
            panic!("TIMEOUT: wait() did not return within 5 seconds after stop!");
        }
    }

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test that all concurrent wait() calls return when box is stopped.
///
/// This tests that the cancellation token properly fans out to all
/// pending operations.
#[tokio::test]
async fn test_all_waits_return_on_stop() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Start multiple long-running commands
    let mut run1 = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();
    let mut run2 = handle
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();

    // Spawn wait() for all
    let start_time = std::time::Instant::now();

    let wait1 = tokio::spawn(async move {
        let result = run1.wait().await;
        (1, result, start_time.elapsed())
    });
    let wait2 = tokio::spawn(async move {
        let result = run2.wait().await;
        (2, result, start_time.elapsed())
    });

    // Give commands time to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Stop the box
    handle.stop().await.unwrap();
    let stop_elapsed = start_time.elapsed();

    // Wait for all with timeout
    let results = tokio::time::timeout(
        Duration::from_secs(5),
        futures::future::join_all([wait1, wait2]),
    )
    .await;

    println!("=== test_all_waits_return_on_stop ===");
    println!("box.stop() completed at {:?}", stop_elapsed);

    match results {
        Ok(results) => {
            let mut all_returned = true;
            for result in results {
                match result {
                    Ok((id, run_result, elapsed)) => {
                        println!(
                            "run{} wait() returned at {:?}, result: {:?}",
                            id, elapsed, run_result
                        );
                        // All waits should return within reasonable time after stop
                        assert!(elapsed < Duration::from_secs(6), "wait{} took too long", id);
                    }
                    Err(e) => {
                        println!("Task {} panicked: {:?}", all_returned, e);
                        all_returned = false;
                    }
                }
            }
            assert!(all_returned, "All wait tasks should complete");
            println!("✓ All wait() calls returned after box.stop()");
        }
        Err(_) => {
            panic!("TIMEOUT: Some wait() calls did not return within 5s");
        }
    }

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Test that runtime shutdown stops all boxes and their commands.
#[tokio::test]
async fn test_runtime_shutdown_stops_all_boxes() {
    let ctx = TestContext::new();

    // Create multiple boxes
    let handle1 = ctx
        .runtime
        .create(default_box_options(), Some("box1".into()))
        .await
        .unwrap();
    let handle2 = ctx
        .runtime
        .create(default_box_options(), Some("box2".into()))
        .await
        .unwrap();

    handle1.start().await.unwrap();
    handle2.start().await.unwrap();

    // Start long-running commands on each
    let mut run1 = handle1
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();
    let mut run2 = handle2
        .exec(BoxCommand::new("sleep").arg("3600"))
        .await
        .unwrap();

    // Spawn wait() for all
    let start_time = std::time::Instant::now();

    let wait1 = tokio::spawn(async move {
        let result = run1.wait().await;
        (1, result, start_time.elapsed())
    });
    let wait2 = tokio::spawn(async move {
        let result = run2.wait().await;
        (2, result, start_time.elapsed())
    });

    // Give commands time to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Shutdown runtime (should cancel all boxes)
    let shutdown_result = ctx.runtime.shutdown(Some(5)).await;
    let shutdown_elapsed = start_time.elapsed();

    // Wait for all with timeout
    let results = tokio::time::timeout(
        Duration::from_secs(10),
        futures::future::join_all([wait1, wait2]),
    )
    .await;

    println!("=== test_runtime_shutdown_stops_all_boxes ===");
    println!(
        "runtime.shutdown() completed at {:?}, result: {:?}",
        shutdown_elapsed, shutdown_result
    );

    match results {
        Ok(results) => {
            for result in results {
                match result {
                    Ok((id, run_result, elapsed)) => {
                        println!(
                            "box{} wait() returned at {:?}, result: {:?}",
                            id, elapsed, run_result
                        );
                    }
                    Err(e) => {
                        println!("Task panicked: {:?}", e);
                    }
                }
            }
            println!("✓ All boxes stopped during runtime shutdown");
        }
        Err(_) => {
            panic!("TIMEOUT: Some wait() calls did not return within 10s");
        }
    }
}

// ============================================================================
// ECHILD FIX + SENDINPUT SHUTDOWN TESTS
// ============================================================================
// These tests cover:
// - ECHILD fix: guest uses std::process::Command (no Tokio SIGCHLD race)
// - SendInput fix: spawn_stdin uses shutdown_token for clean cancellation
// - Exit code preservation after the ECHILD safety net

/// Exec completes normally, then runtime shutdown — should be clean.
///
/// Before fix: spawn_stdin hit transport error during shutdown (WARN log).
/// After fix: spawn_stdin cancelled cleanly via shutdown_token.
#[tokio::test]
async fn test_exec_completes_then_shutdown_is_clean() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    let mut execution = handle
        .exec(BoxCommand::new("echo").arg("hello"))
        .await
        .unwrap();
    let result = execution.wait().await.unwrap();
    assert_eq!(result.exit_code, 0);

    // Shutdown after exec completes — should not produce transport errors
    let shutdown_result = ctx.runtime.shutdown(Some(5)).await;
    assert!(shutdown_result.is_ok());
}

/// Sequential exec on same box should both succeed.
///
/// This tests the original bug: transport error on second exec.
/// Root cause was Tokio's orphan reaper racing with waitpid in the guest.
#[tokio::test]
async fn test_sequential_exec_same_box() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // First exec
    let mut exec1 = handle
        .exec(BoxCommand::new("echo").arg("first"))
        .await
        .unwrap();
    let result1 = exec1.wait().await.unwrap();
    assert_eq!(result1.exit_code, 0);

    // Second exec on same box — should also succeed
    let mut exec2 = handle
        .exec(BoxCommand::new("echo").arg("second"))
        .await
        .unwrap();
    let result2 = exec2.wait().await.unwrap();
    assert_eq!(result2.exit_code, 0);

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Exit codes should be correctly preserved.
///
/// Before ECHILD fix: could return -1 due to waitpid race.
/// After fix: std::process::Command avoids the race entirely.
#[tokio::test]
async fn test_exec_exit_code_preserved() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Success (exit 0)
    let mut exec0 = handle.exec(BoxCommand::new("true")).await.unwrap();
    assert_eq!(exec0.wait().await.unwrap().exit_code, 0);

    // Failure (exit 1)
    let mut exec1 = handle.exec(BoxCommand::new("false")).await.unwrap();
    assert_eq!(exec1.wait().await.unwrap().exit_code, 1);

    // Custom exit code
    let mut exec42 = handle
        .exec(BoxCommand::new("sh").args(["-c", "exit 42"]))
        .await
        .unwrap();
    assert_eq!(exec42.wait().await.unwrap().exit_code, 42);

    // Cleanup
    let _ = ctx.runtime.remove(handle.id().as_str(), true).await;
}

/// Multiple sequential execs followed by shutdown — the full CLI workflow.
///
/// This is the exact scenario that triggered the original bug:
/// run several commands, then shutdown cleanly.
#[tokio::test]
async fn test_exec_then_shutdown_sequential() {
    let ctx = TestContext::new();
    let handle = ctx
        .runtime
        .create(default_box_options(), None)
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Run 3 commands sequentially
    for i in 0..3 {
        let mut execution = handle
            .exec(BoxCommand::new("echo").arg(format!("cmd-{}", i)))
            .await
            .unwrap();
        let result = execution.wait().await.unwrap();
        assert_eq!(result.exit_code, 0, "Command {} should succeed", i);
    }

    // Shutdown after all commands complete
    let shutdown_result = ctx.runtime.shutdown(Some(5)).await;
    assert!(shutdown_result.is_ok());
}
