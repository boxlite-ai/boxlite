#![cfg(target_os = "linux")]
//! In-memory SSH control with fully drained server generations.

mod auth;
mod backoff;
mod bridge;
mod control;
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
use tokio_util::task::TaskTracker;
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

/// Serializes control operations and retains timed-out cleanup until it finishes.
pub(crate) struct SshManager {
    guest: OnceLock<Weak<GuestServer>>,
    state: Mutex<SshState>,
    connection_permits: Arc<tokio::sync::Semaphore>,
    shutdown_token: CancellationToken,
    tasks: std::sync::Mutex<TaskTracker>,
}

#[derive(Default)]
struct SshState {
    round: Option<SshRound>,
    status: boxlite_shared::SshStatus,
}

struct SshRound {
    listener: Option<JoinHandle<()>>,
    cancel: CancellationToken,
    tasks: TaskTracker,
}

impl Default for SshManager {
    fn default() -> Self {
        Self {
            guest: OnceLock::new(),
            state: Mutex::new(SshState::default()),
            connection_permits: Arc::new(tokio::sync::Semaphore::new(limits::MAX_CONNECTIONS)),
            shutdown_token: CancellationToken::new(),
            tasks: std::sync::Mutex::new(TaskTracker::new()),
        }
    }
}

struct ConnectionContext {
    guest: Arc<GuestServer>,
    authorizer: Arc<SshAuthorizer>,
    permits: Arc<tokio::sync::Semaphore>,
    shutdown_token: CancellationToken,
    tasks: TaskTracker,
}

#[derive(Debug)]
pub(crate) enum SshShutdownError {
    ConnectionBudgetClosed,
    TimedOut,
    ListenerFailed,
}

impl std::fmt::Display for SshShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ConnectionBudgetClosed => "SSH connection budget closed",
            Self::TimedOut => "timed out waiting for SSH sessions to stop",
            Self::ListenerFailed => "SSH listener task failed while stopping",
        })
    }
}
impl std::error::Error for SshShutdownError {}

impl SshManager {
    pub(crate) fn attach_guest(&self, guest: &Arc<GuestServer>) {
        let _ = self.guest.set(Arc::downgrade(guest));
    }

    // A generation cannot be replaced until every producer of SSH tasks has
    // exited. This also covers cleanup spawned from a russh handler's Drop.
    pub(super) fn tasks(&self) -> TaskTracker {
        self.tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) async fn configure(
        &self,
        config: boxlite_shared::SshConfig,
    ) -> Result<boxlite_shared::SshStatus, Box<tonic::Status>> {
        let config = SshConfig::parse(config)
            .map_err(|error| tonic::Status::invalid_argument(error.to_string()))?;
        let guest = self
            .guest
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| tonic::Status::internal("SSH manager is not attached"))?;
        let mut state = self.state.lock().await;
        if self.shutdown_token.is_cancelled()
            || guest
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(tonic::Status::failed_precondition(
                "guest shutdown has started; SSH cannot start",
            )
            .into());
        }
        self.stop(&mut state).await.map_err(stop_status)?;
        let listener = TcpListener::bind(config.listen_addr)
            .await
            .map_err(|error| {
                tonic::Status::unavailable(format!("failed to bind SSH listener: {error}"))
            })?;
        let address = listener.local_addr().map_err(|error| {
            tonic::Status::internal(format!("failed to read SSH listener address: {error}"))
        })?;
        if self.shutdown_token.is_cancelled()
            || guest
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(tonic::Status::failed_precondition(
                "guest shutdown has started; SSH cannot start",
            )
            .into());
        }
        let public = config.server.keys[0].public_key();
        let host_public_key = russh::keys::PublicKey::new(public.key_data().clone(), "")
            .to_openssh()
            .map_err(|_| tonic::Status::internal("failed to encode SSH host public key"))?;
        let tasks = TaskTracker::new();
        *self
            .tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = tasks.clone();
        let cancel = self.shutdown_token.child_token();
        let context = ConnectionContext {
            guest,
            authorizer: config.authorizer,
            permits: self.connection_permits.clone(),
            shutdown_token: cancel.clone(),
            tasks: tasks.clone(),
        };
        state.status = boxlite_shared::SshStatus {
            enabled: true,
            listen_address: address.to_string(),
            generation: state.status.generation + 1,
            host_public_key,
            host_key_fingerprint: public.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        };
        state.round = Some(SshRound {
            listener: Some(tokio::spawn(accept_loop(listener, config.server, context))),
            cancel,
            tasks,
        });
        info!(%address, generation = state.status.generation, "embedded SSH listener ready");
        Ok(state.status.clone())
    }

    pub(crate) async fn status(&self) -> boxlite_shared::SshStatus {
        let state = self.state.lock().await;
        let mut status = state.status.clone();
        if state.round.as_ref().is_some_and(|round| {
            round.cancel.is_cancelled()
                || round.listener.as_ref().is_none_or(JoinHandle::is_finished)
        }) {
            status.enabled = false;
            status.listen_address.clear();
            status.host_public_key.clear();
            status.host_key_fingerprint.clear();
        }
        status
    }

    pub(crate) async fn disable(&self) -> Result<boxlite_shared::SshStatus, Box<tonic::Status>> {
        let mut state = self.state.lock().await;
        self.stop(&mut state).await.map_err(stop_status)?;
        Ok(state.status.clone())
    }

    async fn stop(&self, state: &mut SshState) -> Result<(), SshShutdownError> {
        state.status = boxlite_shared::SshStatus {
            generation: state.status.generation,
            ..Default::default()
        };
        let draining = async {
            if let Some(round) = state.round.as_mut() {
                round.cancel.cancel();
                if let Some(listener) = round.listener.as_mut() {
                    let result = listener.await;
                    round.listener = None;
                    if result.is_err() {
                        return Err(SshShutdownError::ListenerFailed);
                    }
                }
                round.tasks.close();
                round.tasks.wait().await;
            }
            let _all = self
                .connection_permits
                .clone()
                .acquire_many_owned(limits::MAX_CONNECTIONS as u32)
                .await
                .map_err(|_| SshShutdownError::ConnectionBudgetClosed)?;
            Ok(())
        };
        tokio::time::timeout(limits::CONTROL_CALL_TIMEOUT, draining)
            .await
            .map_err(|_| SshShutdownError::TimedOut)??;
        state.round = None;
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> Result<(), SshShutdownError> {
        self.shutdown_token.cancel();
        self.stop(&mut *self.state.lock().await).await
    }

    #[cfg(test)]
    pub(crate) fn close_connection_budget_for_test(&self) {
        self.connection_permits.close();
    }
}

fn stop_status(error: SshShutdownError) -> tonic::Status {
    match error {
        SshShutdownError::TimedOut => tonic::Status::deadline_exceeded(error.to_string()),
        other => tonic::Status::internal(other.to_string()),
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
        tasks,
    } = context;
    let mut backoff = Backoff::new();

    loop {
        let accepted = tokio::select! {
            biased;
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
                let handler = server::SshConnection::new(
                    guest.clone(),
                    authorizer.clone(),
                    authenticated_tx,
                    shutdown_token.clone(),
                    tasks.token(),
                );
                let config = config.clone();
                let connection_shutdown_token = shutdown_token.clone();
                tasks.spawn(async move {
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
                    disconnect_transport(&handle, &shutdown_socket, "SSH service stopped").await;
                    if let Err(error) = running.await {
                        debug!(%peer_addr, %error, "SSH session ended while stopping");
                    }
                }
            }
        }
        _ = shutdown_token.cancelled() => {
            disconnect_transport(&handle, &shutdown_socket, "SSH service stopped").await;
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
