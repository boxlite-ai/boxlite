//! Runtime-wide child reaper.
//!
//! Boxlite forks many sub-processes — shims via `std::process::Command`,
//! seccomp build helpers, debugfs / mke2fs invocations, jailer userns
//! probes. The runtime keeps `Child` handles for the long-lived ones
//! (shims) and reaps them via `Child::wait` on stop / remove. But:
//!
//!   - external `SIGKILL` / OOM-kill: shim dies without anyone holding
//!     a `Child::wait` future, and the kernel keeps the zombie around
//!     until *someone* calls `waitpid`.
//!   - panic in the shim: same story.
//!   - dropped `Child` (e.g. failed init partway through): same story.
//!
//! Health-check tasks already cover the "I know which pid died, reap
//! it" case via `reap_pid_async(pid, ...)` (see `box_impl.rs`). This
//! module is the runtime-wide *safety net*: a single tokio task that
//! subscribes to `SIGCHLD` and drains every available zombie via
//! `waitpid(-1, ..., WNOHANG)`. It catches the cases health-check
//! never sees — e.g. operator disabled the watcher, the dying pid was
//! never tracked in a `BoxImpl`, or the shim died during init before
//! the watcher even spawned.
//!
//! It does NOT replace the targeted reap calls inside health-check or
//! `ShimHandler::stop_force`. Those are deterministic (caller knows
//! the pid and wants to confirm it exited). This task is the
//! best-effort sweeper that mops up after them. Whichever side wins
//! the `waitpid` race first: the kernel just returns ECHILD to the
//! loser, and the loser treats that as "not our child" (see
//! `process.rs::reap_pid_blocking` / `reap_pid_async`).

#[cfg(unix)]
use tokio::signal::unix::{SignalKind, signal};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Spawn the runtime-wide SIGCHLD reaper task. Returns a `JoinHandle`
/// the caller stores on `RuntimeImpl` for graceful shutdown.
///
/// The task:
///
///   1. Registers a `SIGCHLD` signal stream via tokio.
///   2. On every signal *or* every cancellation check, drains the
///      kernel's zombie queue via `waitpid(-1, ..., WNOHANG)` in a
///      loop until it reports `0` (no more zombies) or `-1` (no child
///      at all — the runtime has no surviving children).
///   3. Exits cleanly when the `shutdown_token` is cancelled.
///
/// SIGCHLD is signal-coalescing — if N children die in quick
/// succession the kernel may deliver only one signal. The
/// drain-until-zero loop is what guarantees we don't leave one of
/// those N permanently zombied.
///
/// On non-unix targets the function returns a no-op task that just
/// awaits the cancellation token. The reaper only matters on Linux
/// (and incidentally macOS), and tokio's `SignalKind::child()`
/// doesn't exist on Windows.
pub fn spawn_child_reaper(shutdown_token: CancellationToken) -> JoinHandle<()> {
    #[cfg(unix)]
    {
        tokio::spawn(async move {
            let mut sigchld = match signal(SignalKind::child()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "failed to register SIGCHLD handler — runtime-wide reaper disabled");
                    return;
                }
            };

            // Drain once at startup in case a child died before the
            // signal handler was registered (race between RuntimeImpl
            // construction and an early shim spawn failure).
            drain_zombies();

            loop {
                tokio::select! {
                    _ = shutdown_token.cancelled() => {
                        tracing::debug!("child reaper: shutdown token cancelled, exiting");
                        // Last drain on the way out — don't leave anything
                        // behind for the operator's `pgrep -af` to find.
                        drain_zombies();
                        return;
                    }
                    sig = sigchld.recv() => {
                        if sig.is_none() {
                            // Stream closed (tokio runtime shutting down).
                            return;
                        }
                        drain_zombies();
                    }
                }
            }
        })
    }

    #[cfg(not(unix))]
    {
        tokio::spawn(async move {
            shutdown_token.cancelled().await;
        })
    }
}

/// Reap every available zombie via `waitpid(-1, ..., WNOHANG)` until
/// the kernel reports no more.
///
/// Returns silently — failures here are best-effort: if `waitpid`
/// errors with `ECHILD` we have no children, `EINTR` we'll be called
/// again on the next signal, anything else is logged at debug.
#[cfg(unix)]
fn drain_zombies() {
    let mut reaped = 0usize;
    loop {
        let mut status: libc::c_int = 0;
        // SAFETY: documented C ABI; we own the `status` variable and
        // pass a valid pointer. `-1` is the well-defined "any child"
        // sentinel for `waitpid`.
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        match pid {
            // No more zombies ready right now.
            0 => break,
            // Error: ECHILD means no children at all (we just bail);
            // EINTR means we were interrupted — next SIGCHLD will
            // re-fire us; anything else gets a debug log.
            -1 => {
                let err = std::io::Error::last_os_error();
                let errno = err.raw_os_error().unwrap_or(0);
                if errno == libc::ECHILD || errno == libc::EINTR {
                    break;
                }
                tracing::debug!(error = %err, "child reaper: waitpid(-1) failed");
                break;
            }
            // Reaped one — log and keep draining.
            reaped_pid => {
                reaped += 1;
                let exit_code = if libc::WIFEXITED(status) {
                    Some(libc::WEXITSTATUS(status))
                } else {
                    None
                };
                let signal_num = if libc::WIFSIGNALED(status) {
                    Some(libc::WTERMSIG(status))
                } else {
                    None
                };
                tracing::debug!(
                    pid = reaped_pid,
                    ?exit_code,
                    ?signal_num,
                    total_reaped_this_pass = reaped,
                    "child reaper: reaped zombie"
                );
            }
        }
    }
}

// Tests live in `src/boxlite/tests/runtime_child_reaper.rs` — they
// install a process-wide SIGCHLD handler and call `waitpid(-1)`, which
// would race-steal `Child`ren spawned by adjacent lib unit tests if
// kept in this module (cargo runs all lib unit tests in one process).
// Each `tests/*.rs` file is its own binary, so the integration-test
// process has no other children to interfere with.
