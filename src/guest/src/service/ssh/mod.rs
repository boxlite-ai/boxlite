#![cfg(target_os = "linux")]
//! SSH embedded in the guest, configured once by Guest.Init.

mod auth;
mod backoff;
mod bridge;
mod forward;
mod limits;
mod reverse_streamlocal;
mod server;
mod session;
mod sftp;
mod streamlocal;
mod workload;

pub(crate) use workload::{BoxliteWorkloadExecutor, SshWorkload};

use crate::service::server::GuestServer;
use auth::SshAuthorizer;
use backoff::Backoff;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::net::{Shutdown, SocketAddr};
use std::sync::{Arc, OnceLock, Weak};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

/// Fully validated before any SSH listener is opened.
struct SshConfig {
    listen_addr: SocketAddr,
    authorizer: Arc<SshAuthorizer>,
    server: Arc<russh::server::Config>,
}

impl SshConfig {
    fn parse(config: boxlite_shared::SshConfig) -> BoxliteResult<Self> {
        let listen_addr = config.listen_address.parse().map_err(|_| {
            BoxliteError::Config("invalid SSH listen address: expected IP:port".into())
        })?;
        let authorizer =
            SshAuthorizer::new(&config).map_err(|error| BoxliteError::Config(error.to_string()))?;
        // Do not include either the input or decoder errors in diagnostics:
        // neither is required to be free of private key material.
        let host_key = russh::keys::PrivateKey::from_openssh(config.host_private_key.trim())
            .map_err(|_| {
                BoxliteError::Config(
                    "invalid SSH host private key: expected unencrypted OpenSSH key".into(),
                )
            })?;
        if host_key.is_encrypted() {
            return Err(BoxliteError::Config(
                "SSH host private key must be unencrypted".into(),
            ));
        }
        // A key can parse and still be unusable as a host key. Two cases,
        // both invisible until the first handshake fails after startup
        // already reported Ready:
        // - FIDO sk-* and DSA keypairs hold no signable material in software;
        // - an OpenSSH key file embeds both halves of the keypair verbatim,
        //   and russh announces the stored public half during key exchange
        //   while signing with the private half, so mismatched halves sign
        //   fine but no client can verify the host signature.
        // Probe once through the same sign/verify path a client uses.
        use russh::keys::signature::{Signer, Verifier};
        let probe = b"boxlite host key validation";
        let signature = host_key
            .try_sign(probe)
            .map_err(|_| {
                BoxliteError::Config(
                    "invalid SSH host private key: unsupported algorithm; expected ed25519, ecdsa, or rsa"
                        .into(),
                )
            })?;
        host_key
            .public_key()
            .key_data()
            .verify(probe, &signature)
            .map_err(|_| {
                BoxliteError::Config(
                    "invalid SSH host private key: public and private key halves do not match"
                        .into(),
                )
            })?;
        Ok(Self {
            listen_addr,
            authorizer: Arc::new(authorizer),
            server: Arc::new(server::build_config(host_key)),
        })
    }
}

/// Owns the one startup listener and waits for all sessions during shutdown.
pub(crate) struct SshManager {
    guest: OnceLock<Weak<GuestServer>>,
    listener: Mutex<Option<JoinHandle<()>>>,
    connection_permits: Arc<tokio::sync::Semaphore>,
    shutdown_token: CancellationToken,
}

impl Default for SshManager {
    fn default() -> Self {
        Self {
            guest: OnceLock::new(),
            listener: Mutex::new(None),
            connection_permits: Arc::new(tokio::sync::Semaphore::new(limits::MAX_CONNECTIONS)),
            shutdown_token: CancellationToken::new(),
        }
    }
}

struct ConnectionContext {
    guest: Arc<GuestServer>,
    authorizer: Arc<SshAuthorizer>,
    permits: Arc<tokio::sync::Semaphore>,
    shutdown_token: CancellationToken,
}

#[derive(Debug)]
pub(crate) enum SshShutdownError {
    ConnectionBudgetClosed,
    TimedOut,
}

impl std::fmt::Display for SshShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConnectionBudgetClosed => {
                write!(f, "SSH connection budget closed during guest shutdown")
            }
            Self::TimedOut => write!(f, "timed out waiting for SSH sessions to stop"),
        }
    }
}

impl std::error::Error for SshShutdownError {}

impl SshManager {
    /// The weak reference avoids a server/manager ownership cycle.
    pub(crate) fn attach_guest(&self, guest: &Arc<GuestServer>) {
        let _ = self.guest.set(Arc::downgrade(guest));
    }

    /// SSH is optional: return a sanitized outcome instead of failing Guest.Init.
    pub(crate) async fn configure(
        &self,
        config: Option<boxlite_shared::SshConfig>,
    ) -> boxlite_shared::SshInitResult {
        use boxlite_shared::{SshInitResult, SshInitState};
        let Some(config) = config else {
            return SshInitResult {
                state: SshInitState::Disabled.into(),
                error_reason: None,
            };
        };
        let config = match SshConfig::parse(config) {
            Ok(config) => config,
            Err(error) => return Self::failure("validate", error),
        };
        match self.start(config).await {
            Ok(()) => SshInitResult {
                state: SshInitState::Ready.into(),
                error_reason: None,
            },
            Err(error) => Self::failure("listen", error),
        }
    }

    fn failure(stage: &'static str, error: BoxliteError) -> boxlite_shared::SshInitResult {
        // All parsing errors above and in auth use fixed messages, never decoder
        // errors or raw input. Listener errors contain only a parsed IP and port.
        let reason = format!("SSH {stage}: {error}");
        warn!(stage, error_reason = %reason, "SSH initialization failed; continuing guest initialization");
        boxlite_shared::SshInitResult {
            state: boxlite_shared::SshInitState::Failed.into(),
            error_reason: Some(reason),
        }
    }

    async fn start(&self, ssh: SshConfig) -> BoxliteResult<()> {
        let guest = self.guest.get().and_then(Weak::upgrade).ok_or_else(|| {
            BoxliteError::Internal("SSH manager is not attached to the guest server".into())
        })?;
        let mut state = self.listener.lock().await;
        if self.shutdown_token.is_cancelled()
            || guest
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(BoxliteError::Config(
                "guest shutdown has started; SSH cannot start".into(),
            ));
        }
        if state.is_some() {
            return Err(BoxliteError::Config("SSH listener already started".into()));
        }
        let listener = TcpListener::bind(ssh.listen_addr).await.map_err(|error| {
            BoxliteError::Config(format!(
                "failed to bind SSH listener at {}: {error}",
                ssh.listen_addr
            ))
        })?;
        let bound_addr = listener.local_addr().map_err(|error| {
            BoxliteError::Internal(format!("failed to read SSH listener address: {error}"))
        })?;
        let context = ConnectionContext {
            guest,
            authorizer: ssh.authorizer,
            permits: self.connection_permits.clone(),
            shutdown_token: self.shutdown_token.clone(),
        };
        *state = Some(tokio::spawn(accept_loop(listener, ssh.server, context)));
        info!(%bound_addr, "embedded SSH listener ready");
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> Result<(), SshShutdownError> {
        // Serialize with start so an accepted connection cannot escape the
        // shutdown signal or acquire a permit after we finish draining.
        let mut state = self.listener.lock().await;
        self.shutdown_token.cancel();
        if let Some(listener) = state.take() {
            if let Err(error) = listener.await {
                warn!(%error, "SSH listener task failed while stopping");
            }
        }
        let all_connections = self
            .connection_permits
            .clone()
            .acquire_many_owned(limits::MAX_CONNECTIONS as u32);
        match tokio::time::timeout(limits::CONTROL_CALL_TIMEOUT, all_connections).await {
            Ok(Ok(_permit)) => Ok(()),
            Ok(Err(_)) => Err(SshShutdownError::ConnectionBudgetClosed),
            Err(_) => Err(SshShutdownError::TimedOut),
        }
    }

    #[cfg(test)]
    pub(crate) fn close_connection_budget_for_test(&self) {
        self.connection_permits.close();
    }
}

async fn accept_loop(
    listener: TcpListener,
    config: Arc<russh::server::Config>,
    context: ConnectionContext,
) {
    let ConnectionContext {
        guest,
        authorizer,
        permits,
        shutdown_token,
    } = context;
    let mut backoff = Backoff::new();

    loop {
        let accepted = tokio::select! {
            _ = shutdown_token.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        match accepted {
            Ok((socket, peer_addr)) => {
                backoff.reset();
                if let Err(error) = socket.set_nodelay(true) {
                    debug!(%peer_addr, %error, "failed to enable TCP_NODELAY for SSH connection");
                }
                let (socket, shutdown_socket) = match socket_with_shutdown_handle(socket) {
                    Ok(sockets) => sockets,
                    Err(error) => {
                        warn!(%peer_addr, %error, "failed to prepare SSH connection socket");
                        continue;
                    }
                };
                let permit = match permits.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        warn!(%peer_addr, "SSH connection limit reached");
                        continue;
                    }
                };

                let (authenticated_tx, authenticated_rx) = tokio::sync::oneshot::channel();
                let handler =
                    server::SshConnection::new(guest.clone(), authorizer.clone(), authenticated_tx);
                let config = config.clone();
                let connection_shutdown_token = shutdown_token.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let handshake = tokio::time::timeout(
                        limits::AUTHENTICATION_TIMEOUT,
                        russh::server::run_stream(config, socket, handler),
                    );
                    tokio::pin!(handshake);
                    let handshake_result = tokio::select! {
                        biased;
                        _ = connection_shutdown_token.cancelled() => {
                            let _ = shutdown_socket.shutdown(Shutdown::Both);
                            return;
                        }
                        result = &mut handshake => result,
                    };
                    match handshake_result {
                        Ok(Ok(running)) => {
                            monitor_session(
                                running,
                                authenticated_rx,
                                connection_shutdown_token,
                                shutdown_socket,
                                peer_addr,
                            )
                            .await;
                        }
                        Ok(Err(error)) => {
                            debug!(%peer_addr, %error, "SSH handshake failed");
                        }
                        Err(_) => warn!(%peer_addr, "SSH identification exchange timed out"),
                    }
                });
            }
            Err(error) => {
                warn!(%error, "SSH accept failed");
                tokio::select! {
                    _ = shutdown_token.cancelled() => break,
                    _ = backoff.wait() => {}
                }
            }
        }
    }
    debug!("embedded SSH accept loop stopped");
}

async fn monitor_session(
    mut running: russh::server::RunningSession<server::SshConnection>,
    mut authenticated: tokio::sync::oneshot::Receiver<()>,
    shutdown_token: CancellationToken,
    shutdown_socket: std::net::TcpStream,
    peer_addr: SocketAddr,
) {
    let handle = running.handle();
    tokio::select! {
        biased;
        result = &mut running => {
            if let Err(error) = result {
                debug!(%peer_addr, %error, "SSH session ended");
            }
        }
        result = &mut authenticated => {
            if result.is_err() {
                debug!(%peer_addr, "SSH session ended before authentication completed");
                if let Err(error) = running.await {
                    debug!(%peer_addr, %error, "SSH session ended");
                }
                return;
            }

            tokio::select! {
                result = &mut running => {
                    if let Err(error) = result {
                        debug!(%peer_addr, %error, "SSH session ended");
                    }
                }
                _ = shutdown_token.cancelled() => {
                    disconnect_transport(&handle, &shutdown_socket, "guest shutdown").await;
                    if let Err(error) = running.await {
                        debug!(%peer_addr, %error, "SSH session ended during guest shutdown");
                    }
                }
            }
        }
        _ = shutdown_token.cancelled() => {
            disconnect_transport(&handle, &shutdown_socket, "guest shutdown").await;
            if let Err(error) = running.await {
                debug!(%peer_addr, %error, "pre-authentication SSH session ended during shutdown");
            }
        }
        _ = tokio::time::sleep(limits::AUTHENTICATION_TIMEOUT) => {
            warn!(%peer_addr, "SSH authentication timed out");
            disconnect_transport(&handle, &shutdown_socket, "authentication timeout").await;
            if let Err(error) = running.await {
                debug!(%peer_addr, %error, "SSH session ended after authentication timeout");
            }
        }
    }
}

async fn disconnect_transport(
    handle: &russh::server::Handle,
    shutdown_socket: &std::net::TcpStream,
    reason: &'static str,
) {
    let disconnect = handle.disconnect(
        russh::Disconnect::ByApplication,
        reason.into(),
        String::new(),
    );
    let _ = tokio::time::timeout(limits::DISCONNECT_GRACE_TIMEOUT, disconnect).await;
    if let Err(error) = shutdown_socket.shutdown(Shutdown::Both) {
        debug!(%error, reason, "failed to shut down SSH transport");
    }
}

fn socket_with_shutdown_handle(
    socket: tokio::net::TcpStream,
) -> std::io::Result<(tokio::net::TcpStream, std::net::TcpStream)> {
    let socket = socket.into_std()?;
    let shutdown_socket = socket.try_clone()?;
    let socket = tokio::net::TcpStream::from_std(socket)?;
    Ok((socket, shutdown_socket))
}

#[cfg(test)]
mod tests;
