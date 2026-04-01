//! Execution state registry.
//!
//! Manages the state of all active executions, providing thread-safe access
//! to execution metadata, I/O channels, and completion status.

use crate::service::exec::state::ExecutionState;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Registry of active executions.
///
/// Thread-safe registry that stores execution state and provides
/// methods for registration, lookup, and lifecycle management.
#[derive(Clone)]
pub(crate) struct ExecutionRegistry {
    executions: Arc<Mutex<HashMap<String, ExecutionState>>>,
}

impl ExecutionRegistry {
    /// Create new registry.
    pub fn new() -> Self {
        Self {
            executions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check if execution exists.
    pub async fn exists(&self, exec_id: &str) -> bool {
        self.executions.lock().await.contains_key(exec_id)
    }

    /// Get execution state.
    pub async fn get(&self, exec_id: &str) -> Option<ExecutionState> {
        self.executions.lock().await.get(exec_id).cloned()
    }

    /// Register new execution state.
    pub async fn register(&self, exec_id: String, state: ExecutionState) {
        self.executions.lock().await.insert(exec_id, state);
    }

    /// Gracefully shutdown all running executions.
    ///
    /// Sends SIGTERM first, waits for exit with timeout, then SIGKILL if needed.
    pub async fn shutdown_all(&self, timeout_ms: u64) {
        // Step 1: Collect all PIDs and send SIGTERM
        let mut pids_to_wait: Vec<(String, i32)> = Vec::new();

        {
            let executions = self.executions.lock().await;
            for (exec_id, state) in executions.iter() {
                if let Some(pid) = state.get_pid().await {
                    let pid_i32 = pid as i32;
                    // Check if process is still alive (signal 0 doesn't send anything)
                    if kill(Pid::from_raw(pid_i32), None).is_ok() {
                        info!(exec_id = %exec_id, pid = pid, "Sending SIGTERM to execution");
                        let _ = kill(Pid::from_raw(pid_i32), Signal::SIGTERM);
                        pids_to_wait.push((exec_id.clone(), pid_i32));
                    }
                }
            }
        }

        if pids_to_wait.is_empty() {
            info!("No running executions to shutdown");
            return;
        }

        // Step 2: Wait for graceful exit with timeout
        let start = std::time::Instant::now();
        while start.elapsed().as_millis() < timeout_ms as u128 {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

            // Check which processes are still running
            let still_running: Vec<_> = pids_to_wait
                .iter()
                .filter(|(_, pid)| kill(Pid::from_raw(*pid), None).is_ok())
                .cloned()
                .collect();

            if still_running.is_empty() {
                info!("All executions exited gracefully");
                return;
            }

            pids_to_wait = still_running;
        }

        // Step 3: SIGKILL remaining executions
        for (exec_id, pid) in &pids_to_wait {
            if kill(Pid::from_raw(*pid), None).is_ok() {
                warn!(exec_id = %exec_id, pid = pid, "Execution didn't exit gracefully, sending SIGKILL");
                let _ = kill(Pid::from_raw(*pid), Signal::SIGKILL);
            }
        }
    }
}
