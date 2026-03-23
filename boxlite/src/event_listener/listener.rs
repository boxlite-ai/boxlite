//! EventListener trait — push-based event callbacks for box operations.
//!
//! Inspired by RocksDB's EventListener pattern. All callbacks default to no-op.
//! Users implement only the events they care about.
//!
//! # Threading
//!
//! Callbacks are called on the thread performing the operation.
//! Implementations must be `Send + Sync`.
//! Callbacks should not block for extended periods.
//!
//! # Example
//!
//! ```rust,ignore
//! use boxlite::event_listener::EventListener;
//! use boxlite::BoxID;
//!
//! struct MetricsCollector;
//!
//! impl EventListener for MetricsCollector {
//!     fn on_exec_started(&self, box_id: &BoxID, command: &str, _args: &[String]) {
//!         println!("Box {} ran: {}", box_id, command);
//!     }
//! }
//! ```

use std::time::Duration;

use crate::BoxID;

/// Push-based event listener for box operations.
///
/// All callbacks default to no-op — implement only what you need.
/// Register at runtime level via `BoxliteOptions::event_listeners`.
pub trait EventListener: Send + Sync {
    // ── Lifecycle ────────────────────────────────────────────────────────

    /// Called after a box is created.
    fn on_box_created(&self, _box_id: &BoxID) {}

    /// Called after a box VM starts successfully.
    fn on_box_started(&self, _box_id: &BoxID) {}

    /// Called after a box VM stops.
    fn on_box_stopped(&self, _box_id: &BoxID, _exit_code: Option<i32>) {}

    /// Called after a box is removed.
    fn on_box_removed(&self, _box_id: &BoxID) {}

    // ── Execution ───────────────────────────────────────────────────────

    /// Called when a command execution starts.
    fn on_exec_started(&self, _box_id: &BoxID, _command: &str, _args: &[String]) {}

    /// Called when a command execution completes.
    fn on_exec_completed(
        &self,
        _box_id: &BoxID,
        _command: &str,
        _exit_code: i32,
        _duration: Duration,
    ) {
    }

    // ── File transfer ───────────────────────────────────────────────────

    /// Called after files are copied from host into the container.
    fn on_file_copied_in(&self, _box_id: &BoxID, _host_src: &str, _container_dst: &str) {}

    /// Called after files are copied from container to host.
    fn on_file_copied_out(&self, _box_id: &BoxID, _container_src: &str, _host_dst: &str) {}
}
