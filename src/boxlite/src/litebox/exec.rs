//! Command execution types
//!
//! Type definitions for executing commands in a box.
//! The actual execution logic is in BoxImpl::exec().

use crate::runtime::backend::ExecBackend;
use boxlite_shared::errors::BoxliteResult;
use futures::Stream;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::mpsc;

/// Command builder for executing programs in a box.
///
/// Provides a builder API similar to `std::process::Command`.
///
/// # Examples
///
/// ```rust,no_run
/// # use boxlite::BoxCommand;
/// # use std::time::Duration;
/// let cmd = BoxCommand::new("python3")
///     .args(["-c", "print('hello')"])
///     .env("PYTHONPATH", "/app")
///     .timeout(Duration::from_secs(30))
///     .working_dir("/workspace");
/// ```
#[derive(Clone, Debug)]
pub struct BoxCommand {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Option<Vec<(String, String)>>,
    pub(crate) timeout: Option<Duration>,
    pub(crate) working_dir: Option<String>,
    pub(crate) tty: bool,
    pub(crate) user: Option<String>,
}

impl BoxCommand {
    /// Create a new command.
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            args: vec![],
            env: None,
            timeout: None,
            working_dir: None,
            tty: false,
            user: None,
        }
    }

    /// Add a single argument.
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Add multiple arguments.
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Set an environment variable.
    pub fn env(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.env
            .get_or_insert_with(Vec::new)
            .push((key.into(), val.into()));
        self
    }

    /// Set execution timeout.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Set working directory.
    pub fn working_dir(mut self, dir: impl Into<String>) -> Self {
        self.working_dir = Some(dir.into());
        self
    }

    /// Enable TTY (pseudo-terminal) for interactive sessions.
    ///
    /// Terminal size is auto-detected from the current terminal.
    pub fn tty(mut self, enable: bool) -> Self {
        self.tty = enable;
        self
    }

    /// Set the user to run the command as.
    ///
    /// Format: `<name|uid>[:<group|gid>]` (same as `docker exec --user`).
    /// If not set, uses the container's default user from image config.
    pub fn user(mut self, spec: impl Into<String>) -> Self {
        let s = spec.into();
        self.user = if s.trim().is_empty() { None } else { Some(s) };
        self
    }
}

/// Handle to a running command execution.
///
/// Similar to `std::process::Child` but for remote execution in a guest.
/// Provides access to stdin, stdout, stderr streams and control operations.
///
/// # Examples
///
/// ```rust,no_run
/// # async fn example(litebox: &boxlite::LiteBox) -> Result<(), Box<dyn std::error::Error>> {
/// use boxlite::BoxCommand;
/// use futures::StreamExt;
///
/// let mut execution = litebox.exec(BoxCommand::new("ls").arg("-la")).await?;
///
/// // Read stdout
/// let mut stdout = execution.stdout.take().unwrap();
/// while let Some(line) = stdout.next().await {
///     println!("{}", line);
/// }
///
/// // Wait for completion
/// let status = execution.wait().await?;
/// println!("Exit code: {}", status.exit_code);
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct Execution {
    id: ExecutionId,
    inner: std::sync::Arc<tokio::sync::Mutex<ExecutionInner>>,
    /// Result-channel state held on a separate lock so a parked `wait()`
    /// can never block `kill()`/`signal()`/`resize_tty()`.
    wait_state: std::sync::Arc<WaitState>,
}

pub(crate) struct ExecutionInner {
    interface: Box<dyn ExecBackend>,

    /// Standard input stream (write-only).
    stdin: Option<ExecStdin>,

    /// Standard output stream (read-only).
    stdout: Option<ExecStdout>,

    /// Standard error stream (read-only).
    stderr: Option<ExecStderr>,
}

/// Independent lock domain for `Execution::wait`. Held only by waiters; never
/// contended with `interface`-using ops (`kill`, `signal`, `resize_tty`).
///
/// `OnceCell::get_or_try_init` ensures the result channel is read at most
/// once; concurrent waiters past the first one observe the cached value
/// without ever locking `rx`.
struct WaitState {
    cached: tokio::sync::OnceCell<ExecResult>,
    rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<ExecResult>>,
}

/// Unique identifier for an execution.
pub type ExecutionId = String;

impl Execution {
    /// Create a new Execution (internal use).
    pub(crate) fn new(
        execution_id: ExecutionId,
        interface: Box<dyn ExecBackend>,
        result_rx: mpsc::UnboundedReceiver<ExecResult>,
        stdin: Option<ExecStdin>,
        stdout: Option<ExecStdout>,
        stderr: Option<ExecStderr>,
    ) -> Self {
        let inner = ExecutionInner {
            interface,
            stdin,
            stdout,
            stderr,
        };
        let wait_state = WaitState {
            cached: tokio::sync::OnceCell::new(),
            rx: tokio::sync::Mutex::new(result_rx),
        };

        Self {
            id: execution_id,
            inner: std::sync::Arc::new(tokio::sync::Mutex::new(inner)),
            wait_state: std::sync::Arc::new(wait_state),
        }
    }

    /// Get the execution ID.
    pub fn id(&self) -> &ExecutionId {
        &self.id
    }

    /// Take the stdin stream (can only be called once).
    pub fn stdin(&mut self) -> Option<ExecStdin> {
        futures::executor::block_on(async {
            let mut inner = self.inner.lock().await;
            inner.stdin.take()
        })
    }

    /// Take the stdout stream (can only be called once).
    pub fn stdout(&mut self) -> Option<ExecStdout> {
        futures::executor::block_on(async {
            let mut inner = self.inner.lock().await;
            inner.stdout.take()
        })
    }

    /// Take the stderr stream (can only be called once).
    pub fn stderr(&mut self) -> Option<ExecStderr> {
        futures::executor::block_on(async {
            let mut inner = self.inner.lock().await;
            inner.stderr.take()
        })
    }

    /// Wait for the execution to complete.
    ///
    /// Returns the exit status once the execution finishes. If the result is
    /// already cached, returns immediately. Otherwise, awaits the next value
    /// from the result channel.
    ///
    /// The lock domain is `wait_state`, independent of `inner`, so a parked
    /// wait does not block `kill`/`signal`/`resize_tty`.
    pub async fn wait(&self) -> BoxliteResult<ExecResult> {
        self.wait_state
            .cached
            .get_or_try_init(|| async {
                let mut rx = self.wait_state.rx.lock().await;
                rx.recv().await.ok_or_else(|| {
                    boxlite_shared::BoxliteError::Internal("Result channel closed".into())
                })
            })
            .await
            .cloned()
    }

    /// Kill the process (sends SIGKILL).
    pub async fn kill(&mut self) -> BoxliteResult<()> {
        self.signal(9).await // SIGKILL
    }

    /// Send a signal to the execution.
    pub async fn signal(&self, signal: i32) -> BoxliteResult<()> {
        let mut inner = self.inner.lock().await;
        inner.interface.kill(&self.id, signal).await
    }

    /// Resize PTY terminal window.
    ///
    /// Only works for executions started with TTY enabled.
    pub async fn resize_tty(&self, rows: u32, cols: u32) -> BoxliteResult<()> {
        let mut inner = self.inner.lock().await;
        inner.interface.resize_tty(&self.id, rows, cols, 0, 0).await
    }
}

/// Exit status of a process.
#[derive(Clone, Debug)]
pub struct ExecResult {
    /// Exit code (0 = success). If terminated by signal, code is negative signal number.
    pub exit_code: i32,
    /// Diagnostic message when process died unexpectedly
    /// (e.g., container init death causing PID namespace teardown).
    /// None if the process exited normally.
    pub error_message: Option<String>,
}

impl ExecResult {
    /// Returns true if the exit code was 0.
    pub fn success(&self) -> bool {
        self.exit_code == 0
    }

    pub fn code(&self) -> i32 {
        self.exit_code
    }
}

/// Standard input stream (write-only).
pub struct ExecStdin {
    sender: Option<mpsc::UnboundedSender<Vec<u8>>>,
}

impl ExecStdin {
    pub(crate) fn new(sender: mpsc::UnboundedSender<Vec<u8>>) -> Self {
        Self {
            sender: Some(sender),
        }
    }

    /// Write data to stdin.
    pub async fn write(&mut self, data: &[u8]) -> BoxliteResult<()> {
        match &self.sender {
            Some(sender) => sender.send(data.to_vec()).map_err(|_| {
                boxlite_shared::BoxliteError::Internal("stdin channel closed".to_string())
            }),
            None => Err(boxlite_shared::BoxliteError::Internal(
                "stdin already closed".to_string(),
            )),
        }
    }

    /// Write all data to stdin.
    pub async fn write_all(&mut self, data: &[u8]) -> BoxliteResult<()> {
        self.write(data).await
    }

    /// Close stdin stream, signaling EOF to the process.
    pub fn close(&mut self) {
        self.sender = None;
    }

    /// Check if stdin is closed.
    pub fn is_closed(&self) -> bool {
        self.sender.is_none()
    }
}

/// Standard output stream (read-only).
pub struct ExecStdout {
    receiver: mpsc::UnboundedReceiver<String>,
}

impl ExecStdout {
    pub(crate) fn new(receiver: mpsc::UnboundedReceiver<String>) -> Self {
        Self { receiver }
    }
}

impl Stream for ExecStdout {
    type Item = String;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx)
    }
}

/// Standard error stream (read-only).
pub struct ExecStderr {
    receiver: mpsc::UnboundedReceiver<String>,
}

impl ExecStderr {
    pub(crate) fn new(receiver: mpsc::UnboundedReceiver<String>) -> Self {
        Self { receiver }
    }
}

impl Stream for ExecStderr {
    type Item = String;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_box_command_user_builder() {
        let cmd = BoxCommand::new("whoami").user("abc:staff");
        assert_eq!(cmd.user, Some("abc:staff".to_string()));
    }

    #[test]
    fn test_box_command_default_no_user() {
        let cmd = BoxCommand::new("ls");
        assert_eq!(cmd.user, None);
    }

    #[test]
    fn test_box_command_user_numeric() {
        let cmd = BoxCommand::new("id").user("1000:1000");
        assert_eq!(cmd.user, Some("1000:1000".to_string()));
    }

    #[test]
    fn test_box_command_user_empty_string_becomes_none() {
        let cmd = BoxCommand::new("id").user("");
        assert_eq!(cmd.user, None);
    }

    #[test]
    fn test_box_command_user_whitespace_only_becomes_none() {
        let cmd = BoxCommand::new("id").user("  ");
        assert_eq!(cmd.user, None);
    }

    // ─── wait must not block kill ─────────────────────────────────────
    //
    // `kill`/`signal`/`resize_tty` need the inner mutex. If `wait`
    // held the inner mutex across `result_rx.recv().await`, a parked
    // wait would block them indefinitely. wait operates on its own
    // `wait_state` lock domain so the inner mutex stays available.

    use crate::runtime::backend::ExecBackend;
    use async_trait::async_trait;
    use std::sync::Arc as StdArc;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use tokio::sync::mpsc as tokio_mpsc;

    struct StubExecBackend {
        kill_observed: StdArc<AtomicBool>,
    }

    #[async_trait]
    impl ExecBackend for StubExecBackend {
        async fn kill(&mut self, _execution_id: &str, _signal: i32) -> BoxliteResult<()> {
            self.kill_observed.store(true, AtomicOrdering::SeqCst);
            Ok(())
        }
        async fn resize_tty(
            &mut self,
            _execution_id: &str,
            _rows: u32,
            _cols: u32,
            _x_pixels: u32,
            _y_pixels: u32,
        ) -> BoxliteResult<()> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_does_not_block_kill() {
        let (_result_tx, result_rx) = tokio_mpsc::unbounded_channel::<ExecResult>();
        let kill_observed = StdArc::new(AtomicBool::new(false));
        let backend = Box::new(StubExecBackend {
            kill_observed: kill_observed.clone(),
        });

        let exec = Execution::new(
            "test-exec".to_string(),
            backend,
            result_rx,
            None,
            None,
            None,
        );

        // Park a `wait` future. With the bug present, `wait` would hold
        // `inner.lock()` across `recv().await` and `kill` below would
        // never get the lock.
        let wait_clone = exec.clone();
        tokio::spawn(async move {
            let _ = wait_clone.wait().await;
        });

        // Give the wait task a tick to grab whatever locks it needs.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Kill must resolve within bounded time even though wait is
        // parked. With the bug present, this awaits forever.
        let result = tokio::time::timeout(std::time::Duration::from_millis(500), exec.signal(9))
            .await
            .expect(
                "kill/signal blocked by parked wait — Execution lock split \
             regressed; see src/boxlite/src/litebox/exec.rs::wait",
            );
        assert!(result.is_ok());
        assert!(kill_observed.load(AtomicOrdering::SeqCst));
    }
}
