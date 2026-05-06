//! VmmHandler - Runtime operations on a running VM.

use super::VmmMetrics;
use crate::util::ProcessExit;
use boxlite_shared::BoxliteResult;

/// Trait for runtime operations on a running VM.
#[async_trait::async_trait]
///
/// Separates runtime operations (stop, metrics) from spawning operations (VmmController).
/// This allows reconnection to existing VMs by creating a handler directly from PID.
///
/// The handler is purely about VM lifecycle management:
/// - Stop the VM
/// - Get VM metrics
/// - Check if running
/// - Get process ID
///
/// Other metadata (transport, boot duration) is stored in BoxConfig/BoxMetrics.
pub trait VmmHandler: Send + Sync {
    /// Stop the VM.
    fn stop(&mut self) -> BoxliteResult<()>;

    /// Get VM metrics (CPU, memory, disk usage).
    fn metrics(&self) -> BoxliteResult<VmmMetrics>;

    /// Check if the VM is still running.
    fn is_running(&self) -> bool;

    /// Get the process ID of the running VM.
    fn pid(&self) -> u32;

    /// Wait for the VM process to exit.
    ///
    /// Spawn path uses `tokio::process::Child::wait()` (event-driven).
    /// Attach path falls back to PID-based polling.
    ///
    /// # Errors
    ///
    /// Returns `Err` if the child handle has already been consumed
    /// (e.g., `wait_for_exit()` or `stop()` was called previously),
    /// or in the attach path where no child handle exists.
    async fn wait_for_exit(&self) -> BoxliteResult<ProcessExit>;
}
