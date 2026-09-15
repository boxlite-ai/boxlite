#![cfg(target_os = "linux")]
//! Opt-in SSH server embedded in `boxlite-guest`.
//!
//! The listener is opt-in and accepts host-originated connections over vsock. Session processes and the OCI-contained SFTP helper are
//! delegated through the existing guest Execution service; TCP forwarding
//! uses the network namespace shared by the guest and its one container.

mod auth;
mod backoff;
mod bridge;
mod connection;
mod control;
mod forward;
mod limits;
mod reverse_streamlocal;
mod server;
mod session;
mod sftp;
mod streamlocal;
mod transport;
mod workload;

pub(crate) use workload::{BoxliteWorkloadExecutor, SshWorkload};

use crate::service::server::GuestServer;
use auth::SshAuthorizer;
use backoff::Backoff;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use connection::{Connection, ConnectionTasks};
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{debug, info, warn};

#[derive(Clone)]
pub(crate) struct SshConfig {
    authorizer: Arc<SshAuthorizer>,
    host_key: russh::keys::PrivateKey,
}

impl SshConfig {
    pub(crate) fn from_request(
        request: boxlite_shared::SshConfigureRequest,
    ) -> BoxliteResult<Self> {
        use boxlite_shared::ssh_configure_request::Auth;
        let authorizer = match request.auth {
            Some(Auth::Keys(keys)) => {
                SshAuthorizer::new(&keys.ca_public_keys, &keys.public_keys, request.principal)?
            }
            Some(Auth::NoAuth(_)) => SshAuthorizer::NoAuth,
            None => {
                return Err(BoxliteError::InvalidArgument(
                    "SSH authentication configuration is required".into(),
                ))
            }
        };
        let host_key = boxlite_shared::ssh::parse_host_key(&request.host_private_key)?;
        Ok(Self {
            authorizer: Arc::new(authorizer),
            host_key,
        })
    }
}

/// Public state returned by the SSH control plane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SshRuntimeStatus {
    pub enabled: bool,
    pub generation: u64,
    pub host_key_fingerprint: Option<String>,
}

/// Owns one SSH service generation and serializes complete restarts.
pub(crate) struct SshManager {
    guest: OnceLock<Weak<GuestServer>>,
    state: Mutex<ManagerState>,
    connection_permits: Arc<tokio::sync::Semaphore>,
    is_shutdown: std::sync::atomic::AtomicBool,
}

impl Default for SshManager {
    fn default() -> Self {
        Self {
            guest: OnceLock::new(),
            state: Mutex::new(ManagerState::default()),
            connection_permits: Arc::new(tokio::sync::Semaphore::new(limits::MAX_CONNECTIONS)),
            is_shutdown: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[derive(Default)]
struct ManagerState {
    generation: u64,
    listener: Option<RunningListener>,
}

struct RunningListener {
    host_key_fingerprint: String,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
    connections: TaskTracker,
}

impl RunningListener {
    async fn stop(&mut self) -> Result<(), SshShutdownError> {
        self.shutdown.cancel();
        if let Some(task) = self.task.as_mut() {
            let result = match tokio::time::timeout(limits::SERVICE_STOP_TIMEOUT, &mut *task).await
            {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) if error.is_cancelled() => Ok(()),
                Ok(Err(error)) => Err(SshShutdownError::ListenerTask(error)),
                Err(_) => {
                    // Only the accept loop is aborted. Connection supervisors
                    // remain tracked and continue closing their transports.
                    warn!("SSH listener stop timed out; forcing listener shutdown");
                    task.abort();
                    let _ = task.await;
                    Ok(())
                }
            };
            self.task = None;
            result?;
        }
        // The accept loop can no longer add connections. Keep this tracker in
        // ManagerState if waiting times out or its control caller is cancelled.
        self.connections.close();
        tokio::time::timeout(limits::SERVICE_STOP_TIMEOUT, self.connections.wait())
            .await
            .map_err(|_| SshShutdownError::TimedOut)
    }
}

impl Drop for RunningListener {
    fn drop(&mut self) {
        // Cancellation of Configure/Disable must still stop the old generation.
        self.shutdown.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

struct PreparedListener {
    config: Arc<russh::server::Config>,
    host_key_fingerprint: String,
}

#[derive(Clone)]
struct ConnectionContext {
    guest: Arc<GuestServer>,
    authorizer: Arc<SshAuthorizer>,
    permits: Arc<tokio::sync::Semaphore>,
    shutdown: CancellationToken,
}

#[derive(Debug)]
pub(crate) enum SshStartError {
    NotAttached,
    ShuttingDown,
    Bind(std::io::Error),
    Stop(SshShutdownError),
}

impl std::fmt::Display for SshStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAttached => write!(f, "SSH manager is not attached to the guest server"),
            Self::ShuttingDown => write!(f, "guest shutdown has started; SSH cannot be configured"),
            Self::Bind(error) => write!(f, "failed to bind SSH listener: {error}"),
            Self::Stop(error) => write!(f, "failed to stop the previous SSH service: {error}"),
        }
    }
}

impl std::error::Error for SshStartError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Bind(error) => Some(error),
            Self::Stop(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub(crate) enum SshShutdownError {
    TimedOut,
    ListenerTask(tokio::task::JoinError),
}

impl std::fmt::Display for SshShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TimedOut => write!(f, "timed out waiting for SSH sessions to stop"),
            Self::ListenerTask(error) => {
                write!(f, "SSH listener task failed during shutdown: {error}")
            }
        }
    }
}

impl std::error::Error for SshShutdownError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ListenerTask(error) => Some(error),
            _ => None,
        }
    }
}

impl SshManager {
    /// The weak reference avoids a server/manager ownership cycle.
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
        if self.is_shutdown.load(std::sync::atomic::Ordering::SeqCst)
            || guest
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(SshStartError::ShuttingDown);
        }

        // SshConfig has already validated every input. Only now revoke the old
        // generation; any later bind failure intentionally leaves SSH disabled.
        let prepared = prepare_listener(&ssh);
        state.generation = state.generation.saturating_add(1);
        self.stop_listener(&mut state)
            .await
            .map_err(SshStartError::Stop)?;
        let listener = transport::Listener::bind().map_err(SshStartError::Bind)?;
        let shutdown = CancellationToken::new();
        let context = ConnectionContext {
            guest,
            authorizer: ssh.authorizer,
            permits: self.connection_permits.clone(),
            shutdown: shutdown.clone(),
        };
        let connections = TaskTracker::new();
        let task = tokio::spawn(accept_loop(
            listener,
            prepared.config,
            context,
            connections.clone(),
        ));
        info!(
            vsock_port = boxlite_shared::constants::network::GUEST_SSH_PORT,
            fingerprint = %prepared.host_key_fingerprint,
            generation = state.generation,
            "embedded SSH listener ready"
        );
        state.listener = Some(RunningListener {
            host_key_fingerprint: prepared.host_key_fingerprint,
            shutdown,
            task: Some(task),
            connections,
        });
        Ok(runtime_status(&state))
    }

    pub(crate) async fn status(&self) -> SshRuntimeStatus {
        let state = self.state.lock().await;
        runtime_status(&state)
    }

    pub(crate) async fn disable(&self) -> Result<SshRuntimeStatus, SshShutdownError> {
        let mut state = self.state.lock().await;
        if state.listener.is_some() {
            state.generation = state.generation.saturating_add(1);
        }
        self.stop_listener(&mut state).await?;
        Ok(runtime_status(&state))
    }

    pub(crate) async fn shutdown(&self) -> Result<SshRuntimeStatus, SshShutdownError> {
        self.is_shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.disable().await
    }

    async fn stop_listener(&self, state: &mut ManagerState) -> Result<(), SshShutdownError> {
        if let Some(listener) = state.listener.as_mut() {
            listener.stop().await?;
        }
        state.listener = None;
        Ok(())
    }
}

fn runtime_status(state: &ManagerState) -> SshRuntimeStatus {
    match &state.listener {
        Some(listener) if !listener.shutdown.is_cancelled() => SshRuntimeStatus {
            enabled: true,
            generation: state.generation,
            host_key_fingerprint: Some(listener.host_key_fingerprint.clone()),
        },
        _ => SshRuntimeStatus {
            enabled: false,
            generation: state.generation,
            host_key_fingerprint: None,
        },
    }
}

fn prepare_listener(ssh: &SshConfig) -> PreparedListener {
    PreparedListener {
        host_key_fingerprint: ssh
            .host_key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string(),
        config: Arc::new(server::build_config(
            ssh.host_key.clone(),
            ssh.authorizer.method(),
        )),
    }
}

async fn accept_loop(
    listener: transport::Listener,
    config: Arc<russh::server::Config>,
    context: ConnectionContext,
    connections: TaskTracker,
) {
    let shutdown = context.shutdown.clone();
    let mut backoff = Backoff::new();
    loop {
        let accepted = tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        match accepted {
            Ok(None) => continue,
            Ok(Some((socket, peer_addr))) => {
                backoff.reset();
                let permit = match context.permits.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        warn!(%peer_addr, "SSH connection limit reached");
                        continue;
                    }
                };
                connections.spawn(Connection::run(
                    socket,
                    peer_addr,
                    config.clone(),
                    context.clone(),
                    permit,
                ));
            }
            Err(error) => {
                warn!(%error, "SSH accept failed");
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = backoff.wait() => {}
                }
            }
        }
    }
    // Release the listening socket before waiting for established sessions.
    drop(listener);
    debug!("embedded SSH accept loop stopped");
}

#[cfg(test)]
mod tests;
