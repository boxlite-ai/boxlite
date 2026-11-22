use boxlite_shared::errors::BoxliteError;
use serde::{Deserialize, Serialize};

use super::{
    CompleteOutboundSnapshot, CompleteOutboundStatus, OutboundApplicationState, OutboundRevision,
};

/// Current committed and live policy identities. A Cloud create can be pending
/// before it has a committed snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OutboundPolicyStatus {
    pub persisted: Option<CompleteOutboundSnapshot>,
    pub runtime_persisted: Option<CompleteOutboundSnapshot>,
    pub observed: Option<OutboundPolicyObservation>,
    pub application_state: OutboundApplicationState,
    pub pending_revision: Option<OutboundRevision>,
    pub observation_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct OutboundPolicyObservation {
    pub snapshot: CompleteOutboundSnapshot,
    pub application_state: OutboundApplicationState,
}

impl OutboundPolicyStatus {
    pub fn confirmed_snapshot(&self) -> Option<&CompleteOutboundSnapshot> {
        let persisted = self.persisted.as_ref()?;
        let observed = self.observed.as_ref()?;
        (self.application_state == OutboundApplicationState::Confirmed
            && observed.application_state == OutboundApplicationState::Confirmed
            && self.pending_revision.is_none()
            && self.observation_error.is_none()
            && &observed.snapshot == persisted
            && self
                .runtime_persisted
                .as_ref()
                .is_none_or(|runtime| runtime == persisted))
        .then_some(persisted)
    }
}

impl From<CompleteOutboundStatus> for OutboundPolicyStatus {
    fn from(status: CompleteOutboundStatus) -> Self {
        Self {
            persisted: Some(status.persisted),
            runtime_persisted: None,
            observed: status.observed.map(|observed| OutboundPolicyObservation {
                snapshot: observed.snapshot,
                application_state: observed.application_state,
            }),
            application_state: status.application_state,
            pending_revision: status.pending_revision,
            observation_error: status.observation_error,
        }
    }
}

/// An acknowledged replacement and an independent read of current live state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OutboundPolicyReplacement {
    pub acknowledged: CompleteOutboundSnapshot,
    pub status: Option<OutboundPolicyStatus>,
    pub application_verified: bool,
    pub status_error: Option<String>,
}

impl OutboundPolicyReplacement {
    pub(crate) fn from_readback(
        acknowledged: CompleteOutboundSnapshot,
        readback: Result<OutboundPolicyStatus, BoxliteError>,
    ) -> Self {
        let (status, status_error) = match readback {
            Ok(status) => (Some(status), None),
            Err(error) => (None, Some(error.to_string())),
        };
        let application_verified = status
            .as_ref()
            .and_then(OutboundPolicyStatus::confirmed_snapshot)
            == Some(&acknowledged);
        Self {
            acknowledged,
            status,
            application_verified,
            status_error,
        }
    }
}

/// Evidence about whether a failed complete policy request took effect.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundPolicyEffect {
    NotAllocated,
    Allocated,
    NotApplied,
    Uncertain,
}

impl OutboundPolicyEffect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAllocated => "not_allocated",
            Self::Allocated => "allocated",
            Self::NotApplied => "not_applied",
            Self::Uncertain => "uncertain",
        }
    }
}

/// Retains the server's status and code, and an allocated Box ID when known.
#[derive(Debug, thiserror::Error)]
pub enum OutboundPolicyError {
    #[error(transparent)]
    Runtime(#[from] BoxliteError),
    #[error(
        "outbound policy {effect:?}: {message} (Box ID {box_id:?}, HTTP {status:?}, code {code:?})"
    )]
    Request {
        effect: OutboundPolicyEffect,
        status: Option<u16>,
        code: Option<String>,
        box_id: Option<String>,
        message: String,
    },
}

pub type OutboundPolicyResult<T> = Result<T, OutboundPolicyError>;
