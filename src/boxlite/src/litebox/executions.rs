//! Live execution inventory and control recovery for a box.

use std::sync::Arc;

use boxlite_shared::errors::BoxliteResult;

use super::exec::{Execution, ExecutionInfo};
use crate::runtime::backend::BoxBackend;

/// Namespace for the live execution sessions of one box.
///
/// Discovery and recovery never start or restart the box. Attaching to output
/// stays on [`LiteBox::attach`](super::LiteBox::attach).
#[derive(Clone)]
pub struct ExecutionsHandle {
    backend: Arc<dyn BoxBackend>,
}

impl ExecutionsHandle {
    /// Retain the backend without starting it; the backend decides support.
    pub(super) fn new(backend: Arc<dyn BoxBackend>) -> Self {
        Self { backend }
    }

    /// Discover live guest sessions, including the main command. Never starts
    /// or restarts a box. Finished sessions are not execution history.
    pub async fn list(&self) -> BoxliteResult<Vec<ExecutionInfo>> {
        self.backend.list_executions().await
    }

    /// Recover a control-only handle for a live execution in this box.
    ///
    /// Does not claim the output reader or stdin; use `attach` separately for
    /// streams. Wait, signal, kill, and resize remain available while another
    /// handle reads output. Recovery does not start the box.
    pub async fn get(&self, execution_id: &str) -> BoxliteResult<Execution> {
        self.backend.get_execution(execution_id).await
    }
}
