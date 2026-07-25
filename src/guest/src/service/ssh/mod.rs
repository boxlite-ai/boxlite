#![cfg(target_os = "linux")]
//! In-process SSH server embedded in `boxlite-guest`.
//!
//! Listens on a plain guest TCP port reached through the existing direct VM
//! tunnel (`Network().Tunnel()` / gvproxy) -- this module knows nothing
//! about the tunnel and adds no transport of its own. It owns SSH protocol
//! negotiation, a stable host identity, public-key authentication against an
//! injectable [`access::AccessState`] snapshot, and delegates shell/exec/PTY
//! to the in-process Guest Execution service and SFTP to the shared
//! [`files backend`](crate::service::files::backend).
//!
//! Disabled unless [`spawn`] is called with a listen address; production
//! wiring is `main.rs`'s optional `--ssh-listen` flag via
//! `service::server::GuestServer::run`.

pub(crate) mod access;
mod backoff;
pub(crate) mod bridge;
mod host_key;
mod limits;
mod rpc;
mod server;
mod sftp;

#[cfg(test)]
mod tests;

use crate::service::server::GuestServer;
use access::AccessState;
use backoff::Backoff;
use boxlite_shared::execution_client::ExecutionClient;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use tokio::net::TcpListener;
use tonic::transport::Channel as TonicChannel;
use tracing::{debug, info, warn};

/// Guest-observed SSH host identity health, mirroring the design's
/// `BoxSshIdentity.status` (`READY`/`DEGRADED`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) enum IdentityStatus {
    #[default]
    Unknown,
    Ready,
    Degraded,
}

/// Live snapshot the `Ssh.Status` RPC reports, kept up to date by
/// [`spawn`] on both the success and failure path -- a failed listener
/// start must still be observable as `Degraded`, not silently absent.
#[derive(Clone, Debug, Default)]
pub(crate) struct SshRuntimeStatus {
    pub(crate) listener_ready: bool,
    pub(crate) host_public_key: String,
    pub(crate) host_fingerprint: String,
    pub(crate) identity_status: IdentityStatus,
}

pub(crate) type SshStatusCell = Arc<RwLock<SshRuntimeStatus>>;

#[derive(Debug)]
pub(crate) enum SshStartError {
    HostKey(host_key::HostKeyError),
    Bridge(bridge::BridgeError),
    Bind(std::io::Error),
}

impl std::fmt::Display for SshStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshStartError::HostKey(e) => write!(f, "{e}"),
            SshStartError::Bridge(e) => write!(f, "{e}"),
            SshStartError::Bind(e) => write!(f, "failed to bind ssh listener: {e}"),
        }
    }
}

impl std::error::Error for SshStartError {}

/// A running guest SSH listener. Dropping this does not stop the listener
/// (the accept loop is a detached background task, matching the rest of
/// this guest's fire-and-forget service tasks); it exists so callers/tests
/// can read the bound address and host identity. The `Ssh.ReplaceAccessSet`/
/// `Status` RPCs (`rpc.rs`) reach the same state via `GuestServer.ssh_access`
/// / `GuestServer.ssh_status`, not through this handle.
pub(crate) struct SshHandle {
    pub(crate) bound_addr: SocketAddr,
    pub(crate) host_fingerprint: String,
}

/// Start the guest SSH listener on `listen_addr`, using `access` and
/// `status` as the shared state the `Ssh` gRPC service (`rpc.rs`) also
/// reads/writes -- both are owned by `GuestServer` so they're reachable
/// (and initialized) whether or not the listener itself ever starts.
///
/// Loads (or, on first boot, atomically creates) the persistent host key
/// before binding, so a corrupt/unreadable key file fails the whole
/// listener startup rather than silently minting a fresh identity --
/// recorded in `status` as `Degraded`, per the design's fail-closed
/// contract for host-identity corruption.
pub(crate) async fn spawn(
    guest: Arc<GuestServer>,
    listen_addr: SocketAddr,
    access_state: Arc<AccessState>,
    status: SshStatusCell,
) -> Result<SshHandle, SshStartError> {
    let key_path = host_key::host_key_path(guest.layout.shared_dir());
    let host_key = match host_key::load_or_create(&key_path) {
        Ok(k) => k,
        Err(e) => {
            status
                .write()
                .expect("ssh status lock poisoned")
                .identity_status = IdentityStatus::Degraded;
            return Err(SshStartError::HostKey(e));
        }
    };
    let host_fingerprint = access::fingerprint(host_key.public_key());
    let host_public_key = host_key
        .public_key()
        .to_openssh()
        .unwrap_or_else(|_| String::new());

    {
        let mut status = status.write().expect("ssh status lock poisoned");
        status.host_fingerprint = host_fingerprint.clone();
        status.host_public_key = host_public_key;
        status.identity_status = IdentityStatus::Ready;
    }

    let execution_client = bridge::connect_execution_client(guest.clone())
        .await
        .map_err(SshStartError::Bridge)?;

    let config = Arc::new(server::build_config(host_key));

    let listener = TcpListener::bind(listen_addr)
        .await
        .map_err(SshStartError::Bind)?;
    let bound_addr = listener.local_addr().map_err(SshStartError::Bind)?;

    info!(%bound_addr, fingerprint = %host_fingerprint, "ssh: listener ready");
    status
        .write()
        .expect("ssh status lock poisoned")
        .listener_ready = true;

    let accept_guest = guest.clone();
    let accept_access = access_state.clone();
    tokio::spawn(async move {
        accept_loop(
            listener,
            config,
            accept_guest,
            accept_access,
            execution_client,
        )
        .await;
    });

    Ok(SshHandle {
        bound_addr,
        host_fingerprint,
    })
}

async fn accept_loop(
    listener: TcpListener,
    config: Arc<russh::server::Config>,
    guest: Arc<GuestServer>,
    access: Arc<AccessState>,
    execution_client: ExecutionClient<TonicChannel>,
) {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(limits::MAX_CONNECTIONS));
    let mut backoff = Backoff::new();

    loop {
        match listener.accept().await {
            Ok((socket, peer_addr)) => {
                backoff.reset();

                let permit = match semaphore.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        warn!(%peer_addr, "ssh: connection limit reached, dropping connection");
                        continue;
                    }
                };
                if let Err(e) = socket.set_nodelay(true) {
                    warn!(error = %e, "ssh: set_nodelay failed");
                }

                let handler = server::SshConnection::new(
                    guest.clone(),
                    access.clone(),
                    execution_client.clone(),
                );
                let config = config.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    match russh::server::run_stream(config, socket, handler).await {
                        Ok(running) => {
                            if let Err(e) = running.await {
                                debug!(%peer_addr, error = %e, "ssh: session ended");
                            }
                        }
                        Err(e) => {
                            debug!(%peer_addr, error = %e, "ssh: handshake failed");
                        }
                    }
                });
            }
            Err(e) => {
                warn!(error = %e, "ssh: accept failed");
                backoff.wait().await;
            }
        }
    }
}
