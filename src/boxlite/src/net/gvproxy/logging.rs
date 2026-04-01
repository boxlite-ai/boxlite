//! Logging bridge between Go's slog and Rust's tracing
//!
//! This module implements a callback-based logging bridge that allows Go code
//! to forward log messages to Rust's tracing system. The bridge is initialized
//! once on first use and remains active for the lifetime of the program.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::sync::Once;

use libgvproxy_sys::gvproxy_set_log_callback;

/// Log callback implementation that forwards Go slog messages to Rust tracing
///
/// This function is called by Go's RustTracingHandler whenever a log message is emitted.
/// It bridges Go's structured logging with Rust's tracing system using the "gvproxy" target.
///
/// # Safety
///
/// This function is `extern "C"` and called from Go via CGO. It must not panic.
/// The `message` pointer is guaranteed to be valid and null-terminated by the Go side.
///
/// # Log Level Mapping
///
/// - 0 → `tracing::trace!`
/// - 1 → `tracing::debug!`
/// - 2 → `tracing::info!`
/// - 3 → `tracing::warn!`
/// - 4 → `tracing::error!`
extern "C" fn gvproxy_log_callback(level: c_int, message: *const c_char) {
    if message.is_null() {
        return;
    }

    let msg = unsafe {
        match CStr::from_ptr(message).to_str() {
            Ok(s) => s,
            Err(_) => {
                // Invalid UTF-8, skip this log message
                return;
            }
        }
    };

    // Route to tracing with "gvproxy" target for easy filtering
    // Users can control gvproxy logs with RUST_LOG=gvproxy=debug
    match level {
        0 => tracing::trace!(target: "gvproxy", "{}", msg),
        1 => tracing::debug!(target: "gvproxy", "{}", msg),
        2 => tracing::info!(target: "gvproxy", "{}", msg),
        3 => tracing::warn!(target: "gvproxy", "{}", msg),
        4 => tracing::error!(target: "gvproxy", "{}", msg),
        _ => tracing::info!(target: "gvproxy", "{}", msg),
    }
}

/// Initialize the logging bridge between Go and Rust
///
/// This function registers the logging callback with the Go side, causing all
/// Go `slog` messages to be forwarded to Rust's tracing system.
///
/// This function is safe to call multiple times; the initialization only happens once
/// thanks to `std::sync::Once`.
///
/// # Example
///
/// ```no_run
/// use boxlite::net::gvproxy::logging::init_logging;
///
/// // Initialize logging bridge (idempotent)
/// init_logging();
/// ```
pub fn init_logging() {
    static INIT_LOGGING: Once = Once::new();
    INIT_LOGGING.call_once(|| {
        tracing::debug!("Initializing gvproxy log callback");
        unsafe {
            gvproxy_set_log_callback(gvproxy_log_callback as *const std::ffi::c_void);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_logging_multiple_times() {
        // Should be safe to call multiple times
        init_logging();
        init_logging();
        init_logging();
    }
}
