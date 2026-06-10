//! Integration tests for [`boxlite::util::spawn_child_reaper`].
//!
//! Lives in `tests/` rather than as a `#[cfg(test)] mod tests` inside
//! `util/child_reaper.rs` because the reaper installs a process-wide
//! SIGCHLD handler and calls `waitpid(-1, ..., WNOHANG)`. Inside the
//! `boxlite --lib` test binary, cargo runs all unit tests in one
//! process with parallel threads, so a co-resident reaper would
//! race-steal `Child`ren spawned by tests like
//! `runtime::rt_impl::tests::test_shutdown_sync_stops_non_detached_running_box`
//! before their `try_wait()` call. Each `tests/*.rs` file is its own
//! binary — this one only has reaper tests, so no other code in the
//! same process is fighting for SIGCHLD.

#![cfg(unix)]

use boxlite::util::spawn_child_reaper;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Returns true if `/proc/<pid>/status` exists at all (alive OR
/// zombie). False if the slot has been freed — i.e. somebody called
/// waitpid on it.
#[cfg(target_os = "linux")]
fn is_zombie_or_alive(pid: u32) -> bool {
    std::fs::metadata(format!("/proc/{pid}/status")).is_ok()
}

/// macOS fallback: `kill(pid, 0)` returns 0 for alive *or* zombie,
/// `ESRCH` for fully gone. (No `/proc` to read.)
#[cfg(not(target_os = "linux"))]
fn is_zombie_or_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Spawn the reaper, then spawn a child that exits immediately, drop
/// the `Child` so nobody calls `wait` on it, and confirm the kernel's
/// zombie slot for that pid is gone within a reasonable window.
///
/// Two-side: replacing the body of `drain_zombies` with `return;`
/// leaves the pid in `/proc/<pid>/status: State: Z` past the deadline
/// — `is_zombie_or_alive` then returns `true` and the assertion fails.
#[tokio::test(flavor = "multi_thread")]
async fn reaper_drains_zombie_left_by_dropped_child() {
    let token = CancellationToken::new();
    let task = spawn_child_reaper(token.clone());

    // Spawn a child that exits immediately. Dropping the `Child`
    // BEFORE calling `wait()` produces a zombie until somebody (the
    // reaper) calls waitpid on it.
    let child = Command::new("sh")
        .arg("-c")
        .arg("true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sh");
    let pid = child.id();
    drop(child); // <- no Child::wait happens here

    // Wait up to 2s for the reaper to drain the SIGCHLD.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut became_gone = false;
    while std::time::Instant::now() < deadline {
        if !is_zombie_or_alive(pid) {
            became_gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        became_gone,
        "child reaper should have drained pid {pid}, but it's still in /proc/<pid>/status"
    );

    // Clean shutdown.
    token.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
}

/// Cancellation contract: the reaper task must observe the shutdown
/// token and exit, not block on SIGCHLD forever.
#[tokio::test(flavor = "multi_thread")]
async fn reaper_exits_on_shutdown_token() {
    let token = CancellationToken::new();
    let task = spawn_child_reaper(token.clone());
    token.cancel();
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("reaper must exit within 1s of cancellation")
        .expect("reaper join");
}
