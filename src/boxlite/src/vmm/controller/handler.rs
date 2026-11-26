//! VmmHandler - Runtime operations on a running VM.

use super::VmmMetrics;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Trait for runtime operations on a running VM.
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
pub trait VmmHandler: Send {
    /// Stop the VM.
    fn stop(&mut self) -> BoxliteResult<()>;

    /// Capture VM memory for a full checkpoint in the destination directory.
    fn capture_memory_checkpoint(&self, _dest_dir: &std::path::Path) -> BoxliteResult<()> {
        Err(BoxliteError::Unsupported(
            "full memory checkpoint capture is not supported by this VMM backend".into(),
        ))
    }

    /// Get VM metrics (CPU, memory, disk usage).
    fn metrics(&self) -> BoxliteResult<VmmMetrics>;

    /// Check if the VM is still running.
    fn is_running(&self) -> bool;

    /// Get the process ID of the running VM.
    fn pid(&self) -> u32;
}
