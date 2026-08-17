#![cfg(target_os = "linux")]
//! CA-authenticated SSH server embedded in `boxlite-guest`.
//!
//! The listener is opt-in and is reached through BoxLite's existing direct
//! TCP tunnel. Session processes and the OCI-contained SFTP helper are
//! delegated through the existing guest Execution service; TCP forwarding
//! uses the network namespace shared by the guest and its one container.

mod auth;
mod backoff;
mod bridge;
mod control;
mod forward;
mod host_key;
mod limits;
mod reverse_streamlocal;
mod server;
mod session;
mod sftp;
mod streamlocal;
mod workload;

pub(crate) use workload::{BoxliteWorkloadExecutor, SshWorkload};

use crate::service::server::GuestServer;
use auth::CertificateAuthorizer;
use backoff::Backoff;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use russh::keys::HashAlg;
use std::net::{Shutdown, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, Weak};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

/// Materialize the persistent SSH host key during guest startup.
///
/// A listener is configured later over RPC, and clients pin this identity in
/// `known_hosts`. Preparing it here preserves the stable key across listener
/// reconfiguration; `load_or_create` remains the lazy fallback.
pub(crate) fn provision_host_key() -> BoxliteResult<()> {
    host_key::load_or_create(&host_key::default_path())
        .map(|_| ())
        .map_err(|error| {
            BoxliteError::Internal(format!("failed to provision SSH host key: {error}"))
        })
}

#[derive(Clone)]
pub(crate) struct SshConfig {
    listen_addr: SocketAddr,
    authorizer: Arc<CertificateAuthorizer>,
    host_key_path: PathBuf,
}

impl SshConfig {
    pub(crate) fn new(
        listen_addr: SocketAddr,
        ca_public_key: impl AsRef<str>,
        principal: impl Into<String>,
    ) -> BoxliteResult<Self> {
        let authorizer = CertificateAuthorizer::new(ca_public_key.as_ref(), principal)
            .map_err(|error| BoxliteError::Config(error.to_string()))?;
        Ok(Self {
            listen_addr,
            authorizer: Arc::new(authorizer),
            host_key_path: host_key::default_path(),
        })
    }

    #[cfg(test)]
    fn with_host_key_path(mut self, host_key_path: PathBuf) -> Self {
        self.host_key_path = host_key_path;
        self
    }
}

/// Public state returned by the SSH control plane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SshRuntimeStatus {
    pub enabled: bool,
    pub listen_addr: Option<SocketAddr>,
    pub generation: u64,
    pub host_key_fingerprint: Option<String>,
}

/// Owns the live SSH listener independently from guest initialization.
///
/// The accept loop receives policy epochs through a watch channel. Policy is
/// committed when authentication succeeds: rotation closes earlier transports
/// that are still unauthenticated, while authenticated sessions retain their
/// identity snapshot.
pub(crate) struct SshManager {
    guest: OnceLock<Weak<GuestServer>>,
    state: Mutex<ManagerState>,
    /// Authentication epoch shared by every listener generation. Updating it
    /// wakes pre-authentication transports so revoked credentials cannot be
    /// used through a connection opened before rotation or disable.
    policy_tx: watch::Sender<Option<Arc<CertificateAuthorizer>>>,
    /// One connection budget spans live listener rebinds. Existing sessions
    /// may drain across a rebind without multiplying the configured bound.
    connection_permits: Arc<tokio::sync::Semaphore>,
    /// Guest shutdown is terminal and closes established transports; ordinary
    /// Disable intentionally leaves authenticated connections draining.
    shutdown_tx: watch::Sender<bool>,
}

impl Default for SshManager {
    fn default() -> Self {
        let (policy_tx, _) = watch::channel(None);
        let (shutdown_tx, _) = watch::channel(false);
        Self {
            guest: OnceLock::new(),
            state: Mutex::new(ManagerState::default()),
            policy_tx,
            connection_permits: Arc::new(tokio::sync::Semaphore::new(limits::MAX_CONNECTIONS)),
            shutdown_tx,
        }
    }
}

#[derive(Default)]
struct ManagerState {
    generation: u64,
    listener: Option<RunningListener>,
}

struct RunningListener {
    requested_addr: SocketAddr,
    bound_addr: SocketAddr,
    host_key_fingerprint: String,
    config: Arc<russh::server::Config>,
    authorizer: Arc<CertificateAuthorizer>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl RunningListener {
    async fn stop(mut self) -> StoppedListener {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        if let Err(error) = self.task.await {
            warn!(%error, "SSH listener task failed while stopping");
        }
        StoppedListener {
            requested_addr: self.requested_addr,
            host_key_fingerprint: self.host_key_fingerprint,
            config: self.config,
            authorizer: self.authorizer,
        }
    }
}

struct StoppedListener {
    requested_addr: SocketAddr,
    host_key_fingerprint: String,
    config: Arc<russh::server::Config>,
    authorizer: Arc<CertificateAuthorizer>,
}

struct PreparedListener {
    config: Arc<russh::server::Config>,
    host_key_fingerprint: String,
}

#[derive(Clone)]
struct ConnectionContext {
    guest: Arc<GuestServer>,
    policy_rx: watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
    permits: Arc<tokio::sync::Semaphore>,
    guest_shutdown_rx: watch::Receiver<bool>,
}

#[derive(Debug)]
pub(crate) enum SshStartError {
    NotAttached,
    ShuttingDown,
    HostKey(host_key::HostKeyError),
    Bind(std::io::Error),
    Rebind {
        replacement: std::io::Error,
        rollback: std::io::Error,
    },
}

impl std::fmt::Display for SshStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAttached => write!(f, "SSH manager is not attached to the guest server"),
            Self::ShuttingDown => write!(f, "guest shutdown has started; SSH cannot be configured"),
            Self::HostKey(error) => write!(f, "{error}"),
            Self::Bind(error) => write!(f, "failed to bind SSH listener: {error}"),
            Self::Rebind {
                replacement,
                rollback,
            } => write!(
                f,
                "failed to bind replacement SSH listener ({replacement}) and restore the previous listener ({rollback})"
            ),
        }
    }
}

impl std::error::Error for SshStartError {}

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
    /// Attach the manager after `GuestServer` has been wrapped in its serving
    /// `Arc`. The weak reference avoids a server/manager ownership cycle.
    pub(crate) fn attach_guest(&self, guest: &Arc<GuestServer>) {
        let _ = self.guest.set(Arc::downgrade(guest));
    }

    pub(crate) async fn configure(
        &self,
        ssh: SshConfig,
    ) -> Result<SshRuntimeStatus, SshStartError> {
        let guest = self
            .guest
            .get()
            .and_then(Weak::upgrade)
            .ok_or(SshStartError::NotAttached)?;
        let mut state = self.state.lock().await;

        // This check shares the listener-state critical section with every
        // mutation. A Configure queued behind shutdown therefore cannot reopen
        // the listener after teardown has disabled it.
        if *self.shutdown_tx.borrow()
            || guest
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(SshStartError::ShuttingDown);
        }

        // Updating policy on the same fixed socket does not disrupt the
        // listener. Pre-authentication connections observe the new epoch and
        // are closed; authenticated connections keep their established policy.
        let can_update_in_place = ssh.listen_addr.port() != 0
            && state
                .listener
                .as_ref()
                .is_some_and(|listener| listener.requested_addr == ssh.listen_addr);
        if can_update_in_place {
            state.generation = state.generation.saturating_add(1);
            let listener = state.listener.as_mut().expect("listener checked above");
            listener.authorizer = ssh.authorizer.clone();
            self.policy_tx.send_replace(Some(ssh.authorizer));
            info!(
                listen_addr = %ssh.listen_addr,
                generation = state.generation,
                "embedded SSH authentication policy updated"
            );
            return Ok(runtime_status(&state));
        }

        let prepared = prepare_listener(&ssh).await?;
        let mut listener_result = TcpListener::bind(ssh.listen_addr).await;
        let mut stopped_listener = None;

        // Switching between overlapping wildcard/specific bindings on the
        // same port cannot be prepared concurrently. Stop our old listener and
        // retry once; other bind failures leave the old listener untouched.
        if listener_result
            .as_ref()
            .is_err_and(|error| error.kind() == std::io::ErrorKind::AddrInUse)
            && state.listener.as_ref().is_some_and(|listener| {
                listen_addresses_overlap(listener.bound_addr, ssh.listen_addr)
            })
        {
            if let Some(listener) = state.listener.take() {
                stopped_listener = Some(listener.stop().await);
            }
            listener_result = TcpListener::bind(ssh.listen_addr).await;
        }

        let listener = match listener_result {
            Ok(listener) => listener,
            Err(replacement) => {
                let Some(previous) = stopped_listener else {
                    return Err(SshStartError::Bind(replacement));
                };
                match restart_listener(
                    previous,
                    self.policy_tx.subscribe(),
                    self.connection_permits.clone(),
                    self.shutdown_tx.subscribe(),
                    guest.clone(),
                )
                .await
                {
                    Ok(restored) => {
                        state.listener = Some(restored);
                        return Err(SshStartError::Bind(replacement));
                    }
                    Err(rollback) => {
                        // No listener remains to own the old policy. Revoke it
                        // explicitly so transports accepted by the stopped
                        // generation cannot authenticate against stale state.
                        self.policy_tx.send_replace(None);
                        state.generation = state.generation.saturating_add(1);
                        return Err(SshStartError::Rebind {
                            replacement,
                            rollback,
                        });
                    }
                }
            }
        };
        let previous_authorizer = state
            .listener
            .as_ref()
            .map(|listener| listener.authorizer.clone())
            .or_else(|| {
                stopped_listener
                    .as_ref()
                    .map(|listener| listener.authorizer.clone())
            });
        let next_authorizer = ssh.authorizer;
        self.policy_tx.send_replace(Some(next_authorizer.clone()));
        let running = match start_listener(
            listener,
            ssh.listen_addr,
            prepared.config,
            prepared.host_key_fingerprint,
            next_authorizer,
            ConnectionContext {
                guest,
                policy_rx: self.policy_tx.subscribe(),
                permits: self.connection_permits.clone(),
                guest_shutdown_rx: self.shutdown_tx.subscribe(),
            },
        ) {
            Ok(running) => running,
            Err(replacement) => {
                self.policy_tx.send_replace(previous_authorizer);
                let Some(previous) = stopped_listener else {
                    return Err(SshStartError::Bind(replacement));
                };
                match restart_listener(
                    previous,
                    self.policy_tx.subscribe(),
                    self.connection_permits.clone(),
                    self.shutdown_tx.subscribe(),
                    self.guest
                        .get()
                        .and_then(Weak::upgrade)
                        .ok_or(SshStartError::NotAttached)?,
                )
                .await
                {
                    Ok(restored) => {
                        state.listener = Some(restored);
                        return Err(SshStartError::Bind(replacement));
                    }
                    Err(rollback) => {
                        self.policy_tx.send_replace(None);
                        state.generation = state.generation.saturating_add(1);
                        return Err(SshStartError::Rebind {
                            replacement,
                            rollback,
                        });
                    }
                }
            }
        };
        let bound_addr = running.bound_addr;
        let fingerprint = running.host_key_fingerprint.clone();

        let previous = state.listener.replace(running);
        state.generation = state.generation.saturating_add(1);
        if let Some(previous) = previous {
            let _ = previous.stop().await;
        }
        info!(
            %bound_addr,
            fingerprint = %fingerprint,
            generation = state.generation,
            "embedded SSH listener ready"
        );
        Ok(runtime_status(&state))
    }

    pub(crate) async fn status(&self) -> SshRuntimeStatus {
        let state = self.state.lock().await;
        runtime_status(&state)
    }

    pub(crate) async fn disable(&self) -> SshRuntimeStatus {
        let mut state = self.state.lock().await;
        // This is unconditional because a failed listener rollback can leave
        // accepted pre-authentication transports even though no listener is
        // present in ManagerState.
        self.policy_tx.send_replace(None);
        if let Some(listener) = state.listener.take() {
            let _ = listener.stop().await;
            state.generation = state.generation.saturating_add(1);
            info!(
                generation = state.generation,
                "embedded SSH listener disabled"
            );
        }
        runtime_status(&state)
    }

    /// Terminal guest teardown: stop accepts, revoke pre-auth transports, close
    /// authenticated sessions, and wait for their handlers to release the
    /// shared connection budget before the execution registry is snapshotted.
    pub(crate) async fn shutdown(&self) -> Result<SshRuntimeStatus, SshShutdownError> {
        self.shutdown_tx.send_replace(true);
        let status = self.disable().await;
        let all_connections = self
            .connection_permits
            .clone()
            .acquire_many_owned(limits::MAX_CONNECTIONS as u32);
        match tokio::time::timeout(limits::CONTROL_CALL_TIMEOUT, all_connections).await {
            Ok(Ok(_permit)) => Ok(status),
            Ok(Err(_)) => Err(SshShutdownError::ConnectionBudgetClosed),
            Err(_) => Err(SshShutdownError::TimedOut),
        }
    }

    /// Force the next `shutdown` to fail without waiting out its timeout, so
    /// callers can be tested against a degraded quiesce.
    #[cfg(test)]
    pub(crate) fn close_connection_budget_for_test(&self) {
        self.connection_permits.close();
    }
}

fn start_listener(
    listener: TcpListener,
    requested_addr: SocketAddr,
    config: Arc<russh::server::Config>,
    host_key_fingerprint: String,
    authorizer: Arc<CertificateAuthorizer>,
    context: ConnectionContext,
) -> std::io::Result<RunningListener> {
    let bound_addr = listener.local_addr()?;
    let (shutdown_tx, listener_shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(accept_loop(
        listener,
        config.clone(),
        context,
        listener_shutdown_rx,
    ));
    Ok(RunningListener {
        requested_addr,
        bound_addr,
        host_key_fingerprint,
        config,
        authorizer,
        shutdown_tx: Some(shutdown_tx),
        task,
    })
}

async fn restart_listener(
    previous: StoppedListener,
    policy_rx: watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
    connection_permits: Arc<tokio::sync::Semaphore>,
    guest_shutdown_rx: watch::Receiver<bool>,
    guest: Arc<GuestServer>,
) -> std::io::Result<RunningListener> {
    let listener = TcpListener::bind(previous.requested_addr).await?;
    let context = ConnectionContext {
        guest,
        policy_rx,
        permits: connection_permits,
        guest_shutdown_rx,
    };
    start_listener(
        listener,
        previous.requested_addr,
        previous.config,
        previous.host_key_fingerprint,
        previous.authorizer,
        context,
    )
}

fn runtime_status(state: &ManagerState) -> SshRuntimeStatus {
    match &state.listener {
        Some(listener) => SshRuntimeStatus {
            enabled: true,
            listen_addr: Some(listener.bound_addr),
            generation: state.generation,
            host_key_fingerprint: Some(listener.host_key_fingerprint.clone()),
        },
        None => SshRuntimeStatus {
            enabled: false,
            listen_addr: None,
            generation: state.generation,
            host_key_fingerprint: None,
        },
    }
}

fn listen_addresses_overlap(current: SocketAddr, next: SocketAddr) -> bool {
    current.port() == next.port()
        && (current.ip() == next.ip()
            || current.ip().is_unspecified()
            || next.ip().is_unspecified())
}

async fn prepare_listener(ssh: &SshConfig) -> Result<PreparedListener, SshStartError> {
    let host_key = host_key::load_or_create(&ssh.host_key_path).map_err(SshStartError::HostKey)?;
    let host_key_fingerprint = host_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let config = Arc::new(server::build_config(host_key));
    Ok(PreparedListener {
        config,
        host_key_fingerprint,
    })
}

async fn accept_loop(
    listener: TcpListener,
    config: Arc<russh::server::Config>,
    context: ConnectionContext,
    mut listener_shutdown_rx: oneshot::Receiver<()>,
) {
    let ConnectionContext {
        guest,
        policy_rx,
        permits,
        mut guest_shutdown_rx,
    } = context;
    let mut backoff = Backoff::new();

    loop {
        let accepted = tokio::select! {
            _ = &mut listener_shutdown_rx => break,
            _ = wait_for_shutdown(&mut guest_shutdown_rx) => break,
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
                let mut connection_policy_rx = policy_rx.clone();
                let authorizer = connection_policy_rx.borrow_and_update().clone();
                let Some(authorizer) = authorizer else {
                    debug!(%peer_addr, "SSH connection rejected while listener policy is disabled");
                    continue;
                };
                let handler = server::SshConnection::new(
                    guest.clone(),
                    authorizer,
                    connection_policy_rx.clone(),
                    authenticated_tx,
                );
                let config = config.clone();
                let mut connection_shutdown_rx = guest_shutdown_rx.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let handshake = tokio::time::timeout(
                        limits::AUTHENTICATION_TIMEOUT,
                        russh::server::run_stream(config, socket, handler),
                    );
                    tokio::pin!(handshake);
                    let handshake_result = tokio::select! {
                        biased;
                        _ = wait_for_shutdown(&mut connection_shutdown_rx) => {
                            let _ = shutdown_socket.shutdown(Shutdown::Both);
                            return;
                        }
                        _ = connection_policy_rx.changed() => {
                            // This transport has not authenticated yet. Any
                            // policy epoch change revokes its accepted snapshot.
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
                                connection_policy_rx,
                                connection_shutdown_rx,
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
                    _ = &mut listener_shutdown_rx => break,
                    _ = wait_for_shutdown(&mut guest_shutdown_rx) => break,
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
    mut policy_rx: watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
    mut shutdown_rx: watch::Receiver<bool>,
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

            // The certificate callback sent this signal while holding the
            // current policy epoch's read lock. Authentication is now the
            // snapshot boundary: later credential rotation does not revoke
            // this identity, while guest shutdown still closes the transport.
            tokio::select! {
                result = &mut running => {
                    if let Err(error) = result {
                        debug!(%peer_addr, %error, "SSH session ended");
                    }
                }
                _ = wait_for_shutdown(&mut shutdown_rx) => {
                    disconnect_transport(&handle, &shutdown_socket, "guest shutdown").await;
                    if let Err(error) = running.await {
                        debug!(%peer_addr, %error, "SSH session ended during guest shutdown");
                    }
                }
            }
        }
        _ = policy_rx.changed() => {
            disconnect_transport(&handle, &shutdown_socket, "SSH authentication policy changed").await;
            if let Err(error) = running.await {
                debug!(%peer_addr, %error, "pre-authentication SSH session ended after policy change");
            }
        }
        _ = wait_for_shutdown(&mut shutdown_rx) => {
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

/// Lock the connection's accepted policy epoch for an atomic authentication
/// commit. `Ref::has_changed` detects replacement even when rollback restores
/// the same `Arc`, while retaining the guard orders a later policy publication
/// after the caller's commit signal.
pub(super) fn authentication_policy_guard<'a>(
    policy_rx: &'a watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
    accepted_authorizer: &Arc<CertificateAuthorizer>,
) -> Option<watch::Ref<'a, Option<Arc<CertificateAuthorizer>>>> {
    let current = policy_rx.borrow();
    if current.has_changed()
        || !current
            .as_ref()
            .is_some_and(|authorizer| Arc::ptr_eq(authorizer, accepted_authorizer))
    {
        None
    } else {
        Some(current)
    }
}

#[cfg(test)]
fn authentication_policy_is_current(
    policy_rx: &mut watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
    accepted_authorizer: &Arc<CertificateAuthorizer>,
) -> bool {
    authentication_policy_guard(policy_rx, accepted_authorizer).is_some()
}

async fn wait_for_shutdown(shutdown_rx: &mut watch::Receiver<bool>) {
    if *shutdown_rx.borrow() {
        return;
    }
    while shutdown_rx.changed().await.is_ok() {
        if *shutdown_rx.borrow() {
            return;
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
mod tests {
    use super::*;
    use crate::layout::GuestLayout;
    use russh::keys::ssh_key::certificate::{Builder, CertType};
    use russh::keys::{Algorithm, Certificate, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::AsyncReadExt;

    fn private_key() -> PrivateKey {
        let mut rng = russh::keys::key::safe_rng();
        PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap()
    }

    fn ca_public_key() -> String {
        private_key().public_key().to_openssh().unwrap()
    }

    fn user_certificate(ca_key: &PrivateKey, principal: &str) -> (Arc<PrivateKey>, Certificate) {
        let subject_key = Arc::new(private_key());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut rng = russh::keys::key::safe_rng();
        let mut builder = Builder::new_with_random_nonce(
            &mut rng,
            subject_key.public_key(),
            now.saturating_sub(60),
            now.saturating_add(60),
        )
        .unwrap();
        builder.cert_type(CertType::User).unwrap();
        builder.key_id("boxlite-test").unwrap();
        builder.valid_principal(principal).unwrap();
        builder.extension("permit-pty", "").unwrap();
        builder.extension("permit-port-forwarding", "").unwrap();
        (subject_key, builder.sign(ca_key).unwrap())
    }

    #[derive(Clone)]
    struct TrustTestHostKey;

    impl russh::client::Handler for TrustTestHostKey {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            _server_public_key: &PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn connect_test_client(address: SocketAddr) -> russh::client::Handle<TrustTestHostKey> {
        tokio::time::timeout(
            Duration::from_secs(2),
            russh::client::connect(
                Arc::new(russh::client::Config::default()),
                address,
                TrustTestHostKey,
            ),
        )
        .await
        .expect("SSH handshake timed out")
        .expect("SSH handshake failed")
    }

    async fn wait_for_available_connection_permits(manager: &SshManager, expected: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if manager.connection_permits.available_permits() == expected {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "timed out waiting for {expected} available SSH connection permits; found {}",
                manager.connection_permits.available_permits()
            )
        });
    }

    #[test]
    fn ssh_config_is_disabled_by_absence_and_rejects_bad_auth_inputs() {
        let address = "127.0.0.1:0".parse().unwrap();
        assert!(SshConfig::new(address, "not a key", "box_123").is_err());
        assert!(SshConfig::new(address, ca_public_key(), "../box").is_err());
    }

    #[test]
    fn tests_can_redirect_the_host_key_without_changing_production_default() {
        let address = "127.0.0.1:0".parse().unwrap();
        let path = PathBuf::from("/tmp/test-host-key");
        let config = SshConfig::new(address, ca_public_key(), "box_123")
            .unwrap()
            .with_host_key_path(path.clone());
        assert_eq!(config.host_key_path, path);
        assert_eq!(
            host_key::default_path(),
            PathBuf::from(host_key::DEFAULT_HOST_KEY_PATH)
        );
    }

    #[test]
    fn authentication_commit_rejects_a_replaced_or_disabled_policy_epoch() {
        let accepted = Arc::new(CertificateAuthorizer::new(&ca_public_key(), "box_123").unwrap());
        let (policy_tx, mut policy_rx) = watch::channel(Some(accepted.clone()));
        assert!(authentication_policy_is_current(&mut policy_rx, &accepted));

        let replacement =
            Arc::new(CertificateAuthorizer::new(&ca_public_key(), "box_456").unwrap());
        policy_tx.send_replace(Some(replacement));
        assert!(!authentication_policy_is_current(&mut policy_rx, &accepted));

        policy_tx.send_replace(None);
        assert!(!authentication_policy_is_current(&mut policy_rx, &accepted));

        let (policy_tx, mut policy_rx) = watch::channel(Some(accepted.clone()));
        policy_tx.send_replace(Some(Arc::new(
            CertificateAuthorizer::new(&ca_public_key(), "box_789").unwrap(),
        )));
        policy_tx.send_replace(Some(accepted.clone()));
        assert!(
            !authentication_policy_is_current(&mut policy_rx, &accepted),
            "a policy replacement followed by rollback is still a new epoch"
        );
    }

    #[tokio::test]
    async fn disable_revokes_policy_even_without_a_running_listener() {
        let manager = SshManager::default();
        let authorizer = Arc::new(CertificateAuthorizer::new(&ca_public_key(), "box_123").unwrap());
        manager.policy_tx.send_replace(Some(authorizer));

        let status = manager.disable().await;

        assert!(!status.enabled);
        assert!(manager.policy_tx.borrow().is_none());
    }

    #[tokio::test]
    async fn shutdown_handle_forces_a_live_transport_to_finish() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let peer = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let (mut socket, shutdown_socket) = socket_with_shutdown_handle(socket).unwrap();

        shutdown_socket.shutdown(Shutdown::Both).unwrap();
        let mut byte = [0_u8; 1];
        let read_result =
            tokio::time::timeout(std::time::Duration::from_secs(1), socket.read(&mut byte)).await;

        assert!(read_result.is_ok(), "local shutdown must unblock the read");
        drop(peer);
    }

    #[tokio::test]
    async fn manager_reconfigures_in_place_and_releases_listener_on_disable() {
        let port_guard = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = port_guard.local_addr().unwrap();
        drop(port_guard);
        let host_key_dir = tempfile::tempdir().unwrap();
        let host_key_path = host_key_dir.path().join("ssh_host_ed25519_key");

        let guest = Arc::new(GuestServer::new(GuestLayout::new()));
        guest.ssh_manager.attach_guest(&guest);
        let first = guest
            .ssh_manager
            .configure(
                SshConfig::new(address, ca_public_key(), "box_123")
                    .unwrap()
                    .with_host_key_path(host_key_path),
            )
            .await
            .unwrap();
        let second = guest
            .ssh_manager
            .configure(SshConfig::new(address, ca_public_key(), "box_456").unwrap())
            .await
            .unwrap();

        assert!(first.enabled);
        assert_eq!(first.listen_addr, Some(address));
        assert_eq!(second.listen_addr, first.listen_addr);
        assert_eq!(second.generation, first.generation + 1);

        let disabled = guest.ssh_manager.disable().await;
        assert!(!disabled.enabled);
        assert_eq!(disabled.generation, second.generation + 1);
        assert_eq!(guest.ssh_manager.disable().await, disabled);
        let _rebound = TcpListener::bind(address).await.unwrap();
    }

    #[tokio::test]
    async fn wire_auth_rotation_disable_and_shutdown_have_distinct_lifecycles() {
        let port_guard = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = port_guard.local_addr().unwrap();
        drop(port_guard);
        let host_key_dir = tempfile::tempdir().unwrap();
        let host_key_path = host_key_dir.path().join("ssh_host_ed25519_key");
        let ca_a = private_key();
        let ca_b = private_key();
        let (subject_a, certificate_a) = user_certificate(&ca_a, "box_123");
        let (subject_b, certificate_b) = user_certificate(&ca_b, "box_456");

        let guest = Arc::new(GuestServer::new(GuestLayout::new()));
        guest.ssh_manager.attach_guest(&guest);
        guest
            .ssh_manager
            .configure(
                SshConfig::new(address, ca_a.public_key().to_openssh().unwrap(), "box_123")
                    .unwrap()
                    .with_host_key_path(host_key_path.clone()),
            )
            .await
            .unwrap();

        let mut authenticated_a = connect_test_client(address).await;
        let raw_key_result = authenticated_a
            .authenticate_publickey(
                "root",
                PrivateKeyWithHashAlg::new(Arc::new(private_key()), None),
            )
            .await
            .unwrap();
        assert!(!raw_key_result.success(), "raw user keys must be rejected");
        assert!(
            authenticated_a
                .authenticate_openssh_cert("root", subject_a.clone(), certificate_a.clone())
                .await
                .unwrap()
                .success(),
            "the configured CA certificate must authenticate"
        );

        let mut pre_rotation = connect_test_client(address).await;
        wait_for_available_connection_permits(&guest.ssh_manager, limits::MAX_CONNECTIONS - 2)
            .await;
        guest
            .ssh_manager
            .configure(
                SshConfig::new(address, ca_b.public_key().to_openssh().unwrap(), "box_456")
                    .unwrap(),
            )
            .await
            .unwrap();
        wait_for_available_connection_permits(&guest.ssh_manager, limits::MAX_CONNECTIONS - 1)
            .await;

        let stale_auth = tokio::time::timeout(
            Duration::from_secs(2),
            pre_rotation.authenticate_openssh_cert("root", subject_a, certificate_a),
        )
        .await
        .expect("a pre-rotation transport must be closed promptly");
        assert!(
            stale_auth.is_err() || !stale_auth.unwrap().success(),
            "a connection opened under the old CA must not authenticate after rotation"
        );

        let channel = authenticated_a
            .channel_open_session()
            .await
            .expect("an already-authenticated connection must survive rotation");
        channel.close().await.unwrap();

        let mut authenticated_b = connect_test_client(address).await;
        assert!(
            authenticated_b
                .authenticate_openssh_cert("root", subject_b.clone(), certificate_b.clone())
                .await
                .unwrap()
                .success(),
            "new connections must use the rotated CA and principal"
        );

        let disabled = guest.ssh_manager.disable().await;
        assert!(!disabled.enabled);
        let channel = authenticated_b
            .channel_open_session()
            .await
            .expect("Disable must allow authenticated connections to drain");
        channel.close().await.unwrap();
        assert!(
            tokio::net::TcpStream::connect(address).await.is_err(),
            "Disable must stop new TCP accepts"
        );

        authenticated_a
            .disconnect(russh::Disconnect::ByApplication, "test complete", "")
            .await
            .unwrap();
        authenticated_b
            .disconnect(russh::Disconnect::ByApplication, "test complete", "")
            .await
            .unwrap();
        drop(authenticated_a);
        drop(authenticated_b);
        drop(pre_rotation);
        wait_for_available_connection_permits(&guest.ssh_manager, limits::MAX_CONNECTIONS).await;

        guest
            .ssh_manager
            .configure(
                SshConfig::new(address, ca_b.public_key().to_openssh().unwrap(), "box_456")
                    .unwrap()
                    .with_host_key_path(host_key_path),
            )
            .await
            .unwrap();
        let mut shutdown_client = connect_test_client(address).await;
        assert!(shutdown_client
            .authenticate_openssh_cert("root", subject_b, certificate_b)
            .await
            .unwrap()
            .success());

        guest
            .shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        guest.ssh_manager.shutdown().await.unwrap();
        wait_for_available_connection_permits(&guest.ssh_manager, limits::MAX_CONNECTIONS).await;
        assert!(shutdown_client.channel_open_session().await.is_err());
        assert!(matches!(
            guest
                .ssh_manager
                .configure(
                    SshConfig::new(address, ca_public_key(), "box_789")
                        .unwrap()
                        .with_host_key_path(host_key_dir.path().join("other-host-key")),
                )
                .await,
            Err(SshStartError::ShuttingDown)
        ));
    }

    #[tokio::test]
    async fn wire_rejected_session_requests_close_the_accepted_channel() {
        let port_guard = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = port_guard.local_addr().unwrap();
        drop(port_guard);
        let host_key_dir = tempfile::tempdir().unwrap();
        let ca_key = private_key();
        let (subject_key, certificate) = user_certificate(&ca_key, "box_123");
        let guest = Arc::new(GuestServer::new(GuestLayout::new()));
        guest.ssh_manager.attach_guest(&guest);
        guest
            .ssh_manager
            .configure(
                SshConfig::new(
                    address,
                    ca_key.public_key().to_openssh().unwrap(),
                    "box_123",
                )
                .unwrap()
                .with_host_key_path(host_key_dir.path().join("ssh_host_ed25519_key")),
            )
            .await
            .unwrap();

        let mut client = connect_test_client(address).await;
        assert!(client
            .authenticate_openssh_cert("root", subject_key, certificate)
            .await
            .unwrap()
            .success());

        let mut invalid_exec = client.channel_open_session().await.unwrap();
        invalid_exec
            .exec(true, b"bad\0command".to_vec())
            .await
            .unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), invalid_exec.wait())
                .await
                .expect("invalid exec must receive a failure reply"),
            Some(russh::ChannelMsg::Failure)
        ));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), invalid_exec.wait())
                .await
                .expect("invalid exec must close its accepted channel"),
            Some(russh::ChannelMsg::Close) | None
        ));

        let mut unsupported_subsystem = client.channel_open_session().await.unwrap();
        unsupported_subsystem
            .request_subsystem(true, "not-sftp")
            .await
            .unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), unsupported_subsystem.wait())
                .await
                .expect("unsupported subsystem must receive a failure reply"),
            Some(russh::ChannelMsg::Failure)
        ));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), unsupported_subsystem.wait())
                .await
                .expect("unsupported subsystem must close its accepted channel"),
            Some(russh::ChannelMsg::Close) | None
        ));

        client
            .disconnect(russh::Disconnect::ByApplication, "test complete", "")
            .await
            .unwrap();
        guest.ssh_manager.disable().await;
    }

    #[tokio::test]
    async fn failed_overlapping_rebind_preserves_the_previous_listener() {
        let port_guard = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = port_guard.local_addr().unwrap().port();
        drop(port_guard);

        // This listener does not conflict with the initial 127.0.0.1 bind,
        // but it keeps a later wildcard bind failing after the manager stops
        // its own socket. That makes the rollback path deterministic.
        let _other_loopback_listener = std::net::TcpListener::bind(("127.0.0.2", port)).unwrap();
        let old_address: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let replacement_address: SocketAddr = format!("0.0.0.0:{port}").parse().unwrap();
        let host_key_dir = tempfile::tempdir().unwrap();
        let host_key_path = host_key_dir.path().join("ssh_host_ed25519_key");

        let guest = Arc::new(GuestServer::new(GuestLayout::new()));
        guest.ssh_manager.attach_guest(&guest);
        let original = guest
            .ssh_manager
            .configure(
                SshConfig::new(old_address, ca_public_key(), "box_123")
                    .unwrap()
                    .with_host_key_path(host_key_path.clone()),
            )
            .await
            .unwrap();

        let replacement = guest
            .ssh_manager
            .configure(
                SshConfig::new(replacement_address, ca_public_key(), "box_456")
                    .unwrap()
                    .with_host_key_path(host_key_path),
            )
            .await;

        assert!(replacement.is_err());
        assert_eq!(guest.ssh_manager.status().await, original);
        assert!(std::net::TcpListener::bind(old_address).is_err());
        guest.ssh_manager.disable().await;
    }

    #[test]
    fn rebind_retry_only_stops_a_listener_that_can_conflict() {
        let loopback: SocketAddr = "127.0.0.1:2200".parse().unwrap();
        let wildcard: SocketAddr = "0.0.0.0:2200".parse().unwrap();
        let other_ip: SocketAddr = "192.0.2.1:2200".parse().unwrap();

        assert!(listen_addresses_overlap(loopback, wildcard));
        assert!(listen_addresses_overlap(wildcard, other_ip));
        assert!(!listen_addresses_overlap(loopback, other_ip));
        assert!(!listen_addresses_overlap(
            loopback,
            "127.0.0.1:2201".parse().unwrap()
        ));
    }
}
