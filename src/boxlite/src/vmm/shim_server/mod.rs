//! Shim control and SSH forwarding share one OS thread, with independent tasks.

pub(super) mod client;
pub(super) mod control;
mod ipc;
#[cfg(all(test, target_os = "linux"))]
mod sandbox_tests;
#[cfg(test)]
mod tests;

use std::net::SocketAddr;
use std::sync::Arc;
use std::thread::JoinHandle;

use boxlite_shared::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::ssh_forwarder::SshForwarder;
use crate::net::socket_path::BoxSockets;
pub(crate) use client::ShimClient;
use control::ControlServer;

// Slow readers cannot grow the number of control tasks.
const MAX_CONTROL_CONNECTIONS: usize = 32;

#[derive(Serialize, Deserialize)]
enum Request {
    SetSshForwarding { address: Option<SocketAddr> },
    GetSshSocketAddr,
}

#[derive(Serialize, Deserialize)]
enum Response {
    Ok,
    SshSocketAddr { address: Option<SocketAddr> },
    Error { error: String },
}

/// Owns the background runtime until the shim exits, even after runtime detach.
#[derive(Debug)]
pub struct ShimServer {
    shutdown: CancellationToken,
    thread: Option<JoinHandle<()>>,
}

impl ShimServer {
    pub fn start(sockets: BoxSockets, network_enabled: bool) -> BoxliteResult<Self> {
        let shutdown = CancellationToken::new();
        let child_shutdown = shutdown.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("boxlite-shim".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let control = match ControlServer::bind(sockets.shim_sock(), network_enabled) {
                        Ok(control) => control,
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                            return;
                        }
                    };
                    let forwarder = SshForwarder::new(sockets.ssh_sock());
                    if ready_tx.send(Ok(())).is_ok() {
                        Self::serve(control, forwarder, child_shutdown).await;
                    }
                });
            })
            .map_err(|error| failure("start thread", error))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                shutdown,
                thread: Some(thread),
            }),
            result => {
                let _ = thread.join();
                Err(failure("initialize thread", format!("{result:?}")))
            }
        }
    }

    async fn serve(control: ControlServer, forwarder: SshForwarder, shutdown: CancellationToken) {
        let forwarder = Arc::new(Mutex::new(forwarder));
        if let Err(error) = control.run(forwarder.clone(), shutdown).await {
            tracing::warn!(%error, "shim control service ended");
        }
        if let Err(error) = forwarder.lock().await.set(None).await {
            tracing::warn!(%error, "stop SSH forwarding");
        }
    }
}

impl Drop for ShimServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!("shim service thread panicked");
        }
    }
}

fn failure(operation: &str, error: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Rpc(format!("shim {operation}: {error}"))
}
