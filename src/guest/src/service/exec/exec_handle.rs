//! Process execution handle
//!
//! Provides types for managing a running process.
//! Works for both container and direct guest execution.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use futures::stream::{Stream, StreamExt};
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{unix::AsyncFd, Interest};

/// Stdin writer for executed process
///
/// Async wrapper around file descriptor for writing to process stdin.
pub struct ExecStdin {
    inner: AsyncFd<OwnedFd>,
}

impl ExecStdin {
    /// Create from file descriptor
    pub fn new(fd: OwnedFd) -> BoxliteResult<Self> {
        Ok(Self {
            inner: async_fd(fd, "stdin")?,
        })
    }

    /// Write all data to stdin
    ///
    /// # Errors
    ///
    /// - I/O error (pipe closed, etc.)
    pub async fn write_all(&mut self, data: &[u8]) -> BoxliteResult<()> {
        let mut written = 0;
        while written < data.len() {
            let count = self
                .inner
                .async_io(Interest::WRITABLE, |fd| write_fd(fd, &data[written..]))
                .await
                .map_err(|error| {
                    BoxliteError::Internal(format!("Failed to write to stdin: {error}"))
                })?;
            if count == 0 {
                return Err(BoxliteError::Internal(
                    "Failed to write to stdin: write returned zero bytes".into(),
                ));
            }
            written += count;
        }
        Ok(())
    }
}

fn async_fd(fd: OwnedFd, stream_name: &str) -> BoxliteResult<AsyncFd<OwnedFd>> {
    set_nonblocking(&fd)?;
    AsyncFd::new(fd).map_err(|error| {
        BoxliteError::Internal(format!(
            "Failed to register {stream_name} with Tokio I/O reactor: {error}"
        ))
    })
}

fn set_nonblocking(fd: &OwnedFd) -> BoxliteResult<()> {
    let flags = nix::fcntl::fcntl(fd.as_raw_fd(), nix::fcntl::FcntlArg::F_GETFL)
        .map_err(|error| BoxliteError::Internal(format!("Failed to read fd flags: {error}")))?;
    let mut flags = nix::fcntl::OFlag::from_bits_truncate(flags);
    flags.insert(nix::fcntl::OFlag::O_NONBLOCK);
    nix::fcntl::fcntl(fd.as_raw_fd(), nix::fcntl::FcntlArg::F_SETFL(flags)).map_err(|error| {
        BoxliteError::Internal(format!("Failed to set fd non-blocking: {error}"))
    })?;
    Ok(())
}

fn read_fd(fd: &OwnedFd, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        match nix::unistd::read(fd.as_raw_fd(), buffer) {
            Err(nix::errno::Errno::EINTR) => continue,
            result => return result.map_err(Into::into),
        }
    }
}

fn write_fd(fd: &OwnedFd, buffer: &[u8]) -> io::Result<usize> {
    loop {
        match nix::unistd::write(fd, buffer) {
            Err(nix::errno::Errno::EINTR) => continue,
            result => return result.map_err(Into::into),
        }
    }
}

// Shared output stream implementation
struct OutputStream {
    inner: Pin<Box<dyn Stream<Item = io::Result<Vec<u8>>> + Send>>,
}

impl OutputStream {
    fn new(fd: OwnedFd, pty_eio_is_eof: bool) -> BoxliteResult<Self> {
        use async_stream::stream;

        let reader = async_fd(fd, "output")?;

        let stream = stream! {
            let mut buf = [0u8; 1024];
            loop {
                match reader.async_io(Interest::READABLE, |fd| read_fd(fd, &mut buf)).await {
                    Ok(0) => break,  // EOF
                    Ok(n) => yield Ok(buf[..n].to_vec()),
                    Err(error) if pty_eio_is_eof && error.raw_os_error() == Some(nix::libc::EIO) => break,
                    Err(error) => {
                        yield Err(error);
                        break;
                    }
                }
            }
        };

        Ok(Self {
            inner: Box::pin(stream),
        })
    }
}

impl Stream for OutputStream {
    type Item = io::Result<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

/// Stdout stream from executed process
///
/// Stream that yields lines from stdout.
pub struct ExecStdout {
    inner: OutputStream,
}

impl ExecStdout {
    /// Create from file descriptor
    pub fn new(fd: OwnedFd) -> BoxliteResult<Self> {
        Ok(Self {
            inner: OutputStream::new(fd, false)?,
        })
    }

    fn new_pty(fd: OwnedFd) -> BoxliteResult<Self> {
        Ok(Self {
            inner: OutputStream::new(fd, true)?,
        })
    }
}

impl Stream for ExecStdout {
    type Item = io::Result<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.poll_next_unpin(cx)
    }
}

/// Stderr stream from executed process
///
/// Stream that yields lines from stderr.
pub struct ExecStderr {
    inner: OutputStream,
}

impl ExecStderr {
    /// Create from file descriptor
    pub fn new(fd: OwnedFd) -> BoxliteResult<Self> {
        Ok(Self {
            inner: OutputStream::new(fd, false)?,
        })
    }
}

impl Stream for ExecStderr {
    type Item = io::Result<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.poll_next_unpin(cx)
    }
}

/// Process exit status
///
/// Either normal exit with code or termination by signal.
#[derive(Debug, Clone, Copy)]
pub enum ExitStatus {
    /// Process exited normally with exit code
    Code(i32),

    /// Process was terminated by signal
    #[allow(dead_code)] // API completeness for future signal handling
    Signal(Signal),
}

impl ExitStatus {
    /// Get exit code
    ///
    /// Returns the exit code for normal termination, or 0 if killed by signal.
    #[allow(dead_code)] // API completeness for std::process::ExitStatus compatibility
    pub fn code(&self) -> i32 {
        match self {
            ExitStatus::Code(c) => *c,
            ExitStatus::Signal(_) => 0,
        }
    }

    /// Check if process exited successfully
    ///
    /// Returns `true` if exit code is 0, `false` otherwise (including signals).
    #[allow(dead_code)] // API completeness for std::process::ExitStatus compatibility
    pub fn success(&self) -> bool {
        matches!(self, ExitStatus::Code(0))
    }

    /// The code as a POSIX shell reports it: the exit code for a normal exit,
    /// `128 + n` for death by signal `n`. This is what the exit record stores —
    /// the true status is worth logging, but the code is what every reader
    /// consumes.
    pub fn shell_code(&self) -> i32 {
        match self {
            ExitStatus::Code(c) => *c,
            ExitStatus::Signal(s) => 128 + *s as i32,
        }
    }
}

/// PTY configuration
#[derive(Clone, Debug)]
pub struct PtyConfig {
    pub rows: u16,
    pub cols: u16,
    pub x_pixels: u16,
    pub y_pixels: u16,
    pub modes: Vec<PtyMode>,
}

/// One RFC 4254 terminal-mode opcode and value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PtyMode {
    pub opcode: u8,
    pub value: u32,
}

/// Handle to a running process
///
/// Represents a spawned process with stdin, stdout, and stderr.
/// Works for both container execution and direct guest execution.
///
/// # Example
///
/// ```no_run
/// # use guest::execution::*;
/// # use futures::StreamExt;
/// # async fn example(mut handle: ExecHandle) -> Result<(), Box<dyn std::error::Error>> {
/// // Write to stdin
/// if let Some(mut stdin) = handle.stdin() {
///     stdin.write_all(b"hello\n").await?;
/// }
///
/// // Read stdout and stderr separately
/// let mut stdout = handle.stdout().unwrap();
/// let mut stderr = handle.stderr().unwrap();
///
/// // Stream stdout
/// tokio::spawn(async move {
///     while let Some(line) = stdout.next().await {
///         println!("out: {}", String::from_utf8_lossy(&line));
///     }
/// });
///
/// // Stream stderr
/// tokio::spawn(async move {
///     while let Some(line) = stderr.next().await {
///         eprintln!("err: {}", String::from_utf8_lossy(&line));
///     }
/// });
///
/// # Ok(())
/// # }
/// ```
pub struct ExecHandle {
    /// Process ID
    pid: Pid,

    /// Stdin writer (None if closed)
    stdin: Option<ExecStdin>,

    /// Stdout stream
    stdout: Option<ExecStdout>,

    /// Stderr stream
    stderr: Option<ExecStderr>,

    /// PTY controller (for resize)
    ///
    /// Only present when spawned with PTY mode (tty=true).
    /// Used for terminal size operations via ioctl.
    pty_controller: Option<std::fs::File>,

    /// PTY configuration
    ///
    /// Only present when spawned with PTY mode (tty=true).
    pty_config: Option<PtyConfig>,
}

impl ExecHandle {
    /// Create new execution handle.
    ///
    /// # Arguments
    ///
    /// * `pid` - Process ID
    /// * `stdin` - Stdin file descriptor
    /// * `stdout` - Stdout file descriptor
    /// * `stderr` - Stderr file descriptor, or `None` in PTY mode (merged into stdout)
    pub fn new(
        pid: Pid,
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: Option<OwnedFd>,
    ) -> BoxliteResult<Self> {
        let stdout = if stderr.is_some() {
            ExecStdout::new(stdout)?
        } else {
            ExecStdout::new_pty(stdout)?
        };
        Ok(Self {
            pid,
            stdin: Some(ExecStdin::new(stdin)?),
            stdout: Some(stdout),
            // In PTY mode, stderr is None because stdout/stderr are merged
            // at the PTY level (single reader from PTY master)
            stderr: stderr.map(ExecStderr::new).transpose()?,
            pty_controller: None,
            pty_config: None,
        })
    }

    /// Set PTY controller and config
    ///
    /// Called when process is spawned with console socket (PTY mode).
    pub fn set_pty(&mut self, controller: std::fs::File, config: PtyConfig) {
        self.pty_controller = Some(controller);
        self.pty_config = Some(config);
    }

    /// Get PTY controller for resize operations
    pub fn pty_controller(&self) -> Option<&std::fs::File> {
        self.pty_controller.as_ref()
    }

    /// Get PTY config
    #[allow(dead_code)] // API completeness
    pub fn pty_config(&self) -> Option<&PtyConfig> {
        self.pty_config.as_ref()
    }

    /// Get process ID
    pub fn pid(&self) -> Pid {
        self.pid
    }

    /// Take stdin writer
    ///
    /// Returns `None` if stdin was already taken.
    pub fn stdin(&mut self) -> Option<ExecStdin> {
        self.stdin.take()
    }

    /// Close stdin (signals EOF to process)
    ///
    /// This drops the stdin handle, preventing further writes.
    /// The underlying file descriptor is closed when dropped.
    ///
    /// # Idempotent
    ///
    /// Safe to call multiple times (no-op if already closed).
    #[allow(dead_code)] // API completeness
    pub fn close_stdin(&mut self) {
        self.stdin = None; // Drop closes the fd
    }

    /// Take stdout stream
    ///
    /// Returns the stdout stream. After calling this, you cannot call it again.
    /// The stream can be moved into a spawned task for concurrent reading.
    pub fn stdout(&mut self) -> Option<ExecStdout> {
        self.stdout.take()
    }

    /// Take stderr stream
    ///
    /// Returns the stderr stream. After calling this, you cannot call it again.
    /// The stream can be moved into a spawned task for concurrent reading.
    pub fn stderr(&mut self) -> Option<ExecStderr> {
        self.stderr.take()
    }

    /// Kill process with signal.
    ///
    /// Sends a signal to the process.
    ///
    /// # Arguments
    ///
    /// - `signal`: POSIX signal number (9 = SIGKILL, 15 = SIGTERM, etc.)
    ///
    /// # Errors
    ///
    /// - Invalid signal number
    /// - Process already exited
    /// - Permission denied
    pub fn kill(&self, signal: Signal) -> BoxliteResult<()> {
        use nix::sys::signal::kill;

        kill(self.pid, signal).map_err(|e| {
            BoxliteError::Internal(format!(
                "Failed to send signal {} to process {}: {}",
                signal, self.pid, e
            ))
        })
    }

    /// Signal the execution's process group after proving the tracked process
    /// is still that group's leader. This check prevents a negative-PID kill
    /// from targeting a different group when used on an execution that did not
    /// create its own session.
    pub fn kill_process_group(&self, signal: Signal) -> BoxliteResult<()> {
        use nix::sys::signal::kill;
        use nix::unistd::getpgid;

        let process_group = getpgid(Some(self.pid)).map_err(|error| {
            BoxliteError::Internal(format!(
                "Failed to resolve process group for {}: {}",
                self.pid, error
            ))
        })?;
        let target = checked_process_group_target(self.pid, process_group)?;
        kill(target, signal).map_err(|error| {
            BoxliteError::Internal(format!(
                "Failed to send signal {} to process group {}: {}",
                signal, process_group, error
            ))
        })
    }
}

fn checked_process_group_target(pid: Pid, process_group: Pid) -> BoxliteResult<Pid> {
    let pid_raw = pid.as_raw();
    if pid_raw <= 0 || process_group != pid {
        return Err(BoxliteError::Internal(format!(
            "Refusing process-group signal: execution pid {pid} is not group leader {process_group}"
        )));
    }
    Ok(Pid::from_raw(-pid_raw))
}

#[cfg(test)]
mod process_group_tests {
    use super::*;
    use std::io::BufRead as _;
    use std::os::unix::process::CommandExt as _;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    struct ChildGroup {
        child: Child,
        process_group: Pid,
    }

    impl Drop for ChildGroup {
        fn drop(&mut self) {
            let _ = nix::sys::signal::kill(
                Pid::from_raw(-self.process_group.as_raw()),
                Signal::SIGKILL,
            );
            let _ = self.child.wait();
        }
    }

    fn is_gone_or_zombie(pid: Pid) -> bool {
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
        stat.rsplit_once(") ")
            .and_then(|(_, fields)| fields.chars().next())
            == Some('Z')
    }

    #[test]
    fn negative_kill_target_requires_the_execution_to_be_group_leader() {
        let pid = Pid::from_raw(4242);
        assert_eq!(
            checked_process_group_target(pid, pid).unwrap(),
            Pid::from_raw(-4242)
        );

        let error = checked_process_group_target(pid, Pid::from_raw(4000)).unwrap_err();
        assert!(error.to_string().contains("is not group leader"));
        assert!(checked_process_group_target(Pid::from_raw(0), Pid::from_raw(0)).is_err());
    }

    #[tokio::test]
    async fn process_group_kill_reaches_a_background_descendant() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("trap '' HUP TERM; sleep 30 & echo $!; wait")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: setsid is async-signal-safe and this closure performs no
        // allocation or other work between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut group = ChildGroup {
            child: command.spawn().unwrap(),
            process_group: Pid::from_raw(0),
        };
        let leader = Pid::from_raw(group.child.id() as i32);
        group.process_group = leader;
        assert_eq!(nix::unistd::getpgid(Some(leader)).unwrap(), leader);

        let stdout = group.child.stdout.take().unwrap();
        let mut line = String::new();
        std::io::BufReader::new(stdout)
            .read_line(&mut line)
            .unwrap();
        let descendant = Pid::from_raw(line.trim().parse::<i32>().unwrap());
        assert_eq!(nix::unistd::getpgid(Some(descendant)).unwrap(), leader);

        let (_stdin_peer, stdin) = nix::unistd::pipe().unwrap();
        let (stdout, _stdout_peer) = nix::unistd::pipe().unwrap();
        let (stderr, _stderr_peer) = nix::unistd::pipe().unwrap();
        let handle = ExecHandle::new(leader, stdin, stdout, Some(stderr))
            .expect("test pipe must register with Tokio");

        handle.kill_process_group(Signal::SIGTERM).unwrap();
        std::thread::sleep(Duration::from_millis(25));
        assert!(group.child.try_wait().unwrap().is_none());

        handle.kill_process_group(Signal::SIGKILL).unwrap();
        let status = group.child.wait().unwrap();
        assert_eq!(
            std::os::unix::process::ExitStatusExt::signal(&status),
            Some(9)
        );

        let deadline = Instant::now() + Duration::from_secs(2);
        while !is_gone_or_zombie(descendant) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            is_gone_or_zombie(descendant),
            "background descendant survived process-group SIGKILL"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Poll;
    use std::time::Duration;

    #[test]
    fn output_read_does_not_occupy_blocking_pool() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (read_fd, _write_fd) = nix::unistd::pipe().unwrap();
            let mut stdout = ExecStdout::new(read_fd).unwrap();
            let (pending_tx, pending_rx) = tokio::sync::oneshot::channel();
            let output_read = tokio::spawn(async move {
                let mut pending_tx = Some(pending_tx);
                futures::future::poll_fn(move |cx| {
                    let next = Pin::new(&mut stdout).poll_next(cx);
                    if matches!(next, Poll::Pending) {
                        if let Some(tx) = pending_tx.take() {
                            let _ = tx.send(());
                        }
                    }
                    next
                })
                .await
            });
            pending_rx.await.unwrap();

            let temporary_file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(temporary_file.path(), b"ready").unwrap();
            let read_file = tokio::fs::read(temporary_file.path());

            assert!(
                tokio::time::timeout(Duration::from_millis(100), read_file)
                    .await
                    .is_ok(),
                "an idle output stream must not occupy a blocking-pool worker"
            );

            output_read.abort();
        });
    }
}
