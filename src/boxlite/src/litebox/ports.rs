//! Lifecycle policy for published-port metadata.
//!
//! Concrete bindings belong to the live network backend and are overlaid by
//! [`super::box_impl::BoxImpl`] only after publication or live observation.
//! This module answers the synchronous question that does not require backend
//! I/O: whether an empty publication set is authoritative for the lifecycle.

use super::config::BoxConfig;
use super::state::BoxState;
use crate::runtime::layout::dirs;
use crate::runtime::types::PublishedPort;
use crate::util::{PidFileReader, PidRecord, ProcessIdentity};

/// Concrete bindings tied to the exact shim lifecycle that published or
/// confirmed them. This is process memory only; gvproxy remains authoritative
/// for asynchronous metadata reads.
#[derive(Clone)]
pub(crate) struct LivePublishedPorts {
    lifecycle: PidRecord,
    bindings: Vec<PublishedPort>,
}

impl LivePublishedPorts {
    pub(crate) fn new(lifecycle: PidRecord, bindings: Vec<PublishedPort>) -> Self {
        Self {
            lifecycle,
            bindings,
        }
    }

    pub(crate) fn lifecycle(&self) -> PidRecord {
        self.lifecycle
    }

    pub(crate) fn bindings(&self) -> &[PublishedPort] {
        &self.bindings
    }
}

/// Resolved-port view safe to expose through [`crate::BoxInfo`].
pub(crate) struct PortResolution {
    pub(crate) published_ports: Option<Vec<PublishedPort>>,
}

impl PortResolution {
    fn resolved(published_ports: Vec<PublishedPort>) -> Self {
        Self {
            published_ports: Some(published_ports),
        }
    }

    fn unresolved() -> Self {
        Self {
            published_ports: None,
        }
    }

    /// Build the lifecycle-only synchronous view.
    ///
    /// A live shim can still own listeners even if persisted state says the box
    /// is stopped or failed, so only an absent shim proves an empty set. Running
    /// bindings require an in-memory publication result or live backend query.
    pub(crate) fn load(config: &BoxConfig, state: &BoxState) -> Self {
        if config.options.ports.is_empty() {
            return Self::resolved(Vec::new());
        }
        let pid_file = PidFileReader::at(config.box_home.join(dirs::SHIM_PID_FILE));
        match state.status {
            crate::BoxStatus::Configured | crate::BoxStatus::Stopped | crate::BoxStatus::Failed => {
                // Start/restart publishes ports before the public state flips
                // to Running, and failed cleanup can itself fail. A verified
                // live shim means "empty" has not yet been proven.
                return if pid_file.process_identity() != ProcessIdentity::Absent {
                    Self::unresolved()
                } else {
                    Self::resolved(Vec::new())
                };
            }
            crate::BoxStatus::Unknown | crate::BoxStatus::Stopping => {
                return Self::unresolved();
            }
            crate::BoxStatus::Running | crate::BoxStatus::Paused => {}
        }

        // Running and paused states can still own listeners, but resolving
        // them requires querying the live backend.
        Self::unresolved()
    }
}
