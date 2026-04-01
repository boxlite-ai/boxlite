//! Tests to verify Execution behavior during shutdown scenarios.
//!
//! These tests document current behavior and verify assumptions about
//! how wait(), streams, and shutdown interact.

mod common;

use boxlite::BoxCommand;
use boxlite::BoxliteRuntime;
use boxlite::runtime::options::BoxliteOptions;
use boxlite_shared::BoxliteError;
use std::time::Duration;

// ============================================================================
// BEHAVIOR VERIFICATION TESTS
// ============================================================================

/// Test 1: What happens to wait() when box.stop() is called?
///
/// Assumption: wait() should eventually return (not hang forever)
/// because the guest process exits when box stops.
#[tokio::test]
async fn test_wait_behavior_on_box_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    tokio::time::sleep(Duration::from_millis(50)).await;

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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test 2: What happens to wait() when runtime.shutdown() is called?
///
/// Assumption: Similar to box.stop(), but may have different timing
/// because shutdown stops all boxes concurrently.
#[tokio::test]
async fn test_wait_behavior_on_runtime_shutdown() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Shutdown runtime
    let shutdown_start = std::time::Instant::now();
    let shutdown_result = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
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

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Stop the box
    handle.stop().await.unwrap();

    let (lines, final_result) = read_handle.await.unwrap();

    println!("=== test_stdout_stream_on_box_stop ===");
    println!("Lines read before stop: {:?}", lines);
    println!("Final stream result after stop: {:?}", final_result);
    // None = EOF, Some(...) = got more data, Timeout = stream hung

    // Cleanup
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test 4: Can we call exec() on a stopped box?
///
/// Assumption: Should return an error (InvalidState or Stopped).
#[tokio::test]
async fn test_exec_on_stopped_box() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test 5: What happens to existing Execution when box is stopped?
///
/// This tests the scenario where user has an Execution handle,
/// then box.stop() is called from elsewhere.
#[tokio::test]
async fn test_existing_execution_after_box_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test 6: Measure actual timing - how long does wait() block after stop?
#[tokio::test]
async fn test_wait_timing_after_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    handle.start().await.unwrap();

    // Start command that ignores SIGTERM (to test worst case)
    let mut execution = handle
        .exec(BoxCommand::new("sh").args(["-c", "trap '' TERM; sleep 3600"]))
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(50)).await;

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
        }
        Ok(Err(e)) => {
            println!("wait() task panicked: {:?}", e);
        }
        Err(_) => {
            println!("TIMEOUT: wait() hung for 30+ seconds");
        }
    }

    // Cleanup
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test 7: Multiple concurrent executions when box stops
///
/// Tests that all pending wait() calls return when box stops.
#[tokio::test]
async fn test_multiple_executions_on_box_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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

    tokio::time::sleep(Duration::from_millis(50)).await;

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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

// ============================================================================
// CANCELLATION TOKEN INTEGRATION TESTS
// ============================================================================

/// Test that running a command returns Stopped error after box.stop().
#[tokio::test]
async fn test_run_command_returns_stopped_error() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
            println!("Got expected Stopped error: {}", msg);
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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test that start() returns Stopped error after box.stop().
#[tokio::test]
async fn test_start_returns_stopped_error() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    handle.start().await.unwrap();

    // Stop the box
    handle.stop().await.unwrap();

    // Attempt start - should fail with Stopped error
    let result = handle.start().await;

    println!("=== test_start_returns_stopped_error ===");
    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("Got expected Stopped error: {}", msg);
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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test that metrics() returns Stopped error after box.stop().
#[tokio::test]
async fn test_metrics_returns_stopped_error() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    handle.start().await.unwrap();

    // Stop the box
    handle.stop().await.unwrap();

    // Attempt metrics - should fail with Stopped error
    let result = handle.metrics().await;

    println!("=== test_metrics_returns_stopped_error ===");
    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("Got expected Stopped error: {}", msg);
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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test that create() returns Stopped error after runtime.shutdown().
#[tokio::test]
async fn test_create_after_shutdown_returns_stopped() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Shutdown runtime
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();

    // Attempt to create box after shutdown
    let result = runtime.create(common::alpine_opts(), None).await;

    println!("=== test_create_after_shutdown_returns_stopped ===");
    match &result {
        Err(BoxliteError::Stopped(msg)) => {
            println!("Got expected Stopped error: {}", msg);
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
#[tokio::test]
async fn test_wait_returns_promptly_on_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    tokio::time::sleep(Duration::from_millis(50)).await;

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

            assert!(
                wait_elapsed < Duration::from_secs(5),
                "wait() took too long: {:?}",
                wait_elapsed
            );
            println!("wait() returned promptly after box.stop()");
        }
        Ok(Err(e)) => {
            panic!("wait() task panicked: {:?}", e);
        }
        Err(_) => {
            panic!("TIMEOUT: wait() did not return within 5 seconds after stop!");
        }
    }

    // Cleanup
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test that all concurrent wait() calls return when box is stopped.
#[tokio::test]
async fn test_all_waits_return_on_stop() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    tokio::time::sleep(Duration::from_millis(50)).await;

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
                        assert!(elapsed < Duration::from_secs(6), "wait{} took too long", id);
                    }
                    Err(e) => {
                        println!("Task {} panicked: {:?}", all_returned, e);
                        all_returned = false;
                    }
                }
            }
            assert!(all_returned, "All wait tasks should complete");
            println!("All wait() calls returned after box.stop()");
        }
        Err(_) => {
            panic!("TIMEOUT: Some wait() calls did not return within 5s");
        }
    }

    // Cleanup
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Test that runtime shutdown stops all boxes and their commands.
#[tokio::test]
async fn test_runtime_shutdown_stops_all_boxes() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // Create multiple boxes
    let handle1 = runtime
        .create(common::alpine_opts(), Some("box1".into()))
        .await
        .unwrap();
    let handle2 = runtime
        .create(common::alpine_opts(), Some("box2".into()))
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
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Shutdown runtime (should cancel all boxes)
    let shutdown_result = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
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
            println!("All boxes stopped during runtime shutdown");
        }
        Err(_) => {
            panic!("TIMEOUT: Some wait() calls did not return within 10s");
        }
    }
}

// ============================================================================
// ECHILD FIX + SENDINPUT SHUTDOWN TESTS
// ============================================================================

/// Exec completes normally, then runtime shutdown — should be clean.
#[tokio::test]
async fn test_exec_completes_then_shutdown_is_clean() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    handle.start().await.unwrap();

    let mut execution = handle
        .exec(BoxCommand::new("echo").arg("hello"))
        .await
        .unwrap();
    let result = execution.wait().await.unwrap();
    assert_eq!(result.exit_code, 0);

    // Shutdown after exec completes — should not produce transport errors
    let shutdown_result = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
    assert!(shutdown_result.is_ok());
}

/// Sequential exec on same box should both succeed.
#[tokio::test]
async fn test_sequential_exec_same_box() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Exit codes should be correctly preserved.
#[tokio::test]
async fn test_exec_exit_code_preserved() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Multiple sequential execs followed by shutdown — the full CLI workflow.
#[tokio::test]
async fn test_exec_then_shutdown_sequential() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
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
    let shutdown_result = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
    assert!(shutdown_result.is_ok());
}

// ============================================================================
// CONCURRENT EXEC TESTS
// ============================================================================

// ---- Shared helpers for concurrent exec tests ----

use boxlite::LiteBox;
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use std::sync::Arc;

/// Dump guest-side logs (shim.stderr + console.log) for diagnostic visibility.
fn dump_guest_logs(home_dir: &std::path::Path, box_id: &str) {
    let box_dir = home_dir.join("boxes").join(box_id);

    // shim.stderr: contains shim + guest eprintln output
    let shim_stderr = box_dir.join("shim.stderr");
    match std::fs::read_to_string(&shim_stderr) {
        Ok(content) if !content.is_empty() => {
            eprintln!("\n=== shim.stderr ({}) ===", shim_stderr.display());
            // Print lines containing [guest] for focused diagnostics
            let guest_lines: Vec<&str> =
                content.lines().filter(|l| l.contains("[guest]")).collect();
            if guest_lines.is_empty() {
                eprintln!(
                    "(no [guest] lines found, full content {} bytes)",
                    content.len()
                );
                // Print last 30 lines for context
                let lines: Vec<&str> = content.lines().collect();
                let start = lines.len().saturating_sub(30);
                for line in &lines[start..] {
                    eprintln!("  {}", line);
                }
            } else {
                eprintln!("Found {} [guest] lines:", guest_lines.len());
                for line in &guest_lines {
                    eprintln!("  {}", line);
                }
            }
            eprintln!("=== end shim.stderr ===\n");
        }
        Ok(_) => eprintln!("[diag] shim.stderr is empty"),
        Err(e) => eprintln!("[diag] shim.stderr not found: {}", e),
    }

    // console.log: VM console output (kernel + init + guest diagnostics)
    let console_log = box_dir.join("logs").join("console.log");
    match std::fs::read_to_string(&console_log) {
        Ok(content) if !content.is_empty() => {
            // Match both [guest] and [guest-diag] prefixes
            let guest_lines: Vec<&str> = content.lines().filter(|l| l.contains("[guest")).collect();
            if !guest_lines.is_empty() {
                eprintln!(
                    "\n=== console.log ({} guest lines of {} total) ===",
                    guest_lines.len(),
                    content.lines().count()
                );
                for line in &guest_lines {
                    eprintln!("  {}", line);
                }
                eprintln!("=== end console.log ===\n");
            } else {
                // No guest lines — dump last 50 lines for context
                eprintln!(
                    "\n=== console.log (no [guest lines, {} bytes, last 50 lines) ===",
                    content.len()
                );
                let lines: Vec<&str> = content.lines().collect();
                let start = lines.len().saturating_sub(50);
                for line in &lines[start..] {
                    eprintln!("  {}", line);
                }
                eprintln!("=== end console.log ===\n");
            }
        }
        Ok(_) => eprintln!("[diag] console.log is empty"),
        Err(e) => eprintln!("[diag] console.log not found: {}", e),
    }
}

/// Await a future with timeout; on timeout, panic with context.
async fn timeout_with_dump<T>(
    duration: Duration,
    future: impl std::future::Future<Output = T>,
    context: &str,
) -> T {
    tokio::time::timeout(duration, future)
        .await
        .unwrap_or_else(|_| panic!("TIMEOUT after {:?}: {}", duration, context))
}

/// Create a 2-vCPU box for concurrent tests, returned as Arc for sharing.
///
/// Includes a warmup exec to verify the guest is responsive and the gRPC
/// connection is established before returning.
async fn create_concurrent_box(runtime: &BoxliteRuntime) -> Arc<LiteBox> {
    let handle = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                cpus: Some(2),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    handle.start().await.unwrap();

    // Warmup: verify guest is responsive before concurrent tests
    let mut warmup = handle
        .exec(BoxCommand::new("echo").arg("warmup"))
        .await
        .expect("warmup exec should succeed — guest not responsive");
    let result = warmup.wait().await.expect("warmup wait failed");
    assert_eq!(result.exit_code, 0, "warmup exec should exit 0");

    Arc::new(handle)
}

/// Cleanup: unwrap Arc, remove box, shutdown runtime.
async fn cleanup_concurrent_box(handle: Arc<LiteBox>, runtime: BoxliteRuntime) {
    let handle = Arc::try_unwrap(handle).unwrap_or_else(|arc| {
        panic!("unexpected Arc refs: {}", Arc::strong_count(&arc));
    });
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Create a runtime with a per-test home directory.
fn create_test_runtime() -> (boxlite_test_utils::home::PerTestBoxHome, BoxliteRuntime) {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    (home, runtime)
}

/// Regression test for concurrent exec deadlock (issue #349).
///
/// When multiple exec calls run concurrently on the same box, the guest agent
/// hangs because:
/// 1. libcontainer's build is a blocking call (clone3/waitpid) running on tokio
///    worker threads — starving the runtime when N >= worker count.
/// 2. libcontainer uses process-global chdir internally, causing CWD races
///    between concurrent build calls.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_all_complete() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // Spawn 4 concurrent execs — all should complete without hanging
    const NUM_CONCURRENT: usize = 4;
    let mut tasks = Vec::new();
    for i in 0..NUM_CONCURRENT {
        let h = handle.clone();
        let task = tokio::spawn(async move {
            let mut execution = h
                .exec(BoxCommand::new("sh").args(["-c", &format!("echo task-{}", i)]))
                .await?;

            // Collect stdout
            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }

            let result = execution.wait().await?;
            Ok::<(i32, String), BoxliteError>((result.exit_code, output))
        });
        tasks.push(task);
    }

    // All 4 must complete within 60 seconds — failure here indicates deadlock
    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "concurrent exec calls did not complete within 60s — likely deadlock",
    )
    .await;

    // Verify all completed successfully
    for (i, result) in results.into_iter().enumerate() {
        let (exit_code, stdout) = result
            .unwrap_or_else(|e| panic!("task {} panicked: {:?}", i, e))
            .unwrap_or_else(|e| panic!("task {} exec failed: {:?}", i, e));
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
        assert!(
            stdout.trim().starts_with("task-"),
            "task {} stdout should contain 'task-', got: {:?}",
            i,
            stdout
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Verify stdout isolation: each concurrent exec sees only its own output.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_output_isolation() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..4 {
        let h = handle.clone();
        let marker = format!("MARKER-{}", i);
        let task = tokio::spawn(async move {
            let mut execution = h.exec(BoxCommand::new("echo").arg(&marker)).await?;

            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }
            let result = execution.wait().await?;
            Ok::<(i32, String, String), BoxliteError>((result.exit_code, output, marker))
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "output isolation test deadlocked",
    )
    .await;

    for (i, result) in results.into_iter().enumerate() {
        let (exit_code, stdout, marker) = result
            .unwrap_or_else(|e| panic!("task {} panicked: {:?}", i, e))
            .unwrap_or_else(|e| panic!("task {} failed: {:?}", i, e));
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
        assert!(
            stdout.contains(&marker),
            "task {} stdout should contain '{}', got: {:?}",
            i,
            marker,
            stdout
        );
        // Verify NO other markers leaked into this stream
        for j in 0..4 {
            if j != i {
                let other_marker = format!("MARKER-{}", j);
                assert!(
                    !stdout.contains(&other_marker),
                    "task {} stdout contains foreign marker '{}': {:?}",
                    i,
                    other_marker,
                    stdout
                );
            }
        }
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Verify exit codes are correctly reported under concurrency.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_exit_codes() {
    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let exit_codes = [0, 1, 42, 0];
    let mut tasks = Vec::new();
    let t0 = std::time::Instant::now();
    for (i, &code) in exit_codes.iter().enumerate() {
        let h = handle.clone();
        let task = tokio::spawn(async move {
            eprintln!("[{:?}] task-{}: calling exec", t0.elapsed(), i);
            let mut execution = h
                .exec(BoxCommand::new("sh").args(["-c", &format!("exit {}", code)]))
                .await?;
            eprintln!(
                "[{:?}] task-{}: exec returned, calling wait",
                t0.elapsed(),
                i
            );
            let result = execution.wait().await?;
            eprintln!(
                "[{:?}] task-{}: wait returned, exit_code={}",
                t0.elapsed(),
                i,
                result.exit_code
            );
            Ok::<(usize, i32), BoxliteError>((i, result.exit_code))
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "exit code test deadlocked",
    )
    .await;

    for result in results {
        let (i, actual_code) = result.unwrap().unwrap();
        assert_eq!(
            actual_code, exit_codes[i],
            "task {} expected exit code {}, got {}",
            i, exit_codes[i], actual_code
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Fast execs should not block on slow ones; all complete within timeout.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_mixed_durations() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // 2 instant + 2 slow (sleep 2s)
    let commands: Vec<(&str, &[&str])> = vec![
        ("echo", &["fast-0"] as &[&str]),
        ("echo", &["fast-1"]),
        ("sh", &["-c", "sleep 2 && echo slow-0"]),
        ("sh", &["-c", "sleep 2 && echo slow-1"]),
    ];

    let mut tasks = Vec::new();
    for (i, (program, args)) in commands.into_iter().enumerate() {
        let h = handle.clone();
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let program = program.to_string();
        let task = tokio::spawn(async move {
            let mut execution = h.exec(BoxCommand::new(&program).args(args)).await?;

            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }
            let result = execution.wait().await?;
            Ok::<(usize, i32, String), BoxliteError>((i, result.exit_code, output))
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "mixed duration test deadlocked",
    )
    .await;

    for result in results {
        let (i, exit_code, stdout) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
        assert!(
            !stdout.trim().is_empty(),
            "task {} should produce output",
            i
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Mutex does not poison state: sequential execs work after concurrent batch.
#[tokio::test(flavor = "multi_thread")]
async fn test_sequential_exec_after_concurrent() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // Phase 1: 4 concurrent execs
    let mut tasks = Vec::new();
    for i in 0..4 {
        let h = handle.clone();
        let task = tokio::spawn(async move {
            let mut execution = h
                .exec(BoxCommand::new("echo").arg(format!("concurrent-{}", i)))
                .await?;
            let result = execution.wait().await?;
            Ok::<i32, BoxliteError>(result.exit_code)
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "concurrent phase deadlocked",
    )
    .await;

    for (i, result) in results.into_iter().enumerate() {
        assert_eq!(
            result.unwrap().unwrap(),
            0,
            "concurrent task {} should exit 0",
            i
        );
    }

    // Phase 2: 2 sequential execs — must still work
    for i in 0..2 {
        let mut execution = handle
            .exec(BoxCommand::new("echo").arg(format!("sequential-{}", i)))
            .await
            .unwrap();

        let mut output = String::new();
        if let Some(mut stdout) = execution.stdout() {
            while let Some(chunk) = stdout.next().await {
                output.push_str(&chunk);
            }
        }

        let result = execution.wait().await.unwrap();
        assert_eq!(result.exit_code, 0, "sequential exec {} should exit 0", i);
        assert!(
            output.contains(&format!("sequential-{}", i)),
            "sequential exec {} output mismatch: {:?}",
            i,
            output
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// 8 concurrent execs complete without worker starvation.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_high_concurrency() {
    let (home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;
    let box_id = handle.id().to_string();

    let t0 = std::time::Instant::now();
    let mut tasks = Vec::new();
    for i in 0..8 {
        let h = handle.clone();
        let task = tokio::spawn(async move {
            eprintln!("[{:?}] hc-{}: calling exec", t0.elapsed(), i);
            let mut execution = h
                .exec(BoxCommand::new("echo").arg(format!("high-{}", i)))
                .await?;
            eprintln!("[{:?}] hc-{}: exec returned, calling wait", t0.elapsed(), i);
            let result = execution.wait().await?;
            eprintln!(
                "[{:?}] hc-{}: wait returned, exit_code={}",
                t0.elapsed(),
                i,
                result.exit_code
            );
            Ok::<(usize, i32), BoxliteError>((i, result.exit_code))
        });
        tasks.push(task);
    }

    let outcome =
        tokio::time::timeout(Duration::from_secs(120), futures::future::join_all(tasks)).await;

    // Always dump guest logs, even on timeout
    dump_guest_logs(&home.path, &box_id);

    let results = outcome.expect("TIMEOUT after 120s: 8 concurrent execs — likely starvation");

    for result in results {
        let (i, exit_code) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "high-concurrency task {} should exit 0", i);
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// One failure does not block other concurrent execs.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_partial_failure() {
    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // 3 succeed (echo ok) + 1 fails (exit 7)
    let commands: Vec<(&str, &[&str], i32)> = vec![
        ("echo", &["ok"] as &[&str], 0),
        ("echo", &["ok"], 0),
        ("echo", &["ok"], 0),
        ("sh", &["-c", "exit 7"], 7),
    ];

    let mut tasks = Vec::new();
    let t0 = std::time::Instant::now();
    for (i, (program, args, expected)) in commands.into_iter().enumerate() {
        let h = handle.clone();
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let program = program.to_string();
        let task = tokio::spawn(async move {
            eprintln!("[{:?}] task-{}: calling exec({})", t0.elapsed(), i, program);
            let mut execution = h.exec(BoxCommand::new(&program).args(args)).await?;
            eprintln!(
                "[{:?}] task-{}: exec returned, calling wait",
                t0.elapsed(),
                i
            );
            let result = execution.wait().await?;
            eprintln!(
                "[{:?}] task-{}: wait returned, exit_code={}",
                t0.elapsed(),
                i,
                result.exit_code
            );
            Ok::<(usize, i32, i32), BoxliteError>((i, result.exit_code, expected))
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "partial failure test deadlocked",
    )
    .await;

    for result in results {
        let (i, actual, expected) = result.unwrap().unwrap();
        assert_eq!(
            actual, expected,
            "task {} expected exit code {}, got {}",
            i, expected, actual
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Stderr is isolated between concurrent execs.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_with_stderr() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..4 {
        let h = handle.clone();
        let task = tokio::spawn(async move {
            let script = format!("echo OUT-{i}; echo ERR-{i} >&2");
            let mut execution = h.exec(BoxCommand::new("sh").args(["-c", &script])).await?;

            let out_stream = execution.stdout();
            let err_stream = execution.stderr();

            let (stdout_text, stderr_text) = tokio::join!(
                async {
                    let mut text = String::new();
                    if let Some(mut s) = out_stream {
                        while let Some(chunk) = s.next().await {
                            text.push_str(&chunk);
                        }
                    }
                    text
                },
                async {
                    let mut text = String::new();
                    if let Some(mut s) = err_stream {
                        while let Some(chunk) = s.next().await {
                            text.push_str(&chunk);
                        }
                    }
                    text
                }
            );

            let result = execution.wait().await?;
            Ok::<(usize, i32, String, String), BoxliteError>((
                i,
                result.exit_code,
                stdout_text,
                stderr_text,
            ))
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "stderr isolation test deadlocked",
    )
    .await;

    for result in results {
        let (i, exit_code, stdout, stderr) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "task {} should exit 0", i);

        let expected_out = format!("OUT-{}", i);
        let expected_err = format!("ERR-{}", i);
        assert!(
            stdout.contains(&expected_out),
            "task {} stdout should contain '{}', got: {:?}",
            i,
            expected_out,
            stdout
        );
        assert!(
            stderr.contains(&expected_err),
            "task {} stderr should contain '{}', got: {:?}",
            i,
            expected_err,
            stderr
        );

        // No cross-contamination
        for j in 0..4 {
            if j != i {
                assert!(
                    !stdout.contains(&format!("OUT-{}", j)),
                    "task {} stdout has foreign OUT-{}: {:?}",
                    i,
                    j,
                    stdout
                );
                assert!(
                    !stderr.contains(&format!("ERR-{}", j)),
                    "task {} stderr has foreign ERR-{}: {:?}",
                    i,
                    j,
                    stderr
                );
            }
        }
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Environment variables are per-invocation, not shared across concurrent execs.
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_env_isolation() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..4 {
        let h = handle.clone();
        let env_val = format!("value-{}", i);
        let task = tokio::spawn(async move {
            let mut execution = h
                .exec(
                    BoxCommand::new("sh")
                        .args(["-c", "echo $MY_VAR"])
                        .env("MY_VAR", &env_val),
                )
                .await?;

            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }
            let result = execution.wait().await?;
            Ok::<(usize, i32, String, String), BoxliteError>((i, result.exit_code, output, env_val))
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "env isolation test deadlocked",
    )
    .await;

    for result in results {
        let (i, exit_code, stdout, expected_val) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
        assert!(
            stdout.contains(&expected_val),
            "task {} should see MY_VAR='{}', got: {:?}",
            i,
            expected_val,
            stdout
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Working directory is correctly applied per invocation (chdir race fix).
#[tokio::test(flavor = "multi_thread")]
async fn test_concurrent_exec_workdir() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // Use directories that exist in alpine by default
    let workdirs = ["/tmp", "/", "/var", "/tmp"];

    let mut tasks = Vec::new();
    for (i, workdir) in workdirs.iter().enumerate() {
        let h = handle.clone();
        let wd = workdir.to_string();
        let task = tokio::spawn(async move {
            let mut execution = h.exec(BoxCommand::new("pwd").working_dir(&wd)).await?;

            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }
            let result = execution.wait().await?;
            Ok::<(usize, i32, String, String), BoxliteError>((i, result.exit_code, output, wd))
        });
        tasks.push(task);
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "workdir test deadlocked — possible chdir race",
    )
    .await;

    for result in results {
        let (i, exit_code, stdout, expected_dir) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
        assert_eq!(
            stdout.trim(),
            expected_dir,
            "task {} pwd should be '{}', got: {:?}",
            i,
            expected_dir,
            stdout.trim()
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}
