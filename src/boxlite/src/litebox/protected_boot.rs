//! Host-only bootstrap requests and the non-secret Runtime admission record.

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use crate::net::{
    OutboundRevision, OutboundSnapshot,
    gvproxy::{ManagedProxyCredential, ManagedProxyIdentity, ManagedProxyRoute},
};
use crate::util::PidRecord;
use crate::vmm::shim_launch::ProtectedNetworkLaunch;

/// Identity of one authorized dispatch for a Box on one Runner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedBootKey {
    pub runner_id: OutboundRevision,
    pub attempt_id: OutboundRevision,
    pub registration_id: OutboundRevision,
    pub registration_revision: OutboundRevision,
    pub policy: OutboundSnapshot,
}

/// Start material from the host coordinator. Only the key is persisted.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedBootRequest {
    pub key: ProtectedBootKey,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub doh_url: String,
    pub doh_address: SocketAddr,
    #[serde(default)]
    pub credential: Option<ManagedProxyCredential>,
}

impl ProtectedBootRequest {
    pub(super) fn into_launch(self, binding: ManagedProxyIdentity) -> ProtectedNetworkLaunch {
        ProtectedNetworkLaunch {
            policy: self.key.policy,
            route: ManagedProxyRoute {
                binding,
                scheme: self.scheme,
                host: self.host,
                port: self.port,
                doh_url: self.doh_url,
                doh_address: self.doh_address,
                credential: self.credential,
            },
        }
    }
}

/// Exact Runtime evidence returned through the enrolled host API.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProtectedBootReceipt {
    pub key: ProtectedBootKey,
    pub epoch: Option<OutboundRevision>,
    pub outcome: ProtectedBootOutcome,
}

/// The two definitive outcomes that can settle a pending registry reference.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtectedBootOutcome {
    Confirmed,
    Retired,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub(crate) struct ProtectedBootState {
    pub(crate) active: Option<ProtectedBootAttempt>,
    pub(crate) retired: Vec<ProtectedBootReceipt>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ProtectedBootAttempt {
    pub(crate) key: ProtectedBootKey,
    pub(crate) epoch: OutboundRevision,
    pub(crate) spawning: bool,
    pub(crate) owner: Option<PidRecord>,
    pub(crate) confirmed: bool,
}

impl ProtectedBootAttempt {
    pub(crate) fn binding(&self) -> ManagedProxyIdentity {
        ManagedProxyIdentity {
            registration_id: self.key.registration_id.clone(),
            registration_revision: self.key.registration_revision.clone(),
            epoch: self.epoch.clone(),
        }
    }

    pub(crate) fn receipt(&self, outcome: ProtectedBootOutcome) -> ProtectedBootReceipt {
        ProtectedBootReceipt {
            key: self.key.clone(),
            epoch: Some(self.epoch.clone()),
            outcome,
        }
    }
}
