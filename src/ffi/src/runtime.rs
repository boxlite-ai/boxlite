//! Runtime management for BoxLite FFI
//!
//! Provides Tokio runtime and BoxliteRuntime handle management.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxID;
use boxlite::ImageHandle as CoreImageHandle;
use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;

/// Opaque handle to a BoxliteRuntime instance with associated Tokio runtime
pub struct RuntimeHandle {
    pub runtime: BoxliteRuntime,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
}

/// Opaque handle to runtime image operations
pub struct ImageHandle {
    pub handle: CoreImageHandle,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
}

/// Opaque handle to a running box
pub struct BoxHandle {
    pub handle: LiteBox,
    #[allow(dead_code)]
    pub box_id: BoxID,
    pub tokio_rt: Arc<TokioRuntime>,
}

/// Shared runtime liveness for FFI-owned handles.
///
/// Image handles use this to honor the runtime shutdown/free boundary even
/// though they retain their own core handle internally.
pub struct RuntimeLiveness {
    alive: AtomicBool,
}

impl RuntimeLiveness {
    pub fn new() -> Self {
        Self {
            alive: AtomicBool::new(true),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn mark_closed(&self) {
        self.alive.store(false, Ordering::Release);
    }
}

impl Default for RuntimeLiveness {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a new Tokio runtime
pub fn create_tokio_runtime() -> Result<Arc<TokioRuntime>, String> {
    TokioRuntime::new()
        .map(Arc::new)
        .map_err(|e| format!("Failed to create async runtime: {}", e))
}

/// Block on a future using the provided Tokio runtime
pub fn block_on<F: std::future::Future>(tokio_rt: &TokioRuntime, future: F) -> F::Output {
    tokio_rt.block_on(future)
}
