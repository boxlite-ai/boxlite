//! Low-level FFI bindings to libgvproxy
//!
//! This crate provides raw, unsafe bindings to the gvproxy-bridge C library.
//! For a safe, idiomatic Rust API, use the higher-level wrapper in the boxlite crate.

use std::os::raw::{c_char, c_int, c_longlong, c_void};

/// Logging callback function type
///
/// Called by Go's slog handler to forward log messages to Rust.
///
/// # Arguments
/// * `level` - Log level (0=trace, 1=debug, 2=info, 3=warn, 4=error)
/// * `message` - Log message (null-terminated C string)
pub type LogCallbackFn = extern "C" fn(level: c_int, message: *const c_char);

extern "C" {
    /// Create a new gvproxy instance with port mappings
    ///
    /// # Arguments
    /// * `portMappingsJSON` - JSON string describing port mappings
    /// * `errOut` - On failure, receives a heap-allocated C string with the
    ///   underlying error message. Caller must free via `gvproxy_free_string`.
    ///   Pass null to discard the message.
    ///
    /// # Returns
    /// Instance ID (handle) or -1 on error
    pub fn gvproxy_create(portMappingsJSON: *const c_char, errOut: *mut *mut c_char) -> c_longlong;

    /// Free a string allocated by libgvproxy
    ///
    /// # Arguments
    /// * `str` - Pointer to string returned by gvproxy functions
    pub fn gvproxy_free_string(str: *mut c_char);

    /// Destroy a gvproxy instance and free resources
    ///
    /// # Arguments
    /// * `id` - Instance ID to destroy
    ///
    /// # Returns
    /// 0 on success, non-zero on error
    pub fn gvproxy_destroy(id: c_longlong) -> c_int;

    /// Get network statistics for a gvproxy instance
    ///
    /// Returns a JSON string containing network statistics including:
    /// - bytes_sent, bytes_received: Total bandwidth
    /// - tcp.forward_max_inflight_drop: Packets dropped due to maxInFlight limit
    /// - tcp.current_established: Active TCP connections
    /// - tcp.failed_connection_attempts: Total connection failures
    /// - tcp.retransmits: TCP segments retransmitted
    /// - tcp.timeouts: RTO timeout events
    ///
    /// # Arguments
    /// * `id` - Instance ID returned from gvproxy_create
    ///
    /// # Returns
    /// Pointer to JSON string (must be freed with gvproxy_free_string), or NULL if:
    /// - Instance doesn't exist
    /// - VirtualNetwork not initialized yet
    /// - Stats collection or serialization failed
    ///
    /// # Safety
    /// - `id` must be a valid instance ID
    /// - Returned pointer must be freed with gvproxy_free_string
    /// - Do not use pointer after calling gvproxy_free_string
    pub fn gvproxy_get_stats(id: c_longlong) -> *mut c_char;

    /// Get the libgvproxy version string
    ///
    /// # Returns
    /// Pointer to version string (must be freed with gvproxy_free_string)
    pub fn gvproxy_get_version() -> *mut c_char;

    /// Set the log callback function for routing gvproxy logs to Rust
    ///
    /// When set, Go's slog handler will call this callback for all log messages,
    /// allowing integration with Rust's tracing system.
    ///
    /// # Arguments
    /// * `callback` - Function pointer to Rust logging callback, or NULL to disable
    ///
    /// # Safety
    /// The callback must be thread-safe and must not panic.
    /// Pass NULL to restore default stderr logging.
    pub fn gvproxy_set_log_callback(callback: *const c_void);

    /// Poll the oldest unread runtime-phase error from the named instance.
    ///
    /// Runtime-phase errors are emitted by background goroutines that ran
    /// after `gvproxy_create` returned — Accept failures, protocol-handler
    /// errors, late TCP-filter misconfig. Pre-`ErrSink`, these went only to
    /// `logrus.Error` and were invisible to the Rust runtime.
    ///
    /// Intended call pattern: a background tokio task polls every ~250ms,
    /// folds each non-nil return into a `BoxliteError::Network` and writes
    /// it to the box's log file as a structured event. Drains the in-Go
    /// channel one event per call.
    ///
    /// # Arguments
    /// * `id` - Instance ID returned from `gvproxy_create`
    ///
    /// # Returns
    /// Pointer to error string (must be freed with `gvproxy_free_string`),
    /// or NULL if the instance has no unread runtime errors.
    ///
    /// Format: `[2026-06-03T10:00:00.000Z] vn.AcceptQemu: <cause>`
    ///
    /// # Safety
    /// Returned pointer must be freed with `gvproxy_free_string`. Do not
    /// use after free.
    pub fn gvproxy_poll_runtime_error(id: c_longlong) -> *mut c_char;

    /// TEST-ONLY: create a minimal instance for integration tests of the
    /// `gvproxy_poll_runtime_error` polling pattern. No socket, no
    /// goroutines, no virtual network — just an instance map entry with a
    /// live ErrSink so tests can drive injection + polling without the
    /// cost of a real VM transport.
    ///
    /// Pair with `gvproxy_test_inject_runtime_error` to inject events and
    /// `gvproxy_destroy` to clean up.
    pub fn gvproxy_test_create_for_polling() -> c_longlong;

    /// TEST-ONLY: push a synthetic runtime error into the named instance's
    /// ErrSink. Pairs with `gvproxy_test_create_for_polling` for hermetic
    /// Rust integration tests of the polling path.
    ///
    /// # Arguments
    /// * `id` - Instance ID (from `gvproxy_test_create_for_polling`)
    /// * `source` - C string naming the source site (e.g. "AcceptQemu")
    /// * `message` - C string with the error cause
    ///
    /// # Safety
    /// `source` and `message` must be valid null-terminated C strings;
    /// the Go side copies them, so the caller may free immediately.
    pub fn gvproxy_test_inject_runtime_error(
        id: c_longlong,
        source: *const c_char,
        message: *const c_char,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::{CStr, CString};

    #[test]
    fn test_version() {
        unsafe {
            let version = gvproxy_get_version();
            assert!(!version.is_null());
            gvproxy_free_string(version);
        }
    }

    /// Helper: pull one runtime error out as a Rust `String`, freeing the
    /// underlying C string. Returns `None` if the poll returned NULL.
    fn poll_one(id: c_longlong) -> Option<String> {
        unsafe {
            let raw = gvproxy_poll_runtime_error(id);
            if raw.is_null() {
                return None;
            }
            let owned = CStr::from_ptr(raw).to_string_lossy().into_owned();
            gvproxy_free_string(raw);
            Some(owned)
        }
    }

    /// Helper: inject a synthetic runtime error via the test-only FFI.
    fn inject(id: c_longlong, source: &str, message: &str) {
        let c_source = CString::new(source).unwrap();
        let c_message = CString::new(message).unwrap();
        unsafe {
            gvproxy_test_inject_runtime_error(id, c_source.as_ptr(), c_message.as_ptr());
        }
    }

    /// End-to-end: create a fixture instance, observe the empty-queue
    /// case, inject one error, observe it surfaces with source + cause,
    /// observe the queue drains back to empty. Validates the full
    /// FFI path Rust callers will use:
    ///   gvproxy_test_create_for_polling
    ///   -> gvproxy_test_inject_runtime_error
    ///   -> gvproxy_poll_runtime_error
    ///   -> gvproxy_free_string
    ///   -> gvproxy_destroy
    #[test]
    fn poll_runtime_error_round_trips_through_ffi() {
        let id = unsafe { gvproxy_test_create_for_polling() };
        assert!(id > 0, "test fixture must return a valid id");

        // Empty queue -> NULL.
        assert!(
            poll_one(id).is_none(),
            "freshly-created instance must have no runtime errors",
        );

        // Inject one event from the Rust side.
        inject(id, "AcceptQemu", "use of closed network connection");

        // Poll should now return the formatted event.
        let surfaced = poll_one(id).expect(
            "after injection, poll must surface the event — \
             this is the path the 5 silent gvproxy goroutines now feed",
        );
        assert!(
            surfaced.contains("AcceptQemu"),
            "rendered event must name source AcceptQemu; got: {surfaced}",
        );
        assert!(
            surfaced.contains("use of closed network connection"),
            "rendered event must contain the cause string; got: {surfaced}",
        );
        // RFC3339Nano: yyyy-mm-ddTHH:MM:SS.nnnnnnnnnZ
        assert!(
            surfaced.contains("T") && surfaced.contains("Z"),
            "rendered event must have RFC3339 timestamp; got: {surfaced}",
        );

        // Queue should be drained.
        assert!(
            poll_one(id).is_none(),
            "queue must be empty after draining the only event",
        );

        unsafe {
            assert_eq!(gvproxy_destroy(id), 0, "destroy must succeed");
        }
    }

    /// FIFO contract through the FFI: multiple injected events come out
    /// in the same order. Pins that the polling pattern doesn't reorder.
    #[test]
    fn poll_runtime_error_preserves_fifo_through_ffi() {
        let id = unsafe { gvproxy_test_create_for_polling() };
        assert!(id > 0);

        let events = [
            ("OverrideTCPHandler", "filter install failed"),
            ("transport.AcceptVfkit", "vfkit handshake failed"),
            ("vn.AcceptQemu", "qemu protocol panic"),
        ];
        for (source, msg) in &events {
            inject(id, source, msg);
        }

        for (i, (source, msg)) in events.iter().enumerate() {
            let got = poll_one(id).unwrap_or_else(|| panic!("missing event {i}"));
            assert!(
                got.contains(source) && got.contains(msg),
                "poll {i}: expected source={source} cause={msg}; got: {got}",
            );
        }
        assert!(poll_one(id).is_none(), "queue must be empty after 3 polls");

        unsafe {
            assert_eq!(gvproxy_destroy(id), 0);
        }
    }

    /// Polling an unknown id (never created, or already destroyed) must
    /// return NULL — never panic, never UB. This is the contract Rust
    /// callers depend on for the always-on background polling task.
    #[test]
    fn poll_runtime_error_unknown_id_returns_null() {
        // 0 is never a valid id (nextID starts at 1)
        assert!(poll_one(0).is_none());
        // A very large id that was never created
        assert!(poll_one(999_999_999).is_none());

        // Created-then-destroyed id also returns NULL
        let id = unsafe { gvproxy_test_create_for_polling() };
        inject(id, "AcceptQemu", "should be dropped on destroy");
        unsafe {
            assert_eq!(gvproxy_destroy(id), 0);
        }
        assert!(
            poll_one(id).is_none(),
            "polling a destroyed instance must return NULL, not the buffered event",
        );
    }
}
