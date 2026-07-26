//! Lifecycle policy for published-port metadata.
//!
//! Concrete bindings belong to the live network backend and are retained with
//! the [`super::box_impl::LiveState`] that published or reconciled them. This
//! module also answers whether an empty publication set is known from lifecycle
//! state without querying the backend.

use super::config::BoxConfig;
use super::state::BoxState;
use crate::runtime::layout::dirs;
use crate::runtime::types::PublishedPort;
use crate::util::{PidFileReader, PidRecord, ProcessIdentity};

/// Concrete bindings tied to the exact shim lifecycle that published or
/// confirmed them. This is process memory only and disappears with the owning
/// `BoxImpl`.
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

    /// Build the lifecycle-only view used before live state is available.
    ///
    /// A live shim can still own listeners even if persisted state says the box
    /// is stopped or failed, so only an absent shim proves an empty set. Running
    /// bindings require a publication result retained by this box handle.
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

        // Running and paused states can still own listeners. Their concrete
        // bindings are overlaid from this process's LiveState by BoxImpl::info.
        Self::unresolved()
    }
}
