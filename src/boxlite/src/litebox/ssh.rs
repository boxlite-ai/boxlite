//! SSH control over local and REST backends.

use std::{fmt, sync::Arc, time::Duration};

use boxlite_shared::{BoxliteError, BoxliteResult};

use super::box_impl::BoxImpl;
use crate::runtime::backend::SshBackend;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

// Deadline for SSH interface acquisition and RPC, after VM/container startup.
const SSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Complete guest SSH configuration. Keys are never persisted by the runtime.
#[derive(Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub listen_address: String,
    pub host_private_key: String,
    pub accounts: Vec<SshAccount>,
}

/// Credentials accepted for one SSH login (not a container OS identity).
#[derive(Clone, Serialize, Deserialize)]
pub struct SshAccount {
    pub login: String,
    pub authorized_keys: Vec<String>,
    pub ca: Option<SshCaConfig>,
}

/// Certificate authority and required certificate principal.
#[derive(Clone, Serialize, Deserialize)]
pub struct SshCaConfig {
    pub public_key: String,
    pub principal: String,
}

impl fmt::Debug for SshConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshConfig")
            .field("listen_address", &self.listen_address)
            .field("host_private_key", &"[REDACTED]")
            .field("accounts", &self.accounts)
            .finish()
    }
}

impl fmt::Debug for SshAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshAccount")
            .field("login", &self.login)
            .field("authorized_keys", &"[REDACTED]")
            .field("ca", &self.ca)
            .finish()
    }
}

impl fmt::Debug for SshCaConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshCaConfig")
            .field("public_key", &"[REDACTED]")
            .field("principal", &"[REDACTED]")
            .finish()
    }
}

/// Guest listener state and public host identity; contains no credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshStatus {
    pub enabled: bool,
    pub generation: u64,
    pub listen_address: String,
    pub host_public_key: String,
    pub host_key_fingerprint: String,
}

/// Owned SSH control handle. Operations start the VM and container as needed.
///
/// Locally, after startup, interface acquisition and the RPC share a 5-second deadline.
/// REST operations use the HTTP client timeout and the server startup policy.
/// Runtime shutdown cancels the whole operation, including startup. Operations
/// are not retried. Timeout or cancellation
/// does not undo a configuration already applied by the guest.
#[derive(Clone)]
pub struct SshHandle {
    backend: Arc<dyn SshBackend>,
}

impl fmt::Debug for SshHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshHandle").finish_non_exhaustive()
    }
}

impl SshHandle {
    pub(super) fn new(backend: Arc<dyn SshBackend>) -> Self {
        Self { backend }
    }

    /// Replace all credentials and restart SSH, disconnecting existing sessions.
    pub async fn configure(&self, config: SshConfig) -> BoxliteResult<SshStatus> {
        self.backend.configure(config).await
    }
    /// Query listener state; may start the box.
    pub async fn status(&self) -> BoxliteResult<SshStatus> {
        self.backend.status().await
    }
    /// Disable the listener and disconnect sessions; may start the box.
    pub async fn disable(&self) -> BoxliteResult<SshStatus> {
        self.backend.disable().await
    }
}

#[async_trait]
impl SshBackend for BoxImpl {
    /// Validate and replace SSH configuration, disconnecting existing clients.
    /// Starts the VM and container main process as needed.
    async fn configure(&self, config: SshConfig) -> BoxliteResult<SshStatus> {
        let backend = self;
        tokio::select! {
            biased;
            _ = backend.shutdown_token.cancelled() => Err(BoxliteError::Stopped(format!(
                "SSH configure: box {} stopped", backend.config.id
            ))),
            result = async {
                let session = backend.guest_session().await?;
                tokio::time::timeout(SSH_TIMEOUT, async {
                    let mut ssh = session.ssh().await?;
                    ssh.configure(config).await
                }).await.unwrap_or_else(|_| Err(BoxliteError::Rpc(format!(
                    "SSH configure: timed out after {} seconds for box {}",
                    SSH_TIMEOUT.as_secs(), backend.config.id
                ))))
            } => result,
        }
    }

    /// Query SSH state, starting the VM and container as needed.
    async fn status(&self) -> BoxliteResult<SshStatus> {
        let backend = self;
        tokio::select! {
            biased;
            _ = backend.shutdown_token.cancelled() => Err(BoxliteError::Stopped(format!(
                "SSH status: box {} stopped", backend.config.id
            ))),
            result = async {
                let session = backend.guest_session().await?;
                tokio::time::timeout(SSH_TIMEOUT, async {
                    let mut ssh = session.ssh().await?;
                    ssh.status().await
                }).await.unwrap_or_else(|_| Err(BoxliteError::Rpc(format!(
                    "SSH status: timed out after {} seconds for box {}",
                    SSH_TIMEOUT.as_secs(), backend.config.id
                ))))
            } => result,
        }
    }

    /// Stop SSH and disconnect clients. Repeated calls are supported.
    /// Starts the VM and container main process as needed, even if SSH is disabled.
    async fn disable(&self) -> BoxliteResult<SshStatus> {
        let backend = self;
        tokio::select! {
            biased;
            _ = backend.shutdown_token.cancelled() => Err(BoxliteError::Stopped(format!(
                "SSH disable: box {} stopped", backend.config.id
            ))),
            result = async {
                let session = backend.guest_session().await?;
                tokio::time::timeout(SSH_TIMEOUT, async {
                    let mut ssh = session.ssh().await?;
                    ssh.disable().await
                }).await.unwrap_or_else(|_| Err(BoxliteError::Rpc(format!(
                    "SSH disable: timed out after {} seconds for box {}",
                    SSH_TIMEOUT.as_secs(), backend.config.id
                ))))
            } => result,
        }
    }
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    let _ = assert_send_sync::<SshHandle>;
    let _ = assert_send_sync::<SshConfig>;
    let _ = assert_send_sync::<SshAccount>;
    let _ = assert_send_sync::<SshCaConfig>;
    let _ = assert_send_sync::<SshStatus>;
};
