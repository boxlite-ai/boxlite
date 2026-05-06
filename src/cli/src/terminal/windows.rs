use anyhow::Result;
use boxlite::Execution;
use futures::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::select;

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

        let mut ctrl_c = tokio::signal::ctrl_c();

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
                _ = &mut ctrl_c => {
                    // Forward Ctrl+C as SIGINT equivalent
                    let _ = self.execution.signal(2).await; // SIGINT = 2
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
