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
use std::io::Read;
use std::os::unix::io::{AsRawFd, OwnedFd};

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
        /// Read-end of stdout (taken by drain_output for log capture)
        stdout_rx: Option<OwnedFd>,
        /// Read-end of stderr (taken by drain_output for log capture)
        stderr_rx: Option<OwnedFd>,
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

        // nix::unistd::pipe() returns OwnedFd directly
        let container_stdio = Self::Pipes {
            stdin_tx: Some(stdin_tx),
            stdout_rx: Some(stdout_rx),
            stderr_rx: Some(stderr_rx),
        };

        let init_fds = InitStdioFds {
            stdin: stdin_rx,
            stdout: stdout_tx,
            stderr: stderr_tx,
        };

        tracing::debug!("Created container stdio pipes");

        Ok((container_stdio, init_fds))
    }

    /// Drain all available output from the init process.
    ///
    /// Takes ownership of the read-ends and reads with non-blocking I/O.
    /// Can only be called once — subsequent calls return empty strings.
    ///
    /// # Returns
    ///
    /// `(stdout, stderr)` — captured output, truncated to 4 KiB each. On a PTY
    /// stderr is always empty: the terminal merged it into stdout.
    pub fn drain_output(&mut self) -> (String, String) {
        match self {
            Self::Pipes {
                stdout_rx,
                stderr_rx,
                ..
            } => (drain_fd(stdout_rx.take()), drain_fd(stderr_rx.take())),
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
    ///
    /// The read-ends moving out also means a later `drain_output` (init exit
    /// diagnostics) returns empty strings — when init is the user's workload,
    /// its output belongs to the session, not to a 4 KiB diagnostic capture.
    pub fn take_init_io(&mut self) -> BoxliteResult<Option<InitIo>> {
        match self {
            Self::Pipes {
                stdin_tx,
                stdout_rx,
                stderr_rx,
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

    /// Borrow the parent-side pipe fds. Panics on a `Pty`, which these tests
    /// never build.
    fn pipe_fds(stdio: &ContainerStdio) -> [i32; 3] {
        let ContainerStdio::Pipes {
            stdin_tx,
            stdout_rx,
            stderr_rx,
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

    #[test]
    fn test_drain_output_captures_data() {
        let (mut stdio, init_fds) = ContainerStdio::pipes().unwrap();

        // Write to the init side of pipes (simulating init process output)
        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        let mut stderr_writer = std::fs::File::from(init_fds.stderr);
        stdout_writer.write_all(b"hello stdout").unwrap();
        stderr_writer.write_all(b"hello stderr").unwrap();
        drop(stdout_writer);
        drop(stderr_writer);

        let (stdout, stderr) = stdio.drain_output();
        assert_eq!(stdout, "hello stdout");
        assert_eq!(stderr, "hello stderr");
    }

    #[test]
    fn test_drain_output_returns_empty_on_second_call() {
        let (mut stdio, init_fds) = ContainerStdio::pipes().unwrap();

        let mut stdout_writer = std::fs::File::from(init_fds.stdout);
        stdout_writer.write_all(b"data").unwrap();
        drop(stdout_writer);
        drop(init_fds.stderr);

        let (stdout, _) = stdio.drain_output();
        assert_eq!(stdout, "data");

        // Second call returns empty (fds already taken)
        let (stdout2, stderr2) = stdio.drain_output();
        assert_eq!(stdout2, "");
        assert_eq!(stderr2, "");
    }
}
