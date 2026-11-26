//! Host-only bootstrap requests and the non-secret Runtime admission record.

use std::net::SocketAddr;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use super::protected_outbound::{
    ProtectedRouteControl, ProtectedRouteRollback, ProtectedRouteSnapshot, ProtectedRouteUpdate,
};
use crate::net::{
    OutboundRevision, OutboundSnapshot,
    gvproxy::{
        ManagedProxyCredential, ManagedProxyIdentity, ManagedProxyRoute, ManagedRecoveryGateId,
    },
};
use crate::util::PidRecord;
use crate::vmm::shim_launch::ProtectedNetworkLaunch;

/// Identity of one authorized dispatch for a Box on one Runner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedBootKey {
    pub runner_id: OutboundRevision,
    pub attempt_id: OutboundRevision,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub registration_id: Option<OutboundRevision>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub registration_revision: Option<OutboundRevision>,
    pub policy: OutboundSnapshot,
}

/// Start material from the host coordinator. Only the key is persisted.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedBootRequest {
    pub key: ProtectedBootKey,
    pub scheme: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub doh_url: String,
    pub doh_address: SocketAddr,
    #[serde(default)]
    pub credential: Option<ManagedProxyCredential>,
    #[serde(default)]
    pub recovery_generation: Option<OutboundRevision>,
    #[serde(default)]
    pub restart: bool,
}

impl ProtectedBootRequest {
    pub(super) fn into_launch(
        self,
        attempt: &ProtectedBootAttempt,
    ) -> BoxliteResult<ProtectedNetworkLaunch> {
        let route = match (attempt.binding(), self.scheme, self.host, self.port) {
            (Some(binding), Some(scheme), Some(host), Some(port)) => Some(ManagedProxyRoute {
                binding,
                scheme,
                host,
                port,
                doh_url: self.doh_url,
                doh_address: self.doh_address,
                credential: self.credential,
            }),
            (None, None, None, None)
                if self.credential.is_none() && attempt.gate_id().is_some() =>
            {
                None
            }
            _ => {
                return Err(BoxliteError::InvalidArgument(
                    "Incomplete protected bootstrap route".into(),
                ));
            }
        };
        Ok(ProtectedNetworkLaunch {
            policy: self.key.policy,
            route,
            recovery_gate: attempt.gate_id(),
        })
    }
}

impl ProtectedBootKey {
    pub(super) fn validate(&self) -> BoxliteResult<()> {
        if self.registration_id.is_some() != self.registration_revision.is_some() {
            return Err(BoxliteError::InvalidArgument(
                "Incomplete protected bootstrap binding".into(),
            ));
        }
        self.policy.policy.validate()
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

/// Authority for one gate on an exact enrolled Runner and boot attempt.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedGateRequest {
    pub key: ProtectedBootKey,
    pub epoch: OutboundRevision,
    pub generation: OutboundRevision,
    #[serde(default)]
    pub outbound: Option<ProtectedRouteSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedRemoveRequest {
    pub key: ProtectedBootKey,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub epoch: Option<OutboundRevision>,
    #[serde(default)]
    pub runner_box_name: Option<crate::BoxID>,
    /// Bind removal and replay to the selected native ID; the logical name is retained for replay.
    #[serde(default)]
    pub exact_native_id: bool,
}

#[derive(Debug, Serialize)]
pub struct ProtectedGateReceipt {
    pub boot: ProtectedBootReceipt,
    pub generation: OutboundRevision,
    pub closed: bool,
    pub sealed: bool,
    pub outbound: ProtectedRouteSnapshot,
    pub evidence: Option<ProtectedSealedEvidence>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedSealedEvidence {
    pub durable: ProtectedRouteSnapshot,
    pub installed: Option<ProtectedRouteSnapshot>,
    pub pending: Option<ProtectedRouteUpdate>,
    pub rollback: Option<ProtectedRouteRollback>,
    pub unbind_settlement: Option<OutboundRevision>,
    pub ordinary_pending: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub(crate) struct ProtectedBootState {
    pub(crate) active: Option<ProtectedBootAttempt>,
    pub(crate) retired: Vec<ProtectedBootReceipt>,
    #[serde(default)]
    pub(crate) outbound: ProtectedRouteControl,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) removable_attempt: Option<OutboundRevision>,
}

impl ProtectedBootState {
    pub(crate) fn requires_complete_route(&self) -> bool {
        let clear = self.active.as_ref().is_some_and(|attempt| {
            attempt.confirmed
                && attempt
                    .recovery_gate
                    .as_ref()
                    .is_some_and(|gate| gate.released && !gate.seal_requested)
        }) && self
            .outbound
            .committed
            .as_ref()
            .is_some_and(|value| value.binding.is_none())
            && self.outbound.pending.is_none()
            && self.outbound.unbind_settlement.is_none();
        !clear
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ProtectedBootAttempt {
    pub(crate) key: ProtectedBootKey,
    pub(crate) epoch: OutboundRevision,
    pub(crate) spawning: bool,
    pub(crate) owner: Option<PidRecord>,
    pub(crate) confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recovery_gate: Option<BootRecoveryGate>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct BootRecoveryGate {
    pub(crate) generation: OutboundRevision,
    pub(crate) seal_requested: bool,
    #[serde(default)]
    pub(crate) seal_confirmed: bool,
    #[serde(default)]
    pub(crate) released: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) evidence: Option<ProtectedSealedEvidence>,
}

impl ProtectedBootAttempt {
    pub(crate) fn gate_id(&self) -> Option<ManagedRecoveryGateId> {
        self.recovery_gate
            .as_ref()
            .map(|gate| ManagedRecoveryGateId {
                epoch: self.epoch.clone(),
                generation: gate.generation.clone(),
            })
    }

    pub(crate) fn binding(&self) -> Option<ManagedProxyIdentity> {
        Some(ManagedProxyIdentity {
            registration_id: self.key.registration_id.clone()?,
            registration_revision: self.key.registration_revision.clone()?,
            epoch: self.epoch.clone(),
        })
    }

    pub(crate) fn receipt(&self, outcome: ProtectedBootOutcome) -> ProtectedBootReceipt {
        ProtectedBootReceipt {
            key: self.key.clone(),
            epoch: Some(self.epoch.clone()),
            outcome,
        }
    }
}
