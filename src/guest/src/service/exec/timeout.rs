//! Timeout management.
//!
//! Two-stage termination when execution exceeds its deadline:
//! SIGTERM first (cooperative cleanup), then SIGKILL after a grace
//! period to enforce the hard deadline against workloads that ignore
//! or trap SIGTERM.

use crate::service::exec::state::ExecutionState;
use std::time::Duration;
use tracing::{info, warn};

/// Grace period between SIGTERM and SIGKILL on exec timeout.
///
/// Short enough that sandboxed execs still see a near-deadline kill,
/// long enough that cooperative workloads can flush buffers, close
/// files, and exit cleanly. Mirrors the SIGTERM→wait→SIGKILL pattern
/// used by `ExecRegistry::shutdown_all` and `Container::shutdown`.
const TIMEOUT_GRACE: Duration = Duration::from_secs(2);

/// Start timeout watcher.
///
/// After `timeout` elapses, sends SIGTERM and waits up to `TIMEOUT_GRACE`
/// for the process to exit, then escalates to SIGKILL. SIGKILL is
/// uncatchable, so a workload that installs `SIG_IGN`/handlers for
/// SIGTERM (or SIGALRM, etc.) cannot outlive its deadline.
pub(super) fn start_timeout_watcher(
    exec_state: ExecutionState,
    exec_id: String,
    timeout: Duration,
) {
    tokio::spawn(async move {
        tokio::time::sleep(timeout).await;

        use nix::sys::signal::Signal;

        // Stage 1: SIGTERM — polite termination request.
        if !exec_state.kill(Signal::SIGTERM).await {
            // Process already exited on its own; nothing more to do.
            return;
        }
        info!(
            execution_id = %exec_id,
            grace_ms = TIMEOUT_GRACE.as_millis() as u64,
            "SIGTERM on timeout; grace before SIGKILL"
        );

        // Stage 2: wait for the grace window. `exec_state.kill` already
        // returns false once the process is reaped, so we do not need to
        // poll — we just sleep the full grace then ask for SIGKILL.
        tokio::time::sleep(TIMEOUT_GRACE).await;

        // Stage 3: SIGKILL fallback. Returns false if SIGTERM was honored
        // during the grace window (clean exit, no escalation needed).
        if exec_state.kill(Signal::SIGKILL).await {
            warn!(
                execution_id = %exec_id,
                "SIGKILL after grace expired; workload did not exit on SIGTERM"
            );
        } else {
            info!(execution_id = %exec_id, "exited within grace after SIGTERM");
        }
    });
}
