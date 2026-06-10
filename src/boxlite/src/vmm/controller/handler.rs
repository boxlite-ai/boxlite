//! VmmHandler - Runtime operations on a running VM.

use super::VmmMetrics;
use boxlite_shared::BoxliteResult;

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
    /// Stop the VM gracefully — SIGTERM, wait up to a budget, then
    /// SIGKILL if needed.
    fn stop(&mut self) -> BoxliteResult<()>;

    /// Stop the VM immediately with SIGKILL (no graceful SIGTERM phase).
    ///
    /// Used by `rm --force` so the kill+reap goes through the same
    /// 持-Child path as the canonical `stop()` — instead of the
    /// older `kill_process(pid) + libc::waitpid` shortcut that
    /// bypassed the `Child` handle (Issue #523 / #613). Functionally
    /// identical (kernel-level reap), but keeps a single canonical
    /// kill path in the codebase.
    fn stop_force(&mut self) -> BoxliteResult<()>;

    /// Get VM metrics (CPU, memory, disk usage).
    fn metrics(&self) -> BoxliteResult<VmmMetrics>;

    /// Check if the VM is still running.
    fn is_running(&self) -> bool;

    /// Get the process ID of the running VM.
    fn pid(&self) -> u32;
}
