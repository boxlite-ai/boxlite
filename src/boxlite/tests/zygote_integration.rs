//! Integration tests for the zygote-based exec path.
//!
//! These tests verify that the zygote process correctly handles concurrent
//! container builds without the musl __malloc_lock deadlock that occurred
//! when clone3() was called from tokio worker threads.
//!
//! The zygote is transparent — these tests exercise the same `handle.exec()`
//! API as before, but the build now routes through the zygote's single-threaded
//! fork server instead of calling ContainerBuilder inline.
//!
//! See `docs/investigations/concurrent-exec-deadlock.md` for background.

mod common;

use boxlite::BoxCommand;
use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite_shared::BoxliteError;
use std::sync::Arc;
use std::time::Duration;

use boxlite::LiteBox;

// ============================================================================
// HELPERS
// ============================================================================

fn create_test_runtime() -> (boxlite_test_utils::home::PerTestBoxHome, BoxliteRuntime) {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    (home, runtime)
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

/// Timeout wrapper that panics with context on deadlock.
async fn timeout_with_dump<T>(
    duration: Duration,
    future: impl std::future::Future<Output = T>,
    context: &str,
) -> T {
    tokio::time::timeout(duration, future)
        .await
        .unwrap_or_else(|_| panic!("TIMEOUT after {:?}: {}", duration, context))
}

/// Dump guest logs for post-mortem on timeout.
fn dump_guest_logs(home_dir: &std::path::Path, box_id: &str) {
    let shim_stderr = home_dir.join("boxes").join(box_id).join("shim.stderr");
    match std::fs::read_to_string(&shim_stderr) {
        Ok(content) if !content.is_empty() => {
            eprintln!("\n=== shim.stderr ({}) ===", shim_stderr.display());
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(50);
            for line in &lines[start..] {
                eprintln!("  {}", line);
            }
        }
        _ => eprintln!("(no shim.stderr at {})", shim_stderr.display()),
    }
}

// ============================================================================
// DEADLOCK REGRESSION TESTS
// ============================================================================

/// 16 concurrent execs — doubles the previous max (8) to stress the zygote harder.
///
/// Before the zygote fix, 8 concurrent execs had ~30% deadlock rate.
/// With the zygote, clone3() happens in a single-threaded context, so
/// any number of concurrent execs should complete reliably.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_high_concurrency_16() {
    let (home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;
    let box_id = handle.id().to_string();

    let t0 = std::time::Instant::now();
    let mut tasks = Vec::new();
    for i in 0..16 {
        let h = handle.clone();
        tasks.push(tokio::spawn(async move {
            eprintln!("[{:?}] task-{}: calling exec", t0.elapsed(), i);
            let mut execution = h
                .exec(BoxCommand::new("echo").arg(format!("task-{}", i)))
                .await?;
            eprintln!(
                "[{:?}] task-{}: exec returned, calling wait",
                t0.elapsed(),
                i
            );
            let result = execution.wait().await?;
            eprintln!(
                "[{:?}] task-{}: exit_code={}",
                t0.elapsed(),
                i,
                result.exit_code
            );
            Ok::<(usize, i32), BoxliteError>((i, result.exit_code))
        }));
    }

    let outcome =
        tokio::time::timeout(Duration::from_secs(120), futures::future::join_all(tasks)).await;

    dump_guest_logs(&home.path, &box_id);

    let results = outcome.expect("TIMEOUT after 120s: 16 concurrent execs — likely deadlock");
    for result in results {
        let (i, exit_code) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// 3 rounds of 8 concurrent execs with 1s gap between rounds.
///
/// Tests zygote recovery and reuse across bursts. The zygote process must
/// handle repeated bursts without state corruption or resource leaks.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_repeated_bursts() {
    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    for round in 0..3 {
        let mut tasks = Vec::new();
        for i in 0..8 {
            let h = handle.clone();
            tasks.push(tokio::spawn(async move {
                let mut execution = h
                    .exec(BoxCommand::new("echo").arg(format!("r{}-t{}", round, i)))
                    .await?;
                let result = execution.wait().await?;
                Ok::<(usize, usize, i32), BoxliteError>((round, i, result.exit_code))
            }));
        }

        let results = timeout_with_dump(
            Duration::from_secs(60),
            futures::future::join_all(tasks),
            &format!("round {} deadlocked", round),
        )
        .await;

        for result in results {
            let (r, i, exit_code) = result.unwrap().unwrap();
            assert_eq!(exit_code, 0, "round {} task {} should exit 0", r, i);
        }

        // Brief pause between rounds
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// 10 sequential execs, then 8 concurrent.
///
/// Verifies zygote handles both patterns in the same session without
/// state corruption from the transition.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_sequential_then_concurrent() {
    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // Phase 1: 10 sequential execs
    for i in 0..10 {
        let mut execution = handle
            .exec(BoxCommand::new("echo").arg(format!("seq-{}", i)))
            .await
            .unwrap();
        let result = execution.wait().await.unwrap();
        assert_eq!(result.exit_code, 0, "sequential exec {} should exit 0", i);
    }

    // Phase 2: 8 concurrent execs
    let mut tasks = Vec::new();
    for i in 0..8 {
        let h = handle.clone();
        tasks.push(tokio::spawn(async move {
            let mut execution = h
                .exec(BoxCommand::new("echo").arg(format!("conc-{}", i)))
                .await?;
            let result = execution.wait().await?;
            Ok::<i32, BoxliteError>(result.exit_code)
        }));
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "concurrent phase after sequential deadlocked",
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

    cleanup_concurrent_box(handle, runtime).await;
}

/// 8 concurrent: 4 fast (echo) + 4 slow (sleep 2).
///
/// Fast ones should complete quickly; slow ones after ~2s.
/// All must complete. No deadlock regardless of completion order.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_mixed_durations() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let commands: Vec<(&str, Vec<&str>)> = vec![
        ("echo", vec!["fast-0"]),
        ("echo", vec!["fast-1"]),
        ("echo", vec!["fast-2"]),
        ("echo", vec!["fast-3"]),
        ("sh", vec!["-c", "sleep 2 && echo slow-0"]),
        ("sh", vec!["-c", "sleep 2 && echo slow-1"]),
        ("sh", vec!["-c", "sleep 2 && echo slow-2"]),
        ("sh", vec!["-c", "sleep 2 && echo slow-3"]),
    ];

    let mut tasks = Vec::new();
    for (i, (program, args)) in commands.into_iter().enumerate() {
        let h = handle.clone();
        let program = program.to_string();
        let args: Vec<String> = args.into_iter().map(|s| s.to_string()).collect();
        tasks.push(tokio::spawn(async move {
            let mut execution = h.exec(BoxCommand::new(&program).args(args)).await?;

            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }
            let result = execution.wait().await?;
            Ok::<(usize, i32, String), BoxliteError>((i, result.exit_code, output))
        }));
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

// ============================================================================
// STDOUT/STDERR ISOLATION UNDER CONCURRENCY
// ============================================================================

/// 8 concurrent execs, each echoing a unique UUID.
///
/// Verifies no cross-contamination between concurrent exec stdout streams.
/// This tests that SCM_RIGHTS fd passing through the zygote correctly
/// delivers the right pipe fds to each container process.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_stdout_unique() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..8 {
        let h = handle.clone();
        let marker = format!("UNIQUE-{}-{}", i, uuid::Uuid::new_v4());
        tasks.push(tokio::spawn(async move {
            let mut execution = h.exec(BoxCommand::new("echo").arg(&marker)).await?;

            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }
            let result = execution.wait().await?;
            Ok::<(usize, i32, String, String), BoxliteError>((i, result.exit_code, output, marker))
        }));
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "stdout isolation test deadlocked",
    )
    .await;

    // Collect all markers and outputs for cross-contamination check
    let mut all_markers = Vec::new();
    let mut all_outputs = Vec::new();

    for result in results {
        let (i, exit_code, stdout, marker) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
        assert!(
            stdout.contains(&marker),
            "task {} stdout should contain its marker '{}', got: {:?}",
            i,
            marker,
            stdout
        );
        all_markers.push(marker);
        all_outputs.push((i, stdout));
    }

    // Verify no cross-contamination
    for (i, stdout) in &all_outputs {
        for (j, other_marker) in all_markers.iter().enumerate() {
            if j != *i {
                assert!(
                    !stdout.contains(other_marker),
                    "task {} stdout contains task {}'s marker",
                    i,
                    j
                );
            }
        }
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// 8 concurrent execs writing to stderr — verify isolation.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_stderr_isolation() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..8 {
        let h = handle.clone();
        tasks.push(tokio::spawn(async move {
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
        }));
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
        for j in 0..8 {
            if j != i {
                assert!(
                    !stdout.contains(&format!("OUT-{}", j)),
                    "task {} stdout has foreign OUT-{}",
                    i,
                    j
                );
                assert!(
                    !stderr.contains(&format!("ERR-{}", j)),
                    "task {} stderr has foreign ERR-{}",
                    i,
                    j
                );
            }
        }
    }

    cleanup_concurrent_box(handle, runtime).await;
}

// ============================================================================
// ERROR RESILIENCE
// ============================================================================

/// Exec a nonexistent command, then exec a valid one.
///
/// Verifies the zygote isn't broken by build failures — it should
/// recover and handle subsequent requests normally.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_survives_failed_build() {
    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // First: exec a nonexistent command — expect error or non-zero exit
    let bad_result = handle.exec(BoxCommand::new("/nonexistent/binary")).await;

    match bad_result {
        Ok(mut execution) => {
            // Some runtimes succeed at exec but return non-zero exit
            let result = execution.wait().await;
            eprintln!("nonexistent command result: {:?}", result);
        }
        Err(e) => {
            eprintln!("nonexistent command error (expected): {:?}", e);
        }
    }

    // Then: exec a valid command — must succeed
    let mut execution = handle
        .exec(BoxCommand::new("echo").arg("recovered"))
        .await
        .expect("valid exec should succeed after failed one");
    let result = execution.wait().await.expect("wait should succeed");
    assert_eq!(
        result.exit_code, 0,
        "valid exec should exit 0 after failure"
    );

    cleanup_concurrent_box(handle, runtime).await;
}

/// 8 concurrent: 6 succeed + 2 fail (exit 1).
///
/// All 8 must complete (no deadlock). 6 exit 0, 2 exit 1.
/// One failure must not block other concurrent execs.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_partial_failure() {
    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let expected_codes = [0, 0, 0, 1, 0, 0, 1, 0];
    let mut tasks = Vec::new();
    for (i, &code) in expected_codes.iter().enumerate() {
        let h = handle.clone();
        tasks.push(tokio::spawn(async move {
            let mut execution = h
                .exec(BoxCommand::new("sh").args(["-c", &format!("exit {}", code)]))
                .await?;
            let result = execution.wait().await?;
            Ok::<(usize, i32, i32), BoxliteError>((i, result.exit_code, code))
        }));
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

/// 8 concurrent: 7 succeed + 1 self-kills with SIGKILL.
///
/// The self-killed process should report a non-zero exit / signal.
/// Other 7 must complete normally. No deadlock from the crash.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_with_crash() {
    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..8 {
        let h = handle.clone();
        let is_crash = i == 3; // Task 3 kills itself
        tasks.push(tokio::spawn(async move {
            let cmd = if is_crash {
                BoxCommand::new("sh").args(["-c", "kill -9 $$"])
            } else {
                BoxCommand::new("echo").arg(format!("ok-{}", i))
            };
            let mut execution = h.exec(cmd).await?;
            let result = execution.wait().await?;
            Ok::<(usize, i32, bool), BoxliteError>((i, result.exit_code, is_crash))
        }));
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "crash resilience test deadlocked",
    )
    .await;

    for result in results {
        let (i, exit_code, is_crash) = result.unwrap().unwrap();
        if is_crash {
            assert_ne!(exit_code, 0, "crashed task {} should have non-zero exit", i);
        } else {
            assert_eq!(exit_code, 0, "normal task {} should exit 0", i);
        }
    }

    cleanup_concurrent_box(handle, runtime).await;
}

// ============================================================================
// ENVIRONMENT AND WORKING DIRECTORY ISOLATION
// ============================================================================

/// Environment variables are per-invocation, not shared across concurrent execs.
///
/// Each exec sets a unique MY_VAR; each should see only its own value.
/// This verifies that BuildSpec env is correctly passed through the zygote IPC.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_env_isolation() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..8 {
        let h = handle.clone();
        let env_val = format!("value-{}", i);
        tasks.push(tokio::spawn(async move {
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
        }));
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

/// Working directory is correctly applied per invocation.
///
/// The zygote moves the chdir into the container's namespace via BuildSpec.cwd,
/// eliminating the process-global chdir race that existed before.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_workdir_isolation() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // Directories that exist in alpine by default
    let workdirs = ["/tmp", "/", "/var", "/home", "/tmp", "/", "/var", "/home"];

    let mut tasks = Vec::new();
    for (i, workdir) in workdirs.iter().enumerate() {
        let h = handle.clone();
        let wd = workdir.to_string();
        tasks.push(tokio::spawn(async move {
            let mut execution = h.exec(BoxCommand::new("pwd").working_dir(&wd)).await?;

            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }
            let result = execution.wait().await?;
            Ok::<(usize, i32, String, String), BoxliteError>((i, result.exit_code, output, wd))
        }));
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "workdir isolation test deadlocked — possible chdir race",
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

// ============================================================================
// FD PASSING CORRECTNESS
// ============================================================================

/// 4 concurrent cat processes: write unique data to stdin, verify stdout matches.
///
/// Tests SCM_RIGHTS fd passing under concurrency — each cat process should
/// receive its own stdin/stdout pipes via the zygote's fd passing.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_concurrent_stdin_pipes() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    let mut tasks = Vec::new();
    for i in 0..4 {
        let h = handle.clone();
        let input_data = format!("input-data-{}\n", i);
        tasks.push(tokio::spawn(async move {
            let mut execution = h.exec(BoxCommand::new("cat")).await?;

            // Write to stdin and close (EOF signals cat to exit)
            if let Some(mut stdin) = execution.stdin() {
                stdin.write_all(input_data.as_bytes()).await?;
                stdin.close();
            }

            // Read stdout
            let mut output = String::new();
            if let Some(mut stdout) = execution.stdout() {
                while let Some(chunk) = stdout.next().await {
                    output.push_str(&chunk);
                }
            }

            let result = execution.wait().await?;
            Ok::<(usize, i32, String, String), BoxliteError>((
                i,
                result.exit_code,
                output,
                input_data,
            ))
        }));
    }

    let results = timeout_with_dump(
        Duration::from_secs(60),
        futures::future::join_all(tasks),
        "stdin pipe test deadlocked",
    )
    .await;

    for result in results {
        let (i, exit_code, stdout, expected) = result.unwrap().unwrap();
        assert_eq!(exit_code, 0, "task {} should exit 0", i);
        assert!(
            stdout.contains(expected.trim()),
            "task {} stdout should contain input data '{}', got: {:?}",
            i,
            expected.trim(),
            stdout
        );
    }

    cleanup_concurrent_box(handle, runtime).await;
}

/// Run 20 sequential execs and verify the box's fd count doesn't grow.
///
/// Regression: if pipe fds leak (not closed by zygote after build), each
/// exec would leave 3 unclosed fds, accumulating over time.
#[tokio::test(flavor = "multi_thread")]
async fn test_zygote_pipe_fd_no_leak() {
    use futures::StreamExt;

    let (_home, runtime) = create_test_runtime();
    let handle = create_concurrent_box(&runtime).await;

    // Get baseline fd count inside the box
    let get_fd_count = |h: Arc<LiteBox>| async move {
        let mut execution = h
            .exec(BoxCommand::new("sh").args(["-c", "ls /proc/1/fd 2>/dev/null | wc -l"]))
            .await?;
        let mut output = String::new();
        if let Some(mut stdout) = execution.stdout() {
            while let Some(chunk) = stdout.next().await {
                output.push_str(&chunk);
            }
        }
        let result = execution.wait().await?;
        let count: i32 = output.trim().parse().unwrap_or(-1);
        Ok::<(i32, i32), BoxliteError>((count, result.exit_code))
    };

    let (baseline_fds, _) = get_fd_count(handle.clone()).await.unwrap();
    eprintln!("baseline fd count: {}", baseline_fds);

    // Run 20 execs
    for i in 0..20 {
        let mut execution = handle
            .exec(BoxCommand::new("echo").arg(format!("leak-test-{}", i)))
            .await
            .unwrap();
        let result = execution.wait().await.unwrap();
        assert_eq!(result.exit_code, 0);
    }

    // Check fd count after — should not have grown significantly
    let (after_fds, _) = get_fd_count(handle.clone()).await.unwrap();
    eprintln!("after 20 execs fd count: {}", after_fds);

    // Allow some variance (up to 5 extra fds for transient state)
    let growth = after_fds - baseline_fds;
    assert!(
        growth <= 5,
        "fd count grew by {} (from {} to {}) — likely fd leak",
        growth,
        baseline_fds,
        after_fds
    );

    cleanup_concurrent_box(handle, runtime).await;
}
