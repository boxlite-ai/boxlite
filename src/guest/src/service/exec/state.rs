use crate::service::exec::error::ExecutionError;
use crate::service::exec::exec_handle::ExecHandle;
use crate::service::exec::output::{OutputManager, OutputTerminalSummary};
use crate::service::exec::process_instance::ProcessInstance;
use boxlite_shared::ExecOutput;
use futures::{Stream, StreamExt as _};
use std::os::unix::io::AsRawFd;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, OnceCell};
use tokio::task::{AbortHandle, JoinHandle};
use tonic::Status;

/// Abstraction for checking container init health.
///
/// Decouples ExecutionState (state layer) from the Container type (container module),
/// following Dependency Inversion: the exec module defines the interface it needs,
/// and the container module implements it.
pub(crate) trait InitHealthCheck: Send + Sync {
    /// Check if the init process is still running.
    fn is_running(&self) -> bool;

    /// Diagnose why init exited. Includes status, PID, init stdout/stderr.
    /// May only return full output once (drains init pipes).
    fn diagnose_exit(&mut self) -> String;
}

/// Inner state that requires synchronization.
struct Inner {
    /// The process handle (owns pid, pty_controller, stdin, stdout, stderr)
    handle: Option<ExecHandle>,
    output: OutputManager,
    /// Abort handles for stdin forwarding tasks that may own the taken stdin FD.
    input_tasks: Vec<AbortHandle>,
    output_task: Option<JoinHandle<()>>,
    timeout_task: Option<JoinHandle<()>>,
    /// Set once ephemeral callers explicitly release this execution's resources.
    released: bool,
    /// Optional init health checker for the container this exec runs in.
    /// Used to detect container init death when exec gets SIGKILL.
    init_health: Option<Arc<Mutex<dyn InitHealthCheck>>>,
}

enum OutputAttachMode {
    Live,
    Retained,
}

/// How an execution ended, already classified.
///
/// `error_message` carries the container-death diagnosis when pid-namespace
/// teardown is what killed the process; it is empty otherwise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutionExit {
    pub exit_code: i32,
    pub signal: i32,
    pub error_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalSnapshot {
    pub(crate) exit: ExecutionExit,
    pub(crate) output: OutputTerminalSummary,
}

/// Execution state.
///
/// Handle owns pid, pty_controller, stdin, stdout, stderr.
#[derive(Clone)]
pub(crate) struct ExecutionState {
    inner: Arc<Mutex<Inner>>,
    /// This execution's exit, registered with the reaper at spawn. Level-triggered,
    /// so every caller — concurrent or long after the fact — reads the same
    /// status, and one that arrives before the process exits simply waits.
    exit: crate::reaper::ExitSlot,
    process: Option<ProcessInstance>,
    shutdown_managed: bool,
    consumer_lease: Arc<std::sync::atomic::AtomicBool>,
    /// Classified once: the container-death diagnosis drains init's pipes, so a
    /// second reader would get a different answer.
    terminal_exit: Arc<OnceCell<ExecutionExit>>,
}

impl ExecutionState {
    fn from_handle(
        mut handle: ExecHandle,
        init_health: Option<Arc<Mutex<dyn InitHealthCheck>>>,
        exit: crate::reaper::ExitSlot,
        process: Option<ProcessInstance>,
        shutdown_managed: bool,
    ) -> Self {
        let output = OutputManager::new(handle.stdout(), handle.stderr());
        let consumer_lease = output.consumer_lease_flag();
        Self {
            inner: Arc::new(Mutex::new(Inner {
                output,
                handle: Some(handle),
                input_tasks: Vec::new(),
                output_task: None,
                timeout_task: None,
                released: false,
                init_health,
            })),
            exit,
            process,
            shutdown_managed,
            consumer_lease,
            terminal_exit: Arc::new(OnceCell::new()),
        }
    }

    /// Whether a reader is currently streaming this execution's output.
    ///
    /// Kept outside `inner` so eviction can ask while holding the registry lock,
    /// which must not await on a state's own mutex.
    pub(crate) fn has_active_reader(&self) -> bool {
        self.consumer_lease
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// Create new execution state for a guest-side process.
    pub(super) fn new(
        handle: ExecHandle,
        exit: crate::reaper::ExitSlot,
        process: Option<ProcessInstance>,
    ) -> Self {
        Self::from_handle(handle, None, exit, process, true)
    }

    #[cfg(test)]
    pub(in crate::service) fn new_for_test(
        handle: ExecHandle,
        exit: crate::reaper::ExitSlot,
    ) -> Self {
        Self::from_handle(handle, None, exit, None, false)
    }

    /// Create execution state with an init health checker.
    ///
    /// Enables detection of container init death when the exec'd process
    /// receives SIGKILL (PID namespace teardown).
    pub(super) fn new_with_init_health(
        handle: ExecHandle,
        init_health: Arc<Mutex<dyn InitHealthCheck>>,
        exit: crate::reaper::ExitSlot,
        process: Option<ProcessInstance>,
    ) -> Self {
        Self::from_handle(handle, Some(init_health), exit, process, true)
    }

    /// Create execution state for the container's init process itself.
    ///
    /// Like every session, init is waited via the guest-wide reaper: it
    /// reparents to guest main (the boxlite-guest agent process), which owns
    /// `waitpid(-1)`. See `wait_process`.
    ///
    /// The container lifecycle owns shutdown for init, so registry shutdown must
    /// leave this session alone while an explicit Kill may still signal it.
    pub(crate) fn new_init_session(
        handle: ExecHandle,
        exit: crate::reaper::ExitSlot,
        process: Option<ProcessInstance>,
    ) -> Self {
        Self::from_handle(handle, None, exit, process, false)
    }

    /// Check if the container init process died.
    ///
    /// Returns `Some(diagnosis)` if init is dead, `None` if alive or no health checker.
    pub(super) async fn check_container_death(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        let health = inner.init_health.as_ref()?;
        let mut health = health.lock().await;
        if health.is_running() {
            return None;
        }
        Some(health.diagnose_exit())
    }

    /// Get PID for execution.
    #[cfg(test)]
    pub async fn get_pid(&self) -> Option<u32> {
        let inner = self.inner.lock().await;
        inner.handle.as_ref().map(|h| h.pid().as_raw() as u32)
    }

    /// Send input to execution stdin.
    ///
    /// Takes stdin from handle, spawns forwarding task, returns task handle.
    /// Note: First message has already been read to extract execution_id.
    pub async fn send_input(
        &self,
        first: boxlite_shared::ExecStdin,
        stream: impl Stream<Item = Result<boxlite_shared::ExecStdin, ExecutionError>>
            + Send
            + Unpin
            + 'static,
    ) -> Result<JoinHandle<Result<(), ExecutionError>>, ExecutionError> {
        use futures::StreamExt as _;

        // Take stdin from handle
        let mut stdin = {
            let mut inner = self.inner.lock().await;
            let handle = inner
                .handle
                .as_mut()
                .ok_or(ExecutionError::HandleUnavailable)?;

            handle.stdin().ok_or(ExecutionError::StdinTaken)?
        };

        // Spawn forwarding task
        let mut stream = stream;
        let task = tokio::spawn(async move {
            // Write first message data
            if !first.data.is_empty() {
                stdin
                    .write_all(&first.data)
                    .await
                    .map_err(|e| ExecutionError::Io(e.to_string()))?;
            }
            if first.close {
                return Ok(());
            }

            // Forward remaining messages
            while let Some(msg) = stream.next().await {
                let msg = msg?;
                if !msg.data.is_empty() {
                    stdin
                        .write_all(&msg.data)
                        .await
                        .map_err(|e| ExecutionError::Io(e.to_string()))?;
                }
                if msg.close {
                    break;
                }
            }
            Ok(())
        });
        self.track_input_task(task.abort_handle()).await;

        Ok(task)
    }

    /// Track a task that owns stdin after it has been taken from the handle.
    ///
    /// Release can race with task creation. A task registered after release is
    /// aborted immediately instead of escaping the execution's lifetime.
    async fn track_input_task(&self, task: AbortHandle) {
        let mut inner = self.inner.lock().await;
        if inner.released {
            task.abort();
        } else {
            inner.input_tasks.push(task);
        }
    }

    /// Wait for process to exit.
    ///
    /// Every process we wait on — the container init and exec tenants alike —
    /// reparents to guest main (tenants via `as_sibling`/`CLONE_PARENT`; init
    /// the same way), so the guest-wide reaper owns `waitpid(-1)` for all of
    /// them. We just ask it for this pid's exit.
    ///
    /// Multi-waiter safe, and repeatable: the slot is level-triggered, so
    /// concurrent callers and any number of later ones all read the same status.
    pub async fn wait_process(&self) -> crate::service::exec::exec_handle::ExitStatus {
        self.exit.get().await
    }

    pub(crate) async fn wait_terminal_output_summary(&self) -> OutputTerminalSummary {
        let output = self.inner.lock().await.output.clone();
        let summary = output.wait_terminal_summary().await;
        let sealed = output.seal().await;
        debug_assert!(sealed, "terminal output must be sealable after its summary");
        summary
    }

    pub(crate) async fn sealed_terminal_output_summary(&self) -> Option<OutputTerminalSummary> {
        let output = self.inner.lock().await.output.clone();
        output.sealed_terminal_summary().await
    }

    pub(crate) async fn retained_output_bytes(&self) -> usize {
        let output = self.inner.lock().await.output.clone();
        output.retained_bytes().await
    }

    pub(crate) async fn set_timeout_task(&self, task: JoinHandle<()>) {
        let task_to_abort = {
            let mut inner = self.inner.lock().await;
            if inner.released {
                Some(task)
            } else {
                debug_assert!(inner.timeout_task.is_none());
                inner.timeout_task = Some(task);
                None
            }
        };
        if let Some(task) = task_to_abort {
            task.abort();
            let _ = task.await;
        }
    }

    pub(crate) async fn cancel_timeout_task(&self) {
        let task = self.inner.lock().await.timeout_task.take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }

    pub(crate) async fn abort_unpublished(&self) {
        let _ = self
            .signal_owned_process_if_current(nix::sys::signal::Signal::SIGKILL)
            .await;
        self.release_resources().await;
    }

    #[cfg(test)]
    pub(crate) async fn wait_terminal_snapshot(&self, exec_id: &str) -> TerminalSnapshot {
        let (exit, output) =
            tokio::join!(self.wait_exit(exec_id), self.wait_terminal_output_summary(),);
        TerminalSnapshot { exit, output }
    }

    /// Wait for exit and classify it.
    ///
    /// The SIGKILL diagnosis lives here rather than in a caller because
    /// [`Self::check_container_death`] is private to the exec module: every
    /// consumer — the RPC adapter and the in-process SSH bridge alike — must get
    /// the same answer, including the reason a tenant was killed by pid-namespace
    /// teardown rather than by its own exit.
    pub(crate) async fn wait_exit(&self, exec_id: &str) -> ExecutionExit {
        self.terminal_exit
            .get_or_init(|| self.classify_exit(exec_id))
            .await
            .clone()
    }

    async fn classify_exit(&self, exec_id: &str) -> ExecutionExit {
        use crate::service::exec::exec_handle::ExitStatus;

        match self.wait_process().await {
            ExitStatus::Code(code) => {
                tracing::debug!(execution_id = %exec_id, exit_code = code, "Process exited with code");
                ExecutionExit {
                    exit_code: code,
                    signal: 0,
                    error_message: String::new(),
                }
            }
            ExitStatus::Signal(signal) => {
                let mut error_message = String::new();
                // PID namespace teardown SIGKILLs every process when init exits,
                // so a bare SIGKILL is ambiguous without asking the container.
                if signal == nix::sys::signal::Signal::SIGKILL {
                    if let Some(diagnosis) = self.check_container_death().await {
                        tracing::warn!(
                            execution_id = %exec_id,
                            signal = signal as i32,
                            diagnosis = %diagnosis,
                            "Process killed by container init death (PID namespace teardown). \
                             The container's init process exited, causing all exec'd processes \
                             to receive SIGKILL."
                        );
                        error_message = diagnosis;
                    }
                }
                tracing::debug!(execution_id = %exec_id, signal = signal as i32, "Process exited due to signal");
                ExecutionExit {
                    exit_code: 0,
                    signal: signal as i32,
                    error_message,
                }
            }
        }
    }

    /// Attach to execution output.
    pub async fn attach(
        &self,
        exec_id: &str,
    ) -> Result<mpsc::Receiver<Result<ExecOutput, Status>>, ExecutionError> {
        self.attach_output(exec_id, OutputAttachMode::Live).await
    }

    pub(crate) async fn attach_retained(
        &self,
        exec_id: &str,
    ) -> Result<mpsc::Receiver<Result<ExecOutput, Status>>, ExecutionError> {
        self.attach_output(exec_id, OutputAttachMode::Retained)
            .await
    }

    async fn attach_output(
        &self,
        exec_id: &str,
        mode: OutputAttachMode,
    ) -> Result<mpsc::Receiver<Result<ExecOutput, Status>>, ExecutionError> {
        self.join_finished_output_task().await;

        let output = {
            let inner = self.inner.lock().await;
            if inner.released {
                return Err(ExecutionError::HandleUnavailable);
            }
            inner.output.clone()
        };
        let mut output = match mode {
            OutputAttachMode::Live => output.attach().await,
            OutputAttachMode::Retained => output.attach_retained().await,
        }
        .map_err(|_| ExecutionError::AlreadyAttached)?;
        let (tx, rx) = mpsc::channel(100);
        let execution_id = exec_id.to_owned();
        let task = tokio::spawn(async move {
            while let Some(message) = output.next().await {
                if tx.send(message).await.is_err() {
                    break;
                }
            }
            tracing::info!(%execution_id, "execution output forwarding ended");
        });

        let (task_to_abort, displaced) = {
            let mut inner = self.inner.lock().await;
            if inner.released {
                (Some(task), None)
            } else {
                (None, inner.output_task.replace(task))
            }
        };
        // A forwarder releases the consumer lease when its stream drops, which
        // happens before its handle reports finished. So a displaced forwarder is
        // already ending, and this join cannot wait on live output.
        if let Some(displaced) = displaced {
            let _ = displaced.await;
        }
        if let Some(task) = task_to_abort {
            task.abort();
            let _ = task.await;
            return Err(ExecutionError::HandleUnavailable);
        }
        Ok(rx)
    }

    async fn join_finished_output_task(&self) {
        let task = {
            let mut inner = self.inner.lock().await;
            if inner
                .output_task
                .as_ref()
                .is_some_and(JoinHandle::is_finished)
            {
                inner.output_task.take()
            } else {
                None
            }
        };
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    #[cfg(test)]
    async fn output_task_count(&self) -> usize {
        if self.inner.lock().await.output_task.is_some() {
            1
        } else {
            0
        }
    }

    /// Drop every resource owned by an explicitly ephemeral execution.
    ///
    /// Ordinary SDK executions never call this method, so their repeatable wait
    /// contract remains unchanged. Taking the handle closes any retained stdin,
    /// stdout/stderr, and PTY controller descriptors even when another state
    /// clone still exists. Forwarders are aborted because stdin may already have
    /// moved out of the handle into one of those tasks.
    pub(super) async fn release_resources(&self) -> bool {
        let (output, input_tasks, output_task, timeout_task) = {
            let mut inner = self.inner.lock().await;
            if inner.released {
                return false;
            }
            inner.released = true;
            let output = inner.output.clone();
            let input_tasks = std::mem::take(&mut inner.input_tasks);
            let output_task = inner.output_task.take();
            let timeout_task = inner.timeout_task.take();
            drop(inner.handle.take());
            drop(inner.init_health.take());
            (output, input_tasks, output_task, timeout_task)
        };

        for task in input_tasks {
            task.abort();
        }
        if let Some(task) = output_task {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = timeout_task {
            task.abort();
            let _ = task.await;
        }
        output.shutdown_drains().await;
        if self.shutdown_managed {
            if let Some(reaper) = crate::reaper::REAPER.get() {
                reaper.release_slot(&self.exit);
            }
        }
        true
    }

    /// Signal this execution only while it remains registered for shutdown.
    pub(crate) async fn signal_owned_process_if_current(
        &self,
        signal: nix::sys::signal::Signal,
    ) -> Result<bool, nix::errno::Errno> {
        if !self.shutdown_managed {
            return Ok(false);
        }
        self.signal_if_current(signal, false).await
    }

    async fn signal_if_current(
        &self,
        signal: nix::sys::signal::Signal,
        process_group: bool,
    ) -> Result<bool, nix::errno::Errno> {
        let inner = self.inner.lock().await;
        if inner.released {
            return Ok(false);
        }
        let Some(process) = self.process else {
            return Ok(false);
        };
        let result = process.signal(signal, process_group);
        drop(inner);
        result
    }

    pub(crate) async fn owned_process_is_current(&self) -> bool {
        self.shutdown_managed
            && !self.inner.lock().await.released
            && self.process.is_some_and(|process| process.is_current())
    }

    /// Kill process with signal.
    ///
    /// Returns true if signal was sent, false if already exited.
    pub async fn kill(&self, signal: nix::sys::signal::Signal, process_group: bool) -> bool {
        self.signal_if_current(signal, process_group)
            .await
            .unwrap_or(false)
    }

    /// Resize PTY window.
    pub async fn resize_pty(
        &self,
        rows: u16,
        cols: u16,
        x_pixels: u16,
        y_pixels: u16,
    ) -> Result<(), ExecutionError> {
        use nix::libc::TIOCSWINSZ;
        use nix::pty::Winsize;

        let inner = self.inner.lock().await;

        let handle = inner
            .handle
            .as_ref()
            .ok_or(ExecutionError::HandleUnavailable)?;

        let controller = handle.pty_controller().ok_or(ExecutionError::NotAPty)?;

        let winsize = Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: x_pixels,
            ws_ypixel: y_pixels,
        };

        // Send TIOCSWINSZ ioctl
        unsafe {
            if nix::libc::ioctl(controller.as_raw_fd(), TIOCSWINSZ, &winsize as *const _) == -1 {
                return Err(ExecutionError::Io("ioctl TIOCSWINSZ failed".into()));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod release_tests {
    use super::*;
    use crate::reaper::ExitSlot;
    use crate::service::exec::exec_handle::{ExitStatus, PtyConfig};
    use crate::service::exec::process_instance::ProcessInstance;
    use nix::unistd::{pipe, Pid};
    use std::os::fd::{AsRawFd, OwnedFd, RawFd};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fd_is_open(fd: RawFd) -> bool {
        (unsafe { nix::libc::fcntl(fd, nix::libc::F_GETFD) }) != -1
    }

    fn state_with_tracked_handle() -> (ExecutionState, [RawFd; 4], Vec<OwnedFd>) {
        let (stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        let (pty_controller, pty_peer) = pipe().unwrap();
        let tracked = [
            stdin.as_raw_fd(),
            stdout.as_raw_fd(),
            stderr.as_raw_fd(),
            pty_controller.as_raw_fd(),
        ];

        let mut handle = ExecHandle::new(Pid::from_raw(42_424), stdin, stdout, Some(stderr))
            .expect("test pipe must register with Tokio");
        handle.set_pty(
            std::fs::File::from(pty_controller),
            PtyConfig {
                rows: 24,
                cols: 80,
                x_pixels: 0,
                y_pixels: 0,
                modes: Vec::new(),
            },
        );
        let state =
            ExecutionState::new_for_test(handle, ExitSlot::settled_for_test(ExitStatus::Code(0)));
        (
            state,
            tracked,
            vec![stdin_peer, stdout_peer, stderr_peer, pty_peer],
        )
    }

    #[tokio::test]
    async fn release_closes_handle_fds_and_aborts_forwarders_idempotently() {
        let (state, tracked_fds, _peers) = state_with_tracked_handle();
        let retained_clone = state.clone();
        let (task_fd, task_peer) = pipe().unwrap();
        let task_raw_fd = task_fd.as_raw_fd();
        let task = tokio::spawn(async move {
            let _task_fd = task_fd;
            std::future::pending::<()>().await;
        });
        state.track_input_task(task.abort_handle()).await;

        assert!(tracked_fds.into_iter().all(fd_is_open));
        assert!(fd_is_open(task_raw_fd));
        assert!(state.release_resources().await);
        assert!(!state.release_resources().await);

        assert!(tracked_fds.into_iter().all(|fd| !fd_is_open(fd)));
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .expect("aborted input task must finish")
                .expect_err("input task must be cancelled")
                .is_cancelled()
        );
        assert!(!fd_is_open(task_raw_fd));
        assert!(retained_clone.get_pid().await.is_none());
        drop(task_peer);
    }

    #[tokio::test]
    async fn a_forwarder_registered_after_release_is_aborted() {
        let (state, _tracked_fds, _peers) = state_with_tracked_handle();
        assert!(state.release_resources().await);

        let task = tokio::spawn(std::future::pending::<()>());
        state.track_input_task(task.abort_handle()).await;

        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .expect("late forwarder must finish")
                .expect_err("late forwarder must be cancelled")
                .is_cancelled()
        );
    }

    #[tokio::test]
    async fn release_aborts_the_timeout_task() {
        let (state, _tracked_fds, _peers) = state_with_tracked_handle();
        let task = tokio::spawn(std::future::pending::<()>());
        state.set_timeout_task(task).await;

        assert!(state.release_resources().await);
    }

    #[tokio::test]
    async fn process_identity_refuses_a_changed_start_time() {
        use std::os::unix::process::ExitStatusExt;

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = Pid::from_raw(child.id() as i32);
        let identity = ProcessInstance::capture(pid).expect("read child identity");
        let stale = identity.with_start_time_for_test(
            identity
                .start_time()
                .checked_sub(1)
                .expect("process start time must be nonzero"),
        );

        assert!(!stale
            .signal(nix::sys::signal::Signal::SIGTERM, false)
            .expect("stale identity must be rejected"));
        assert!(child.try_wait().expect("check child status").is_none());

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
    async fn aborting_an_unpublished_execution_kills_its_process() {
        use std::os::unix::process::ExitStatusExt;

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let leader = Pid::from_raw(child.id() as i32);
        let process = ProcessInstance::capture(leader).expect("read child identity");
        let (stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        let (exit, _exit_tx) = ExitSlot::pending_for_test();
        let state = ExecutionState::new(
            ExecHandle::new(leader, stdin, stdout, Some(stderr))
                .expect("test pipes must register with Tokio"),
            exit,
            Some(process),
        );

        state.abort_unpublished().await;

        let status = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("aborted leader must exit")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(
            status.signal(),
            Some(nix::sys::signal::Signal::SIGKILL as i32)
        );
        drop((stdin_peer, stdout_peer, stderr_peer));
    }

    #[tokio::test]
    async fn direct_kill_does_not_signal_a_released_execution() {
        use std::os::unix::process::ExitStatusExt;

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let leader = Pid::from_raw(child.id() as i32);
        let process = ProcessInstance::capture(leader).expect("read child identity");
        let (stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        let (exit, _exit_tx) = ExitSlot::pending_for_test();
        let state = ExecutionState::new(
            ExecHandle::new(leader, stdin, stdout, Some(stderr))
                .expect("test pipes must register with Tokio"),
            exit,
            Some(process),
        );

        assert!(state.release_resources().await);
        assert!(!state.kill(nix::sys::signal::Signal::SIGTERM, false).await);
        assert!(child.try_wait().expect("check child status").is_none());

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

    #[tokio::test]
    async fn process_identity_signals_the_matching_process() {
        use std::os::unix::process::ExitStatusExt;

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let identity = ProcessInstance::capture(Pid::from_raw(child.id() as i32))
            .expect("read child identity");

        assert!(identity
            .signal(nix::sys::signal::Signal::SIGTERM, false)
            .expect("signal matching identity"));
        let status = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for test child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(
            status.signal(),
            Some(nix::sys::signal::Signal::SIGTERM as i32)
        );
    }

    #[tokio::test]
    async fn process_group_kill_refuses_a_changed_start_time() {
        use std::os::unix::process::{CommandExt as _, ExitStatusExt};

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("30");
        // SAFETY: `setpgid` is async-signal-safe and this closure performs no
        // allocation or locking between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().expect("spawn process-group leader");
        let pid = Pid::from_raw(child.id() as i32);
        let identity = ProcessInstance::capture(pid).expect("read child identity");
        let stale = identity.with_start_time_for_test(
            identity
                .start_time()
                .checked_sub(1)
                .expect("process start time must be nonzero"),
        );

        assert!(!stale
            .signal(nix::sys::signal::Signal::SIGTERM, true)
            .expect("stale identity must be rejected"));
        assert!(child.try_wait().expect("check child status").is_none());

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

    /// Init is exempt from registry shutdown, not from an explicit Kill.
    #[tokio::test]
    async fn direct_kill_signals_an_init_session() {
        use std::os::unix::process::ExitStatusExt;

        let _test_guard = crate::reaper::reap_test_guard().await;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let leader = Pid::from_raw(child.id() as i32);
        let process = ProcessInstance::capture(leader).expect("read child identity");
        let (stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        let (exit, _exit_tx) = ExitSlot::pending_for_test();
        let state = ExecutionState::new_init_session(
            ExecHandle::new(leader, stdin, stdout, Some(stderr))
                .expect("test pipes must register with Tokio"),
            exit,
            Some(process),
        );

        assert!(!state
            .signal_owned_process_if_current(nix::sys::signal::Signal::SIGTERM)
            .await
            .expect("shutdown must skip an init session"));
        assert!(state.kill(nix::sys::signal::Signal::SIGTERM, false).await);

        let status = tokio::task::spawn_blocking(move || {
            let _fence = crate::reaper::reap_fence();
            child.wait().expect("wait for test child")
        })
        .await
        .expect("wait task must not panic");
        assert_eq!(
            status.signal(),
            Some(nix::sys::signal::Signal::SIGTERM as i32)
        );
        assert!(state.release_resources().await);
        drop((stdin_peer, stdout_peer, stderr_peer));
    }

    #[tokio::test]
    async fn state_waits_for_its_terminal_output_summary() {
        let (state, _tracked_fds, peers) = state_with_tracked_handle();
        drop(peers);

        let summary = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state.wait_terminal_output_summary(),
        )
        .await
        .expect("closed output peers must finish the summary wait");
        assert!(summary.stdout.enabled);
        assert!(summary.stderr.enabled);
    }

    #[tokio::test]
    async fn terminal_output_summary_seals_the_output_before_retention() {
        let (state, _tracked_fds, peers) = state_with_tracked_handle();
        drop(peers);

        state.wait_terminal_output_summary().await;

        assert!(matches!(
            state.attach("sealed-exec").await,
            Err(ExecutionError::AlreadyAttached)
        ));
    }

    #[tokio::test]
    async fn terminal_snapshot_caches_exit_with_completed_output() {
        let (state, _tracked_fds, peers) = state_with_tracked_handle();
        drop(peers);

        let snapshot = state.wait_terminal_snapshot("test-exec").await;
        assert_eq!(snapshot.exit.exit_code, 0);
        assert!(snapshot.output.stdout.enabled);
        assert!(snapshot.output.stderr.enabled);
    }

    struct DeadInit {
        diagnoses: Arc<AtomicUsize>,
    }

    impl InitHealthCheck for DeadInit {
        fn is_running(&self) -> bool {
            false
        }

        fn diagnose_exit(&mut self) -> String {
            self.diagnoses.fetch_add(1, Ordering::SeqCst);
            "init exited".into()
        }
    }

    #[tokio::test]
    async fn repeated_wait_caches_the_init_exit_diagnosis() {
        let (stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        let handle = ExecHandle::new(Pid::from_raw(42_424), stdin, stdout, Some(stderr))
            .expect("test pipe must register with Tokio");
        let diagnoses = Arc::new(AtomicUsize::new(0));
        let health: Arc<Mutex<dyn InitHealthCheck>> = Arc::new(Mutex::new(DeadInit {
            diagnoses: diagnoses.clone(),
        }));
        let state = ExecutionState::new_with_init_health(
            handle,
            health,
            ExitSlot::settled_for_test(ExitStatus::Signal(nix::sys::signal::Signal::SIGKILL)),
            None,
        );

        assert_eq!(state.wait_exit("exec").await.error_message, "init exited");
        assert_eq!(state.wait_exit("exec").await.error_message, "init exited");
        assert_eq!(diagnoses.load(Ordering::SeqCst), 1);

        drop((stdin_peer, stdout_peer, stderr_peer));
    }

    #[tokio::test]
    async fn repeated_attach_does_not_retain_finished_forwarding_tasks() {
        let (state, _tracked_fds, peers) = state_with_tracked_handle();

        let first = state.attach("exec-1").await.unwrap();
        drop(first);
        drop(peers);

        let second = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                match state.attach("exec-1").await {
                    Ok(receiver) => break receiver,
                    Err(ExecutionError::AlreadyAttached) => tokio::task::yield_now().await,
                    Err(error) => panic!("second attach must not fail: {error:?}"),
                }
            }
        })
        .await
        .expect("completed attach must release its output lease");
        drop(second);

        assert_eq!(state.output_task_count().await, 1);
    }
}
