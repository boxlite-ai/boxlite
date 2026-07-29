//! Execution state registry.
//!
//! Manages the state of all active executions, providing thread-safe access
//! to execution metadata, I/O channels, and completion status.

use crate::service::exec::state::ExecutionState;
use nix::sys::signal::{kill, Signal};

/// How long [`ExecutionRegistry::shutdown_all`] gives execs to die between
/// SIGTERM and SIGKILL.
///
/// One budget, because there is one policy: both teardown paths — the
/// host-driven Shutdown RPC and the guest's own power-off when the main
/// command exits — drain the same execs and should wait the same amount.
pub(crate) const SHUTDOWN_TIMEOUT_MS: u64 = 1000;
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

    /// Release one explicitly ephemeral execution.
    ///
    /// SSH calls this only after its output stream and terminal wait complete.
    /// Retained SDK executions and container-init sessions are never released by
    /// their normal wait paths, preserving repeatable waits for those callers.
    pub async fn release_ephemeral(&self, exec_id: &str) -> bool {
        let state = {
            let mut executions = self.executions.lock().await;
            executions.remove(exec_id)
        };
        let Some(state) = state else {
            return false;
        };
        state.release_resources().await;
        true
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

#[cfg(test)]
mod release_tests {
    use super::*;
    use crate::reaper::ExitSlot;
    use crate::service::exec::exec_handle::{ExecHandle, ExitStatus};
    use nix::unistd::{pipe, Pid};

    fn settled_state(pid: i32, is_init: bool) -> ExecutionState {
        let (_stdin_peer, stdin) = pipe().unwrap();
        let (stdout, _stdout_peer) = pipe().unwrap();
        let (stderr, _stderr_peer) = pipe().unwrap();
        let handle = ExecHandle::new(Pid::from_raw(pid), stdin, stdout, Some(stderr));
        let exit = ExitSlot::settled_for_test(ExitStatus::Code(7));
        if is_init {
            ExecutionState::new_init_session(handle, exit)
        } else {
            ExecutionState::new(handle, exit)
        }
    }

    #[tokio::test]
    async fn release_is_scoped_and_preserves_retained_waits_and_init_sessions() {
        let registry = ExecutionRegistry::new();
        registry
            .register("sdk-exec".into(), settled_state(11_001, false))
            .await;
        registry
            .register("init-exec".into(), settled_state(11_002, true))
            .await;
        registry
            .register("ssh-exec".into(), settled_state(11_003, false))
            .await;

        let sdk_state = registry.get("sdk-exec").await.unwrap();
        assert_eq!(sdk_state.wait_process().await.code(), 7);
        assert_eq!(sdk_state.wait_process().await.code(), 7);

        assert!(registry.release_ephemeral("ssh-exec").await);
        assert!(!registry.release_ephemeral("ssh-exec").await);
        assert!(!registry.exists("ssh-exec").await);
        assert!(registry.exists("sdk-exec").await);
        assert!(registry.exists("init-exec").await);
    }

    #[tokio::test]
    async fn sequential_ssh_releases_do_not_accumulate_registry_entries() {
        let registry = ExecutionRegistry::new();
        registry
            .register("retained".into(), settled_state(12_000, false))
            .await;

        for index in 0..128 {
            let execution_id = format!("ssh-{index}");
            registry
                .register(execution_id.clone(), settled_state(12_001 + index, false))
                .await;
            assert!(registry.release_ephemeral(&execution_id).await);
            assert!(!registry.exists(&execution_id).await);
        }

        assert!(registry.exists("retained").await);
    }
}
