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

/// Epoch and generation of a host-only recovery gate.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedRecoveryGateId {
    pub epoch: OutboundRevision,
    pub generation: OutboundRevision,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ManagedRecoveryGate {
    pub(crate) epoch: OutboundRevision,
    pub(crate) generation: OutboundRevision,
    pub(crate) closed: bool,
    pub(crate) sealed: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecoveryGateAction {
    Release,
    Seal,
}

/// Installed policy and proxy identity from one immutable bridge snapshot.
#[derive(Debug, Deserialize)]
pub(crate) struct ManagedProxyStatus {
    #[serde(flatten)]
    pub(crate) status: OutboundSnapshotStatus,
    pub(crate) binding: Option<ManagedProxyIdentity>,
    pub(crate) recovery_gate: Option<ManagedRecoveryGate>,
    pub(crate) capabilities: Vec<String>,
    pub(crate) proxy_diagnostic: Option<serde_json::Value>,
}

impl ManagedProxyStatus {
    pub(crate) fn diagnostic_code(&self) -> Option<&str> {
        match self.proxy_diagnostic.as_ref()?.as_str()? {
            code @ ("proxy_unreachable"
            | "proxy_auth_failed"
            | "proxy_handshake_failed"
            | "proxy_timeout") => Some(code),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ManagedProxyStatus;
    use serde_json::json;

    #[test]
    fn protected_outbound_diagnostic_does_not_change_snapshot_decoding() {
        let snapshot = json!({
            "policy": {"mode": "enabled", "allow_net": []},
            "revision": "fixture-policy",
            "application_state": "confirmed",
            "binding": {"registration_id": "proxy", "registration_revision": "2", "epoch": "fixture-epoch"},
            "capabilities": ["managed-proxy-v1"],
        });
        let old: ManagedProxyStatus = serde_json::from_value(snapshot.clone()).unwrap();
        for (value, expected) in [
            (json!("proxy_timeout"), Some("proxy_timeout")),
            (json!({"code": "proxy_timeout"}), None),
            (json!("future_error"), None),
            (json!(null), None),
        ] {
            let mut body = snapshot.clone();
            body["proxy_diagnostic"] = value;
            let decoded: ManagedProxyStatus = serde_json::from_value(body).unwrap();
            assert_eq!(decoded.status, old.status);
            assert_eq!(decoded.binding, old.binding);
            assert_eq!(decoded.diagnostic_code(), expected);
        }
        assert_eq!(old.diagnostic_code(), None);
    }
}
