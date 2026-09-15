use std::io;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Arc;

use boxlite_shared::constants::ssh::CONNECT_TIMEOUT;
use tokio::net::UnixListener;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::{
    MAX_CONTROL_CONNECTIONS, Request, Response,
    ipc::{ControlChannel, invalid},
};
use crate::vmm::accept::AcceptBackoff;
use crate::vmm::ssh_forwarder::SshForwarder;

/// Owns the private endpoint and all per-connection protocol work.
pub(in crate::vmm) struct ControlServer {
    listener: UnixListener,
    path: PathBuf,
    network_enabled: bool,
}

impl ControlServer {
    pub(in crate::vmm) fn bind(path: PathBuf, network_enabled: bool) -> io::Result<Self> {
        // This directory is private to the box. Replace stale sockets only.
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(&path)?,
            Ok(_) => return Err(invalid("shim control path is not a socket")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let server = Self {
            listener: UnixListener::bind(&path)?,
            path,
            network_enabled,
        };
        std::fs::set_permissions(&server.path, std::fs::Permissions::from_mode(0o600))?;
        Ok(server)
    }

    pub(super) async fn run(
        &self,
        forwarder: Arc<Mutex<SshForwarder>>,
        shutdown: CancellationToken,
    ) -> io::Result<()> {
        let mut connections = JoinSet::new();
        let mut backoff = AcceptBackoff::default();
        let result = loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break Ok(()),
                result = connections.join_next(), if !connections.is_empty() => {
                    match result {
                        Some(Ok(Err(error))) => tracing::debug!(%error, "shim control connection ended"),
                        Some(Err(error)) => tracing::warn!(%error, "shim control connection task failed"),
                        _ => {}
                    }
                }
                accepted = backoff.accept(|| self.listener.accept()) => match accepted {
                    Ok((stream, _)) if connections.len() < MAX_CONTROL_CONNECTIONS => {
                        let forwarder = forwarder.clone();
                        connections.spawn(Self::respond(
                            ControlChannel(stream), forwarder, self.network_enabled,
                        ));
                    }
                    Ok(_) => {}, // Drop excess connections immediately.
                    Err(error) => break Err(error),
                }
            }
        };
        // No more accepts; abort and join readers/writers before removing shim.sock.
        connections.shutdown().await;
        result
    }

    async fn respond(
        mut channel: ControlChannel,
        forwarder: Arc<Mutex<SshForwarder>>,
        network_enabled: bool,
    ) -> io::Result<()> {
        let (request, descriptor) =
            tokio::time::timeout(CONNECT_TIMEOUT, channel.receive::<Request>()).await??;
        let response = match (request, descriptor) {
            (
                Request::SetSshForwarding {
                    address: Some(address),
                },
                Some(descriptor),
            ) => {
                if !network_enabled {
                    drop(descriptor);
                    Response::Error {
                        error: "TCP SSH requires security.network_enabled=true".into(),
                    }
                } else {
                    match forwarder
                        .lock()
                        .await
                        .set(Some((descriptor, address)))
                        .await
                    {
                        Ok(()) => Response::Ok,
                        Err(error) => Response::Error {
                            error: error.to_string(),
                        },
                    }
                }
            }
            (Request::SetSshForwarding { address: None }, None) => {
                match forwarder.lock().await.set(None).await {
                    Ok(()) => Response::Ok,
                    Err(error) => Response::Error {
                        error: error.to_string(),
                    },
                }
            }
            (Request::GetSshSocketAddr, None) => Response::SshSocketAddr {
                address: forwarder.lock().await.get_socket_addr(),
            },
            (_, descriptor) => {
                drop(descriptor);
                Response::Error {
                    error: "missing or unexpected descriptor for SSH forwarding request".into(),
                }
            }
        };
        tokio::time::timeout(CONNECT_TIMEOUT, channel.send(&response, None)).await?
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(%error, path = %self.path.display(), "remove shim control socket");
        }
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
