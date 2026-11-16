//! Versioned control values, separate from user outbound policy configuration.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Deserializer, Serialize};

use crate::runtime::options::OutboundNetworkConfig;

/// Opaque identity shared by a persisted policy and its applied snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct OutboundRevision(String);

impl OutboundRevision {
    pub(crate) fn initial() -> Self {
        Self("initial".into())
    }

    pub(crate) fn fresh() -> Self {
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
