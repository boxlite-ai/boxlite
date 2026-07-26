//! Container init process stdio management.
//!
//! Provides pipe-based stdio that keeps init processes alive by holding
//! the write-end of stdin open (never written to, never closed).
//!
//! # Problem
//!
//! When container init's stdin is /dev/null, interactive entrypoints like
//! `/bin/sh` or `python` detect EOF and exit immediately, invalidating
//! the container namespace for subsequent exec operations.
//!
//! # Solution
//!
//! Create pipes where boxlite-guest holds the write-end of stdin open.
//! The init process blocks on `read(stdin)` indefinitely.
//!
//! # Example
//!
//! ```ignore
//! let (stdio, init_fds) = ContainerStdio::pipes()?;
//!
//! // Pass init_fds to libcontainer
//! ContainerBuilder::new(...)
//!     .with_stdin(init_fds.stdin)
//!     .with_stdout(init_fds.stdout)
//!     .with_stderr(init_fds.stderr)
//!     .build()?;
//!
//! // Hold stdio in Container struct - init blocks forever
//! let container = Container { stdio, ... };
//!
//! // When container is dropped, stdio is dropped → init gets EOF → exits
//! ```

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::unistd::pipe;
use std::collections::VecDeque;
use std::io::Read;
use std::os::unix::io::{AsRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::pipe::Receiver;
use tokio::task::JoinHandle;

/// Maximum size of the active log before rotation.
const LOG_MAX_SIZE: u64 = 10 * 1024 * 1024;
/// Total retained files, including the active log.
const LOG_MAX_FILES: usize = 5;
/// Maximum raw content bytes in one CRI record.
const CRI_MAX_CONTENT_SIZE: usize = 16 * 1024;
/// Retained diagnostic output per stream.
const DIAGNOSTIC_TAIL_SIZE: usize = 8 * 1024;

/// The guest's side of the container init process's stdio.
///
/// Two shapes, fixed when the container is created and never mixed, because
/// OCI `process.terminal` is decided at that point and init is the process it
/// applies to:
///
/// - `Pipes` (default): three pipes. The guest holds stdin's write-end so
///   init's `read()` blocks rather than seeing EOF, plus the read-ends of
///   stdout and stderr.
/// - `Pty` (docker `run -t`): one PTY master, handed over by libcontainer on
///   the console socket. stdin and stdout are the *same* fd and the kernel
///   merges stderr into it, so there is exactly one reader — a second reader
///   on the master would race the first for bytes.
///
/// # Lifecycle
///
/// 1. Create the pipes (or console socket) before container start
/// 2. Init gets the child ends via `InitStdioFds` (or the PTY replica)
/// 3. The guest holds the parent ends here
/// 4. Init blocks on read(stdin) indefinitely — nothing closes it
/// 5. On container stop, dropping this closes them → init sees EOF
#[derive(Debug)]
pub enum ContainerStdio {
    Pipes {
        /// Write-end of stdin (held open, never written to). Moved out by
        /// `take_init_io` when init is exposed as an exec session — the
        /// session then owns keeping stdin open, and closing its stream
        /// delivers real EOF to init (docker `run -i` semantics).
        stdin_tx: Option<OwnedFd>,
        /// Read-end of the stdout relay handed to the attach session.
        stdout_rx: Option<OwnedFd>,
        /// Read-end of the stderr relay handed to the attach session.
        stderr_rx: Option<OwnedFd>,
        /// One task that owns and drains the original stdout/stderr pipes.
        output_task: Option<JoinHandle<()>>,
        /// Bounded stdout/stderr tails used for startup diagnostics.
        diagnostics: Arc<Mutex<DiagnosticTails>>,
    },
    Pty {
        /// PTY master received from libcontainer over the console socket.
        master: Option<OwnedFd>,
    },
}

/// The init process's stdio, handed to the exec session that represents the
/// box's main command.
#[derive(Debug)]
pub enum InitIo {
    Pipes {
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: OwnedFd,
    },
    /// The session builds stdin/stdout by duplicating the master and keeps it
    /// for window-size ioctls, so `ResizeTty` works on the main command too.
    Pty { master: OwnedFd },
}

/// File descriptors to pass to container init process.
///
/// These are the "child side" of the pipes:
/// - stdin: read-end (init reads from this, blocks when empty)
/// - stdout: write-end (init writes here)
/// - stderr: write-end (init writes here)
///
/// Pass these to libcontainer's `ContainerBuilder::with_stdin/stdout/stderr`.
#[derive(Debug)]
pub struct InitStdioFds {
    /// Read-end of stdin pipe (init reads from this)
    pub stdin: OwnedFd,

    /// Write-end of stdout pipe (init writes here)
    pub stdout: OwnedFd,

    /// Write-end of stderr pipe (init writes here)
    pub stderr: OwnedFd,
}

impl ContainerStdio {
    /// Adopt a PTY master as init's stdio (`run -t`).
    ///
    /// The master arrives from libcontainer over the console socket *after*
    /// the container is built, which is why this is separate from `pipes()`:
    /// pipes exist before the container does, a PTY only after.
    pub fn pty(master: OwnedFd) -> Self {
        tracing::debug!("Adopted container PTY master");
        Self::Pty {
            master: Some(master),
        }
    }

    /// Create new stdio pipes for container init.
    ///
    /// Returns `(ContainerStdio, InitStdioFds)` where:
    /// - `ContainerStdio`: held by boxlite-guest to keep init alive
    /// - `InitStdioFds`: passed to libcontainer for init process
    ///
    /// # Errors
    ///
    /// Returns error if pipe creation fails.
    pub fn pipes() -> BoxliteResult<(Self, InitStdioFds)> {
        // Create stdin pipe: init reads from rx, we hold tx open
        let (stdin_rx, stdin_tx) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stdin pipe: {}", e)))?;

        // Create stdout pipe: init writes to tx, we can read from rx
        let (stdout_rx, stdout_tx) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stdout pipe: {}", e)))?;

        // Create stderr pipe: init writes to tx, we can read from rx
        let (stderr_rx, stderr_tx) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stderr pipe: {}", e)))?;

        let diagnostics = Arc::new(Mutex::new(DiagnosticTails::default()));
        let container_stdio = Self::Pipes {
            stdin_tx: Some(stdin_tx),
            stdout_rx: Some(stdout_rx),
            stderr_rx: Some(stderr_rx),
            output_task: None,
            diagnostics,
        };

        let init_fds = InitStdioFds {
            stdin: stdin_rx,
            stdout: stdout_tx,
            stderr: stderr_tx,
        };

        tracing::debug!("Created container stdio pipes");

        Ok((container_stdio, init_fds))
    }

    /// Start the single owner of init stdout/stderr. It always drains both
    /// pipes, keeps bounded diagnostic tails, and relays raw bytes to attach.
    /// When `path` is present, it also writes CRI-formatted rotating logs.
    pub fn start_output_pump(&mut self, path: Option<PathBuf>) -> BoxliteResult<()> {
        let Self::Pipes {
            stdout_rx,
            stderr_rx,
            output_task,
            diagnostics,
            ..
        } = self
        else {
            return Err(BoxliteError::InvalidArgument(
                "the pipe output pump is not used with TTY mode".to_string(),
            ));
        };

        let writer = path
            .map(|path| {
                let log = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .map_err(|e| {
                        BoxliteError::Storage(format!(
                            "Failed to open container log {}: {}",
                            path.display(),
                            e
                        ))
                    })?;
                Ok::<_, BoxliteError>(CaptureWriter::new(log, path))
            })
            .transpose()?;

        let stdout = stdout_rx
            .take()
            .map(Receiver::from_owned_fd)
            .transpose()?
            .ok_or_else(|| BoxliteError::Internal("stdout pipe is unavailable".to_string()))?;
        let stderr = stderr_rx
            .take()
            .map(Receiver::from_owned_fd)
            .transpose()?
            .ok_or_else(|| BoxliteError::Internal("stderr pipe is unavailable".to_string()))?;

        let (stdout_relay_rx, stdout_relay_tx) = pipe().map_err(|e| {
            BoxliteError::Internal(format!("Failed to create stdout relay pipe: {}", e))
        })?;
        let (stderr_relay_rx, stderr_relay_tx) = pipe().map_err(|e| {
            BoxliteError::Internal(format!("Failed to create stderr relay pipe: {}", e))
        })?;
        set_nonblocking(&stdout_relay_tx)?;
        set_nonblocking(&stderr_relay_tx)?;
        *stdout_rx = Some(stdout_relay_rx);
        *stderr_rx = Some(stderr_relay_rx);

        let diagnostics = Arc::clone(diagnostics);
        tracing::debug!(capture = writer.is_some(), "Starting container init output pump");
        *output_task = Some(tokio::spawn(async move {
            let mut writer = writer;
            let mut stdout_cri = CriStream::new("stdout");
            let mut stderr_cri = CriStream::new("stderr");
            let mut stdout = stdout;
            let mut stderr = stderr;
            let mut stdout_open = true;
            let mut stderr_open = true;
            let mut stdout_relay = Some(stdout_relay_tx);
            let mut stderr_relay = Some(stderr_relay_tx);
            let mut stdout_buf = [0u8; 4096];
            let mut stderr_buf = [0u8; 4096];

            while stdout_open || stderr_open {
                tokio::select! {
                    result = stdout.read(&mut stdout_buf), if stdout_open => {
                        match result {
                            Ok(0) => {
                                stdout_open = false;
                                if let Some(writer) = writer.as_mut() {
                                    stdout_cri.finish(writer).await;
                                }
                            }
                            Ok(n) => {
                                let chunk = &stdout_buf[..n];
                                diagnostics.lock().expect("diagnostic tails poisoned").stdout.push(chunk);
                                relay(&mut stdout_relay, chunk);
                                if let Some(writer) = writer.as_mut() {
                                    stdout_cri.push(writer, chunk).await;
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, "Failed to read container init stdout");
                                stdout_open = false;
                                if let Some(writer) = writer.as_mut() {
                                    stdout_cri.finish(writer).await;
                                }
                            }
                        }
                    }
                    result = stderr.read(&mut stderr_buf), if stderr_open => {
                        match result {
                            Ok(0) => {
                                stderr_open = false;
                                if let Some(writer) = writer.as_mut() {
                                    stderr_cri.finish(writer).await;
                                }
                            }
                            Ok(n) => {
                                let chunk = &stderr_buf[..n];
                                diagnostics.lock().expect("diagnostic tails poisoned").stderr.push(chunk);
                                relay(&mut stderr_relay, chunk);
                                if let Some(writer) = writer.as_mut() {
                                    stderr_cri.push(writer, chunk).await;
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, "Failed to read container init stderr");
                                stderr_open = false;
                                if let Some(writer) = writer.as_mut() {
                                    stderr_cri.finish(writer).await;
                                }
                            }
                        }
                    }
                }
            }

            if let Some(writer) = writer.as_mut() {
                writer.flush().await;
            }
            tracing::debug!("Container init output pump finished");
        }));
        Ok(())
    }

    /// Wait for the output task to drain both pipes and flush any capture log.
    pub async fn finish_output(&mut self, timeout: Duration) {
        let Self::Pipes { output_task, .. } = self else {
            return;
        };
        let Some(mut task) = output_task.take() else {
            return;
        };

        if tokio::time::timeout(timeout, &mut task).await.is_err() {
            tracing::warn!(?timeout, "Timed out draining container init output");
            task.abort();
            let _ = task.await;
        }
    }
    /// Return and clear the bounded diagnostic tail for each init stream.
    /// On a PTY, stderr is always empty because the terminal merged it into stdout.
    pub fn drain_output(&mut self) -> (String, String) {
        match self {
            Self::Pipes { diagnostics, .. } => diagnostics
                .lock()
                .expect("diagnostic tails poisoned")
                .take(),
            Self::Pty { master } => (drain_fd(master.take()), String::new()),
        }
    }

    /// Take init's stdio, to hand to the exec session that represents the
    /// box's main command. Returns `None` if it was already taken.
    ///
    /// The fds MOVE out — the session becomes the sole holder of init's stdin
    /// write-end. Ownership matters: a session that is never attached keeps
    /// stdin open indefinitely (interactive image defaults like `python` stay
    /// alive, the boot-and-exec model), while an attached client that closes
    /// its stdin stream drops the last write-end and init sees real EOF
    /// (docker `run -i` piped semantics). A duplicate held here would make EOF
    /// impossible.
    /// The output fds are relay read-ends. The output pump remains the sole
    /// reader of init's original pipes and independently keeps diagnostic tails.
    pub fn take_init_io(&mut self) -> BoxliteResult<Option<InitIo>> {
        match self {
            Self::Pipes {
                stdin_tx,
                stdout_rx,
                stderr_rx,
                ..
            } => {
                let (Some(stdin), Some(stdout), Some(stderr)) =
                    (stdin_tx.take(), stdout_rx.take(), stderr_rx.take())
                else {
                    return Ok(None);
                };
                Ok(Some(InitIo::Pipes {
                    stdin,
                    stdout,
                    stderr,
                }))
            }
            Self::Pty { master } => Ok(master.take().map(|master| InitIo::Pty { master })),
        }
    }
}

impl Drop for ContainerStdio {
    fn drop(&mut self) {
        if let Self::Pipes {
            output_task: Some(task),
            ..
        } = self
        {
            task.abort();
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct DiagnosticTails {
    stdout: ByteTail,
    stderr: ByteTail,
}

impl DiagnosticTails {
    fn take(&mut self) -> (String, String) {
        (self.stdout.take_string(), self.stderr.take_string())
    }
}

#[derive(Debug, Default)]
struct ByteTail {
    bytes: VecDeque<u8>,
}

impl ByteTail {
    fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= DIAGNOSTIC_TAIL_SIZE {
            self.bytes.clear();
            self.bytes
                .extend(&chunk[chunk.len() - DIAGNOSTIC_TAIL_SIZE..]);
            return;
        }

        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(DIAGNOSTIC_TAIL_SIZE);
        self.bytes.drain(..overflow);
        self.bytes.extend(chunk);
    }

    fn take_string(&mut self) -> String {
        let bytes: Vec<u8> = self.bytes.drain(..).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

struct CriStream {
    name: &'static str,
    pending: Vec<u8>,
}

impl CriStream {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            pending: Vec::new(),
        }
    }

    async fn push(&mut self, writer: &mut CaptureWriter, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);

        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=newline).collect();
            line.pop();
            self.write_complete_line(writer, &line).await;
        }

        while self.pending.len() > CRI_MAX_CONTENT_SIZE {
            let partial: Vec<u8> = self.pending.drain(..CRI_MAX_CONTENT_SIZE).collect();
            writer.write_cri(self.name, 'P', &partial).await;
        }
    }

    async fn finish(&mut self, writer: &mut CaptureWriter) {
        if !self.pending.is_empty() {
            let final_fragment = std::mem::take(&mut self.pending);
            self.write_complete_line(writer, &final_fragment).await;
        }
    }

    async fn write_complete_line(&self, writer: &mut CaptureWriter, line: &[u8]) {
        if line.is_empty() {
            writer.write_cri(self.name, 'F', line).await;
            return;
        }

        let mut chunks = line.chunks(CRI_MAX_CONTENT_SIZE).peekable();
        while let Some(chunk) = chunks.next() {
            let tag = if chunks.peek().is_some() { 'P' } else { 'F' };
            writer.write_cri(self.name, tag, chunk).await;
        }
    }
}

fn relay(fd: &mut Option<OwnedFd>, chunk: &[u8]) {
    let Some(relay) = fd.as_ref() else {
        return;
    };

    match nix::unistd::write(relay, chunk) {
        Ok(_) | Err(nix::errno::Errno::EAGAIN) => {}
        Err(nix::errno::Errno::EPIPE) => *fd = None,
        Err(error) => {
            tracing::warn!(%error, "Failed to relay container init output");
            *fd = None;
        }
    }
}

fn set_nonblocking(fd: &OwnedFd) -> BoxliteResult<()> {
    let flags = nix::fcntl::fcntl(fd.as_raw_fd(), nix::fcntl::FcntlArg::F_GETFL)
        .map_err(|e| BoxliteError::Internal(format!("Failed to read relay pipe flags: {}", e)))?;
    let mut flags = nix::fcntl::OFlag::from_bits_truncate(flags);
    flags.insert(nix::fcntl::OFlag::O_NONBLOCK);
    nix::fcntl::fcntl(fd.as_raw_fd(), nix::fcntl::FcntlArg::F_SETFL(flags))
        .map_err(|e| BoxliteError::Internal(format!("Failed to update relay pipe flags: {}", e)))?;
    Ok(())
}

struct CaptureWriter {
    file: tokio::fs::File,
    path: PathBuf,
    current_size: u64,
    max_size: u64,
    max_files: usize,
    failed: bool,
}

impl CaptureWriter {
    fn new(file: std::fs::File, path: PathBuf) -> Self {
        let current_size = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        Self {
            file: tokio::fs::File::from_std(file),
            path,
            current_size,
            max_size: LOG_MAX_SIZE,
            max_files: LOG_MAX_FILES,
            failed: false,
        }
    }

    async fn write_cri(&mut self, stream: &'static str, tag: char, content: &[u8]) {
        if self.failed {
            return;
        }

        let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let content = String::from_utf8_lossy(content);
        let record = format!("{timestamp} {stream} {tag} {content}\n");
        let record = record.as_bytes();

        if self.current_size > 0 && self.current_size + record.len() as u64 > self.max_size {
            if let Err(error) = self.rotate().await {
                tracing::warn!(
                    path = %self.path.display(),
                    %error,
                    "Failed to rotate container init log; continuing with current file"
                );
            }
        }

        if let Err(error) = self.file.write_all(record).await {
            self.failed = true;
            tracing::warn!(
                stream,
                path = %self.path.display(),
                %error,
                "Container init log write failed; continuing to drain output"
            );
        } else {
            self.current_size += record.len() as u64;
        }
    }

    async fn rotate(&mut self) -> std::io::Result<()> {
        self.file.flush().await?;

        let mut replacement_path = self.path.as_os_str().to_os_string();
        replacement_path.push(".tmp");
        let replacement_path = PathBuf::from(replacement_path);
        let replacement = tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&replacement_path)
            .await?;

        let archive_count = self.max_files - 1;
        let oldest = self.archive_path(archive_count);
        if tokio::fs::try_exists(&oldest).await? {
            tokio::fs::remove_file(oldest).await?;
        }

        for index in (1..archive_count).rev() {
            let source = self.archive_path(index);
            if tokio::fs::try_exists(&source).await? {
                tokio::fs::rename(source, self.archive_path(index + 1)).await?;
            }
        }

        let newest = self.archive_path(1);
        tokio::fs::rename(&self.path, &newest).await?;
        if let Err(error) = tokio::fs::rename(&replacement_path, &self.path).await {
            tokio::fs::rename(newest, &self.path).await?;
            return Err(error);
        }

        self.file = replacement;
        self.current_size = 0;
        Ok(())
    }

    fn archive_path(&self, index: usize) -> PathBuf {
        let mut path = self.path.as_os_str().to_os_string();
        path.push(format!(".{index}"));
        path.into()
    }

    async fn flush(&mut self) {
        if !self.failed {
            let _ = self.file.flush().await;
        }
    }
}

/// Read all available data from an fd using non-blocking I/O.
fn drain_fd(fd: Option<OwnedFd>) -> String {
    const MAX_CAPTURE: usize = 4096;

    let Some(fd) = fd else {
        return String::new();
    };

    // Set non-blocking so read returns immediately when no more data
    let raw_fd = fd.as_raw_fd();
    let flags = nix::fcntl::fcntl(raw_fd, nix::fcntl::FcntlArg::F_GETFL);
    if let Ok(flags) = flags {
        let mut new_flags = nix::fcntl::OFlag::from_bits_truncate(flags);
        new_flags.insert(nix::fcntl::OFlag::O_NONBLOCK);
        let _ = nix::fcntl::fcntl(raw_fd, nix::fcntl::FcntlArg::F_SETFL(new_flags));
    }

    let mut file = std::fs::File::from(fd);
    let mut buf = vec![0u8; MAX_CAPTURE];
    let mut total = 0;

    // Read in a loop to drain the pipe buffer
    loop {
        match file.read(&mut buf[total..]) {
            Ok(0) => break, // EOF
            Ok(n) => {
                total += n;
                if total >= MAX_CAPTURE {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }

    buf.truncate(total);
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::io::AsRawFd;

    fn capture_writer(path: &std::path::Path, max_size: u64, max_files: usize) -> CaptureWriter {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        let current_size = file.metadata().unwrap().len();
        CaptureWriter {
            file: tokio::fs::File::from_std(file),
            path: path.to_path_buf(),
            current_size,
            max_size,
            max_files,
            failed: false,
        }
    }

    fn parse_cri_record(line: &str) -> (String, String, &str, String) {
        let mut fields = line.splitn(4, ' ');
        let timestamp = fields.next().expect("timestamp").to_string();
        let stream = fields.next().expect("stream").to_string();
        let tag = fields.next().expect("tag");
        let message = fields.next().unwrap_or_default().to_string();
        chrono::DateTime::parse_from_rfc3339(&timestamp).expect("RFC3339 timestamp");
        (timestamp, stream, tag, message)
    }

    /// Borrow the parent-side pipe fds. Panics on a `Pty`, which these tests
    /// never build.
    fn pipe_fds(stdio: &ContainerStdio) -> [i32; 3] {
        let ContainerStdio::Pipes {
            stdin_tx,
            stdout_rx,
            stderr_rx,
            ..
        } = stdio
        else {
            panic!("expected pipes");
        };
        [
            stdin_tx.as_ref().unwrap().as_raw_fd(),
            stdout_rx.as_ref().unwrap().as_raw_fd(),
            stderr_rx.as_ref().unwrap().as_raw_fd(),
        ]
    }

    #[test]
    fn test_stdio_creation() {
        let result = ContainerStdio::pipes();
        assert!(result.is_ok());

        let (stdio, init_fds) = result.unwrap();
        let parent = pipe_fds(&stdio);

        // Verify all FDs are valid (positive integers)
        assert!(parent.iter().all(|fd| *fd >= 0));
        assert!(init_fds.stdin.as_raw_fd() >= 0);
        assert!(init_fds.stdout.as_raw_fd() >= 0);
        assert!(init_fds.stderr.as_raw_fd() >= 0);

        // Verify all FDs are unique
        let fds = [
            parent[0],
            parent[1],
            parent[2],
            init_fds.stdin.as_raw_fd(),
            init_fds.stdout.as_raw_fd(),
            init_fds.stderr.as_raw_fd(),
        ];
        for i in 0..fds.len() {
            for j in (i + 1)..fds.len() {
                assert_ne!(fds[i], fds[j], "FDs should be unique");
            }
        }
    }

    /// `run -t`: the PTY master is init's stdin, stdout AND stderr, so the
    /// session must receive it as one fd with stderr merged — two readers on a
    /// master race each other for bytes.
    #[test]
    fn pty_stdio_yields_a_single_master_and_no_separate_stderr() {
        let (_read, write) = nix::unistd::pipe().unwrap();
        let master_fd = write.as_raw_fd();

        let mut stdio = ContainerStdio::pty(write);

        let io = stdio.take_init_io().unwrap().expect("first take yields io");
        match io {
            InitIo::Pty { master } => assert_eq!(master.as_raw_fd(), master_fd),
            InitIo::Pipes { .. } => panic!("a PTY container must not hand out pipes"),
        }

        // Taken once: the session is the sole owner of init's terminal.
        assert!(stdio.take_init_io().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_output_pump_keeps_and_clears_diagnostic_tails() {
        let (mut stdio, init_fds) = ContainerStdio::pipes().unwrap();
        stdio.start_output_pump(None).unwrap();
        let _relay = stdio.take_init_io().unwrap().unwrap();

        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        let mut stderr_writer = std::fs::File::from(init_fds.stderr);
        stdout_writer.write_all(b"hello stdout").unwrap();
        stderr_writer.write_all(b"hello stderr").unwrap();
        drop(stdout_writer);
        drop(stderr_writer);
        stdio.finish_output(Duration::from_secs(1)).await;

        let (stdout, stderr) = stdio.drain_output();
        assert_eq!(stdout, "hello stdout");
        assert_eq!(stderr, "hello stderr");
        assert_eq!(stdio.drain_output(), (String::new(), String::new()));
    }

    #[tokio::test]
    async fn test_output_pump_retains_only_the_diagnostic_tail() {
        let (mut stdio, init_fds) = ContainerStdio::pipes().unwrap();
        stdio.start_output_pump(None).unwrap();
        let _relay = stdio.take_init_io().unwrap().unwrap();
        let payload = vec![b'x'; DIAGNOSTIC_TAIL_SIZE + 1024];
        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        drop(init_fds.stderr);
        stdout_writer.write_all(&payload).unwrap();
        drop(stdout_writer);
        stdio.finish_output(Duration::from_secs(1)).await;

        let (stdout, stderr) = stdio.drain_output();
        assert_eq!(stdout.len(), DIAGNOSTIC_TAIL_SIZE);
        assert!(stdout.bytes().all(|byte| byte == b'x'));
        assert!(stderr.is_empty());
    }

    #[tokio::test]
    async fn test_capture_off_does_not_block_when_relay_is_unread() {
        let (mut stdio, init_fds) = ContainerStdio::pipes().unwrap();
        let payload = vec![b'x'; 256 * 1024];

        stdio.start_output_pump(None).unwrap();
        let _unread_relay = stdio.take_init_io().unwrap().unwrap();
        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        drop(init_fds.stderr);
        let write_task = tokio::task::spawn_blocking(move || {
            stdout_writer.write_all(&payload).unwrap();
        });

        tokio::time::timeout(Duration::from_secs(2), write_task)
            .await
            .expect("output pump blocked behind an unread relay")
            .unwrap();
        stdio.finish_output(Duration::from_secs(1)).await;

        let (stdout, _) = stdio.drain_output();
        assert_eq!(stdout.len(), DIAGNOSTIC_TAIL_SIZE);
    }

    #[tokio::test]
    async fn test_capture_on_does_not_block_when_relay_is_unread() {
        let (mut stdio, init_fds) = ContainerStdio::pipes().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        let payload = vec![b'y'; 256 * 1024];
        let expected = payload.len();

        stdio.start_output_pump(Some(log_path.clone())).unwrap();
        let _unread_relay = stdio.take_init_io().unwrap().unwrap();
        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        drop(init_fds.stderr);
        let write_task = tokio::task::spawn_blocking(move || {
            stdout_writer.write_all(&payload).unwrap();
        });

        tokio::time::timeout(Duration::from_secs(2), write_task)
            .await
            .expect("capture blocked behind an unread relay")
            .unwrap();
        stdio.finish_output(Duration::from_secs(1)).await;

        let content = std::fs::read_to_string(log_path).unwrap();
        let records: Vec<_> = content.lines().map(parse_cri_record).collect();
        assert!(records.iter().all(|record| record.1 == "stdout"));
        assert_eq!(
            records.iter().map(|record| record.3.len()).sum::<usize>(),
            expected
        );
    }

    #[tokio::test]
    async fn test_output_pump_writes_cri_log_and_relays_raw_output() {
        let (mut stdio, init_fds) = ContainerStdio::pipes().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");

        stdio.start_output_pump(Some(log_path.clone())).unwrap();
        let InitIo::Pipes { stdout, stderr, .. } = stdio.take_init_io().unwrap().unwrap() else {
            panic!("expected relay pipes");
        };

        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        let mut stderr_writer = std::fs::File::from(init_fds.stderr);
        stdout_writer.write_all(b"hello stdout\n").unwrap();
        stderr_writer.write_all(b"hello stderr\n").unwrap();
        drop(stdout_writer);
        drop(stderr_writer);
        stdio.finish_output(Duration::from_secs(1)).await;

        let content = std::fs::read_to_string(&log_path).unwrap();
        let records: Vec<_> = content.lines().map(parse_cri_record).collect();
        assert!(records.iter().any(|(_, stream, tag, message)| {
            stream == "stdout" && *tag == "F" && message == "hello stdout"
        }));
        assert!(records.iter().any(|(_, stream, tag, message)| {
            stream == "stderr" && *tag == "F" && message == "hello stderr"
        }));
        assert_eq!(drain_fd(Some(stdout)), "hello stdout\n");
        assert_eq!(drain_fd(Some(stderr)), "hello stderr\n");
    }

    #[tokio::test]
    async fn test_cri_stream_frames_partial_lines_and_eof() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        let mut writer = capture_writer(&log_path, u64::MAX, 3);
        let mut stream = CriStream::new("stdout");

        stream.push(&mut writer, b"first").await;
        stream.push(&mut writer, b" line\nsecond").await;
        stream.finish(&mut writer).await;
        writer.flush().await;

        let content = std::fs::read_to_string(log_path).unwrap();
        let records: Vec<_> = content.lines().map(parse_cri_record).collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].1, "stdout");
        assert_eq!(records[0].2, "F");
        assert_eq!(records[0].3, "first line");
        assert_eq!(records[1].1, "stdout");
        assert_eq!(records[1].2, "F");
        assert_eq!(records[1].3, "second");
    }

    #[tokio::test]
    async fn test_cri_stream_emits_empty_lines_and_lossy_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        let mut writer = capture_writer(&log_path, u64::MAX, 3);
        let mut stream = CriStream::new("stdout");

        stream.push(&mut writer, b"\ninvalid: \xff\n").await;
        writer.flush().await;

        let content = std::fs::read_to_string(log_path).unwrap();
        let records: Vec<_> = content.lines().map(parse_cri_record).collect();
        assert_eq!(records.len(), 2);
        assert!(records[0].3.is_empty());
        assert_eq!(records[1].3, "invalid: \u{fffd}");
    }

    #[tokio::test]
    async fn test_cri_streams_do_not_splice_partial_lines_together() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        let mut writer = capture_writer(&log_path, u64::MAX, 3);
        let mut stdout = CriStream::new("stdout");
        let mut stderr = CriStream::new("stderr");

        stdout.push(&mut writer, b"stdout partial").await;
        stderr.push(&mut writer, b"stderr complete\n").await;
        stdout.push(&mut writer, b" completed\n").await;
        writer.flush().await;

        let content = std::fs::read_to_string(log_path).unwrap();
        let records: Vec<_> = content.lines().map(parse_cri_record).collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].1, "stderr");
        assert_eq!(records[0].3, "stderr complete");
        assert_eq!(records[1].1, "stdout");
        assert_eq!(records[1].3, "stdout partial completed");
    }

    #[tokio::test]
    async fn test_cri_stream_splits_long_lines_with_partial_tags() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        let mut writer = capture_writer(&log_path, u64::MAX, 3);
        let mut stream = CriStream::new("stderr");
        let line = vec![b'z'; CRI_MAX_CONTENT_SIZE * 2 + 7];

        stream.push(&mut writer, &line).await;
        stream.push(&mut writer, b"\n").await;
        writer.flush().await;

        let content = std::fs::read_to_string(log_path).unwrap();
        let records: Vec<_> = content.lines().map(parse_cri_record).collect();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].2, "P");
        assert_eq!(records[1].2, "P");
        assert_eq!(records[2].2, "F");
        assert_eq!(
            records.iter().map(|record| record.3.len()).sum::<usize>(),
            line.len()
        );
        assert!(records.iter().all(|record| record.1 == "stderr"));
    }

    #[tokio::test]
    async fn test_capture_writer_rotates_by_size_and_prunes_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        let mut writer = capture_writer(&log_path, 5, 3);

        writer.write_cri("stdout", 'F', b"first").await;
        writer.write_cri("stdout", 'F', b"second").await;
        writer.write_cri("stdout", 'F', b"third").await;
        writer.flush().await;

        let active = std::fs::read_to_string(&log_path).unwrap();
        let archive1 = std::fs::read_to_string(log_path.with_extension("log.1")).unwrap();
        let archive2 = std::fs::read_to_string(log_path.with_extension("log.2")).unwrap();
        assert!(active.contains("third"));
        assert!(archive1.contains("second"));
        assert!(archive2.contains("first"));
        assert_eq!(active.lines().count(), 1);
        assert_eq!(archive1.lines().count(), 1);
        assert_eq!(archive2.lines().count(), 1);
        let mut replacement_path = log_path.as_os_str().to_os_string();
        replacement_path.push(".tmp");
        assert!(!PathBuf::from(replacement_path).exists());
    }

    #[tokio::test]
    async fn test_capture_writer_resumes_size_from_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        std::fs::write(&log_path, b"1234").unwrap();
        let mut writer = capture_writer(&log_path, 5, 3);

        writer.write_cri("stdout", 'F', b"XY").await;
        writer.flush().await;

        let active = std::fs::read_to_string(&log_path).unwrap();
        assert!(active.contains("XY"));
        assert_eq!(
            std::fs::read(log_path.with_extension("log.1")).unwrap(),
            b"1234"
        );
    }

    #[tokio::test]
    async fn test_capture_writer_keeps_active_log_when_replacement_creation_fails() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("console.log");
        std::fs::write(&log_path, b"12345").unwrap();
        let mut replacement_path = log_path.as_os_str().to_os_string();
        replacement_path.push(".tmp");
        std::fs::create_dir(PathBuf::from(replacement_path)).unwrap();
        let mut writer = capture_writer(&log_path, 5, 3);

        writer.write_cri("stderr", 'F', b"X").await;
        writer.flush().await;

        let active = std::fs::read_to_string(&log_path).unwrap();
        assert!(active.starts_with("12345"));
        assert!(active.contains(" stderr F X\n"));
        assert!(!log_path.with_extension("log.1").exists());
        assert!(!writer.failed);
    }
}
