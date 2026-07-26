//! Bridges an SSH channel (shell/exec/PTY/resize/stdin/exit-status) to the
//! in-process Guest Execution service.
//!
//! `Execution` is consumed as a genuine gRPC service -- a real
//! `ExecutionClient` connected over an in-memory duplex socket to the same
//! `ExecutionServer` the host talks to -- rather than reaching into its
//! private state layer. That keeps this module a pure consumer of the
//! existing RPC contract, with zero changes to `service::exec`.

use crate::service::files;
use crate::service::server::GuestServer;
use crate::service::ssh::limits::{CONTROL_RPC_TIMEOUT, STDIN_QUEUE_DEPTH};
use boxlite_shared::{
    constants::executor as executor_const, execution_client::ExecutionClient, AttachRequest,
    ExecRequest, ExecStdin, KillRequest, ResizeTtyRequest, TtyConfig, WaitRequest,
};
use russh::server::Handle as SessionHandle;
use russh::ChannelId;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Channel, Endpoint, Uri};
use tracing::warn;

#[derive(Debug)]
pub(crate) enum BridgeError {
    Connect(String),
    Exec(String),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::Connect(e) => write!(f, "execution bridge connect failed: {e}"),
            BridgeError::Exec(e) => write!(f, "exec failed: {e}"),
        }
    }
}

impl std::error::Error for BridgeError {}

/// Connect an in-process `ExecutionClient` to `server`'s own `Execution`
/// implementation over an in-memory duplex socket -- no TCP/vsock, no extra
/// listener, and the exact same request/response types a host caller uses.
pub(crate) async fn connect_execution_client(
    server: Arc<GuestServer>,
) -> Result<ExecutionClient<Channel>, BridgeError> {
    let (client_io, server_io) = tokio::io::duplex(1024 * 1024);

    let router = tonic::transport::Server::builder()
        .add_service(boxlite_shared::ExecutionServer::from_arc(server));
    tokio::spawn(async move {
        let incoming = tokio_stream::once(Ok::<_, std::io::Error>(server_io));
        if let Err(e) = router.serve_with_incoming(incoming).await {
            warn!(error = %e, "in-process execution server ended");
        }
    });

    let mut client_io = Some(client_io);
    let channel = Endpoint::try_from("http://[::]:0")
        .map_err(|e| BridgeError::Connect(e.to_string()))?
        .connect_with_connector(tower::service_fn(move |_: Uri| {
            let client_io = client_io.take();
            async move {
                client_io
                    .map(hyper_util::rt::TokioIo::new)
                    .ok_or_else(|| std::io::Error::other("execution duplex already connected"))
            }
        }))
        .await
        .map_err(|e| BridgeError::Connect(e.to_string()))?;

    Ok(ExecutionClient::new(channel))
}

/// What to run: an interactive shell, or a single command line (SSH `exec`).
pub(crate) enum Command {
    Shell,
    Exec(String),
}

/// Bridges one SSH channel's shell/exec lifecycle to one guest execution.
pub(crate) struct ChannelBridge {
    client: ExecutionClient<Channel>,
    execution_id: String,
    stdin_tx: mpsc::Sender<ExecStdin>,
    output_cancel: Option<oneshot::Sender<()>>,
    dropped_stdin_frames: std::sync::atomic::AtomicU64,
}

impl ChannelBridge {
    /// Start the execution and spawn its stdin-forwarding and output-pump
    /// tasks. `env` is the caller-supplied, already-capped `env_request` set.
    pub(crate) async fn start(
        mut client: ExecutionClient<Channel>,
        server: &GuestServer,
        command: Command,
        tty: Option<(u32, u32, u32, u32)>,
        env: HashMap<String, String>,
        channel_id: ChannelId,
        session_handle: SessionHandle,
    ) -> Result<Self, BridgeError> {
        // Target the running box container process when one is resolvable
        // (the common case: `boxlite-guest` architecture diagram routes SSH
        // to "box container process"). When none is registered yet -- e.g.
        // a box with no container started, or this test harness -- fall
        // back to the guest executor rather than failing the whole session;
        // reaching this code already required a valid app-grant + temporary
        // SSH credential, so there is no extra exposure in still handing
        // back a shell.
        let mut exec_env = env;
        if let Ok(container_id) = files::resolve_container_id(&server.containers, "").await {
            exec_env.insert(
                executor_const::ENV_VAR.to_string(),
                format!("{}={}", executor_const::CONTAINER_KEY, container_id),
            );
        }

        let (program, args) = match &command {
            Command::Shell => ("/bin/sh".to_string(), vec!["-l".to_string()]),
            Command::Exec(cmd) => ("/bin/sh".to_string(), vec!["-c".to_string(), cmd.clone()]),
        };

        let req = ExecRequest {
            execution_id: None,
            program,
            args,
            env: exec_env,
            workdir: String::new(),
            timeout_ms: 0,
            tty: tty.map(|(rows, cols, x_pixels, y_pixels)| TtyConfig {
                rows,
                cols,
                x_pixels,
                y_pixels,
            }),
            user: Some(super::ca::SSH_LOGIN_USER.to_string()),
        };

        let resp = tokio::time::timeout(CONTROL_RPC_TIMEOUT, client.exec(req))
            .await
            .map_err(|_| BridgeError::Exec("exec RPC timed out".into()))?
            .map_err(|e| BridgeError::Exec(e.to_string()))?
            .into_inner();

        if let Some(err) = resp.error {
            return Err(BridgeError::Exec(format!("{}: {}", err.reason, err.detail)));
        }
        let execution_id = resp.execution_id;

        let (stdin_tx, stdin_rx) = mpsc::channel::<ExecStdin>(STDIN_QUEUE_DEPTH);
        let mut stdin_client = client.clone();
        tokio::spawn(async move {
            let stream = ReceiverStream::new(stdin_rx);
            if let Err(e) = stdin_client.send_input(stream).await {
                warn!(error = %e, "send_input stream ended with error");
            }
        });

        let (cancel_tx, cancel_rx) = oneshot::channel();
        spawn_output_pump(
            client.clone(),
            execution_id.clone(),
            channel_id,
            session_handle,
            cancel_rx,
        );

        Ok(Self {
            client,
            execution_id,
            stdin_tx,
            output_cancel: Some(cancel_tx),
            dropped_stdin_frames: std::sync::atomic::AtomicU64::new(0),
        })
    }

    /// Forward a `data` frame to the process's stdin. Never blocks: a full
    /// queue means the process isn't draining stdin fast enough, so the
    /// frame is dropped rather than stalling every other channel on this
    /// connection (russh serializes all channel callbacks through one
    /// Handler instance).
    pub(crate) fn stdin(&self, data: Vec<u8>) {
        let msg = ExecStdin {
            execution_id: self.execution_id.clone(),
            data,
            close: false,
        };
        if self.stdin_tx.try_send(msg).is_err() {
            self.dropped_stdin_frames
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Signal stdin EOF. Spawned so a momentarily full queue can't block the
    /// dispatcher -- unlike a dropped data frame, EOF must never be lost.
    pub(crate) fn stdin_eof(&self) {
        let tx = self.stdin_tx.clone();
        let execution_id = self.execution_id.clone();
        tokio::spawn(async move {
            let _ = tx
                .send(ExecStdin {
                    execution_id,
                    data: Vec::new(),
                    close: true,
                })
                .await;
        });
    }

    pub(crate) async fn resize(&self, rows: u32, cols: u32, x_pixels: u32, y_pixels: u32) {
        let req = ResizeTtyRequest {
            execution_id: self.execution_id.clone(),
            rows,
            cols,
            x_pixels,
            y_pixels,
        };
        let mut client = self.client.clone();
        if let Err(e) = tokio::time::timeout(CONTROL_RPC_TIMEOUT, client.resize_tty(req)).await {
            warn!(error = %e, "resize_tty RPC timed out");
        }
    }

    /// Kill the delegated process and always cancel the output pump,
    /// independent of whether the kill RPC itself succeeds -- a kill sent to
    /// an already-wedged guest process must not leave the pump task (and its
    /// `Attach` stream) running forever.
    pub(crate) fn kill_running(&mut self) {
        let execution_id = self.execution_id.clone();
        let mut client = self.client.clone();
        tokio::spawn(async move {
            let req = KillRequest {
                execution_id,
                signal: 9,
            };
            let _ = tokio::time::timeout(CONTROL_RPC_TIMEOUT, client.kill(req)).await;
        });
        if let Some(cancel) = self.output_cancel.take() {
            let _ = cancel.send(());
        }
    }
}

impl Drop for ChannelBridge {
    fn drop(&mut self) {
        if let Some(cancel) = self.output_cancel.take() {
            let _ = cancel.send(());
        }
        let dropped = self
            .dropped_stdin_frames
            .load(std::sync::atomic::Ordering::Relaxed);
        if dropped > 0 {
            warn!(dropped, execution_id = %self.execution_id, "dropped stdin frames under backpressure");
        }
    }
}

const SIGNAL_EXIT_BASE: i32 = 128;
const INDETERMINATE_EXIT_STATUS: u32 = 255;

fn spawn_output_pump(
    mut client: ExecutionClient<Channel>,
    execution_id: String,
    channel_id: ChannelId,
    session_handle: SessionHandle,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let attach = client
            .attach(AttachRequest {
                execution_id: execution_id.clone(),
            })
            .await;
        let mut stream = match attach {
            Ok(resp) => resp.into_inner(),
            Err(e) => {
                warn!(error = %e, execution_id = %execution_id, "attach failed");
                let _ = session_handle
                    .exit_status_request(channel_id, INDETERMINATE_EXIT_STATUS)
                    .await;
                let _ = session_handle.eof(channel_id).await;
                let _ = session_handle.close(channel_id).await;
                return;
            }
        };

        loop {
            tokio::select! {
                _ = &mut cancel_rx => break,
                msg = stream.message() => {
                    match msg {
                        Ok(Some(output)) => match output.event {
                            Some(boxlite_shared::exec_output::Event::Stdout(s)) => {
                                let _ = session_handle.data(channel_id, s.data).await;
                            }
                            Some(boxlite_shared::exec_output::Event::Stderr(s)) => {
                                let _ = session_handle.extended_data(channel_id, 1, s.data).await;
                            }
                            None => {}
                        },
                        Ok(None) => break,
                        Err(e) => {
                            warn!(error = %e, execution_id = %execution_id, "attach stream error");
                            break;
                        }
                    }
                }
            }
        }

        let exit_status = tokio::time::timeout(
            CONTROL_RPC_TIMEOUT,
            client.wait(WaitRequest {
                execution_id: execution_id.clone(),
            }),
        )
        .await;

        match exit_status {
            Ok(Ok(resp)) => {
                let resp = resp.into_inner();
                if resp.signal != 0 {
                    let _ = session_handle
                        .exit_status_request(channel_id, (SIGNAL_EXIT_BASE + resp.signal) as u32)
                        .await;
                } else {
                    let _ = session_handle
                        .exit_status_request(channel_id, resp.exit_code as u32)
                        .await;
                }
            }
            _ => {
                let _ = session_handle
                    .exit_status_request(channel_id, INDETERMINATE_EXIT_STATUS)
                    .await;
            }
        }

        let _ = session_handle.eof(channel_id).await;
        let _ = session_handle.close(channel_id).await;
    });
}
