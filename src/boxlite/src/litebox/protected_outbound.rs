//! Private outbound ownership and receipts exchanged with an enrolled Runner.

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use crate::net::{
    OutboundRevision, OutboundSnapshot,
    gvproxy::{ManagedProxyCredential, ManagedProxyIdentity, ManagedProxyRoute},
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedRouteSnapshot {
    pub snapshot: OutboundSnapshot,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub binding: Option<ManagedProxyIdentity>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedRouteUpdate {
    pub attempt_id: OutboundRevision,
    pub predecessor: ProtectedRouteSnapshot,
    pub candidate: ProtectedRouteSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProtectedRouteOperation {
    Inspect,
    Prepare {
        update: ProtectedRouteUpdate,
    },
    PrepareRestore {
        update: ProtectedRouteUpdate,
        failed: ProtectedRouteUpdate,
    },
    Apply {
        attempt_id: OutboundRevision,
        #[serde(deserialize_with = "Deserialize::deserialize")]
        route: Option<ProtectedRouteMaterial>,
        #[serde(deserialize_with = "Deserialize::deserialize")]
        predecessor_route: Option<ProtectedRouteMaterial>,
    },
    RetirePrepared {
        attempt_id: OutboundRevision,
        predecessor: ProtectedRouteSnapshot,
    },
    SettleUnbind {
        attempt_id: OutboundRevision,
        revision: OutboundRevision,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedRouteMaterial {
    pub binding: ManagedProxyIdentity,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub credential: Option<ManagedProxyCredential>,
}

impl ProtectedRouteMaterial {
    pub(crate) fn route(self, doh_url: String, doh_address: SocketAddr) -> ManagedProxyRoute {
        ManagedProxyRoute {
            binding: self.binding,
            scheme: self.scheme,
            host: self.host,
            port: self.port,
            credential: self.credential,
            doh_url,
            doh_address,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedRouteRequest {
    pub runner_id: OutboundRevision,
    pub epoch: OutboundRevision,
    pub command: ProtectedRouteOperation,
    pub doh_url: String,
    pub doh_address: SocketAddr,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ProtectedRoutePending {
    pub(crate) update: ProtectedRouteUpdate,
    pub(crate) dispatched: bool,
    pub(crate) restoration: Option<ProtectedRouteSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProtectedRouteRollback {
    pub failed: ProtectedRouteUpdate,
    pub restored: ProtectedRouteSnapshot,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProtectedRouteOutcome {
    Applied,
    Unapplied,
    Restored,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ProtectedRouteRetirement {
    pub(crate) id: OutboundRevision,
    pub(crate) outcome: ProtectedRouteOutcome,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct ProtectedRouteControl {
    pub(crate) committed: Option<ProtectedRouteSnapshot>,
    pub(crate) last_applied: Option<ProtectedRouteUpdate>,
    pub(crate) pending: Option<ProtectedRoutePending>,
    pub(crate) unbind_settlement: Option<OutboundRevision>,
    pub(crate) retired: Vec<ProtectedRouteRetirement>,
    pub(crate) rollback: Option<ProtectedRouteRollback>,
}

impl ProtectedRouteControl {
    pub(crate) fn outcome(&self, id: &OutboundRevision) -> Option<ProtectedRouteOutcome> {
        self.retired
            .iter()
            .find(|record| &record.id == id)
            .map(|record| record.outcome)
    }

    pub(crate) fn retire(&mut self, id: OutboundRevision, outcome: ProtectedRouteOutcome) {
        self.retired.push(ProtectedRouteRetirement { id, outcome })
    }
}

#[derive(Debug, Serialize)]
pub struct ProtectedRouteReceipt {
    pub runner_id: OutboundRevision,
    pub epoch: OutboundRevision,
    pub durable: ProtectedRouteSnapshot,
    pub installed: Option<ProtectedRouteSnapshot>,
    pub pending_attempt: Option<OutboundRevision>,
    pub unbind_settlement: Option<OutboundRevision>,
    pub rollback: Option<ProtectedRouteRollback>,
    pub retired_attempt: Option<OutboundRevision>,
}
