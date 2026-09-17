//! TCP byte forwarding to the fixed guest SSH bridge.

pub(super) mod listener;
#[cfg(test)]
pub(super) mod tests;

use std::io;
use std::net::SocketAddr;
use std::os::fd::OwnedFd;
use std::path::PathBuf;

use boxlite_shared::constants::ssh::{CONNECT_TIMEOUT, MAX_CONNECTIONS};
use boxlite_shared::{BoxliteError, BoxliteResult};
use tokio::net::UnixStream;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use super::accept::AcceptBackoff;
use listener::Listener;

pub(super) struct SshForwarder {
    guest_path: PathBuf,
    listening: Option<Listening>,
}

struct Listening {
    address: SocketAddr,
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

impl SshForwarder {
    pub(super) fn new(guest_path: PathBuf) -> Self {
        Self {
            guest_path,
            listening: None,
        }
    }

    pub(super) async fn set(
        &mut self,
        listener: Option<(OwnedFd, SocketAddr)>,
    ) -> BoxliteResult<()> {
        if let Some(listening) = self.listening.as_mut() {
            listening.shutdown.cancel();
            if let Err(error) = (&mut listening.task).await {
                tracing::warn!(%error, "SSH listener task failed");
            }
        }
        self.listening = None;
        let Some((descriptor, address)) = listener else {
            return Ok(());
        };
        let listener = Listener::from_fd(descriptor, &address).map_err(|error| {
            BoxliteError::Network(format!("validate SSH TCP listener {address}: {error}"))
        })?;
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(Self::listen(
            listener,
            self.guest_path.clone(),
            shutdown.clone(),
        ));
        self.listening = Some(Listening {
            address,
            shutdown,
            task,
        });
        Ok(())
    }

    pub(super) fn get_socket_addr(&self) -> Option<SocketAddr> {
        self.listening
            .as_ref()
            .filter(|listening| !listening.task.is_finished())
            .map(|listening| listening.address)
    }

    async fn listen(listener: Listener, guest_path: PathBuf, shutdown: CancellationToken) {
        let mut connections = JoinSet::new();
        let mut backoff = AcceptBackoff::default();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                result = connections.join_next(), if !connections.is_empty() => {
                    match result {
                        Some(Ok(Err(error))) => tracing::debug!(%error, "SSH byte forwarding ended"),
                        Some(Err(error)) => tracing::warn!(%error, "SSH byte forwarding task failed"),
                        _ => {}
                    }
                }
                accepted = backoff.accept(|| listener.accept()) => {
                    match accepted {
                        Ok(mut stream) if connections.len() < MAX_CONNECTIONS => {
                            let path = guest_path.clone();
                            connections.spawn(async move {
                                let mut guest = tokio::time::timeout(
                                    CONNECT_TIMEOUT,
                                    UnixStream::connect(path),
                                ).await??;
                                tokio::io::copy_bidirectional(&mut stream, &mut guest).await?;
                                Ok::<(), io::Error>(())
                            });
                        }
                        Ok(_) => {}, // Closing the accepted stream enforces the bound.
                        Err(error) => {
                            tracing::warn!(%error, "accept SSH connection failed");
                            break;
                        }
                    }
                }
            }
        }
        drop(listener);
        connections.shutdown().await;
    }
}

impl Drop for SshForwarder {
    fn drop(&mut self) {
        if let Some(listening) = &self.listening {
            listening.shutdown.cancel();
            listening.task.abort();
        }
    }
}
