//! Execution state registry.
//!
//! Manages the state of all active executions, providing thread-safe access
//! to execution metadata, I/O channels, and completion status.

use crate::service::exec::state::ExecutionState;
use nix::sys::signal::Signal;

/// How long [`ExecutionRegistry::shutdown_all`] gives execs to die between
/// SIGTERM and SIGKILL.
///
/// One budget, because there is one policy: both teardown paths — the
/// host-driven Shutdown RPC and the guest's own power-off when the main
/// command exits — drain the same execs and should wait the same amount.
pub(crate) const SHUTDOWN_TIMEOUT_MS: u64 = 1000;
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
        // Step 1: SIGTERM every execution whose process identity is current.
        let mut states_to_wait = Vec::new();

        let states: Vec<_> = self
            .executions
            .lock()
            .await
            .iter()
            .map(|(exec_id, state)| (exec_id.clone(), state.clone()))
            .collect();
        for (exec_id, state) in states {
            match state.signal_owned_process_if_current(Signal::SIGTERM).await {
                Ok(true) => {
                    info!(exec_id = %exec_id, "Sending SIGTERM to execution");
                    states_to_wait.push((exec_id, state));
                }
                Ok(false) => {}
                Err(error) => warn!(exec_id = %exec_id, %error, "shutdown SIGTERM failed"),
            }
        }

        if states_to_wait.is_empty() {
            info!("No running executions to shutdown");
            return;
        }

        // Step 2: Wait for graceful exit with timeout
        let start = std::time::Instant::now();
        while start.elapsed().as_millis() < timeout_ms as u128 {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

            let mut still_running = Vec::new();
            for (exec_id, state) in states_to_wait {
                if state.owned_process_is_current().await {
                    still_running.push((exec_id, state));
                }
            }
            states_to_wait = still_running;

            if states_to_wait.is_empty() {
                info!("All executions exited gracefully");
                return;
            }
        }

        // Step 3: SIGKILL remaining executions
        for (exec_id, state) in &states_to_wait {
            match state.signal_owned_process_if_current(Signal::SIGKILL).await {
                Ok(true) => {
                    warn!(exec_id = %exec_id, "Execution didn't exit gracefully, sending SIGKILL");
                }
                Ok(false) => {}
                Err(error) => warn!(exec_id = %exec_id, %error, "shutdown SIGKILL failed"),
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
        let handle = ExecHandle::new(Pid::from_raw(pid), stdin, stdout, Some(stderr))
            .expect("test pipe must register with Tokio");
        let exit = ExitSlot::settled_for_test(ExitStatus::Code(7));
        if is_init {
            ExecutionState::new_init_session(handle, exit, None)
        } else {
            ExecutionState::new_for_test(handle, exit)
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

    #[tokio::test]
    async fn shutdown_does_not_signal_an_execution_without_identity() {
        use std::os::unix::process::ExitStatusExt;

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id() as i32;
        let registry = ExecutionRegistry::new();
        registry
            .register("without-identity".into(), settled_state(pid, false))
            .await;

        registry.shutdown_all(0).await;

        assert!(
            child.try_wait().expect("check child status").is_none(),
            "registry must not signal a state without process identity"
        );
        child.kill().expect("kill test child");
        let status = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for test child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(
            status.signal(),
            Some(nix::sys::signal::Signal::SIGKILL as i32),
            "child must die from this test's SIGKILL; SIGTERM means shutdown_all \
             signalled a state that has no process identity"
        );
    }
}
