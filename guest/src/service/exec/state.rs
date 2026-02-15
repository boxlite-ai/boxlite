use crate::service::exec::exec_handle::ExecHandle;
use boxlite_shared::ExecOutput;
use std::os::unix::io::AsRawFd;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tonic::Status;
use tracing::info;

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
    /// Stdout/stderr forwarding tasks (set on attach)
    output_tasks: Vec<JoinHandle<()>>,
    /// Timeout flag
    #[allow(dead_code)] // Will be used for timeout handling
    timed_out: bool,
    /// Optional init health checker for the container this exec runs in.
    /// Used to detect container init death when exec gets SIGKILL.
    init_health: Option<Arc<Mutex<dyn InitHealthCheck>>>,
}

/// Execution state.
///
/// Handle owns pid, pty_controller, stdin, stdout, stderr.
/// stdin is taken on send_input(), stdout/stderr are taken on attach().
#[derive(Clone)]
pub(crate) struct ExecutionState {
    inner: Arc<Mutex<Inner>>,
}

impl ExecutionState {
    /// Create new execution state.
    pub(super) fn new(handle: ExecHandle) -> Self {
        let inner = Inner {
            handle: Some(handle),
            output_tasks: Vec::new(),
            timed_out: false,
            init_health: None,
        };

        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// Create execution state with an init health checker.
    ///
    /// Enables detection of container init death when the exec'd process
    /// receives SIGKILL (PID namespace teardown).
    pub(super) fn new_with_init_health(
        handle: ExecHandle,
        init_health: Arc<Mutex<dyn InitHealthCheck>>,
    ) -> Self {
        let inner = Inner {
            handle: Some(handle),
            output_tasks: Vec::new(),
            timed_out: false,
            init_health: Some(init_health),
        };

        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
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
    #[allow(dead_code)] // API completeness
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
        mut stream: tonic::Streaming<boxlite_shared::ExecStdin>,
    ) -> Result<JoinHandle<Result<(), Status>>, Status> {
        // Take stdin from handle
        let mut stdin = {
            let mut inner = self.inner.lock().await;
            let handle = inner
                .handle
                .as_mut()
                .ok_or_else(|| Status::failed_precondition("Handle not available"))?;

            handle
                .stdin()
                .ok_or_else(|| Status::already_exists("Stdin already taken"))?
        };

        // Spawn forwarding task
        let task = tokio::spawn(async move {
            // Write first message data
            if !first.data.is_empty() {
                stdin
                    .write_all(&first.data)
                    .await
                    .map_err(|e| Status::internal(format!("Stdin write failed: {}", e)))?;
            }
            if first.close {
                return Ok(());
            }

            // Forward remaining messages
            while let Some(msg) = stream.message().await? {
                if !msg.data.is_empty() {
                    stdin
                        .write_all(&msg.data)
                        .await
                        .map_err(|e| Status::internal(format!("Stdin write failed: {}", e)))?;
                }
                if msg.close {
                    break;
                }
            }
            Ok(())
        });

        Ok(task)
    }

    /// Wait for process to exit.
    ///
    /// Gets pid from handle and waits using waitpid.
    pub async fn wait_process(
        &self,
    ) -> Result<crate::service::exec::exec_handle::ExitStatus, Status> {
        use crate::service::exec::exec_handle::ExitStatus;
        use nix::sys::wait::{waitpid, WaitStatus};

        // Get pid from handle
        let pid = {
            let inner = self.inner.lock().await;
            inner
                .handle
                .as_ref()
                .ok_or_else(|| Status::failed_precondition("Handle not available"))?
                .pid()
        };

        // Wait for process (blocking call in spawn_blocking)
        let result = tokio::task::spawn_blocking(move || waitpid(pid, None))
            .await
            .map_err(|e| Status::internal(format!("spawn_blocking failed: {}", e)))?;

        let result = match result {
            Ok(status) => status,
            Err(nix::errno::Errno::ECHILD) => {
                // Child already reaped — process exited but exit code is lost.
                // This can happen if another reaper (container init, signal handler)
                // called waitpid() before us. Return 0 as best-effort.
                tracing::debug!(pid = pid.as_raw(), "waitpid ECHILD: child already reaped");
                return Ok(ExitStatus::Code(0));
            }
            Err(e) => return Err(Status::internal(format!("waitpid failed: {}", e))),
        };

        match result {
            WaitStatus::Exited(_, code) => Ok(ExitStatus::Code(code)),
            WaitStatus::Signaled(_, sig, _) => Ok(ExitStatus::Signal(sig)),
            other => Err(Status::internal(format!(
                "Unexpected wait status: {:?}",
                other
            ))),
        }
    }

    /// Attach to execution output.
    ///
    /// Takes stdout/stderr from handle and starts forwarding tasks.
    /// Returns stream of output chunks.
    pub async fn attach(
        &self,
        exec_id: &str,
    ) -> Result<mpsc::Receiver<Result<ExecOutput, Status>>, Status> {
        use boxlite_shared::{exec_output, Stderr, Stdout};
        use futures::StreamExt;

        let (tx, rx) = mpsc::channel(100);

        // Take stdout/stderr from handle
        let (stdout, stderr) = {
            let mut inner = self.inner.lock().await;

            if !inner.output_tasks.is_empty() {
                return Err(Status::already_exists("Already attached"));
            }

            let handle = inner
                .handle
                .as_mut()
                .ok_or_else(|| Status::failed_precondition("Handle not available"))?;

            let stdout = handle.stdout();
            let stderr = handle.stderr();

            (stdout, stderr)
        };

        // Spawn forwarding tasks
        let mut tasks = Vec::new();

        // Spawn stdout forwarding task
        let exec_id_string = exec_id.to_string();
        if let Some(mut stdout) = stdout {
            let tx = tx.clone();
            let handle = tokio::spawn(async move {
                while let Some(chunk) = stdout.next().await {
                    let msg = ExecOutput {
                        event: Some(exec_output::Event::Stdout(Stdout { data: chunk })),
                    };
                    if tx.send(Ok(msg)).await.is_err() {
                        break;
                    }
                }
                info!(execution = ?exec_id_string, "Stdout forwarding task ended");
            });
            tasks.push(handle);
        }

        // Spawn stderr forwarding task
        let exec_id_string = exec_id.to_string();
        if let Some(mut stderr) = stderr {
            let tx = tx.clone();
            let handle = tokio::spawn(async move {
                while let Some(chunk) = stderr.next().await {
                    let msg = ExecOutput {
                        event: Some(exec_output::Event::Stderr(Stderr { data: chunk })),
                    };
                    if tx.send(Ok(msg)).await.is_err() {
                        break;
                    }
                }
                info!(execution = ?exec_id_string, "Stderr forwarding task ended");
            });
            tasks.push(handle);
        }

        // Store tasks
        {
            let mut inner = self.inner.lock().await;
            inner.output_tasks = tasks;
        }

        Ok(rx)
    }

    /// Kill process with signal.
    ///
    /// Returns true if signal was sent, false if already exited.
    pub async fn kill(&self, signal: nix::sys::signal::Signal) -> bool {
        let inner = self.inner.lock().await;

        if let Some(ref handle) = inner.handle {
            handle.kill(signal).is_ok()
        } else {
            false
        }
    }

    /// Resize PTY window.
    pub async fn resize_pty(
        &self,
        rows: u16,
        cols: u16,
        x_pixels: u16,
        y_pixels: u16,
    ) -> Result<(), Status> {
        use nix::libc::TIOCSWINSZ;
        use nix::pty::Winsize;

        let inner = self.inner.lock().await;

        let handle = inner
            .handle
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("handle already consumed"))?;

        let controller = handle
            .pty_controller()
            .ok_or_else(|| Status::failed_precondition("not a PTY"))?;

        let winsize = Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: x_pixels,
            ws_ypixel: y_pixels,
        };

        // Send TIOCSWINSZ ioctl
        unsafe {
            if nix::libc::ioctl(controller.as_raw_fd(), TIOCSWINSZ, &winsize as *const _) == -1 {
                return Err(Status::internal("ioctl TIOCSWINSZ failed"));
            }
        }

        Ok(())
    }
}
