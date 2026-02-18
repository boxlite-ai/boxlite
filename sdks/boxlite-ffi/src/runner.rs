//! High-level "Runner" API for quick box execution
//!
//! Provides a simplified API for creating a box, running a command, and cleaning up.
//! Useful for scripting and simple integrations.

use std::os::raw::{c_char, c_int};
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxID;
use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;

/// Opaque handle for Runner API (auto-manages runtime)
pub struct BoxRunner {
    pub runtime: BoxliteRuntime,
    pub handle: Option<LiteBox>,
    pub box_id: Option<BoxID>,
    pub tokio_rt: Arc<TokioRuntime>,
}

/// Result structure for runner command execution
#[repr(C)]
pub struct ExecResult {
    pub exit_code: c_int,
    pub stdout_text: *mut c_char,
    pub stderr_text: *mut c_char,
}

impl BoxRunner {
    pub fn new(
        runtime: BoxliteRuntime,
        handle: LiteBox,
        box_id: BoxID,
        tokio_rt: Arc<TokioRuntime>,
    ) -> Self {
        Self {
            runtime,
            handle: Some(handle),
            box_id: Some(box_id),
            tokio_rt,
        }
    }
}
