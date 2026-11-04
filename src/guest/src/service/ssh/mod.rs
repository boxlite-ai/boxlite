#![cfg(target_os = "linux")]
//! Persistent SSH control with fully drained server generations.

mod auth;
mod backoff;
mod bridge;
mod control;
mod forward;
mod limits;
mod persistence;
mod reverse_streamlocal;
mod server;
mod session;
mod sftp;
mod streamlocal;
mod task_group;
mod workload;

pub(crate) use workload::{BoxliteWorkloadExecutor, SshWorkload};

use crate::service::server::GuestServer;
use auth::SshAuthorizer;
use backoff::Backoff;
use boxlite_shared::constants::ssh::DRAIN_TIMEOUT;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::net::{Shutdown, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock, Weak};
use task_group::TaskGroup;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

pub(super) enum SshUpdate {
    Control(boxlite_shared::SshControlRequest),
    Setup(String),
}

/// Keep host identity in the guest's existing persisted configuration.
fn setup_config(
    client_public_key: String,
    previous: Option<boxlite_shared::SshConfig>,
) -> Result<boxlite_shared::SshConfig, Box<tonic::Status>> {
    let host_private_key = match previous {
        Some(config) => config.host_private_key,
        None => russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .and_then(|key| key.to_openssh(Default::default()))
        .map_err(|_| tonic::Status::internal("SSH host key generation failed"))?
        .to_string(),
    };
    Ok(boxlite_shared::SshConfig {
        listen_address: "0.0.0.0:22".into(),
        host_private_key,
        accounts: vec![boxlite_shared::SshAccount {
            login: "box".into(),
            authorized_keys: vec![client_public_key],
            ca: None,
        }],
    })
}

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
}

#[derive(Default)]
struct SshState {
    config: Option<SshConfig>,
    tasks: Option<Arc<TaskGroup>>,
    listener: Option<JoinHandle<()>>,
    status: boxlite_shared::SshStatus,
    rootfs: Option<PathBuf>,
    #[cfg(test)]
    activation_gate: Option<Arc<ActivationGate>>,
}

#[cfg(test)]
use tests::ActivationGate;

impl Default for SshManager {
    fn default() -> Self {
        Self {
            guest: OnceLock::new(),
            state: Mutex::new(SshState::default()),
            connection_permits: Arc::new(tokio::sync::Semaphore::new(limits::MAX_CONNECTIONS)),
        }
    }
}

impl SshManager {
    pub(crate) fn guest(&self) -> Option<Arc<GuestServer>> {
        self.guest.get().and_then(Weak::upgrade)
    }

    pub(crate) fn attach_guest(&self, guest: &Arc<GuestServer>) {
        let _ = self.guest.set(Arc::downgrade(guest));
    }

    pub(super) async fn control(
        &self,
        update: SshUpdate,
    ) -> Result<boxlite_shared::SshStatus, Box<tonic::Status>> {
        let (enable, config, client_public_key) = match update {
            SshUpdate::Control(request) => (request.enable, request.config, None),
            SshUpdate::Setup(key) => (Some(true), None, Some(key)),
        };
        let guest = self
            .guest()
            .ok_or_else(|| tonic::Status::internal("SSH manager is not attached"))?;
        let mut state = self.state.lock().await;
        if enable.is_none() && config.is_none() {
            return Ok(Self::live_status(&state));
        }
        if guest.shutting_down.load(Ordering::SeqCst) {
            return Err(tonic::Status::failed_precondition("guest is shutting down").into());
        }
        let root = state
            .rootfs
            .clone()
            .ok_or_else(|| tonic::Status::failed_precondition("container rootfs is not ready"))?;
        if enable == Some(false) {
            self.stop(&mut state).await?;
        }
        let supplied = config.is_some() || client_public_key.is_some();
        let mut desired = if enable.is_some() && config.is_some() {
            persistence::DesiredState::default()
        } else {
            let load_root = root.clone();
            tokio::task::spawn_blocking(move || persistence::load(&load_root))
                .await
                .map_err(|_| tonic::Status::internal("SSH state load failed"))?
                .map_err(|_| tonic::Status::internal("SSH state load failed"))?
        };
        // Load, reuse/generate the host key, and persist under one control lock.
        desired.config = match client_public_key {
            Some(key) => Some(setup_config(key, desired.config)?),
            None => config.or(desired.config),
        };
        desired.enable = enable.unwrap_or(desired.enable);
        let parsed = desired
            .config
            .clone()
            .map(SshConfig::parse)
            .transpose()
            .map_err(|error| tonic::Status::invalid_argument(error.to_string()))?;
        if desired.enable && parsed.is_none() {
            return Err(tonic::Status::failed_precondition("SSH configuration is required").into());
        }
        let enabled = desired.enable;
        tokio::task::spawn_blocking(move || persistence::save(&root, &desired))
            .await
            .map_err(|_| tonic::Status::internal("SSH state save failed"))?
            .map_err(|_| tonic::Status::internal("SSH state save failed"))?;
        if !enabled {
            if enable.is_none() {
                self.stop(&mut state).await?;
            }
        } else if supplied || !Self::live_status(&state).enabled {
            self.stop(&mut state).await?;
            if !guest.shutting_down.load(Ordering::SeqCst) {
                #[cfg(test)]
                if let Some(gate) = &state.activation_gate {
                    gate.wait().await;
                }
                self.start(&mut state, parsed.expect("validated config"), guest)
                    .await?;
            }
        }
        Ok(Self::live_status(&state))
    }

    pub(crate) async fn restore(&self, root: PathBuf) -> Result<(), Box<tonic::Status>> {
        let guest = self
            .guest()
            .ok_or_else(|| tonic::Status::internal("SSH manager is not attached"))?;
        let mut state = self.state.lock().await;
        if guest.shutting_down.load(Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(existing) = &state.rootfs {
            return if existing == &root {
                Ok(())
            } else {
                Err(tonic::Status::failed_precondition("SSH rootfs already selected").into())
            };
        }
        state.rootfs = Some(root.clone());
        let desired = tokio::task::spawn_blocking(move || persistence::load(&root))
            .await
            .map_err(|_| tonic::Status::internal("SSH state load failed"))?
            .map_err(|_| tonic::Status::internal("SSH state load failed"))?;
        let parsed = desired
            .config
            .map(SshConfig::parse)
            .transpose()
            .map_err(|_| tonic::Status::invalid_argument("invalid stored SSH configuration"))?;
        if desired.enable {
            let config = parsed.ok_or_else(|| {
                tonic::Status::failed_precondition("stored SSH configuration is missing")
            })?;
            if !guest.shutting_down.load(Ordering::SeqCst) {
                self.start(&mut state, config, guest).await?;
            }
        }
        Ok(())
    }

    async fn start(
        &self,
        state: &mut SshState,
        config: SshConfig,
        guest: Arc<GuestServer>,
    ) -> Result<(), Box<tonic::Status>> {
        let listener = TcpListener::bind(config.listen_addr)
            .await
            .map_err(|error| {
                tonic::Status::unavailable(format!("failed to bind SSH listener: {error}"))
            })?;
        let address = listener.local_addr().map_err(|error| {
            tonic::Status::internal(format!("failed to read SSH listener address: {error}"))
        })?;
        let public = config.server.keys[0].public_key();
        let host_public_key = russh::keys::PublicKey::new(public.key_data().clone(), "")
            .to_openssh()
            .map_err(|_| tonic::Status::internal("failed to encode SSH host public key"))?;
        let tasks = Arc::new(TaskGroup::default());
        state.status = boxlite_shared::SshStatus {
            enabled: true,
            listen_address: address.to_string(),
            generation: state.status.generation + 1,
            host_public_key,
            host_key_fingerprint: public.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        };
        state.config = Some(config);
        state.listener = Some(tasks.spawn(accept_loop(listener, guest)));
        state.tasks = Some(tasks);
        info!(%address, generation = state.status.generation, "embedded SSH listener ready");
        Ok(())
    }

    fn live_status(state: &SshState) -> boxlite_shared::SshStatus {
        let mut status = state.status.clone();
        if state
            .tasks
            .as_ref()
            .is_some_and(|tasks| tasks.is_cancelled())
            || state.listener.as_ref().is_none_or(JoinHandle::is_finished)
        {
            status.enabled = false;
            status.listen_address.clear();
            status.host_public_key.clear();
            status.host_key_fingerprint.clear();
        }
        status
    }

    pub(crate) async fn status(&self) -> boxlite_shared::SshStatus {
        let state = self.state.lock().await;
        Self::live_status(&state)
    }

    pub(crate) async fn shutdown(&self) -> Result<boxlite_shared::SshStatus, Box<tonic::Status>> {
        let mut state = self.state.lock().await;
        self.stop(&mut state).await?;
        Ok(Self::live_status(&state))
    }

    async fn stop(&self, state: &mut SshState) -> Result<(), Box<tonic::Status>> {
        state.status = boxlite_shared::SshStatus {
            generation: state.status.generation,
            ..Default::default()
        };
        if let Some(tasks) = &state.tasks {
            tasks.cancel();
        }
        let draining = async {
            if let Some(tasks) = &state.tasks {
                tasks.wait().await;
            }
            if let Some(listener) = state.listener.as_mut() {
                listener.await
            } else {
                Ok(())
            }
        };
        let listener_result = tokio::time::timeout(DRAIN_TIMEOUT, draining)
            .await
            .map_err(|_| {
                tonic::Status::deadline_exceeded("timed out waiting for SSH sessions to stop")
            })?;
        state.listener = None;
        state.tasks = None;
        state.config = None;
        listener_result
            .map_err(|_| tonic::Status::internal("SSH listener task failed while stopping").into())
    }

    #[cfg(test)]
    pub(crate) async fn pending_cleanup_for_test(
        &self,
    ) -> tokio_util::task::task_tracker::TaskTrackerToken {
        let mut state = self.state.lock().await;
        state
            .tasks
            .get_or_insert_with(|| Arc::new(TaskGroup::default()))
            .token()
    }

    async fn spawn_connection(&self, stream: tokio::net::TcpStream, peer: SocketAddr) {
        let state = self.state.lock().await;
        if !state.status.enabled {
            return;
        }
        let (Some(config), Some(tasks)) = (&state.config, &state.tasks) else {
            return;
        };
        if tasks.is_cancelled() {
            return;
        }
        let Some(guest) = self.guest() else {
            return;
        };
        let Ok(permit) = self.connection_permits.clone().try_acquire_owned() else {
            warn!(%peer, "SSH connection limit reached");
            return;
        };
        let config_server = config.server.clone();
        let authorizer = config.authorizer.clone();
        let connection_tasks = tasks.child();
        connection_tasks
            .clone()
            .spawn_tracked(move |cancel| async move {
                let _permit = permit;
                let (authenticated_tx, authenticated_rx) = tokio::sync::oneshot::channel();
                let handler = server::SshConnection::new(
                    guest,
                    authorizer,
                    authenticated_tx,
                    connection_tasks,
                );
                serve_connection(
                    stream,
                    peer,
                    config_server,
                    handler,
                    authenticated_rx,
                    cancel,
                )
                .await;
            });
    }
}

async fn accept_loop(listener: TcpListener, guest: Arc<GuestServer>) {
    let mut backoff = Backoff::new();
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                backoff.reset();
                guest.ssh_manager.spawn_connection(stream, peer).await;
            }
            Err(error) => {
                warn!(%error, "SSH accept failed");
                backoff.wait().await;
            }
        }
    }
}

async fn serve_connection(
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
    config: Arc<russh::server::Config>,
    handler: server::SshConnection,
    authenticated: tokio::sync::oneshot::Receiver<()>,
    cancel: CancellationToken,
) {
    if let Err(error) = stream.set_nodelay(true) {
        debug!(%peer, %error, "failed to enable TCP_NODELAY for SSH connection");
    }
    let (stream, shutdown_socket) = match socket_with_shutdown_handle(stream) {
        Ok(sockets) => sockets,
        Err(error) => {
            warn!(%peer, %error, "failed to prepare SSH connection socket");
            return;
        }
    };
    let handshake = tokio::time::timeout(
        limits::AUTHENTICATION_TIMEOUT,
        russh::server::run_stream(config, stream, handler),
    );
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            let _ = shutdown_socket.shutdown(Shutdown::Both);
            return;
        }
        result = handshake => result,
    };
    match result {
        Ok(Ok(running)) => {
            monitor_session(running, authenticated, cancel, shutdown_socket, peer).await
        }
        Ok(Err(error)) => debug!(%peer, %error, "SSH handshake failed"),
        Err(_) => warn!(%peer, "SSH identification exchange timed out"),
    }
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
