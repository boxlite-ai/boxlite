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
    ///
    /// # Returns
    /// Instance ID (handle) or -1 on error
    pub fn gvproxy_create(portMappingsJSON: *const c_char) -> c_longlong;

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        unsafe {
            let version = gvproxy_get_version();
            assert!(!version.is_null());
            gvproxy_free_string(version);
        }
    }
}
