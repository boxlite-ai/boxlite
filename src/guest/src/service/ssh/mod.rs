#![cfg(target_os = "linux")]
//! In-process SSH server embedded in `boxlite-guest`.
//!
//! Listens on a plain guest TCP port reached through the existing direct VM
//! tunnel -- this module knows nothing about the tunnel and adds no transport
//! of its own. It owns SSH protocol negotiation, a stable host identity,
//! offline OpenSSH *certificate* authentication against the immutable
//! organization CA trust bundle in [`ca::SshTrust`], and delegates
//! shell/exec/PTY to the in-process Guest Execution service and SFTP to the
//! shared [`files backend`](crate::service::files::backend).
//!
//! There is deliberately no per-credential state and no control RPC here.
//! Credentials are certificates the Hosted API signs; the guest only ever
//! learns the CA public keys, once, at VM-generation boot time. Nothing about
//! a running guest changes when a credential is created or revoked.
//!
//! Disabled unless [`spawn`] is called with a listen address and a trust
//! bundle; production wiring is `main.rs`'s optional `--ssh-listen` flag via
//! `service::server::GuestServer::run`.

mod backoff;
pub(crate) mod bridge;
pub(crate) mod ca;
mod host_key;
mod limits;
mod server;
mod sftp;

#[cfg(test)]
mod tests;

use crate::service::server::GuestServer;
use backoff::Backoff;
use boxlite_shared::execution_client::ExecutionClient;
use ca::SshTrust;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use tokio::net::TcpListener;
use tonic::transport::Channel as TonicChannel;
use tracing::{debug, info, warn};

/// Non-secret readiness snapshot for diagnostics: which host identity this
/// guest presents and which CA key IDs this VM generation trusts.
///
/// Exposing the trusted CA key IDs is what makes a stale trust bundle
/// diagnosable during rotation -- a box that still trusts only the retired key
/// is visible here rather than only as unexplained auth failures.
#[derive(Clone, Debug, Default)]
pub(crate) struct SshRuntimeStatus {
    pub(crate) listener_ready: bool,
    pub(crate) host_public_key: String,
    pub(crate) host_fingerprint: String,
    pub(crate) trusted_ca_key_ids: Vec<String>,
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
/// (the accept loop is a detached background task, matching the rest of this
/// guest's fire-and-forget service tasks); it exists so callers/tests can read
/// the bound address and host identity.
pub(crate) struct SshHandle {
    pub(crate) bound_addr: SocketAddr,
    pub(crate) host_fingerprint: String,
}

/// Start the guest SSH listener on `listen_addr`, authenticating against
/// `trust`.
///
/// Loads (or, on first boot, atomically creates) the persistent host key
/// before binding, so a corrupt/unreadable key file fails the whole listener
/// startup rather than silently minting a fresh identity -- a changed host
/// fingerprint is indistinguishable from an interception attempt to any client
/// that has pinned it.
pub(crate) async fn spawn(
    guest: Arc<GuestServer>,
    listen_addr: SocketAddr,
    trust: Arc<SshTrust>,
    status: SshStatusCell,
) -> Result<SshHandle, SshStartError> {
    let key_path = host_key::host_key_path(guest.layout.shared_dir());
    let host_key = host_key::load_or_create(&key_path).map_err(SshStartError::HostKey)?;
    let host_fingerprint = ca::fingerprint(host_key.public_key());
    let host_public_key = host_key
        .public_key()
        .to_openssh()
        .unwrap_or_else(|_| String::new());

    {
        let mut status = status.write().expect("ssh status lock poisoned");
        status.host_fingerprint = host_fingerprint.clone();
        status.host_public_key = host_public_key;
        status.trusted_ca_key_ids = trust.ca_key_ids();
    }

    let execution_client = bridge::connect_execution_client(guest.clone())
        .await
        .map_err(SshStartError::Bridge)?;

    let config = Arc::new(server::build_config(host_key));

    let listener = TcpListener::bind(listen_addr)
        .await
        .map_err(SshStartError::Bind)?;
    let bound_addr = listener.local_addr().map_err(SshStartError::Bind)?;

    info!(
        %bound_addr,
        fingerprint = %host_fingerprint,
        ca_key_ids = ?trust.ca_key_ids(),
        "ssh: listener ready"
    );
    status
        .write()
        .expect("ssh status lock poisoned")
        .listener_ready = true;

    let accept_guest = guest.clone();
    tokio::spawn(async move {
        accept_loop(listener, config, accept_guest, trust, execution_client).await;
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
    trust: Arc<SshTrust>,
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
                    trust.clone(),
                    execution_client.clone(),
                );
                let authenticated = handler.authenticated_flag();
                let config = config.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    serve_connection(config, socket, handler, authenticated, peer_addr).await;
                });
            }
            Err(e) => {
                warn!(error = %e, "ssh: accept failed");
                backoff.wait().await;
            }
        }
    }
}

/// Drive one accepted connection under the handshake and authentication
/// deadlines. Both bound how long an *unauthenticated* peer may hold a
/// connection slot; once authenticated the session runs under russh's own
/// `inactivity_timeout` instead.
async fn serve_connection(
    config: Arc<russh::server::Config>,
    socket: tokio::net::TcpStream,
    handler: server::SshConnection,
    authenticated: Arc<std::sync::atomic::AtomicBool>,
    peer_addr: SocketAddr,
) {
    let started = match tokio::time::timeout(
        limits::HANDSHAKE_TIMEOUT,
        russh::server::run_stream(config, socket, handler),
    )
    .await
    {
        Ok(Ok(running)) => running,
        Ok(Err(e)) => {
            debug!(%peer_addr, error = %e, "ssh: handshake failed");
            return;
        }
        Err(_) => {
            debug!(%peer_addr, "ssh: handshake timed out");
            return;
        }
    };

    let session_handle = started.handle();
    let auth_deadline = tokio::time::sleep(limits::AUTH_TIMEOUT);
    tokio::pin!(auth_deadline);
    let mut session = std::pin::pin!(started);

    loop {
        tokio::select! {
            result = &mut session => {
                if let Err(e) = result {
                    debug!(%peer_addr, error = %e, "ssh: session ended");
                }
                return;
            }
            () = &mut auth_deadline => {
                if !authenticated.load(std::sync::atomic::Ordering::Relaxed) {
                    warn!(%peer_addr, "ssh: authentication deadline exceeded, disconnecting");
                    let _ = session_handle
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "authentication timeout".to_string(),
                            String::new(),
                        )
                        .await;
                    return;
                }
                // Authenticated in time: stop arming the deadline and let the
                // session run under russh's inactivity timeout.
                auth_deadline
                    .as_mut()
                    .reset(tokio::time::Instant::now() + std::time::Duration::from_secs(86_400));
            }
        }
    }
}
