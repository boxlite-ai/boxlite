use crate::service::exec::error::ExecutionError;
use crate::service::exec::exec_handle::ExecHandle;
use crate::service::exec::output::OutputManager;
use crate::service::exec::process_instance::ProcessInstance;
use boxlite_shared::ExecOutput;
use futures::{Stream, StreamExt as _};
use std::os::unix::io::AsRawFd;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
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
    /// Stdout/stderr forwarding tasks (set on attach)
    output_tasks: Vec<JoinHandle<()>>,
    /// Set once ephemeral callers explicitly release this execution's resources.
    released: bool,
    /// Timeout flag
    #[allow(dead_code)] // Will be used for timeout handling
    timed_out: bool,
    /// Optional init health checker for the container this exec runs in.
    /// Used to detect container init death when exec gets SIGKILL.
    init_health: Option<Arc<Mutex<dyn InitHealthCheck>>>,
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
}

impl ExecutionState {
    fn from_handle(
        mut handle: ExecHandle,
        init_health: Option<Arc<Mutex<dyn InitHealthCheck>>>,
        exit: crate::reaper::ExitSlot,
        process: Option<ProcessInstance>,
        shutdown_managed: bool,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                output: OutputManager::new(handle.stdout(), handle.stderr()),
                handle: Some(handle),
                input_tasks: Vec::new(),
                output_tasks: Vec::new(),
                released: false,
                timed_out: false,
                init_health,
            })),
            exit,
            process,
            shutdown_managed,
        }
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

    /// Wait for exit and classify it.
    ///
    /// The SIGKILL diagnosis lives here rather than in a caller because
    /// [`Self::check_container_death`] is private to the exec module: every
    /// consumer — the RPC adapter and the in-process SSH bridge alike — must get
    /// the same answer, including the reason a tenant was killed by pid-namespace
    /// teardown rather than by its own exit.
    pub(crate) async fn wait_exit(&self, exec_id: &str) -> ExecutionExit {
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
        let output = {
            let inner = self.inner.lock().await;
            if inner.released {
                return Err(ExecutionError::HandleUnavailable);
            }
            inner.output.clone()
        };
        let mut output = output
            .attach()
            .await
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

        let mut inner = self.inner.lock().await;
        if inner.released {
            task.abort();
            return Err(ExecutionError::HandleUnavailable);
        }
        inner.output_tasks.push(task);
        Ok(rx)
    }

    /// Drop every resource owned by an explicitly ephemeral execution.
    ///
    /// Ordinary SDK executions never call this method, so their repeatable wait
    /// contract remains unchanged. Taking the handle closes any retained stdin,
    /// stdout/stderr, and PTY controller descriptors even when another state
    /// clone still exists. Forwarders are aborted because stdin may already have
    /// moved out of the handle into one of those tasks.
    pub(super) async fn release_resources(&self) -> bool {
        let (output, input_tasks, output_tasks) = {
            let mut inner = self.inner.lock().await;
            if inner.released {
                return false;
            }
            inner.released = true;
            let output = inner.output.clone();
            let input_tasks = std::mem::take(&mut inner.input_tasks);
            let output_tasks = std::mem::take(&mut inner.output_tasks);
            drop(inner.handle.take());
            drop(inner.init_health.take());
            (output, input_tasks, output_tasks)
        };

        for task in input_tasks {
            task.abort();
        }
        for task in output_tasks {
            task.abort();
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
        if self.inner.lock().await.released {
            return Ok(false);
        }
        let Some(process) = self.process else {
            return Ok(false);
        };
        process.signal(signal, process_group)
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
}
