//! Versioned control values, separate from user outbound policy configuration.

use std::net::Ipv6Addr;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Deserializer, Serialize};

use super::outbound_rules::{self, LEGACY_RULES, MAX_RULES};
use crate::runtime::options::{NetworkMode, OutboundNetworkConfig};

/// A complete outbound request. An omitted deny list differs from an explicit clear.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteOutboundPolicy {
    pub mode: NetworkMode,
    #[serde(default)]
    pub allow_net: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present_deny",
        skip_serializing_if = "Option::is_none"
    )]
    pub deny_net: Option<Vec<String>>,
}

fn present_deny<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    Vec::<String>::deserialize(deserializer).map(Some)
}

impl CompleteOutboundPolicy {
    /// Validate the rules supported by the local IPv4 Runtime.
    pub fn validate(&self) -> BoxliteResult<()> {
        self.prepare(OutboundAdmission::ExtendedIpv4, OutboundRevision::initial())?;
        Ok(())
    }

    pub(crate) fn prepare(
        &self,
        minimum: OutboundAdmission,
        revision: OutboundRevision,
    ) -> BoxliteResult<CompleteOutboundSnapshot> {
        self.prepare_with_link(minimum, revision, None)
    }

    pub(crate) fn prepare_with_link(
        &self,
        minimum: OutboundAdmission,
        revision: OutboundRevision,
        ipv6: Option<Ipv6LinkPlan>,
    ) -> BoxliteResult<CompleteOutboundSnapshot> {
        if (minimum == OutboundAdmission::ExtendedDualStack) != ipv6.is_some() {
            return Err(BoxliteError::InvalidArgument(
                "IPv6 link plan and admission disagree".into(),
            ));
        }
        if let Some(plan) = &ipv6 {
            plan.validate()?;
        }
        let deny = self.deny_net.as_deref().unwrap_or_default();
        if self.allow_net.len() > MAX_RULES || deny.len() > MAX_RULES {
            return Err(BoxliteError::InvalidArgument(format!(
                "outbound rule lists may contain at most {MAX_RULES} rules each"
            )));
        }
        if self.mode == NetworkMode::Disabled && !self.allow_net.is_empty() {
            return Err(BoxliteError::InvalidArgument(
                "disabled outbound policy cannot include allow_net".into(),
            ));
        }

        let allow = parse_rules(&self.allow_net, ipv6.is_some())?;
        let deny = parse_rules(deny, ipv6.is_some())?;
        let legacy = OutboundNetworkConfig {
            mode: self.mode.clone(),
            allow_net: self.allow_net.clone(),
        };
        let admission = if ipv6.is_some() {
            OutboundAdmission::ExtendedDualStack
        } else if minimum == OutboundAdmission::ExtendedIpv4
            || allow.len() > LEGACY_RULES
            || !deny.is_empty()
            || legacy.validate().is_err()
        {
            OutboundAdmission::ExtendedIpv4
        } else {
            OutboundAdmission::Legacy
        };
        Ok(CompleteOutboundSnapshot {
            admission,
            revision,
            ipv6,
            policy: EffectiveOutboundPolicy {
                mode: self.mode.clone(),
                allow_net: if admission == OutboundAdmission::Legacy {
                    legacy.allow_net
                } else {
                    allow
                },
                deny_net: deny,
            },
        })
    }
}

fn parse_rules(rules: &[String], native_ipv6: bool) -> BoxliteResult<Vec<String>> {
    let rules = rules
        .iter()
        .map(|rule| outbound_rules::parse(rule))
        .collect::<BoxliteResult<Vec<_>>>()?;
    if !native_ipv6 && rules.iter().any(|rule| rule.native_ipv6) {
        return Err(BoxliteError::Unsupported(
            "native IPv6 outbound rules are unavailable".into(),
        ));
    }
    Ok(rules.into_iter().map(|rule| rule.canonical).collect())
}

pub(crate) fn require_legacy_outbound_write(policy: &OutboundNetworkConfig) -> BoxliteResult<()> {
    if policy.allow_net.len() > LEGACY_RULES {
        return Err(BoxliteError::Unsupported(
            "more than ten outbound rules require the complete policy interface".into(),
        ));
    }
    policy.validate()
}

/// Forwarding behavior included in the identity of an installed snapshot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundAdmission {
    #[default]
    Legacy,
    ExtendedIpv4,
    ExtendedDualStack,
}

/// The immutable guest and gateway addresses on a private ULA /64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ipv6LinkPlan {
    pub interface: String,
    pub guest: Ipv6Addr,
    pub gateway: Ipv6Addr,
}

/// A challenge scoped to the current backend instance and installed revision.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ipv6Readiness {
    pub plan: Ipv6LinkPlan,
    pub revision: OutboundRevision,
    pub epoch: OutboundRevision,
}

impl Ipv6Readiness {
    pub(crate) fn guest_check(&self) -> boxlite_shared::generated::GuestIpv6Check {
        boxlite_shared::generated::GuestIpv6Check {
            interface: self.plan.interface.clone(),
            guest: self.plan.guest.to_string(),
            gateway: self.plan.gateway.to_string(),
            epoch: self.epoch.0.clone(),
        }
    }
}

impl Ipv6LinkPlan {
    pub(crate) fn local() -> Self {
        Self {
            interface: crate::net::constants::GUEST_INTERFACE.into(),
            guest: Ipv6Addr::new(0xfd42, 0x424f, 0x584c, 1, 0, 0, 0, 2),
            gateway: Ipv6Addr::new(0xfd42, 0x424f, 0x584c, 1, 0, 0, 0, 1),
        }
    }

    pub(crate) fn validate(&self) -> BoxliteResult<()> {
        let guest = u128::from(self.guest);
        let gateway = u128::from(self.gateway);
        if self.interface != crate::net::constants::GUEST_INTERFACE
            || guest >> 120 != 0xfd
            || guest >> 64 != gateway >> 64
            || guest as u64 == 0
            || gateway as u64 == 0
            || guest == gateway
        {
            return Err(BoxliteError::InvalidArgument(
                "invalid Guest IPv6 link plan".into(),
            ));
        }
        Ok(())
    }
}

/// Effective rule lists and the forwarding behavior for one revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteOutboundSnapshot {
    pub policy: EffectiveOutboundPolicy,
    pub revision: OutboundRevision,
    pub admission: OutboundAdmission,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ipv6: Option<Ipv6LinkPlan>,
}

/// Canonical create snapshot and the original presence of `deny_net`.
///
/// Used by the hosted coordinator to reserve the same identity that Runtime installs.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedOutboundCreate {
    pub snapshot: CompleteOutboundSnapshot,
    pub deny_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebuild_pin: Option<OutboundRevision>,
}

/// Private control-plane ownership for a hosted replacement.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostedOutboundAttempt {
    pub incarnation: String,
    pub attempt_id: OutboundRevision,
    pub generation: u64,
    pub previous: CompleteOutboundSnapshot,
    pub candidate: PreparedOutboundCreate,
}

/// Commands admitted only by the local hosted Runtime.
#[doc(hidden)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostedOutboundCommand {
    CheckRebuild {
        snapshot: CompleteOutboundSnapshot,
        #[serde(default)]
        pin_backend: bool,
    },
    Prepare {
        previous: CompleteOutboundSnapshot,
        revision: OutboundRevision,
        policy: CompleteOutboundPolicy,
    },
    Apply {
        attempt: HostedOutboundAttempt,
    },
    Cancel {
        attempt: HostedOutboundAttempt,
    },
    Reconcile {
        attempt: HostedOutboundAttempt,
    },
    Restore {
        attempt: HostedOutboundAttempt,
        revision: OutboundRevision,
    },
    Finalize {
        attempt: HostedOutboundAttempt,
    },
}

/// Exact result of a private hosted outbound operation.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostedOutboundReceipt {
    RebuildReady {
        snapshot: CompleteOutboundSnapshot,
        #[serde(skip_serializing_if = "Option::is_none")]
        rebuild_pin: Option<OutboundRevision>,
    },
    Prepared {
        candidate: PreparedOutboundCreate,
    },
    Pending,
    Cancelled,
    Applied {
        snapshot: CompleteOutboundSnapshot,
    },
    Restored {
        snapshot: CompleteOutboundSnapshot,
    },
    Finalized {
        snapshot: CompleteOutboundSnapshot,
    },
}

impl PreparedOutboundCreate {
    #[cfg(test)]
    pub(crate) fn new(
        policy: &CompleteOutboundPolicy,
        revision: OutboundRevision,
    ) -> BoxliteResult<Self> {
        Self::with_link(policy, revision, None)
    }

    pub(crate) fn with_link(
        policy: &CompleteOutboundPolicy,
        revision: OutboundRevision,
        plan: Option<Ipv6LinkPlan>,
    ) -> BoxliteResult<Self> {
        let admission = if plan.is_some() {
            OutboundAdmission::ExtendedDualStack
        } else {
            OutboundAdmission::ExtendedIpv4
        };
        Ok(Self {
            snapshot: policy.prepare_with_link(admission, revision, plan)?,
            deny_present: policy.deny_net.is_some(),
            rebuild_pin: None,
        })
    }

    pub(crate) fn requirements(&self) -> BoxliteResult<OutboundCapabilities> {
        self.snapshot.validate_installed()?;
        if !self.deny_present && !self.snapshot.policy.deny_net.is_empty() {
            return Err(BoxliteError::InvalidArgument(
                "prepared outbound rules require explicit deny presence".into(),
            ));
        }
        let mut requirements = self.snapshot.requirements();
        requirements.deny |= self.deny_present;
        Ok(requirements)
    }
}

#[cfg(test)]
mod prepared_outbound_create_tests {
    use super::*;

    #[test]
    fn dual_stack_snapshot_preserves_plan_and_native_capability() {
        let policy = CompleteOutboundPolicy {
            allow_net: vec!["2606:4700::1111/128".into()],
            ..Default::default()
        };
        let revision = OutboundRevision::fresh();
        assert!(
            policy
                .prepare(OutboundAdmission::ExtendedIpv4, revision.clone())
                .is_err()
        );
        let prepared =
            PreparedOutboundCreate::with_link(&policy, revision, Some(Ipv6LinkPlan::local()))
                .unwrap();
        let wire = serde_json::to_string(&prepared.snapshot).unwrap();
        let restored: CompleteOutboundSnapshot = serde_json::from_str(&wire).unwrap();
        restored.validate_installed().unwrap();
        assert_eq!(restored, prepared.snapshot);
        assert!(restored.requirements().native_ipv6);
        assert!(!restored.requirements().port);
        let disabled = restored
            .prepare_replacement(
                &CompleteOutboundPolicy {
                    mode: NetworkMode::Disabled,
                    ..Default::default()
                },
                OutboundRevision::fresh(),
            )
            .unwrap();
        assert_eq!(disabled.admission, OutboundAdmission::ExtendedDualStack);
        assert_eq!(disabled.ipv6, restored.ipv6);
        let mut invalid = restored;
        invalid.ipv6.as_mut().unwrap().gateway = "fd00:dead::1".parse().unwrap();
        assert!(invalid.validate_installed().is_err());
    }

    #[test]
    fn prepared_outbound_create_preserves_deny_presence_and_snapshot() {
        let revision = OutboundRevision::parse("cloud-revision").unwrap();
        let mut policy = CompleteOutboundPolicy {
            mode: NetworkMode::Enabled,
            allow_net: vec!["EXAMPLE.com:0443".into()],
            deny_net: None,
        };
        let omitted = PreparedOutboundCreate::new(&policy, revision.clone()).unwrap();
        policy.deny_net = Some(Vec::new());
        let empty = PreparedOutboundCreate::new(&policy, revision.clone()).unwrap();

        assert_eq!(omitted.snapshot, empty.snapshot);
        assert_eq!(empty.snapshot.revision, revision);
        assert_eq!(empty.snapshot.policy.allow_net, ["example.com:443"]);
        let legacy_extended = omitted.requirements().unwrap();
        assert!(legacy_extended.port);
        assert!(!legacy_extended.deny);
        assert!(matches!(
            legacy_extended.require(empty.requirements().unwrap()),
            Err(BoxliteError::Unsupported(_))
        ));
    }

    #[test]
    fn prepared_outbound_create_rejects_noncanonical_or_missing_deny_presence() {
        let policy = CompleteOutboundPolicy {
            mode: NetworkMode::Enabled,
            allow_net: vec!["example.com".into()],
            deny_net: Some(vec!["example.net".into()]),
        };
        let mut prepared = PreparedOutboundCreate::new(
            &policy,
            OutboundRevision::parse("cloud-revision").unwrap(),
        )
        .unwrap();
        prepared.deny_present = false;
        assert!(prepared.requirements().is_err());

        prepared.deny_present = true;
        prepared.snapshot.policy.allow_net[0] = "EXAMPLE.com".into();
        assert!(prepared.requirements().is_err());
    }
}

/// Readback always carries both effective lists, including an empty deny list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectiveOutboundPolicy {
    pub mode: NetworkMode,
    pub allow_net: Vec<String>,
    pub deny_net: Vec<String>,
}

/// Independently negotiated requirements on the private outbound wire.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutboundCapabilities {
    pub admission: bool,
    pub deny: bool,
    pub port: bool,
    pub capacity: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub native_ipv6: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl OutboundCapabilities {
    #[cfg(feature = "gvproxy")]
    pub(crate) fn from_bits(bits: u32) -> Self {
        Self {
            admission: bits & 1 != 0,
            deny: bits & 2 != 0,
            port: bits & 4 != 0,
            capacity: bits & 8 != 0,
            native_ipv6: bits & 64 != 0,
        }
    }

    pub(crate) fn union(self, other: Self) -> Self {
        Self {
            admission: self.admission || other.admission,
            deny: self.deny || other.deny,
            port: self.port || other.port,
            capacity: self.capacity || other.capacity,
            native_ipv6: self.native_ipv6 || other.native_ipv6,
        }
    }

    pub fn require(self, required: Self) -> BoxliteResult<()> {
        if self.union(required) != self {
            return Err(BoxliteError::Unsupported(
                "backend lacks required outbound policy capabilities".into(),
            ));
        }
        Ok(())
    }
}

/// Committed launch policy and independent requirements from unresolved attempts.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutboundBootstrap {
    pub snapshot: CompleteOutboundSnapshot,
    pub requirements: OutboundCapabilities,
}

impl CompleteOutboundSnapshot {
    pub(crate) fn prepare_replacement(
        &self,
        policy: &CompleteOutboundPolicy,
        revision: OutboundRevision,
    ) -> BoxliteResult<Self> {
        policy.prepare_with_link(self.admission, revision, self.ipv6.clone())
    }

    pub(crate) fn encode_replacement(
        &self,
        deny_supplied: bool,
        restore: bool,
        versioned: bool,
    ) -> BoxliteResult<String> {
        let body = if versioned {
            #[derive(Serialize)]
            struct Replace<'a> {
                snapshot: &'a CompleteOutboundSnapshot,
                #[serde(skip_serializing_if = "Option::is_none")]
                deny_net: Option<&'a [String]>,
                restore: bool,
            }
            serde_json::to_string(&serde_json::json!({"outbound_v1": Replace {
                snapshot: self,
                deny_net: deny_supplied.then_some(self.policy.deny_net.as_slice()),
                restore,
            }}))
        } else {
            serde_json::to_string(&self.legacy()?.policy)
        }
        .map_err(|error| BoxliteError::Internal(error.to_string()))?;

        // The versioned envelope reserves 1 KiB for metadata around a legacy policy.
        let limit_kib = if versioned { 65 } else { 64 };
        if body.len() > limit_kib << 10 {
            return Err(BoxliteError::InvalidArgument(format!(
                "outbound replacement exceeds the backend's {limit_kib} KiB request limit"
            )));
        }
        Ok(body)
    }

    pub(crate) fn validate_installed(&self) -> BoxliteResult<()> {
        if self.admission == OutboundAdmission::Legacy {
            return self.legacy()?.policy.validate();
        }
        let request = CompleteOutboundPolicy {
            mode: self.policy.mode.clone(),
            allow_net: self.policy.allow_net.clone(),
            deny_net: Some(self.policy.deny_net.clone()),
        };
        let canonical = self.prepare_replacement(&request, self.revision.clone())?;
        if canonical != *self {
            return Err(BoxliteError::InvalidArgument(
                "complete outbound snapshot is not canonical".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn requirements(&self) -> OutboundCapabilities {
        if self.admission == OutboundAdmission::Legacy {
            return OutboundCapabilities::default();
        }
        let policy = &self.policy;
        OutboundCapabilities {
            admission: true,
            deny: !policy.deny_net.is_empty(),
            port: policy
                .allow_net
                .iter()
                .chain(&policy.deny_net)
                .any(|rule| outbound_rules::outbound_rule_has_port(rule)),
            capacity: policy.allow_net.len() > LEGACY_RULES || policy.deny_net.len() > LEGACY_RULES,
            native_ipv6: self.ipv6.is_some(),
        }
    }

    pub(crate) fn legacy(&self) -> BoxliteResult<OutboundSnapshot> {
        if self.admission != OutboundAdmission::Legacy
            || self.ipv6.is_some()
            || !self.policy.deny_net.is_empty()
        {
            return Err(BoxliteError::Unsupported(
                "outbound policy requires the complete policy interface".into(),
            ));
        }
        Ok(OutboundSnapshot {
            revision: self.revision.clone(),
            policy: OutboundNetworkConfig {
                mode: self.policy.mode.clone(),
                allow_net: self.policy.allow_net.clone(),
            },
        })
    }
}

impl From<OutboundSnapshot> for CompleteOutboundSnapshot {
    fn from(value: OutboundSnapshot) -> Self {
        Self {
            revision: value.revision,
            admission: OutboundAdmission::Legacy,
            ipv6: None,
            policy: EffectiveOutboundPolicy {
                mode: value.policy.mode,
                allow_net: value.policy.allow_net,
                deny_net: Vec::new(),
            },
        }
    }
}

/// Runtime readback with both complete identities and the application phase.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompleteOutboundStatus {
    pub persisted: CompleteOutboundSnapshot,
    pub observed: Option<CompleteOutboundObservation>,
    pub application_state: OutboundApplicationState,
    pub pending_revision: Option<OutboundRevision>,
    pub observation_error: Option<String>,
}

/// Backend application phase and the complete observed identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompleteOutboundObservation {
    #[serde(flatten)]
    pub snapshot: CompleteOutboundSnapshot,
    pub application_state: OutboundApplicationState,
}

/// Opaque identity shared by a persisted policy and its applied snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct OutboundRevision(String);

impl OutboundRevision {
    pub(crate) fn initial() -> Self {
        Self("initial".into())
    }

    /// Allocate a fresh identity for a trusted replacement coordinator.
    pub fn fresh() -> Self {
        Self(uuid::Uuid::new_v4().simple().to_string())
    }

    /// Parse the bounded ASCII token used by the outbound control protocol.
    pub fn parse(value: impl Into<String>) -> BoxliteResult<Self> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(BoxliteError::InvalidArgument(
                "invalid outbound revision".into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for OutboundRevision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for OutboundRevision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Complete policy identity. This value alone makes no live-state claim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundSnapshot {
    pub policy: OutboundNetworkConfig,
    pub revision: OutboundRevision,
}

/// Installation phase observed at the network backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundApplicationState {
    Pending,
    Confirmed,
    Uncertain,
}

/// Backend readback, independent of Runtime persistence and connectivity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundSnapshotStatus {
    #[serde(flatten)]
    pub snapshot: OutboundSnapshot,
    pub application_state: OutboundApplicationState,
}

/// Runtime readback comparing durable intent with backend observation.
/// Reading status never reconciles a pending attempt or changes policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundStatus {
    pub persisted: OutboundSnapshot,
    pub observed: Option<OutboundSnapshotStatus>,
    pub application_state: OutboundApplicationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_revision: Option<OutboundRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_error: Option<String>,
}

/// Validated internal compare-and-swap operation with a coordinator-owned ID.
#[derive(Clone, Debug)]
pub struct OutboundReplacement {
    expected: OutboundRevision,
    candidate: OutboundSnapshot,
}

impl OutboundReplacement {
    /// The trusted coordinator must allocate a fresh candidate once per attempt.
    /// Historical reuse is forbidden; the backend does not retain an ID registry.
    pub fn new(expected: OutboundRevision, candidate: OutboundSnapshot) -> BoxliteResult<Self> {
        candidate.policy.validate()?;
        if candidate.revision == expected || candidate.revision.as_str() == "initial" {
            return Err(BoxliteError::InvalidArgument(
                "candidate outbound revision must be fresh".into(),
            ));
        }
        Ok(Self {
            expected,
            candidate,
        })
    }

    pub fn expected(&self) -> &OutboundRevision {
        &self.expected
    }

    pub fn candidate(&self) -> &OutboundSnapshot {
        &self.candidate
    }
}

/// A failed precondition did not apply the candidate and must not be ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use = "a rejected precondition is not a successful update"]
pub enum OutboundReplaceOutcome {
    Applied,
    PreconditionFailed,
}
