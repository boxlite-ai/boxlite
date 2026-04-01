//! Timeout management.
//!
//! Kills process if execution exceeds timeout duration.

use crate::service::exec::state::ExecutionState;
use std::time::Duration;
use tracing::info;

/// Start timeout watcher.
///
/// After duration elapses, marks execution as timed out and kills
/// the process if it's still running.
pub(super) fn start_timeout_watcher(
    exec_state: ExecutionState,
    exec_id: String,
    timeout: Duration,
) {
    tokio::spawn(async move {
        tokio::time::sleep(timeout).await;

        // Kill process with SIGKILL
        use nix::sys::signal::Signal;
        if exec_state.kill(Signal::SIGALRM).await {
            info!(execution_id = %exec_id, "killed on timeout");
        }
    });
}
