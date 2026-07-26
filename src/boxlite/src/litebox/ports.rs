//! Lifecycle policy for published-port metadata.
//!
//! Concrete bindings belong to the live network backend and are overlaid by
//! [`super::box_impl::BoxImpl`] only after publication or live observation.
//! This module answers the synchronous question that does not require backend
//! I/O: whether an empty publication set is authoritative for the lifecycle.

use super::config::BoxConfig;
use super::state::BoxState;
use crate::BoxID;
use crate::runtime::layout::dirs;
use crate::runtime::types::PublishedPort;
use crate::util::{PidFileReader, PidRecord, ProcessIdentity};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

/// Concrete bindings tied to the exact shim lifecycle that published or
/// confirmed them. This is process memory only; gvproxy is consulted when a
/// fresh core process must recover a lifecycle it did not publish.
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

/// Process-local resolved bindings, scoped to the exact shim lifecycle.
///
/// gvproxy must be consulted after a cold core-process restart because these
/// bindings are deliberately not persisted. Within one runtime process, the
/// cache prevents metadata reads from repeatedly querying the control socket.
#[derive(Default)]
pub(crate) struct PublishedPortCache {
    state: Mutex<PublishedPortCacheState>,
}

#[derive(Default)]
struct PublishedPortCacheState {
    bindings: HashMap<(BoxID, PidRecord), Vec<PublishedPort>>,
    refreshes: HashMap<BoxID, Weak<PublishedPortRefresh>>,
}

pub(crate) struct PublishedPortRefresh {
    gate: tokio::sync::Mutex<()>,
    generation: AtomicU64,
}

impl PublishedPortRefresh {
    fn new() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }

    pub(crate) async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
}

impl PublishedPortCache {
    pub(crate) fn get(&self, box_id: &BoxID, lifecycle: PidRecord) -> Option<Vec<PublishedPort>> {
        self.state
            .lock()
            .bindings
            .get(&(box_id.clone(), lifecycle))
            .cloned()
    }

    /// Store only if no lifecycle invalidation occurred after `generation` was
    /// captured under this refresh gate.
    pub(crate) fn store_if_current(
        &self,
        box_id: &BoxID,
        refresh: &Arc<PublishedPortRefresh>,
        generation: u64,
        published_ports: LivePublishedPorts,
    ) -> bool {
        let lifecycle = published_ports.lifecycle();
        let bindings = published_ports.bindings().to_vec();
        let mut state = self.state.lock();
        let is_current_refresh = state
            .refreshes
            .get(box_id)
            .and_then(Weak::upgrade)
            .is_some_and(|current| Arc::ptr_eq(&current, refresh));
        if !is_current_refresh || refresh.generation() != generation {
            return false;
        }
        state.bindings.insert((box_id.clone(), lifecycle), bindings);
        true
    }

    /// Single-flight publication and cold observation across independently
    /// constructed BoxImpl values, including those used by `list_info`.
    pub(crate) fn refresh_lock(&self, box_id: &BoxID) -> Arc<PublishedPortRefresh> {
        let mut state = self.state.lock();
        state
            .refreshes
            .retain(|_, refresh| refresh.strong_count() > 0);
        if let Some(refresh) = state.refreshes.get(box_id).and_then(Weak::upgrade) {
            return refresh;
        }

        let refresh = Arc::new(PublishedPortRefresh::new());
        state
            .refreshes
            .insert(box_id.clone(), Arc::downgrade(&refresh));
        refresh
    }

    pub(crate) fn invalidate(&self, box_id: &BoxID) {
        let mut state = self.state.lock();
        state
            .bindings
            .retain(|(cached_box_id, _), _| cached_box_id != box_id);
        state
            .refreshes
            .retain(|_, refresh| refresh.strong_count() > 0);
        if let Some(refresh) = state.refreshes.get(box_id).and_then(Weak::upgrade) {
            // The entry stays in the map while an observer owns it, so new
            // callers share its gate and the old generation cannot store.
            refresh.invalidate();
        } else {
            state.refreshes.remove(box_id);
        }
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
        // them requires a lifecycle cache populated by publication or recovery.
        Self::unresolved()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BoxIDMint;
    use crate::runtime::options::PortProtocol;

    fn binding(host_port: u16) -> PublishedPort {
        PublishedPort {
            guest_port: 3000,
            host_ip: "127.0.0.1".to_string(),
            host_port,
            protocol: PortProtocol::Tcp,
        }
    }

    #[test]
    fn cache_is_lifecycle_bound_replaceable_and_invalidatable() {
        let cache = PublishedPortCache::default();
        let box_id = BoxIDMint::mint();
        let refresh = cache.refresh_lock(&box_id);
        let generation = refresh.generation();
        let first_lifecycle = PidRecord {
            pid: 101,
            start_time: Some(1001),
        };
        let second_lifecycle = PidRecord {
            pid: 102,
            start_time: Some(1002),
        };

        assert!(cache.store_if_current(
            &box_id,
            &refresh,
            generation,
            LivePublishedPorts::new(first_lifecycle, vec![binding(49152)]),
        ));
        assert_eq!(
            cache.get(&box_id, first_lifecycle),
            Some(vec![binding(49152)])
        );
        assert_eq!(cache.get(&box_id, second_lifecycle), None);

        assert!(cache.store_if_current(
            &box_id,
            &refresh,
            generation,
            LivePublishedPorts::new(first_lifecycle, vec![binding(49153)]),
        ));
        assert!(cache.store_if_current(
            &box_id,
            &refresh,
            generation,
            LivePublishedPorts::new(second_lifecycle, vec![binding(49154)]),
        ));
        assert_eq!(
            cache.get(&box_id, first_lifecycle),
            Some(vec![binding(49153)])
        );
        assert_eq!(
            cache.get(&box_id, second_lifecycle),
            Some(vec![binding(49154)])
        );

        cache.invalidate(&box_id);
        assert_eq!(cache.get(&box_id, first_lifecycle), None);
        assert_eq!(cache.get(&box_id, second_lifecycle), None);
    }

    #[tokio::test]
    async fn invalidation_keeps_an_in_flight_refresh_generation() {
        let cache = PublishedPortCache::default();
        let box_id = BoxIDMint::mint();
        let active_refresh = cache.refresh_lock(&box_id);
        let _held_refresh = active_refresh.lock().await;
        let stale_generation = active_refresh.generation();

        cache.invalidate(&box_id);

        let next_refresh = cache.refresh_lock(&box_id);
        assert!(
            Arc::ptr_eq(&active_refresh, &next_refresh),
            "invalidation must not split callers across refresh generations"
        );
        assert_ne!(next_refresh.generation(), stale_generation);
        assert!(
            !cache.store_if_current(
                &box_id,
                &active_refresh,
                stale_generation,
                LivePublishedPorts::new(
                    PidRecord {
                        pid: 101,
                        start_time: Some(1001),
                    },
                    vec![binding(49152)],
                ),
            ),
            "an invalidated in-flight observation must not resurrect bindings"
        );
    }
}
