//! Integration tests for per-exec working_dir and timeout options.
//!
//! Verifies that `BoxCommand::working_dir()` and `BoxCommand::timeout()`
//! correctly affect command execution inside the VM guest.

mod common;

use std::time::Duration;

use boxlite::BoxCommand;
use tokio_stream::StreamExt;

/// Helper: run a command, collect stdout, assert exit code 0.
async fn run_stdout(handle: &boxlite::LiteBox, cmd: BoxCommand) -> String {
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

/// RAII wrapper that creates/starts a box and cleans up on drop.
struct TestBox {
    handle: boxlite::LiteBox,
    runtime: boxlite::BoxliteRuntime,
    _home: boxlite_test_utils::home::PerTestBoxHome,
}

impl TestBox {
    async fn new() -> Self {
        let home = boxlite_test_utils::home::PerTestBoxHome::new();
        let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .expect("create runtime");
        let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
        handle.start().await.unwrap();
        Self {
            handle,
            runtime,
            _home: home,
        }
    }

    async fn teardown(self) {
        self.handle.stop().await.unwrap();
        let _ = self.runtime.remove(self.handle.id().as_str(), true).await;
        let _ = self
            .runtime
            .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
            .await;
    }
}

/// working_dir changes the current directory for the command.
#[tokio::test]
async fn test_working_dir() {
    let tb = TestBox::new().await;
    let stdout = run_stdout(&tb.handle, BoxCommand::new("pwd").working_dir("/tmp")).await;
    assert_eq!(stdout.trim(), "/tmp", "working_dir should set cwd to /tmp");
    tb.teardown().await;
}

/// timeout kills a long-running command.
#[tokio::test]
async fn test_timeout_kills_long_command() {
    let tb = TestBox::new().await;

    let execution = tb
        .handle
        .exec(
            BoxCommand::new("sleep")
                .arg("60")
                .timeout(Duration::from_secs(2)),
        )
        .await
        .expect("exec failed");

    let result = execution.wait().await.expect("wait failed");
    assert_ne!(
        result.exit_code, 0,
        "timed-out command should have non-zero exit code"
    );

    tb.teardown().await;
}

/// Regression test for exec timeout bypass via SIGALRM.
///
/// Companion to the Python-SDK PoC at
/// `sdks/python/tests/test_exec_timeout_sigalrm.py`. The guest's timeout
/// watcher must use SIGKILL (uncatchable). If it sends SIGALRM (catchable),
/// the workload below — a shell that installs `trap '' ALRM` and then
/// sleeps for 15 seconds — absorbs the signal, the underlying `sleep`
/// runs to its natural end, and exec returns `exit_code=0` after ~15s,
/// bypassing the 2-second deadline.
///
/// The fix lives in `src/guest/src/service/exec/timeout.rs`.
#[tokio::test]
async fn test_timeout_kills_sigalrm_ignoring_process() {
    let tb = TestBox::new().await;

    let start = std::time::Instant::now();
    let execution = tb
        .handle
        .exec(
            BoxCommand::new("sh")
                .args(["-c", "trap '' ALRM; sleep 15"])
                .timeout(Duration::from_secs(2)),
        )
        .await
        .expect("exec failed");

    let result = execution.wait().await.expect("wait failed");
    let elapsed = start.elapsed();

    assert_ne!(
        result.exit_code, 0,
        "timeout bypass: shell exited with exit_code=0 after {elapsed:?} \
         despite timeout=2s — the guest is sending a catchable signal that \
         the shell absorbs via `trap '' ALRM`; the kill must use SIGKILL"
    );
    assert!(
        elapsed < Duration::from_secs(8),
        "timeout did not curtail the workload: elapsed={elapsed:?} \
         (expected near 2s, workload was 15s) — the watcher is not killing \
         the process promptly"
    );

    tb.teardown().await;
}

/// A TTY exec must run to natural completion and surface its real exit code
/// through the zygote's `waitpid` — not lose it or default to 0.
///
/// libcontainer 0.6's `check_terminal` forced TTY execs onto the
/// `with_detach(true)` + console-socket path. Detach changes how youki starts
/// the process, so this guards that the zygote still reaps the detached PTY
/// child and returns its exit status. The existing `resize_tty` tests only
/// `kill()` then `wait()`; none assert a *natural* exit code for a TTY exec.
#[tokio::test]
async fn test_tty_exec_collects_natural_exit_code() {
    let tb = TestBox::new().await;

    let execution = tb
        .handle
        .exec(BoxCommand::new("sh").args(["-c", "exit 7"]).tty(true))
        .await
        .expect("tty exec failed to spawn");

    let result = execution.wait().await.expect("wait failed");
    assert_eq!(
        result.exit_code, 7,
        "TTY exec exit code must propagate through the zygote reaper; got {}",
        result.exit_code
    );

    tb.teardown().await;
}

/// Combine working_dir and user in a single command.
#[tokio::test]
async fn test_working_dir_with_user() {
    let tb = TestBox::new().await;

    let stdout = run_stdout(
        &tb.handle,
        BoxCommand::new("sh")
            .args(["-c", "echo dir=$(pwd) user=$(whoami)"])
            .working_dir("/tmp")
            .user("nobody"),
    )
    .await;

    assert!(
        stdout.contains("dir=/tmp"),
        "expected dir=/tmp in stdout, got: {stdout:?}"
    );
    assert!(
        stdout.contains("user=nobody"),
        "expected user=nobody in stdout, got: {stdout:?}"
    );

    tb.teardown().await;
}

/// The deadline must survive a leader that exits before it.
///
/// `sh -c "cmd &"` returns as soon as it has forked, so the leader is gone long
/// before its own deadline while the workload it started keeps running and keeps
/// the exec's pipes open. Both the group capture and the terminal observer have
/// to account for that: a leader-anchored lookup would find nothing to signal,
/// and retiring the timeout at leader exit would leave the survivor unbounded.
#[tokio::test]
async fn test_timeout_survives_a_leader_that_exits_before_its_deadline() {
    let tb = TestBox::new().await;

    let _execution = tb
        .handle
        .exec(
            BoxCommand::new("sh")
                .args(["-c", "sleep 300 &"])
                .timeout(Duration::from_secs(2)),
        )
        .await
        .expect("exec failed");

    // Precondition: the workload outlived its leader, otherwise a pass below
    // would prove nothing.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = run_stdout(
        &tb.handle,
        BoxCommand::new("sh").args(["-c", "ps | grep -c '[s]leep 300' || true"]),
    )
    .await;
    assert_ne!(
        before.trim(),
        "0",
        "precondition failed: no `sleep 300` running before the deadline"
    );

    // 2s deadline + 2s TIMEOUT_GRACE before SIGKILL, plus slack.
    tokio::time::sleep(Duration::from_secs(6)).await;

    let survivors = run_stdout(
        &tb.handle,
        BoxCommand::new("sh").args(["-c", "ps | grep -c '[s]leep 300' || true"]),
    )
    .await;

    assert_eq!(
        survivors.trim(),
        "0",
        "exec timeout left {} orphaned `sleep 300` process(es) alive 6s after a \
         2s deadline whose leader had already exited",
        survivors.trim()
    );

    tb.teardown().await;
}

/// An exec timeout must bound the whole process tree, not just the spawned
/// leader.
///
/// A forking workload leaves the real work in a child of the captured leader.
/// Signalling that leader alone reaps the shell and reparents the child to
/// init, where it outlives a deadline the caller was told is hard; the SIGKILL
/// escalation cannot recover either, being anchored to a leader that no longer
/// exists. The guest bounds the leader's process group instead — see
/// `src/guest/src/service/exec/timeout.rs`.
#[tokio::test]
async fn test_timeout_kills_forked_child_not_just_leader() {
    let tb = TestBox::new().await;

    // `sleep 300 & wait` forces a fork: a bare `sh -c "sleep 300"` lets ash/dash
    // exec into the sleep, which makes the leader the sleep itself and never
    // exercises the orphan path this test is about.
    let _execution = tb
        .handle
        .exec(
            BoxCommand::new("sh")
                .args(["-c", "sleep 300 & wait"])
                .timeout(Duration::from_secs(2)),
        )
        .await
        .expect("exec failed");

    // Precondition: the workload really did fork, otherwise a pass below would
    // be vacuous.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = run_stdout(
        &tb.handle,
        BoxCommand::new("sh").args(["-c", "ps | grep -c '[s]leep 300' || true"]),
    )
    .await;
    assert_ne!(
        before.trim(),
        "0",
        "precondition failed: no `sleep 300` running before the deadline"
    );

    // 2s deadline + 2s TIMEOUT_GRACE before SIGKILL, plus slack.
    tokio::time::sleep(Duration::from_secs(6)).await;

    let survivors = run_stdout(
        &tb.handle,
        BoxCommand::new("sh").args(["-c", "ps | grep -c '[s]leep 300' || true"]),
    )
    .await;

    assert_eq!(
        survivors.trim(),
        "0",
        "exec timeout left {} orphaned `sleep 300` process(es) alive 6s after a \
         2s deadline: the watcher signalled only the shell leader, so the forked \
         child outlived its deadline",
        survivors.trim()
    );

    tb.teardown().await;
}
