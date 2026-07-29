//! Lifecycle policy for published-port metadata.
//!
//! Concrete bindings belong to the live network backend and are retained with
//! the [`super::box_impl::LiveState`] that published or reconciled them. This
//! module also answers whether an empty publication set is known from lifecycle
//! state alone, without querying the backend.

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

    /// The bindings, but only if `lifecycle` is still the shim that owns them.
    /// A binding must never outlive the process holding its listener.
    pub(crate) fn bindings_for(&self, lifecycle: PidRecord) -> Option<&[PublishedPort]> {
        (self.lifecycle == lifecycle).then_some(&self.bindings)
    }
}

/// Published ports derivable from persisted state alone.
///
/// `None` means this handle does not know the current bindings; `Some([])` means
/// there are provably none. A live shim can still own listeners even when
/// persisted state says the box is stopped or failed, so only an absent shim
/// proves an empty set — running bindings need a publication result retained by
/// the box handle, which [`super::box_impl::BoxImpl::info`] overlays.
pub(crate) fn resolved_from_state(
    config: &BoxConfig,
    state: &BoxState,
) -> Option<Vec<PublishedPort>> {
    use crate::BoxStatus::{Configured, Failed, Paused, Running, Stopped, Stopping, Unknown};

    if config.options.ports.is_empty() {
        return Some(Vec::new());
    }

    match state.status {
        // Start and restart publish ports before the public state flips to
        // Running, and cleanup after a failure can itself fail. A verified live
        // shim means "empty" has not been proven.
        Configured | Stopped | Failed => {
            let pid_file = PidFileReader::at(config.box_home.join(dirs::SHIM_PID_FILE));
            (pid_file.process_identity() == ProcessIdentity::Absent).then(Vec::new)
        }
        // Running and paused lifecycles can still own listeners, and an unknown
        // or stopping one cannot prove anything either way.
        Running | Paused | Stopping | Unknown => None,
    }
}
