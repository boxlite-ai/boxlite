use anyhow::Result;
use boxlite::Execution;
use futures::StreamExt;
use nix::sys::signal::Signal;
use nix::sys::termios::{
    InputFlags, LocalFlags, OutputFlags, SetArg, Termios, tcgetattr, tcsetattr,
};
use std::io::{IsTerminal, Read};
use std::os::fd::{AsFd, AsRawFd};
use tokio::io::AsyncWriteExt;
use tokio::select;
use tokio::signal::unix::{SignalKind, signal};

/// RAII guard to restore terminal mode on drop
pub struct RawModeGuard {
    original_termios: Option<Termios>,
    #[allow(dead_code)]
    fd: std::os::fd::RawFd,
}

impl RawModeGuard {
    pub fn new() -> Result<Self> {
        let stdin = std::io::stdin();
        let fd = stdin.as_fd().as_raw_fd();

        if !stdin.is_terminal() {
            return Ok(Self {
                original_termios: None,
                fd,
            });
        }

        let original_termios = tcgetattr(&stdin)?;
        let mut raw = original_termios.clone();

        // Raw mode flags strictly aligned with run.rs to ensure consistent behavior
        raw.input_flags &= !(InputFlags::IGNBRK
            | InputFlags::BRKINT
            | InputFlags::PARMRK
            | InputFlags::ISTRIP
            | InputFlags::INLCR
            | InputFlags::IGNCR
            | InputFlags::ICRNL
            | InputFlags::IXON);
        raw.output_flags &= !OutputFlags::OPOST;
        raw.local_flags &= !(LocalFlags::ECHO
            | LocalFlags::ECHONL
            | LocalFlags::ICANON
            | LocalFlags::ISIG
            | LocalFlags::IEXTEN);

        tcsetattr(&stdin, SetArg::TCSANOW, &raw)?;

        Ok(Self {
            original_termios: Some(original_termios),
            fd,
        })
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        if let Some(termios) = &self.original_termios {
            let stdin = std::io::stdin();
            let _ = tcsetattr(&stdin, SetArg::TCSANOW, termios);
        }
    }
}

pub struct StreamManager<'a> {
    execution: &'a mut Execution,
    interactive: bool,
    tty: bool,
}

impl<'a> StreamManager<'a> {
    pub fn new(execution: &'a mut Execution, interactive: bool, tty: bool) -> Self {
        Self {
            execution,
            interactive,
            tty,
        }
    }

    pub async fn start(self) -> Result<i32> {
        let _raw_guard = if self.tty && self.interactive {
            match RawModeGuard::new() {
                Ok(guard) => Some(guard),
                Err(e) => {
                    eprintln!("Warning: Failed to enable raw mode: {}", e);
                    eprintln!("Continuing in cooked mode. Some features may not work correctly.");
                    None
                }
            }
        } else {
            None
        };

        // stdout
        let stdout_stream = self.execution.stdout();
        let stdout_handle = tokio::spawn(async move {
            if let Some(mut stream) = stdout_stream {
                let mut stdout = tokio::io::stdout();
                while let Some(chunk) = stream.next().await {
                    if let Err(e) = stdout.write_all(chunk.as_bytes()).await {
                        if e.kind() != std::io::ErrorKind::BrokenPipe {
                            tracing::debug!("stdout write error: {}", e);
                        }
                        break;
                    }
                    let _ = stdout.flush().await;
                }
            }
        });

        // stderr
        let stderr_stream = self.execution.stderr();
        let tty_mode = self.tty;
        let stderr_handle = tokio::spawn(async move {
            if let Some(mut stream) = stderr_stream {
                let mut stderr = tokio::io::stderr();
                let mut stdout = tokio::io::stdout();

                while let Some(chunk) = stream.next().await {
                    let res = if tty_mode {
                        stdout.write_all(chunk.as_bytes()).await
                    } else {
                        stderr.write_all(chunk.as_bytes()).await
                    };

                    if let Err(e) = res {
                        if e.kind() != std::io::ErrorKind::BrokenPipe {
                            tracing::debug!("stderr write error: {}", e);
                        }
                        break;
                    }

                    if tty_mode {
                        let _ = stdout.flush().await;
                    } else {
                        let _ = stderr.flush().await;
                    }
                }
            }
        });

        // stdin (if interactive)
        let stdin_handle = if self.interactive {
            self.execution
                .stdin()
                .map(|stdin_tx| tokio::spawn(stream_stdin(stdin_tx)))
        } else {
            None
        };

        let mut sigint = signal(SignalKind::interrupt())?;
        let mut sigterm = signal(SignalKind::terminate())?;
        let mut sighup = signal(SignalKind::hangup())?;
        let mut sigquit = signal(SignalKind::quit())?;

        // SIGWINCH setup (only if TTY)
        let mut sigwinch = if self.tty {
            Some(signal(SignalKind::window_change())?)
        } else {
            None
        };

        // Initial resize
        if self.tty
            && let Some((w, h)) = term_size::dimensions()
        {
            let _ = self.execution.resize_tty(h as u32, w as u32).await;
        }

        let mut io_done = false;
        let mut exit_status: Option<boxlite::ExecResult> = None;

        let io_finished = async {
            let _ = stdout_handle.await;
            let _ = stderr_handle.await;
        };
        tokio::pin!(io_finished);

        let exit_code = loop {
            select! {
                res = self.execution.wait(), if exit_status.is_none() => {
                    match res {
                        Ok(status) => {
                            exit_status = Some(status);
                            if let Some(h) = stdin_handle.as_ref() {
                                h.abort();
                            }
                            if io_done {
                                break exit_status.as_ref().unwrap().exit_code;
                            }
                        }
                        Err(e) => {
                            tracing::error!("Wait error: {}", e);
                            break 1;
                        }
                    }
                }
                _ = &mut io_finished, if !io_done => {
                    io_done = true;
                    if let Some(status) = &exit_status {
                        break status.exit_code;
                    }
                }
                _ = sigint.recv() => {
                    let _ = self.execution.signal(Signal::SIGINT as i32).await;
                }
                _ = sigterm.recv() => {
                    let _ = self.execution.signal(Signal::SIGTERM as i32).await;
                }
                _ = sighup.recv() => {
                    let _ = self.execution.signal(Signal::SIGHUP as i32).await;
                }
                _ = sigquit.recv() => {
                    let _ = self.execution.signal(Signal::SIGQUIT as i32).await;
                }
                Some(_) = async {
                    if let Some(s) = sigwinch.as_mut() {
                        s.recv().await
                    } else {
                        std::future::pending().await
                    }
                } => {
                    if let Some((w, h)) = term_size::dimensions() {
                        let _ = self.execution.resize_tty(h as u32, w as u32).await;
                    }
                }
            }
        };

        // The exec carried a diagnostic (its output stream failed and the exit
        // code was recovered out-of-band, or the container init died): surface
        // it as an error instead of returning a silent, possibly-misleading
        // exit code. Without this the CLI reports success while stdout/stderr
        // were never delivered.
        if let Some(message) = exit_status.as_ref().and_then(|s| s.error_message.clone()) {
            anyhow::bail!("exec did not complete normally: {message}");
        }

        Ok(exit_code)
    }
}

async fn stream_stdin(mut stdin_tx: boxlite::ExecStdin) {
    // The blocking read(2) on stdin lives on a dedicated OS thread, NOT a tokio
    // blocking-pool thread (which is what `tokio::io::stdin()` uses). A parked
    // read(2) cannot be cancelled; tokio joins its blocking pool on runtime
    // shutdown, so reading stdin there would hang process exit until the user
    // pressed ENTER to unblock the read after the remote shell already exited.
    // A plain std::thread is not joined on shutdown, so the process exits
    // promptly while this read is still parked. See tokio::io::stdin() docs.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 8192];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::debug!("stdin read error: {}", e);
                    break;
                }
            }
        }
    });

    while let Some(chunk) = rx.recv().await {
        if let Err(e) = stdin_tx.write(&chunk).await {
            tracing::debug!("failed to forward stdin: {}", e);
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `nix` already re-exports `libc` (nix-0.30/src/lib.rs:107 `pub use libc;`),
    // so the tests reach for raw syscalls through `nix::libc` rather than
    // pulling libc in as a separate dev-dep.
    use nix::libc;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    // fd 0 is process-global. Serialize tests that swap stdin so they don't
    // race with each other in the same test binary. Matches the pattern in
    // `credentials.rs::ENV_LOCK`.
    static STDIN_LOCK: Mutex<()> = Mutex::new(());

    /// RAII guard: restore the original fd 0 on drop so a panic inside the
    /// test does not leave the binary running with a hijacked stdin.
    struct RestoreStdin(libc::c_int);
    impl Drop for RestoreStdin {
        fn drop(&mut self) {
            unsafe {
                libc::dup2(self.0, libc::STDIN_FILENO);
                libc::close(self.0);
            }
        }
    }

    /// Reproducer for the hang fixed in PR #626 — `boxlite exec -ti` used
    /// to hang after the in-box shell exited until the user pressed ENTER.
    ///
    /// Before the fix, `stream_stdin` read via `tokio::io::stdin().read().await`,
    /// which parks the blocking `read(2)` on a tokio blocking-pool thread.
    /// Once the remote shell exits, the select-loop aborts the stdin task
    /// (`StreamManager::start` at line 191), but `JoinHandle::abort` cannot
    /// interrupt a thread already parked in `read(2)`. Runtime shutdown then
    /// blocks on that pool thread — the user-visible "press ENTER to exit".
    ///
    /// This test parks `stream_stdin` on a pipe with no writer activity,
    /// aborts the spawned task, and times `Runtime::shutdown_timeout`.
    /// Pre-fix: shutdown waits the full timeout because the pool thread
    /// cannot be reaped while parked in `read(2)`. Post-fix: the read lives
    /// on a plain `std::thread` that the tokio runtime does not own, so
    /// shutdown returns immediately.
    #[test]
    fn stream_stdin_does_not_block_runtime_shutdown_after_abort() {
        let _serialize = STDIN_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        // Pipe whose write end stays open: every read on fd 0 will park
        // indefinitely (no data, no EOF). The read end is dup2'd onto fd 0.
        let mut fds = [0 as libc::c_int; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0, "pipe");
        let (read_end, write_end) = (fds[0], fds[1]);

        let saved = unsafe { libc::dup(libc::STDIN_FILENO) };
        assert!(saved >= 0, "dup saved stdin");
        let _restore = RestoreStdin(saved);

        let rc = unsafe { libc::dup2(read_end, libc::STDIN_FILENO) };
        assert_eq!(rc, libc::STDIN_FILENO, "dup2 onto fd 0");
        // The pipe description is kept alive by the kernel's reference
        // from fd 0; closing the original read_end here is fine.
        unsafe { libc::close(read_end) };

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("build runtime");

        let (mut exec, _stdout_tx, _stderr_tx, _stdin_rx, _result_tx) =
            boxlite::Execution::stub("stream-stdin-shutdown");
        let stdin_tx = exec.stdin().expect("stub exposes stdin");

        // Same call shape as the production path at line 151.
        let handle = rt.spawn(stream_stdin(stdin_tx));

        // Let the inner read syscall reach the kernel and park.
        std::thread::sleep(Duration::from_millis(150));

        // Mimic the select-loop on remote-shell exit (line 190-192).
        handle.abort();

        let start = Instant::now();
        rt.shutdown_timeout(Duration::from_secs(2));
        let elapsed = start.elapsed();

        // Keep the write end alive until after shutdown so the pipe never
        // EOFs and the test never accidentally unparks the read.
        unsafe { libc::close(write_end) };

        assert!(
            elapsed < Duration::from_millis(500),
            "Runtime::shutdown_timeout took {:?}; expected <500 ms. With \
             tokio::io::stdin() the parked read(2) on a blocking-pool \
             thread keeps the runtime from reaping the pool, so shutdown \
             waits the full timeout before forcibly terminating.",
            elapsed,
        );
    }

    /// End-to-end PTY reproducer that mirrors the manual `pexpect` probe
    /// from this PR's description: a real terminal device under fd 0, a
    /// full pass through `StreamManager::start` (raw-mode guard, select
    /// loop, abort-on-shell-exit), and then a timed runtime drop. The
    /// first test isolates the mechanism on a pipe; this one demonstrates
    /// the same hang on the actual code path the user hits with
    /// `boxlite exec -ti`.
    #[test]
    fn stream_manager_with_pty_does_not_block_runtime_drop_after_exec_exit() {
        use nix::pty::{OpenptyResult, openpty};
        use std::os::fd::{AsRawFd, IntoRawFd};

        let _serialize = STDIN_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        // Real PTY pair. The slave is dup2'd onto fd 0, so the CLI's
        // `tokio::io::stdin()` (pre-fix) or `std::io::stdin()` (post-fix)
        // reads from a genuine terminal device — `RawModeGuard` activates,
        // the same way it does for a real `exec -ti`. The master stays
        // alive (no writes, no close) so reads on the slave park.
        let OpenptyResult { master, slave } = openpty(None, None).expect("openpty");
        let master_fd = master.into_raw_fd();
        let slave_fd = slave.as_raw_fd();

        let saved = unsafe { libc::dup(libc::STDIN_FILENO) };
        assert!(saved >= 0, "dup saved stdin");
        let _restore = RestoreStdin(saved);

        let rc = unsafe { libc::dup2(slave_fd, libc::STDIN_FILENO) };
        assert_eq!(rc, libc::STDIN_FILENO, "dup2 slave onto fd 0");
        // After dup2, fd 0 holds its own reference to the slave's file
        // description; the OwnedFd `slave` can drop normally.
        drop(slave);

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("build runtime");

        let (mut exec, stdout_tx, stderr_tx, _stdin_rx, result_tx) =
            boxlite::Execution::stub("stream-mgr-pty");

        let exit = rt
            .block_on(async {
                // Simulate "remote shell exited cleanly": after the
                // stdin task has had time to park on the slave, send
                // the exit status and drop the output channels so
                // `StreamManager::start`'s `io_finished` future
                // completes and the select-loop breaks with exit=0.
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    let _ = result_tx.send(boxlite::ExecResult {
                        exit_code: 0,
                        error_message: None,
                    });
                    drop(stdout_tx);
                    drop(stderr_tx);
                });
                StreamManager::new(&mut exec, /*interactive*/ true, /*tty*/ true)
                    .start()
                    .await
            })
            .expect("StreamManager::start");
        assert_eq!(exit, 0, "stub signals clean exit");

        // `start()` returned, the select-loop already aborted the stdin
        // task — but with the buggy implementation that abort cannot
        // unpark the blocking-pool `read(2)` on the slave, so the
        // runtime cannot reap the pool on shutdown.
        let start = Instant::now();
        rt.shutdown_timeout(Duration::from_secs(2));
        let elapsed = start.elapsed();

        // Keep the master alive until after shutdown so the slave never
        // sees EOF and never accidentally unparks the parked read.
        unsafe { libc::close(master_fd) };

        assert!(
            elapsed < Duration::from_millis(500),
            "Runtime drop took {:?} with fd 0 on a PTY slave. Pre-fix \
             the parked read(2) on the blocking-pool thread keeps \
             shutdown waiting for the full timeout — same hang the \
             manual `pexpect` repro in the PR description catches \
             (host process should return immediately on shell exit, \
             not after a stray ENTER).",
            elapsed,
        );
    }

    /// A result that carries an `error_message` (the exec output stream failed
    /// and the exit code was recovered out-of-band, so stdout/stderr were never
    /// delivered) must surface as an `Err`, not a silent exit code. Guards the
    /// regression where the CLI reported a clean `exit 0` for a cloud exec whose
    /// WS attach was rejected 401 and produced no output.
    #[test]
    fn stream_manager_surfaces_exec_error_message_as_error() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("build runtime");

        let (mut exec, stdout_tx, stderr_tx, _stdin_rx, result_tx) =
            boxlite::Execution::stub("stream-mgr-error-message");

        let result = rt.block_on(async {
            tokio::spawn(async move {
                let _ = result_tx.send(boxlite::ExecResult {
                    exit_code: 0,
                    error_message: Some(
                        "WS connect failed: WS auth rejected (401 Unauthorized)".to_string(),
                    ),
                });
                drop(stdout_tx);
                drop(stderr_tx);
            });
            StreamManager::new(&mut exec, /*interactive*/ false, /*tty*/ false)
                .start()
                .await
        });

        let err = result.expect_err(
            "a result carrying error_message must surface as Err, not a silent exit code",
        );
        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("401 Unauthorized"),
            "surfaced error must include the stream-failure cause, got: {rendered}"
        );
    }
}
