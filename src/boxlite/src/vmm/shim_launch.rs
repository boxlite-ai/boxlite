//! Private records read from the shim's host-only launch pipe.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use crate::net::{OutboundRevision, OutboundSnapshot, gvproxy::ManagedProxyRoute};

use super::InstanceSpec;

const PROTECTED_VERSION: u8 = 1;

/// Network initialization data for a single launch.
#[derive(Debug)]
pub enum ShimNetworkLaunch {
    Ordinary(Option<OutboundRevision>),
    Protected(Box<ProtectedNetworkLaunch>),
}

/// Network values that travel together across the protected launch pipe.
#[derive(Debug)]
pub struct ProtectedNetworkLaunch {
    pub policy: OutboundSnapshot,
    pub route: ManagedProxyRoute,
}

/// Encode a versioned record whose top-level shape cannot boot an old shim.
pub fn encode_protected_launch(
    instance: &InstanceSpec,
    network: &ProtectedNetworkLaunch,
) -> BoxliteResult<String> {
    #[derive(Serialize)]
    struct Record<'a> {
        version: u8,
        instance: &'a InstanceSpec,
        route: &'a ManagedProxyRoute,
        policy: &'a OutboundSnapshot,
    }

    serde_json::to_string(&Record {
        version: PROTECTED_VERSION,
        instance,
        route: &network.route,
        policy: &network.policy,
    })
    .map_err(|_| BoxliteError::Engine("Failed to serialize protected shim launch".into()))
}

/// Decode exactly one private launch record and reject incomplete protected records.
pub fn decode_launch(json: &str) -> BoxliteResult<(InstanceSpec, ShimNetworkLaunch)> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| BoxliteError::Engine("Invalid shim launch JSON".into()))?;
    if ["version", "instance", "route", "policy"]
        .iter()
        .any(|key| value.get(*key).is_some())
    {
        return decode_protected(&value, json);
    }

    let revision =
        serde_json::from_value(value.get("outbound_revision").cloned().unwrap_or_default())
            .map_err(|_| BoxliteError::Engine("Invalid outbound bootstrap revision".into()))?;
    let instance = serde_json::from_value(value)
        .map_err(|_| BoxliteError::Engine("Invalid shim instance config".into()))?;
    Ok((instance, ShimNetworkLaunch::Ordinary(revision)))
}

fn decode_protected(
    value: &serde_json::Value,
    json: &str,
) -> BoxliteResult<(InstanceSpec, ShimNetworkLaunch)> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Record {
        #[serde(rename = "version")]
        _version: u8,
        instance: InstanceSpec,
        route: ManagedProxyRoute,
        policy: OutboundSnapshot,
    }

    if value.get("version").and_then(serde_json::Value::as_u64) != Some(PROTECTED_VERSION.into()) {
        return Err(BoxliteError::Engine(
            "Unsupported protected shim launch version".into(),
        ));
    }
    let Record {
        instance,
        route,
        policy,
        ..
    } = serde_json::from_str(json)
        .map_err(|_| BoxliteError::Engine("Invalid protected shim launch".into()))?;
    policy.policy.validate()?;
    let Some(spec) = instance.network_backend_spec.as_ref() else {
        return Err(BoxliteError::Engine(
            "Protected shim launch requires a network backend".into(),
        ));
    };
    if instance.disable_network
        || !spec.outbound_disabled
        || !spec.allow_net.is_empty()
        || instance.network_backend_endpoint.is_some()
    {
        return Err(BoxliteError::Engine(
            "Protected shim launch requires a fresh disabled network backend".into(),
        ));
    }
    Ok((
        instance,
        ShimNetworkLaunch::Protected(Box::new(ProtectedNetworkLaunch { policy, route })),
    ))
}
