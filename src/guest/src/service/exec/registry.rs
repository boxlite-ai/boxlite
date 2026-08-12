//! Execution state registry.
//!
//! Manages the state of all active executions, providing thread-safe access
//! to execution metadata, I/O channels, and completion status.

use crate::service::exec::state::{ExecutionState, TerminalSnapshot};
use nix::sys::signal::Signal;

/// How long [`ExecutionRegistry::shutdown_all`] gives execs to die between
/// SIGTERM and SIGKILL.
///
/// One budget, because there is one policy: both teardown paths — the
/// host-driven Shutdown RPC and the guest's own power-off when the main
/// command exits — drain the same execs and should wait the same amount.
pub(crate) const SHUTDOWN_TIMEOUT_MS: u64 = 1000;
const RETAIN_GRACE: Duration = Duration::from_secs(5 * 60);
const TOMBSTONE_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_RETAINED_ENTRIES: usize = 64;
const MAX_RETAINED_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOMBSTONE_ENTRIES: usize = 1024;
const MAX_TOMBSTONE_METADATA_BYTES: usize = 5 * 1024 * 1024;
const MAX_TOMBSTONE_DIAGNOSTIC_BYTES: usize = 4 * 1024;
const TOMBSTONE_TRUNCATION_SUFFIX: &str = "…[truncated]";
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{info, warn};

/// Holds an execution id from before its process is spawned until the state is
/// published.
///
/// Releases on drop, not on the error path alone: tonic drops the whole request
/// future when a client disconnects, and nothing prunes a `Reserved` entry, so a
/// cancelled Exec would otherwise hold its id for the life of the guest.
pub(crate) struct ExecutionReservation {
    registry: ExecutionRegistry,
    execution_id: String,
    ticket: u64,
    released: AtomicBool,
}

impl Drop for ExecutionReservation {
    fn drop(&mut self) {
        if self.released.load(Ordering::Acquire) {
            return;
        }
        // The registry is behind an async mutex, so the release cannot run here.
        // Same shape as `ChannelBridge::drop`, which spawns its teardown.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let registry = self.registry.clone();
        let execution_id = std::mem::take(&mut self.execution_id);
        let ticket = self.ticket;
        runtime.spawn(async move {
            registry.release_reserved_id(&execution_id, ticket).await;
        });
    }
}

enum ExecutionEntry {
    Reserved {
        ticket: u64,
    },
    Live(ExecutionState),
    Retained {
        state: ExecutionState,
        snapshot: TerminalSnapshot,
        retained_bytes: usize,
        expires_at: Instant,
        last_access: u64,
    },
    Tombstone {
        snapshot: TerminalSnapshot,
        expires_at: Instant,
        metadata_bytes: usize,
        last_access: u64,
    },
}

#[derive(Clone)]
pub(crate) enum ExecutionLookup {
    Live(ExecutionState),
    Retained {
        state: ExecutionState,
        snapshot: TerminalSnapshot,
    },
    Tombstone(TerminalSnapshot),
}

struct RegistryInner {
    entries: HashMap<String, ExecutionEntry>,
    next_ticket: u64,
    next_access: u64,
    lifecycle_manager: Option<JoinHandle<()>>,
    /// Signals the lifecycle manager to leave its loop. Shutdown waits for that
    /// instead of aborting, because `prune_inner` tombstones entries under the
    /// lock and releases their resources after dropping it — an abort between
    /// those two steps strands resources no later caller can reach.
    lifecycle_shutdown: watch::Sender<bool>,
    is_shutting_down: bool,
    lifecycle_ended_cleanly: bool,
}

impl Default for RegistryInner {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            next_ticket: 0,
            next_access: 0,
            lifecycle_manager: None,
            lifecycle_shutdown: watch::channel(false).0,
            is_shutting_down: false,
            lifecycle_ended_cleanly: false,
        }
    }
}

fn next_access(inner: &mut RegistryInner) -> u64 {
    inner.next_access = inner.next_access.wrapping_add(1).max(1);
    inner.next_access
}

fn truncate_diagnostic(message: &str) -> String {
    if message.len() <= MAX_TOMBSTONE_DIAGNOSTIC_BYTES {
        return message.to_owned();
    }
    let mut end = MAX_TOMBSTONE_DIAGNOSTIC_BYTES - TOMBSTONE_TRUNCATION_SUFFIX.len();
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &message[..end], TOMBSTONE_TRUNCATION_SUFFIX)
}

fn tombstone_entry(
    snapshot: TerminalSnapshot,
    expires_at: Instant,
    last_access: u64,
) -> ExecutionEntry {
    let mut snapshot = snapshot;
    snapshot.exit.error_message = truncate_diagnostic(&snapshot.exit.error_message);
    snapshot.output.reader_failure = snapshot
        .output
        .reader_failure
        .as_deref()
        .map(truncate_diagnostic);
    let metadata_bytes = snapshot.exit.error_message.len()
        + snapshot
            .output
            .reader_failure
            .as_ref()
            .map_or(0, String::len);
    ExecutionEntry::Tombstone {
        snapshot,
        expires_at,
        metadata_bytes,
        last_access,
    }
}

fn enforce_tombstone_limits(inner: &mut RegistryInner) {
    let mut tombstones: Vec<_> = inner
        .entries
        .iter()
        .filter_map(|(id, entry)| match entry {
            ExecutionEntry::Tombstone {
                metadata_bytes,
                last_access,
                ..
            } => Some((id.clone(), *metadata_bytes, *last_access)),
            _ => None,
        })
        .collect();
    tombstones.sort_by_key(|(_, _, last_access)| *last_access);
    let mut total_bytes: usize = tombstones.iter().map(|(_, bytes, _)| *bytes).sum();
    while tombstones.len() > MAX_TOMBSTONE_ENTRIES || total_bytes > MAX_TOMBSTONE_METADATA_BYTES {
        let (id, bytes, _) = tombstones.remove(0);
        total_bytes -= bytes;
        inner.entries.remove(&id);
    }
}

/// Registry of active executions.
///
/// Thread-safe registry that stores execution state and provides
/// methods for registration, lookup, and lifecycle management.
#[derive(Clone)]
pub(crate) struct ExecutionRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

impl ExecutionRegistry {
    /// Create new registry.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner::default())),
        }
    }

    /// Check if execution exists.
    pub async fn exists(&self, exec_id: &str) -> bool {
        self.inner.lock().await.entries.contains_key(exec_id)
    }

    /// Get execution state.
    pub async fn get(&self, exec_id: &str) -> Option<ExecutionState> {
        match self.lookup(exec_id).await {
            Some(ExecutionLookup::Live(state) | ExecutionLookup::Retained { state, .. }) => {
                Some(state)
            }
            Some(ExecutionLookup::Tombstone(_)) | None => None,
        }
    }

    pub async fn lookup(&self, exec_id: &str) -> Option<ExecutionLookup> {
        let mut inner = self.inner.lock().await;
        let access = next_access(&mut inner);
        match inner.entries.get_mut(exec_id) {
            Some(ExecutionEntry::Live(state)) => Some(ExecutionLookup::Live(state.clone())),
            Some(ExecutionEntry::Retained {
                state,
                snapshot,
                last_access,
                ..
            }) => {
                *last_access = access;
                Some(ExecutionLookup::Retained {
                    state: state.clone(),
                    snapshot: snapshot.clone(),
                })
            }
            Some(ExecutionEntry::Tombstone {
                snapshot,
                last_access,
                ..
            }) => {
                *last_access = access;
                Some(ExecutionLookup::Tombstone(snapshot.clone()))
            }
            Some(ExecutionEntry::Reserved { .. }) | None => None,
        }
    }

    /// Register new execution state.
    pub async fn register(&self, exec_id: String, state: ExecutionState) -> bool {
        let mut inner = self.inner.lock().await;
        if inner.is_shutting_down || inner.entries.contains_key(&exec_id) {
            return false;
        }
        inner.entries.insert(exec_id, ExecutionEntry::Live(state));
        true
    }

    pub async fn reserve(&self, execution_id: String) -> Option<ExecutionReservation> {
        let mut inner = self.inner.lock().await;
        if inner.is_shutting_down || inner.entries.contains_key(&execution_id) {
            return None;
        }
        inner.next_ticket = inner.next_ticket.wrapping_add(1).max(1);
        let ticket = inner.next_ticket;
        inner
            .entries
            .insert(execution_id.clone(), ExecutionEntry::Reserved { ticket });
        Some(ExecutionReservation {
            registry: self.clone(),
            execution_id,
            ticket,
            released: AtomicBool::new(false),
        })
    }

    pub async fn release_reservation(&self, reservation: &ExecutionReservation) -> bool {
        reservation.released.store(true, Ordering::Release);
        self.release_reserved_id(&reservation.execution_id, reservation.ticket)
            .await
    }

    /// Remove a reservation only while this exact ticket still owns the id, so a
    /// late release cannot evict the entry that replaced it.
    async fn release_reserved_id(&self, execution_id: &str, ticket: u64) -> bool {
        let mut inner = self.inner.lock().await;
        if inner.entries.get(execution_id).is_some_and(
            |entry| matches!(entry, ExecutionEntry::Reserved { ticket: held } if *held == ticket),
        ) {
            inner.entries.remove(execution_id);
            true
        } else {
            false
        }
    }

    pub async fn publish(&self, reservation: &ExecutionReservation, state: ExecutionState) -> bool {
        let mut inner = self.inner.lock().await;
        if inner.is_shutting_down {
            return false;
        }
        let Some(entry) = inner.entries.get_mut(&reservation.execution_id) else {
            return false;
        };
        if !matches!(entry, ExecutionEntry::Reserved { ticket } if *ticket == reservation.ticket) {
            return false;
        }
        *entry = ExecutionEntry::Live(state);
        reservation.released.store(true, Ordering::Release);
        true
    }

    #[cfg(test)]
    pub async fn store_tombstone(&self, execution_id: String, snapshot: TerminalSnapshot) {
        let mut inner = self.inner.lock().await;
        let access = next_access(&mut inner);
        inner.entries.insert(
            execution_id,
            tombstone_entry(snapshot, Instant::now() + TOMBSTONE_TTL, access),
        );
        enforce_tombstone_limits(&mut inner);
    }

    #[cfg(test)]
    pub async fn terminal_snapshot(&self, execution_id: &str) -> Option<TerminalSnapshot> {
        let mut inner = self.inner.lock().await;
        let access = next_access(&mut inner);
        match inner.entries.get_mut(execution_id) {
            Some(ExecutionEntry::Retained {
                snapshot,
                last_access,
                ..
            })
            | Some(ExecutionEntry::Tombstone {
                snapshot,
                last_access,
                ..
            }) => {
                *last_access = access;
                Some(snapshot.clone())
            }
            _ => None,
        }
    }

    pub async fn retain(
        &self,
        execution_id: &str,
        snapshot: TerminalSnapshot,
        retained_bytes: usize,
    ) -> bool {
        let evicted = {
            let mut inner = self.inner.lock().await;
            if inner.is_shutting_down {
                return false;
            }
            let Some(ExecutionEntry::Live(state)) = inner.entries.get(execution_id) else {
                return false;
            };
            let state = state.clone();
            if snapshot.output.reader_failure.is_some() {
                let access = next_access(&mut inner);
                inner.entries.insert(
                    execution_id.to_string(),
                    tombstone_entry(snapshot, Instant::now() + TOMBSTONE_TTL, access),
                );
                enforce_tombstone_limits(&mut inner);
                vec![state]
            } else {
                let access = next_access(&mut inner);
                inner.entries.insert(
                    execution_id.to_string(),
                    ExecutionEntry::Retained {
                        state: state.clone(),
                        snapshot,
                        retained_bytes,
                        expires_at: Instant::now() + RETAIN_GRACE,
                        last_access: access,
                    },
                );
                let mut retained: Vec<_> = inner
                    .entries
                    .iter()
                    .filter_map(|(id, entry)| match entry {
                        ExecutionEntry::Retained {
                            state,
                            snapshot,
                            retained_bytes,
                            last_access,
                            ..
                        } => Some((
                            id.clone(),
                            state.clone(),
                            snapshot.clone(),
                            *retained_bytes,
                            *last_access,
                        )),
                        _ => None,
                    })
                    .collect();
                retained.sort_by_key(|(_, _, _, _, last_access)| *last_access);
                let mut total_bytes: usize =
                    retained.iter().map(|(_, _, _, bytes, _)| *bytes).sum();
                let mut evicted = Vec::new();
                while retained.len() > MAX_RETAINED_ENTRIES || total_bytes > MAX_RETAINED_BYTES {
                    // A reader mid-replay would see its stream cut with no way to
                    // tell truncation from a normal end, so skip it and take the
                    // next oldest. When every candidate is being read the caps
                    // stay breached until those readers finish.
                    let Some(oldest_idle) = retained
                        .iter()
                        .position(|(_, state, _, _, _)| !state.has_active_reader())
                    else {
                        warn!(
                            retained = retained.len(),
                            retained_bytes = total_bytes,
                            "retention over budget: every retained session still has a reader"
                        );
                        break;
                    };
                    let (id, state, snapshot, bytes, _) = retained.remove(oldest_idle);
                    total_bytes -= bytes;
                    let access = next_access(&mut inner);
                    inner.entries.insert(
                        id,
                        tombstone_entry(snapshot, Instant::now() + TOMBSTONE_TTL, access),
                    );
                    evicted.push(state);
                }
                enforce_tombstone_limits(&mut inner);
                evicted
            }
        };
        for state in evicted {
            state.release_resources().await;
        }
        true
    }

    #[cfg(test)]
    async fn prune_at(&self, now: Instant) {
        Self::prune_inner(&self.inner, now).await;
    }

    async fn prune_inner(inner: &Arc<Mutex<RegistryInner>>, now: Instant) {
        let states = {
            let mut inner = inner.lock().await;
            let expired: Vec<_> = inner
                .entries
                .iter()
                .filter_map(|(id, entry)| match entry {
                    // A reader outliving the grace keeps its session: tombstoning
                    // it would abort the forwarder mid-replay, which the client
                    // cannot tell from a normal end of output. The next tick
                    // retires it once the reader detaches.
                    ExecutionEntry::Retained {
                        state,
                        snapshot,
                        expires_at,
                        ..
                    } if *expires_at <= now && !state.has_active_reader() => {
                        Some((id.clone(), state.clone(), snapshot.clone()))
                    }
                    _ => None,
                })
                .collect();
            for (id, _, snapshot) in &expired {
                let access = next_access(&mut inner);
                inner.entries.insert(
                    id.clone(),
                    tombstone_entry(snapshot.clone(), now + TOMBSTONE_TTL, access),
                );
            }
            inner.entries.retain(|_, entry| {
                !matches!(entry, ExecutionEntry::Tombstone { expires_at, .. } if *expires_at <= now)
            });
            enforce_tombstone_limits(&mut inner);
            expired
                .into_iter()
                .map(|(_, state, _)| state)
                .collect::<Vec<_>>()
        };
        for state in states {
            state.release_resources().await;
        }
    }

    #[cfg(test)]
    async fn prune_for_test(&self, now: Instant) {
        self.prune_at(now).await;
    }

    #[cfg(test)]
    async fn lifecycle_manager_is_running(&self) -> bool {
        self.inner.lock().await.lifecycle_manager.is_some()
    }

    async fn ensure_lifecycle_manager(&self) {
        let weak_inner = Arc::downgrade(&self.inner);
        let mut inner = self.inner.lock().await;
        if inner.is_shutting_down || inner.lifecycle_manager.is_some() {
            return;
        }
        let mut shutdown = inner.lifecycle_shutdown.subscribe();
        inner.lifecycle_manager = Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                    _ = shutdown.changed() => break,
                }
                let Some(inner) = weak_inner.upgrade() else {
                    break;
                };
                ExecutionRegistry::prune_inner(&inner, Instant::now()).await;
            }
        }));
    }

    async fn stop_lifecycle_manager(&self) {
        let lifecycle_manager = {
            let mut inner = self.inner.lock().await;
            inner.is_shutting_down = true;
            inner.lifecycle_shutdown.send_replace(true);
            inner.lifecycle_manager.take()
        };
        let Some(lifecycle_manager) = lifecycle_manager else {
            return;
        };
        let ended_cleanly = lifecycle_manager.await.is_ok();
        if !ended_cleanly {
            warn!("execution lifecycle manager did not stop cleanly");
        }
        self.inner.lock().await.lifecycle_ended_cleanly = ended_cleanly;
    }

    #[cfg(test)]
    async fn lifecycle_manager_ended_cleanly(&self) -> bool {
        self.inner.lock().await.lifecycle_ended_cleanly
    }

    pub fn observe_terminal(&self, execution_id: String, state: ExecutionState) {
        let registry = self.clone();
        tokio::spawn(async move {
            registry.ensure_lifecycle_manager().await;
            let exit = state.wait_exit(&execution_id).await;
            state.cancel_timeout_task().await;
            let output = state.wait_terminal_output_summary().await;
            let snapshot = TerminalSnapshot { exit, output };
            let retained_bytes = state.retained_output_bytes().await;
            registry
                .retain(&execution_id, snapshot, retained_bytes)
                .await;
        });
    }

    /// Release one explicitly ephemeral execution.
    ///
    /// SSH calls this only after its output stream and terminal wait complete.
    /// Retained SDK executions and container-init sessions are never released by
    /// their normal wait paths, preserving repeatable waits for those callers.
    pub async fn release_ephemeral(&self, exec_id: &str) -> bool {
        let state = {
            let mut inner = self.inner.lock().await;
            match inner.entries.remove(exec_id) {
                Some(ExecutionEntry::Live(state))
                | Some(ExecutionEntry::Retained { state, .. }) => Some(state),
                Some(
                    entry @ (ExecutionEntry::Reserved { .. } | ExecutionEntry::Tombstone { .. }),
                ) => {
                    inner.entries.insert(exec_id.to_string(), entry);
                    None
                }
                None => None,
            }
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
        self.stop_lifecycle_manager().await;

        let mut states_to_wait = Vec::new();

        let states: Vec<_> = self
            .inner
            .lock()
            .await
            .entries
            .iter()
            .filter_map(|(exec_id, entry)| match entry {
                ExecutionEntry::Live(state) => Some((exec_id.clone(), state.clone())),
                ExecutionEntry::Reserved { .. }
                | ExecutionEntry::Retained { .. }
                | ExecutionEntry::Tombstone { .. } => None,
            })
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
        } else {
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
                    break;
                }
            }

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

        self.release_remaining_states().await;
    }

    async fn release_remaining_states(&self) {
        let states = {
            let mut inner = self.inner.lock().await;
            std::mem::take(&mut inner.entries)
                .into_values()
                .filter_map(|entry| match entry {
                    ExecutionEntry::Live(state) | ExecutionEntry::Retained { state, .. } => {
                        Some(state)
                    }
                    ExecutionEntry::Reserved { .. } | ExecutionEntry::Tombstone { .. } => None,
                })
                .collect::<Vec<_>>()
        };
        for state in states {
            state.release_resources().await;
        }
    }
}

#[cfg(test)]
mod release_tests {
    use super::*;
    use crate::reaper::ExitSlot;
    use crate::service::exec::exec_handle::{ExecHandle, ExitStatus};
    use crate::service::exec::output::{OutputStreamSummary, OutputTerminalSummary};
    use crate::service::exec::state::{ExecutionExit, TerminalSnapshot};
    use nix::unistd::{pipe, Pid};
    use std::os::unix::process::ExitStatusExt;
    use std::time::Instant;

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
    async fn releasing_a_reservation_returns_its_id_to_absent() {
        let registry = ExecutionRegistry::new();
        let first = registry
            .reserve("reserved-exec".into())
            .await
            .expect("first reservation must succeed");

        assert!(registry.reserve("reserved-exec".into()).await.is_none());
        assert!(registry.release_reservation(&first).await);
        assert!(registry.reserve("reserved-exec".into()).await.is_some());
    }

    #[tokio::test]
    async fn shutdown_rejects_a_late_ssh_registration() {
        let registry = ExecutionRegistry::new();
        registry.shutdown_all(0).await;

        assert!(
            !registry
                .register("late-ssh-exec".into(), settled_state(11_010, false))
                .await
        );

        assert!(!registry.exists("late-ssh-exec").await);
    }

    #[tokio::test]
    async fn only_the_matching_reservation_can_publish_a_live_state() {
        let registry = ExecutionRegistry::new();
        let reservation = registry
            .reserve("reserved-exec".into())
            .await
            .expect("reservation must succeed");

        assert!(
            registry
                .publish(&reservation, settled_state(11_004, false))
                .await
        );
        assert!(registry.get("reserved-exec").await.is_some());
        assert!(!registry.release_reservation(&reservation).await);
    }

    #[tokio::test]
    async fn a_tombstone_keeps_its_terminal_snapshot_repeatable() {
        let registry = ExecutionRegistry::new();
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 7,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: true,
                    total_bytes: 12,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        };

        registry
            .store_tombstone("terminal-exec".into(), snapshot.clone())
            .await;
        assert_eq!(
            registry.terminal_snapshot("terminal-exec").await,
            Some(snapshot.clone())
        );
        assert_eq!(
            registry.terminal_snapshot("terminal-exec").await,
            Some(snapshot)
        );
    }

    #[tokio::test]
    async fn retained_entry_exposes_its_terminal_snapshot_before_tombstoning() {
        let registry = ExecutionRegistry::new();
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: true,
                    total_bytes: 3,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        };
        registry
            .register("retained-exec".into(), settled_state(11_005, false))
            .await;

        assert!(registry.retain("retained-exec", snapshot.clone(), 0).await);
        assert_eq!(
            registry.terminal_snapshot("retained-exec").await,
            Some(snapshot)
        );
    }

    #[tokio::test]
    async fn terminal_observer_retains_a_completed_live_execution() {
        let registry = ExecutionRegistry::new();
        let state = settled_state(11_006, false);
        registry
            .register("completed-exec".into(), state.clone())
            .await;

        registry.observe_terminal("completed-exec".into(), state);
        let snapshot = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(snapshot) = registry.terminal_snapshot("completed-exec").await {
                    break snapshot;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("completed execution must become retained");
        assert_eq!(snapshot.exit.exit_code, 7);
    }

    #[tokio::test]
    async fn terminal_observer_cancels_timeout_when_leader_exits_before_pipe_eof() {
        let registry = ExecutionRegistry::new();
        let (_stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        drop(stderr_peer);
        let state = ExecutionState::new_for_test(
            ExecHandle::new(Pid::from_raw(11_009), stdin, stdout, Some(stderr))
                .expect("test pipe must register with Tokio"),
            ExitSlot::settled_for_test(ExitStatus::Code(0)),
        );
        let timeout_task = tokio::spawn(std::future::pending());
        let timeout_abort = timeout_task.abort_handle();
        state.set_timeout_task(timeout_task).await;

        registry
            .register("leader-exited-pipe-open".into(), state)
            .await;
        registry.observe_terminal(
            "leader-exited-pipe-open".into(),
            registry.get("leader-exited-pipe-open").await.unwrap(),
        );

        tokio::time::timeout(Duration::from_secs(1), async {
            while !timeout_abort.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("leader exit must cancel its timeout before output EOF");
        assert!(matches!(
            registry.lookup("leader-exited-pipe-open").await,
            Some(ExecutionLookup::Live(_))
        ));
        drop(stdout_peer);
    }

    #[tokio::test]
    async fn expired_retained_entries_become_tombstones_then_expire() {
        let registry = ExecutionRegistry::new();
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        };
        registry
            .register("expiring-exec".into(), settled_state(11_007, false))
            .await;
        assert!(registry.retain("expiring-exec", snapshot, 0).await);

        let now = Instant::now();
        registry.prune_for_test(now + RETAIN_GRACE).await;
        assert!(registry.terminal_snapshot("expiring-exec").await.is_some());
        assert!(registry.get("expiring-exec").await.is_none());

        registry
            .prune_for_test(now + RETAIN_GRACE + TOMBSTONE_TTL)
            .await;
        assert!(registry.terminal_snapshot("expiring-exec").await.is_none());
    }

    #[tokio::test]
    async fn retained_entry_limit_evicts_the_oldest_to_a_tombstone() {
        let registry = ExecutionRegistry::new();
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        };
        for index in 0..=MAX_RETAINED_ENTRIES {
            let id = format!("retained-{index}");
            registry
                .register(id.clone(), settled_state(12_000 + index as i32, false))
                .await;
            assert!(registry.retain(&id, snapshot.clone(), 0).await);
        }

        assert!(registry.get("retained-0").await.is_none());
        assert_eq!(
            registry.terminal_snapshot("retained-0").await,
            Some(snapshot)
        );
    }

    #[tokio::test]
    async fn retained_byte_limit_evicts_the_oldest_to_a_tombstone() {
        let registry = ExecutionRegistry::new();
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        };
        registry
            .register("first".into(), settled_state(12_100, false))
            .await;
        registry
            .register("second".into(), settled_state(12_101, false))
            .await;

        assert!(
            registry
                .retain("first", snapshot.clone(), MAX_RETAINED_BYTES)
                .await
        );
        assert!(registry.retain("second", snapshot.clone(), 1).await);

        assert!(registry.get("first").await.is_none());
        assert_eq!(registry.terminal_snapshot("first").await, Some(snapshot));
    }

    #[tokio::test]
    async fn tombstone_entry_limit_evicts_the_oldest_snapshot() {
        let registry = ExecutionRegistry::new();
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        };
        for index in 0..=1024 {
            registry
                .store_tombstone(format!("tombstone-{index}"), snapshot.clone())
                .await;
        }

        assert!(registry.terminal_snapshot("tombstone-0").await.is_none());
        assert_eq!(
            registry.terminal_snapshot("tombstone-1024").await,
            Some(snapshot)
        );
    }

    #[tokio::test]
    async fn tombstone_diagnostics_are_utf8_bounded_and_count_toward_eviction() {
        let registry = ExecutionRegistry::new();
        let diagnostic = "€".repeat(2_000);
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: diagnostic.clone(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: Some(diagnostic),
            },
        };
        registry
            .store_tombstone("bounded".into(), snapshot.clone())
            .await;
        let bounded = registry.terminal_snapshot("bounded").await.unwrap();
        assert!(bounded.exit.error_message.len() <= MAX_TOMBSTONE_DIAGNOSTIC_BYTES);
        assert!(bounded.exit.error_message.ends_with("…[truncated]"));
        assert!(bounded
            .output
            .reader_failure
            .as_ref()
            .is_some_and(|message| {
                message.len() <= MAX_TOMBSTONE_DIAGNOSTIC_BYTES && message.ends_with("…[truncated]")
            }));

        for index in 0..700 {
            registry
                .store_tombstone(format!("metadata-{index}"), snapshot.clone())
                .await;
        }

        assert!(registry.terminal_snapshot("metadata-0").await.is_none());
        assert!(registry.terminal_snapshot("metadata-699").await.is_some());
    }

    #[tokio::test]
    async fn reader_failure_is_tombstoned_without_a_retained_grace_period() {
        let registry = ExecutionRegistry::new();
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: true,
                    total_bytes: 10,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: Some("stdout reader failed".into()),
            },
        };
        registry
            .register("reader-failure".into(), settled_state(12_200, false))
            .await;

        assert!(
            registry
                .retain("reader-failure", snapshot.clone(), 10)
                .await
        );
        assert!(registry.get("reader-failure").await.is_none());
        assert_eq!(
            registry.terminal_snapshot("reader-failure").await,
            Some(snapshot)
        );
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
    async fn shutdown_stops_the_lifecycle_manager() {
        let registry = ExecutionRegistry::new();
        registry.ensure_lifecycle_manager().await;
        assert!(registry.lifecycle_manager_is_running().await);

        registry.shutdown_all(0).await;

        assert!(!registry.lifecycle_manager_is_running().await);
    }

    #[tokio::test]
    async fn dropping_registry_does_not_keep_its_lifecycle_manager_alive() {
        let registry = ExecutionRegistry::new();
        registry.ensure_lifecycle_manager().await;
        let inner = Arc::downgrade(&registry.inner);

        drop(registry);

        assert!(inner.upgrade().is_none());
    }

    #[tokio::test]
    async fn shutdown_releases_live_and_retained_state_resources() {
        let registry = ExecutionRegistry::new();
        let live = settled_state(12_300, false);
        let retained = settled_state(12_301, false);
        let snapshot = TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        };
        registry.register("live".into(), live.clone()).await;
        registry.register("retained".into(), retained.clone()).await;
        assert!(registry.retain("retained", snapshot, 0).await);

        registry.shutdown_all(0).await;

        assert!(live.get_pid().await.is_none());
        assert!(retained.get_pid().await.is_none());
        assert!(!registry.exists("live").await);
        assert!(!registry.exists("retained").await);
    }

    #[tokio::test]
    async fn shutdown_does_not_signal_an_execution_without_identity() {
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
            Some(nix::sys::signal::Signal::SIGKILL as i32)
        );
    }

    #[tokio::test]
    async fn shutdown_does_not_signal_an_init_target() {
        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let leader = Pid::from_raw(child.id() as i32);
        let (stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        let init = ExecutionState::new_init_session(
            ExecHandle::new(leader, stdin, stdout, Some(stderr))
                .expect("test pipes must register with Tokio"),
            ExitSlot::settled_for_test(ExitStatus::Code(0)),
            crate::service::exec::process_instance::ProcessInstance::capture(leader),
        );
        let registry = ExecutionRegistry::new();
        registry.register("init".into(), init).await;

        registry.shutdown_all(0).await;

        assert!(
            child.try_wait().expect("check child status").is_none(),
            "registry must leave init shutdown to the container lifecycle"
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
            Some(nix::sys::signal::Signal::SIGKILL as i32)
        );
        drop((stdin_peer, stdout_peer, stderr_peer));
    }

    fn exit_snapshot() -> TerminalSnapshot {
        TerminalSnapshot {
            exit: ExecutionExit {
                exit_code: 0,
                signal: 0,
                error_message: String::new(),
            },
            output: OutputTerminalSummary {
                stdout: OutputStreamSummary {
                    enabled: true,
                    total_bytes: 0,
                },
                stderr: OutputStreamSummary {
                    enabled: false,
                    total_bytes: 0,
                },
                reader_failure: None,
            },
        }
    }

    /// A live state whose pipe peers stay open, so a forwarder attached to it
    /// keeps holding the output lease instead of hitting EOF.
    fn state_with_open_pipes(pid: i32) -> (ExecutionState, Vec<std::os::fd::OwnedFd>) {
        let (stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        let handle = ExecHandle::new(Pid::from_raw(pid), stdin, stdout, Some(stderr))
            .expect("test pipe must register with Tokio");
        let state = ExecutionState::new(
            handle,
            ExitSlot::settled_for_test(ExitStatus::Code(0)),
            None,
        );
        (state, vec![stdin_peer, stdout_peer, stderr_peer])
    }

    /// A cancelled Exec RPC drops its reservation without ever publishing. The
    /// id must not stay reserved for the life of the guest: `prune_inner` never
    /// touches `Reserved`, so nothing else would ever free it.
    #[tokio::test]
    async fn dropping_an_unpublished_reservation_frees_its_execution_id() {
        let registry = ExecutionRegistry::new();
        drop(
            registry
                .reserve("cancelled-exec".into())
                .await
                .expect("reservation must succeed"),
        );

        tokio::time::timeout(Duration::from_secs(1), async {
            while registry.exists("cancelled-exec").await {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a dropped reservation must free its execution id");
    }

    /// A reader attached to a retained session holds its output lease. Evicting
    /// it mid-replay aborts the forwarder, and the client cannot tell that
    /// truncation apart from a normal end of output.
    #[tokio::test]
    async fn eviction_spares_a_retained_session_with_an_active_reader() {
        let registry = ExecutionRegistry::new();
        let snapshot = exit_snapshot();

        let (attached, _peers) = state_with_open_pipes(12_400);
        registry.register("attached".into(), attached.clone()).await;
        let _reader = attached
            .attach_retained("attached")
            .await
            .expect("attach must claim the output lease");
        assert!(
            registry
                .retain("attached", snapshot.clone(), MAX_RETAINED_BYTES)
                .await
        );

        registry
            .register("newcomer".into(), settled_state(12_401, false))
            .await;
        assert!(registry.retain("newcomer", snapshot, 1).await);

        assert!(
            registry.get("attached").await.is_some(),
            "a retained session with an active reader must not be evicted"
        );

        // The forwarder parks on pipes this test keeps open, so join it here
        // rather than leaving a detached task behind for the next test.
        attached.release_resources().await;
        drop((_reader, _peers));
    }

    /// The retain grace elapsing is the other way a reader loses its stream, and
    /// unlike the caps it cannot be deferred by attaching: `lookup` refreshes
    /// `last_access` for LRU but never extends `expires_at`.
    #[tokio::test]
    async fn grace_expiry_spares_a_retained_session_with_an_active_reader() {
        let registry = ExecutionRegistry::new();
        let (attached, _peers) = state_with_open_pipes(12_402);
        registry.register("attached".into(), attached.clone()).await;
        let _reader = attached
            .attach_retained("attached")
            .await
            .expect("attach must claim the output lease");
        assert!(registry.retain("attached", exit_snapshot(), 0).await);

        registry
            .prune_for_test(Instant::now() + RETAIN_GRACE + Duration::from_secs(1))
            .await;

        assert!(
            registry.get("attached").await.is_some(),
            "grace expiry must not tombstone a session with an active reader"
        );

        attached.release_resources().await;
        drop((_reader, _peers));
    }

    /// `prune_inner` tombstones entries under the lock and releases their
    /// resources after dropping it, so aborting the manager between those two
    /// steps strands resources no later caller can reach. Shutdown therefore
    /// signals the manager and waits for it to leave the loop itself.
    #[tokio::test]
    async fn stopping_the_lifecycle_manager_lets_it_exit_on_its_own() {
        let registry = ExecutionRegistry::new();
        registry.ensure_lifecycle_manager().await;
        assert!(registry.lifecycle_manager_is_running().await);

        registry.shutdown_all(0).await;

        assert!(!registry.lifecycle_manager_is_running().await);
        assert!(
            registry.lifecycle_manager_ended_cleanly().await,
            "the manager must finish its own loop rather than be aborted"
        );
    }
}
