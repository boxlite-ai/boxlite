//! GvproxyInstance - High-level wrapper for gvproxy lifecycle management
//!
//! This module provides a safe, RAII-style wrapper around gvproxy instances.
//! Instances are automatically cleaned up when dropped.

use std::path::{Path, PathBuf};
use std::sync::Weak;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::ffi;
use super::logging;
use super::stats::NetworkStats;

/// Safe wrapper for gvproxy library with automatic resource management
///
/// This struct manages the lifecycle of a gvproxy (gvisor-tap-vsock) instance
/// and automatically sets up logging integration on first use.
///
/// ## Logging
///
/// On the first call to `GvproxyInstance::new()`, a logging callback is registered
/// with the Go side via `gvproxy_set_log_callback`. This causes all Go `slog` logs
/// to be forwarded to Rust's `tracing` with the target `"gvproxy"`.
///
/// The callback is registered using `std::sync::Once` to ensure it happens exactly once,
/// regardless of how many instances are created.
///
/// ## Resource Management
///
/// The instance automatically calls `gvproxy_destroy` when dropped, ensuring
/// proper cleanup of Go resources and Unix sockets.
///
/// ## Thread Safety
///
/// `GvproxyInstance` is `Send`, allowing it to be transferred between threads.
/// The underlying CGO layer handles synchronization internally.
///
/// ## Example
///
/// ```no_run
/// use boxlite::net::gvproxy::GvproxyInstance;
/// use std::path::PathBuf;
///
/// // Create instance with caller-provided socket path
/// let socket_path = PathBuf::from("/tmp/my-box/net.sock");
/// let instance = GvproxyInstance::new(socket_path, &[(8080, 80), (8443, 443)])?;
///
/// // Socket path is known from creation — no FFI call needed
/// println!("Socket: {:?}", instance.socket_path());
///
/// // Instance is automatically cleaned up when dropped
/// # Ok::<(), boxlite_shared::errors::BoxliteError>(())
/// ```
#[derive(Debug)]
pub struct GvproxyInstance {
    id: i64,
    socket_path: PathBuf,
}

impl GvproxyInstance {
    /// Create a new gvproxy instance with the given socket path and port mappings
    ///
    /// This automatically initializes the logging bridge on first use.
    ///
    /// # Arguments
    ///
    /// * `socket_path` - Caller-provided Unix socket path (must be unique per box)
    /// * `port_mappings` - List of (host_port, guest_port) tuples for port forwarding
    pub fn new(socket_path: PathBuf, port_mappings: &[(u16, u16)]) -> BoxliteResult<Self> {
        // Initialize logging callback (one-time setup)
        // This ensures all gvproxy logs are routed to Rust's tracing system
        logging::init_logging();

        // Create config with caller-provided socket path + port mappings
        let config = super::config::GvproxyConfig::new(socket_path.clone(), port_mappings.to_vec());

        // Create instance via FFI with full config
        let id = ffi::create_instance(&config)?;

        tracing::info!(id, ?socket_path, "Created GvproxyInstance");

        Ok(Self { id, socket_path })
    }

    /// Unix socket path for the network tap interface.
    ///
    /// This is the caller-provided path passed at creation — no FFI call needed.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Get network statistics from this gvproxy instance
    ///
    /// Returns current network counters including bandwidth, TCP metrics,
    /// and critical debugging counters like forward_max_inflight_drop.
    ///
    /// # Returns
    ///
    /// NetworkStats struct or an error if:
    /// - Instance not found (already destroyed)
    /// - VirtualNetwork not initialized yet (too early)
    /// - JSON parsing failed
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::net::gvproxy::GvproxyInstance;
    ///
    /// let instance = GvproxyInstance::new(&[(8080, 80)])?;
    /// let stats = instance.get_stats()?;
    ///
    /// // Check for packet drops due to maxInFlight limit
    /// if stats.tcp.forward_max_inflight_drop > 0 {
    ///     tracing::warn!(
    ///         drops = stats.tcp.forward_max_inflight_drop,
    ///         "Connections dropped - consider increasing maxInFlight"
    ///     );
    /// }
    ///
    /// println!("Sent: {} bytes, Received: {} bytes",
    ///     stats.bytes_sent, stats.bytes_received);
    /// # Ok::<(), boxlite_shared::errors::BoxliteError>(())
    /// ```
    pub fn get_stats(&self) -> BoxliteResult<NetworkStats> {
        // Get JSON from FFI layer
        let json_str = ffi::get_stats_json(self.id)?;

        tracing::debug!("Received stats JSON: {}", json_str);

        // Parse JSON into NetworkStats
        NetworkStats::from_json_str(&json_str).map_err(|e| {
            BoxliteError::Network(format!(
                "Failed to parse stats JSON from gvproxy: {} (JSON: {})",
                e, json_str
            ))
        })
    }

    /// Get the gvproxy version string
    ///
    /// Returns the version of the gvproxy-bridge library.
    ///
    /// # Returns
    ///
    /// Version string or an error
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::net::gvproxy::GvproxyInstance;
    ///
    /// let version = GvproxyInstance::version()?;
    /// println!("gvproxy version: {}", version);
    /// # Ok::<(), boxlite_shared::errors::BoxliteError>(())
    /// ```
    pub fn version() -> BoxliteResult<String> {
        ffi::get_version()
    }

    /// Get the instance ID
    ///
    /// This is the internal handle used by the CGO layer.
    pub fn id(&self) -> i64 {
        self.id
    }
}

impl Drop for GvproxyInstance {
    fn drop(&mut self) {
        tracing::debug!(id = self.id, "Dropping GvproxyInstance");

        match ffi::destroy_instance(self.id) {
            Ok(()) => tracing::debug!(id = self.id, "Successfully destroyed gvproxy instance"),
            Err(e) => tracing::error!(
                id = self.id,
                error = %e,
                "Failed to destroy gvproxy instance"
            ),
        }
    }
}

// The CGO layer handles synchronization internally, so it's safe to send between threads
unsafe impl Send for GvproxyInstance {}

/// Starts a background task to periodically log network statistics
///
/// This function spawns a tokio task that logs network stats every 30 seconds.
/// The task holds a weak reference to the instance and will automatically exit
/// when the instance is dropped.
///
/// # Arguments
///
/// * `instance` - Weak reference to the GvproxyInstance to monitor
///
/// # Design
///
/// - Uses Weak<GvproxyInstance> to avoid keeping instance alive
/// - Logs at INFO level every 30 seconds
/// - Automatically exits when instance is dropped (weak ref upgrade fails)
/// - Highlights critical metrics like forward_max_inflight_drop
pub(super) fn start_stats_logging(instance: Weak<GvproxyInstance>) {
    tokio::spawn(async move {
        // Wait 30 seconds before first log to let instance stabilize
        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

        loop {
            // Try to upgrade weak reference
            let Some(instance) = instance.upgrade() else {
                tracing::debug!("Stats logging task exiting (instance dropped)");
                break;
            };

            // Get stats and log
            match instance.get_stats() {
                Ok(stats) => {
                    tracing::info!(
                        bytes_sent = stats.bytes_sent,
                        bytes_received = stats.bytes_received,
                        tcp_established = stats.tcp.current_established,
                        tcp_failed = stats.tcp.failed_connection_attempts,
                        tcp_retransmits = stats.tcp.retransmits,
                        tcp_timeouts = stats.tcp.timeouts,
                        "Network statistics"
                    );

                    // Highlight critical drop counter
                    if stats.tcp.forward_max_inflight_drop > 0 {
                        tracing::warn!(
                            drops = stats.tcp.forward_max_inflight_drop,
                            "TCP connections dropped due to maxInFlight limit"
                        );
                    }
                }
                Err(e) => {
                    tracing::debug!(error = %e, "Failed to get stats (instance may be shutting down)");
                }
            }

            // Drop the Arc before sleeping to avoid holding ref
            drop(instance);

            // Sleep 30 seconds before next log
            tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
        }
    });

    tracing::debug!("Started background stats logging task");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_gvproxy_version() {
        let version = GvproxyInstance::version().unwrap();
        assert!(!version.is_empty());
        assert!(version.contains("gvproxy-bridge"));
    }

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_gvproxy_create_destroy() {
        let socket_path = PathBuf::from("/tmp/test-gvproxy-instance.sock");
        let instance =
            GvproxyInstance::new(socket_path.clone(), &[(8080, 80), (8443, 443)]).unwrap();

        // Socket path matches what we provided
        assert_eq!(instance.socket_path(), socket_path);

        // Instance will be destroyed automatically when dropped
    }

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_multiple_instances() {
        let path1 = PathBuf::from("/tmp/test-gvproxy-1.sock");
        let path2 = PathBuf::from("/tmp/test-gvproxy-2.sock");

        let instance1 = GvproxyInstance::new(path1.clone(), &[(8080, 80)]).unwrap();
        let instance2 = GvproxyInstance::new(path2.clone(), &[(9090, 90)]).unwrap();

        assert_ne!(instance1.id(), instance2.id());
        assert_ne!(instance1.socket_path(), instance2.socket_path());
    }
}
