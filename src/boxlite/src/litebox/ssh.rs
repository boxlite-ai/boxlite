//! SSH sub-resource on LiteBox.
//!
//! Parallel to [`crate::litebox::network`]: a typed, box-scoped control
//! facade over the guest's `Ssh.ReplaceAccessSet`/`Status` RPCs. SSH bytes
//! never flow through this facade -- they stay on the existing
//! `Network().Tunnel()` data path. This is control-plane only: apply/query
//! which temporary SSH credentials the guest's russh listener currently
//! authenticates.

use std::sync::Arc;
use std::time::SystemTime;

use boxlite_shared::errors::BoxliteResult;

use crate::runtime::backend::BoxSshBackend;

/// One box-scoped temporary SSH credential to authorize.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshAccessEntry {
    /// `TemporarySshCredential` id (list/revoke/audit).
    pub credential_id: String,
    /// Parent `BoxAccessGrant` id.
    pub grant_id: String,
    /// Canonical OpenSSH public-key line, e.g. `"ssh-ed25519 AAAA... "`.
    pub public_key: String,
    /// SHA-256 fingerprint, for logs/UI only -- never the key body.
    pub fingerprint: String,
    /// Fixed to `"root"` in this design.
    pub unix_user: String,
    pub expires_at: SystemTime,
}

/// Full-set replace request. `generation` must be strictly newer than the
/// guest's currently applied generation, or identical generation with
/// byte-identical `accesses` (idempotent retry) -- anything older or
/// conflicting is rejected, snapshot left unchanged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshAccessSetRequest {
    pub generation: u64,
    pub accesses: Vec<SshAccessEntry>,
}

/// Guest-observed SSH host identity health.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshIdentityStatus {
    Unknown,
    Ready,
    Degraded,
}

/// Applied generation, listener readiness, and host identity, as last
/// observed from the guest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshStatus {
    pub applied_generation: u64,
    pub listener_ready: bool,
    /// OpenSSH-format host public key (for `known_hosts`-style verification).
    pub host_public_key: String,
    pub host_fingerprint: String,
    pub identity_status: SshIdentityStatus,
}

/// Handle for SSH access-set operations on a LiteBox.
///
/// Obtained via `litebox.ssh()`. Internal control facade: resolves the live
/// guest session and calls the typed guest RPC, never exposing the raw
/// guest control stream/CID/vsock port/filesystem path to the caller. Used
/// by the Runner; the public SDK credential-issuance helper is a separate
/// Hosted API client and must not call this facade.
pub struct SshHandle {
    ssh_backend: Arc<dyn BoxSshBackend>,
}

impl SshHandle {
    pub(crate) fn new(ssh_backend: Arc<dyn BoxSshBackend>) -> Self {
        Self { ssh_backend }
    }

    /// Full-set replace of the guest's active SSH access snapshot.
    pub async fn replace_access_set(
        &self,
        request: SshAccessSetRequest,
    ) -> BoxliteResult<SshStatus> {
        self.ssh_backend.ssh_replace_access_set(request).await
    }

    /// Query applied generation, listener readiness, and host identity.
    pub async fn status(&self) -> BoxliteResult<SshStatus> {
        self.ssh_backend.ssh_status().await
    }
}
