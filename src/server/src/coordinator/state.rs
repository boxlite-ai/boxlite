//! Shared state for the coordinator.

use std::sync::Arc;

use crate::scheduler::Scheduler;
use crate::store::StateStore;

/// Coordinator-wide state shared across all Axum handlers.
pub struct CoordinatorState {
    pub store: Arc<dyn StateStore>,
    pub scheduler: Arc<dyn Scheduler>,
}
