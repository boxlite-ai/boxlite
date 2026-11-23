//! Cloud organization proxy registrations and Box binding outcomes.

use std::{fmt, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{BoxID, BoxliteError, BoxliteResult, net::OutboundRevision};

/// Public registration data. Credentials are available only as input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundProxy {
    pub name: String,
    pub url: String,
    pub revision: u64,
    pub credential_configured: bool,
}

/// Write-only proxy login. Both fields are redacted in diagnostic output.
#[derive(Clone, Serialize)]
pub struct ProxyCredential {
    username: String,
    password: String,
}

impl ProxyCredential {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> BoxliteResult<Self> {
        let credential = Self {
            username: username.into(),
            password: password.into(),
        };
        if [&credential.username, &credential.password]
            .iter()
            .any(|value| {
                !(1..=255).contains(&value.len())
                    || !value.bytes().all(|b| (b' '..=b'~').contains(&b))
            })
        {
            return Err(BoxliteError::InvalidArgument(
                "proxy credentials must contain 1 to 255 printable ASCII characters per field"
                    .into(),
            ));
        }
        Ok(credential)
    }
}

impl fmt::Debug for ProxyCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProxyCredential([redacted])")
    }
}

/// PATCH credential behavior. Keeping a credential requires an unchanged endpoint.
#[derive(Debug, Default, Clone)]
pub enum ProxyCredentialChange {
    #[default]
    Keep,
    Clear,
    Set(ProxyCredential),
}

/// Outcome of one proxy mutation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMutationState {
    Accepted,
    Rejected,
    Unknown,
    AcceptedReleaseUnconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProxyMutation {
    pub state: ProxyMutationState,
    pub http_status: Option<u16>,
    /// Validated strong ETag acknowledged by a successful policy PUT.
    pub revision: Option<OutboundRevision>,
}

impl ProxyMutation {
    pub fn is_accepted(&self) -> bool {
        matches!(
            self.state,
            ProxyMutationState::Accepted | ProxyMutationState::AcceptedReleaseUnconfirmed
        )
    }

    pub(crate) fn new(state: ProxyMutationState, http_status: Option<u16>) -> Self {
        Self {
            state,
            http_status,
            revision: None,
        }
    }
}

/// Admission state when an explicitly managed create cannot return a Box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedCreateAdmission {
    Rejected,
    Admitted,
    Unknown,
}

impl ManagedCreateAdmission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rejected => "rejected",
            Self::Admitted => "admitted",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("managed Box creation {admission:?} (HTTP {http_status:?}, Box {}): {source}", .box_id.as_ref().map(|id| id.as_str()).unwrap_or("unknown"))]
pub struct ManagedCreateError {
    pub admission: ManagedCreateAdmission,
    pub http_status: Option<u16>,
    pub box_id: Option<BoxID>,
    pub source: BoxliteError,
}

impl From<BoxliteError> for ManagedCreateError {
    fn from(source: BoxliteError) -> Self {
        Self {
            admission: ManagedCreateAdmission::Rejected,
            http_status: None,
            box_id: None,
            source,
        }
    }
}

/// Redacted Cloud view of a Box's outbound proxy binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedProxyStatus {
    pub application_state: crate::net::OutboundApplicationState,
    pub desired: Option<ProxyIdentity>,
    pub committed: Option<ProxyIdentity>,
    pub pending: Option<ProxyPolicyRevision>,
    pub installed: Option<ProxyPolicyRevision>,
    pub runtime_readback: ProxyRuntimeReadback,
    pub revision: OutboundRevision,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyRuntimeReadback {
    Authenticated,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyPolicyRevision {
    pub policy_revision: OutboundRevision,
    #[serde(deserialize_with = "Option::deserialize")]
    pub proxy: Option<ProxyIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyIdentity {
    pub name: String,
    pub revision: u64,
}

pub(crate) fn proxy_name(name: &str) -> BoxliteResult<&str> {
    if !(1..=63).contains(&name.len())
        || name.starts_with('-')
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(BoxliteError::InvalidArgument(
            "invalid proxy registration name".into(),
        ));
    }
    Ok(name)
}

pub(crate) fn requires_cloud() -> BoxliteError {
    BoxliteError::Unsupported(
        "registered outbound proxies require a supported BoxLite Cloud server".into(),
    )
}

#[async_trait]
pub(crate) trait OutboundProxyBackend: Send + Sync {
    async fn list(&self) -> BoxliteResult<Vec<OutboundProxy>>;
    async fn get(&self, name: &str) -> BoxliteResult<OutboundProxy>;
    async fn create(
        &self,
        name: &str,
        url: &str,
        credential: Option<&ProxyCredential>,
    ) -> BoxliteResult<ProxyMutation>;
    async fn update(
        &self,
        name: &str,
        url: Option<&str>,
        credential: ProxyCredentialChange,
    ) -> BoxliteResult<ProxyMutation>;
    async fn remove(&self, name: &str) -> BoxliteResult<ProxyMutation>;
}

/// Organization registry for a Cloud REST runtime.
#[derive(Clone)]
pub struct OutboundProxyHandle(pub(crate) Arc<dyn OutboundProxyBackend>);

impl OutboundProxyHandle {
    pub async fn list(&self) -> BoxliteResult<Vec<OutboundProxy>> {
        self.0.list().await
    }

    pub async fn get(&self, name: &str) -> BoxliteResult<OutboundProxy> {
        self.0.get(proxy_name(name)?).await
    }

    pub async fn create(
        &self,
        name: &str,
        url: &str,
        credential: Option<&ProxyCredential>,
    ) -> BoxliteResult<ProxyMutation> {
        self.0.create(proxy_name(name)?, url, credential).await
    }

    pub async fn update(
        &self,
        name: &str,
        url: Option<&str>,
        credential: ProxyCredentialChange,
    ) -> BoxliteResult<ProxyMutation> {
        self.0.update(proxy_name(name)?, url, credential).await
    }

    pub async fn remove(&self, name: &str) -> BoxliteResult<ProxyMutation> {
        self.0.remove(proxy_name(name)?).await
    }
}
