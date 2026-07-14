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
//! let (stdio, init_fds) = ContainerStdio::new()?;
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
use std::io::Read;
use std::os::unix::io::OwnedFd;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

const MAX_CAPTURE: usize = 4096;
const DRAIN_BUFFER_SIZE: usize = 8192;

/// Stdio configuration for container init process.
///
/// Holds pipe file descriptors:
/// - stdin_tx: write-end held open (blocks init's read forever)
/// - stdout/stderr tails: bounded diagnostic output retained by background drains
///
/// # Lifecycle
///
/// 1. Create pipes before container start
/// 2. Pass read-end of stdin to container init via `InitStdioFds`
/// 3. Hold write-end in ContainerStdio (never write, never close)
/// 4. Init process blocks on read(stdin) indefinitely
/// 5. On container stop, drop ContainerStdio → pipes close → init gets EOF
#[derive(Debug)]
pub struct ContainerStdio {
    /// Write-end of stdin pipe (held open, never written to)
    #[allow(dead_code)]
    stdin_tx: OwnedFd,

    stdout_tail: Arc<Mutex<Vec<u8>>>,

    stderr_tail: Arc<Mutex<Vec<u8>>>,
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

pub(crate) struct InitOutputCompletion {
    stdout: oneshot::Receiver<Result<(), String>>,
    stderr: oneshot::Receiver<Result<(), String>>,
}

impl InitOutputCompletion {
    pub(crate) async fn wait(self) -> Result<(), String> {
        let (stdout, stderr) = tokio::join!(self.stdout, self.stderr);
        stdout
            .map_err(|_| "init stdout drain stopped before reporting completion".to_string())??;
        stderr
            .map_err(|_| "init stderr drain stopped before reporting completion".to_string())??;
        Ok(())
    }
}

impl ContainerStdio {
    /// Create new stdio pipes for container init.
    ///
    /// Returns `(ContainerStdio, InitStdioFds, InitOutputCompletion)` where:
    /// - `ContainerStdio`: held by boxlite-guest to keep init alive
    /// - `InitStdioFds`: passed to libcontainer for init process
    /// - `InitOutputCompletion`: resolves when stdout and stderr reach EOF
    ///
    /// # Errors
    ///
    /// Returns error if pipe creation fails.
    pub fn new() -> BoxliteResult<(Self, InitStdioFds, InitOutputCompletion)> {
        // Create stdin pipe: init reads from rx, we hold tx open
        let (stdin_rx, stdin_tx) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stdin pipe: {}", e)))?;

        // Create stdout pipe: init writes to tx, we can read from rx
        let (stdout_rx, stdout_tx) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stdout pipe: {}", e)))?;

        // Create stderr pipe: init writes to tx, we can read from rx
        let (stderr_rx, stderr_tx) = pipe()
            .map_err(|e| BoxliteError::Internal(format!("Failed to create stderr pipe: {}", e)))?;

        let stdout_tail = Arc::new(Mutex::new(Vec::with_capacity(MAX_CAPTURE)));
        let stderr_tail = Arc::new(Mutex::new(Vec::with_capacity(MAX_CAPTURE)));

        let stdout_complete =
            spawn_output_drain("boxlite-init-stdout", stdout_rx, stdout_tail.clone())?;
        let stderr_complete =
            spawn_output_drain("boxlite-init-stderr", stderr_rx, stderr_tail.clone())?;

        let container_stdio = Self {
            stdin_tx,
            stdout_tail,
            stderr_tail,
        };

        let init_fds = InitStdioFds {
            stdin: stdin_rx,
            stdout: stdout_tx,
            stderr: stderr_tx,
        };

        tracing::debug!("Created container stdio pipes");

        Ok((
            container_stdio,
            init_fds,
            InitOutputCompletion {
                stdout: stdout_complete,
                stderr: stderr_complete,
            },
        ))
    }

    /// Return the bounded output tail retained by the background drains.
    ///
    /// # Returns
    ///
    /// `(stdout, stderr)` — captured output, truncated to 4 KiB each.
    pub fn drain_output(&self) -> (String, String) {
        (
            output_tail(&self.stdout_tail),
            output_tail(&self.stderr_tail),
        )
    }
}

fn spawn_output_drain(
    name: &str,
    fd: OwnedFd,
    tail: Arc<Mutex<Vec<u8>>>,
) -> BoxliteResult<oneshot::Receiver<Result<(), String>>> {
    let (complete_tx, complete_rx) = oneshot::channel();
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let _ = complete_tx.send(drain_fd(fd, tail));
        })
        .map(|_| complete_rx)
        .map_err(|error| {
            BoxliteError::Internal(format!("Failed to start init output drain: {error}"))
        })
}

fn drain_fd(fd: OwnedFd, tail: Arc<Mutex<Vec<u8>>>) -> Result<(), String> {
    let mut file = std::fs::File::from(fd);
    let mut buffer = [0; DRAIN_BUFFER_SIZE];

    loop {
        match file.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(bytes_read) => {
                let mut captured = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                append_tail(&mut captured, &buffer[..bytes_read]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                tracing::warn!(%error, "Init output drain stopped");
                return Err(error.to_string());
            }
        }
    }
}

fn append_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() >= MAX_CAPTURE {
        tail.clear();
        tail.extend_from_slice(&bytes[bytes.len() - MAX_CAPTURE..]);
        return;
    }

    let overflow = tail
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(MAX_CAPTURE);
    if overflow > 0 {
        tail.drain(..overflow);
    }
    tail.extend_from_slice(bytes);
}

fn output_tail(tail: &Mutex<Vec<u8>>) -> String {
    let captured = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    String::from_utf8_lossy(&captured).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::io::AsRawFd;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn wait_for_output(
        stdio: &ContainerStdio,
        expected_stdout: &str,
        expected_stderr: &str,
    ) -> (String, String) {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let output = stdio.drain_output();
            if output.0 == expected_stdout && output.1 == expected_stderr {
                return output;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for init output"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn test_stdio_creation() {
        let result = ContainerStdio::new();
        assert!(result.is_ok());

        let (stdio, init_fds, _) = result.unwrap();

        assert!(stdio.stdin_tx.as_raw_fd() >= 0);
        assert!(init_fds.stdin.as_raw_fd() >= 0);
        assert!(init_fds.stdout.as_raw_fd() >= 0);
        assert!(init_fds.stderr.as_raw_fd() >= 0);

        let fds = [
            stdio.stdin_tx.as_raw_fd(),
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

    #[test]
    fn test_drain_output_captures_data() {
        let (stdio, init_fds, _) = ContainerStdio::new().unwrap();

        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        let mut stderr_writer = std::fs::File::from(init_fds.stderr);
        stdout_writer.write_all(b"hello stdout").unwrap();
        stderr_writer.write_all(b"hello stderr").unwrap();
        drop(stdout_writer);
        drop(stderr_writer);

        let (stdout, stderr) = wait_for_output(&stdio, "hello stdout", "hello stderr");
        assert_eq!(stdout, "hello stdout");
        assert_eq!(stderr, "hello stderr");
    }

    #[test]
    fn test_drain_output_returns_current_tail() {
        let (stdio, init_fds, _) = ContainerStdio::new().unwrap();

        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        stdout_writer.write_all(b"data").unwrap();
        drop(stdout_writer);
        drop(init_fds.stderr);

        let (stdout, stderr) = wait_for_output(&stdio, "data", "");
        assert_eq!(stdout, "data");
        let (stdout2, stderr2) = stdio.drain_output();
        assert_eq!(stdout2, stdout);
        assert_eq!(stderr2, stderr);
    }

    #[test]
    fn test_drain_output_does_not_wait_for_open_writer() {
        let (stdio, init_fds, _) = ContainerStdio::new().unwrap();
        let stdout_writer = std::fs::File::from(init_fds.stdout);
        drop(init_fds.stderr);

        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        let snapshotter = thread::spawn(move || {
            let _ = snapshot_tx.send(stdio.drain_output());
        });

        let snapshot = snapshot_rx.recv_timeout(Duration::from_secs(1));
        drop(stdout_writer);
        snapshotter.join().unwrap();

        assert!(snapshot.is_ok(), "draining output waited for pipe EOF");
    }

    #[test]
    fn test_drain_output_keeps_large_writers_unblocked() {
        let (stdio, init_fds, _) = ContainerStdio::new().unwrap();
        let mut output = vec![b'x'; 1024 * 1024];
        output.extend_from_slice(b"tail-marker");
        drop(init_fds.stderr);

        let (completed_tx, completed_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            let mut stdout_writer = std::fs::File::from(init_fds.stdout);
            let result = stdout_writer.write_all(&output);
            let _ = completed_tx.send(result);
        });

        let completed = completed_rx.recv_timeout(Duration::from_secs(5));
        if completed.is_err() {
            drop(stdio);
            let _ = writer.join();
            panic!("init stdout writer blocked while the reader was open");
        }
        completed.unwrap().unwrap();
        writer.join().unwrap();

        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let (stdout, _) = stdio.drain_output();
            if stdout.ends_with("tail-marker") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for output tail"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn test_output_completion_waits_for_both_pipes_to_reach_eof() {
        let (_stdio, init_fds, completion) = ContainerStdio::new().unwrap();
        let stdout_writer = std::fs::File::from(init_fds.stdout);
        drop(init_fds.stderr);

        let (result_tx, result_rx) = mpsc::channel();
        thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let _ = result_tx.send(runtime.block_on(completion.wait()));
        });

        assert!(result_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(stdout_writer);
        assert_eq!(
            result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok(())
        );
    }
}
