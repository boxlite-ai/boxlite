//! Runtime management for BoxLite FFI
//!
//! Provides Tokio runtime and BoxliteRuntime handle management.

use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxID;
use boxlite::litebox::LiteBox;
use boxlite::runtime::BoxliteRuntime;

/// Opaque handle to a BoxliteRuntime instance with associated Tokio runtime
pub struct RuntimeHandle {
    pub runtime: BoxliteRuntime,
    pub tokio_rt: Arc<TokioRuntime>,
}

/// Opaque handle to a running box
pub struct BoxHandle {
    pub handle: LiteBox,
    #[allow(dead_code)]
    pub box_id: BoxID,
    pub tokio_rt: Arc<TokioRuntime>,
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
