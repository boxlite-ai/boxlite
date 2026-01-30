use anyhow::Result;
use boxlite::Execution;
use futures::StreamExt;
use nix::sys::signal::Signal;
use nix::sys::termios::{
    InputFlags, LocalFlags, OutputFlags, SetArg, Termios, tcgetattr, tcsetattr,
};
use std::io::IsTerminal;
use std::os::fd::{AsFd, AsRawFd};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
                                break exit_status.unwrap().exit_code;
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

        Ok(exit_code)
    }
}

async fn stream_stdin(mut stdin_tx: boxlite::ExecStdin) {
    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 8192];

    loop {
        match stdin.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if let Err(e) = stdin_tx.write(&buf[..n]).await {
                    tracing::debug!("failed to forward stdin: {}", e);
                    break;
                }
            }
            Err(e) => {
                tracing::debug!("stdin read error: {}", e);
                break;
            }
        }
    }
}
