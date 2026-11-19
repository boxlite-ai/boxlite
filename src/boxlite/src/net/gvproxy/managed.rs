//! Host-only proxy launch configuration and bridge readback.

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use crate::net::{OutboundRevision, OutboundSnapshotStatus};

/// Non-secret identity published with the installed route.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedProxyIdentity {
    pub registration_id: OutboundRevision,
    pub registration_revision: OutboundRevision,
    pub epoch: OutboundRevision,
}

/// Proxy credentials transferred through the host launch pipe.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedProxyCredential {
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for ManagedProxyCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ManagedProxyCredential([REDACTED])")
    }
}

/// Route selected by the trusted bootstrap coordinator.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedProxyRoute {
    pub binding: ManagedProxyIdentity,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub doh_url: String,
    pub doh_address: SocketAddr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<ManagedProxyCredential>,
}

/// Installed policy and proxy identity from one immutable bridge snapshot.
#[derive(Debug, Deserialize)]
pub(crate) struct ManagedProxyStatus {
    #[serde(flatten)]
    pub(crate) status: OutboundSnapshotStatus,
    pub(crate) binding: ManagedProxyIdentity,
}
