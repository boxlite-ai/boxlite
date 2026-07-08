//! GvproxyInstance - High-level wrapper for gvproxy lifecycle management
//!
//! This module provides a safe, RAII-style wrapper around gvproxy instances.
//! Instances are automatically cleaned up when dropped.

use std::path::{Path, PathBuf};

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
/// `GvproxyInstance` is created internally by BoxLite's gvproxy backend during
/// box startup. Once initialized, the instance exposes its socket path via
/// [`GvproxyInstance::socket_path`] and automatically destroys the underlying
/// gvproxy handle on drop.
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
    pub(crate) fn new(
        socket_path: PathBuf,
        port_mappings: &[(u16, u16)],
        allow_net: Vec<String>,
        secrets: Vec<super::config::GvproxySecretConfig>,
        ca_cert_pem: Option<&str>,
        ca_key_pem: Option<&str>,
    ) -> BoxliteResult<Self> {
        // Initialize logging callback (one-time setup)
        logging::init_logging();

        // Derive gvproxy's control socket as a sibling of the data socket, so the
        // path is never plumbed through neutral config/layout/socket types.
        let control_socket_path = super::control_socket_path(&socket_path);
        let mut config =
            super::config::GvproxyConfig::new(socket_path.clone(), port_mappings.to_vec())
                .with_control_socket_path(control_socket_path)
                .with_allow_net(allow_net)
                .with_secrets(secrets);

        if let (Some(cert), Some(key)) = (ca_cert_pem, ca_key_pem) {
            config = config.with_ca(cert.to_string(), key.to_string());
        }

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

    /// Create a GvproxyInstance from a [`NetworkBackendSpec`] and return the endpoint.
    ///
    /// This is the primary constructor — takes the wire spec the core produced,
    /// creates the gvproxy instance, and returns the platform-specific endpoint
    /// for the VM.
    ///
    /// [`NetworkBackendSpec`]: super::super::NetworkBackendSpec
    pub fn from_config(
        spec: &super::super::NetworkBackendSpec,
    ) -> BoxliteResult<(Self, super::super::NetworkBackendEndpoint)> {
        let secrets = spec.secrets.iter().map(Into::into).collect();
        let instance = Self::new(
            spec.socket_path.clone(),
            &spec.port_mappings,
            spec.allow_net.clone(),
            secrets,
            spec.ca_cert_pem.as_deref(),
            spec.ca_key_pem.as_deref(),
        )?;

        let connection_type = if cfg!(target_os = "macos") {
            super::super::ConnectionType::UnixDgram
        } else {
            super::super::ConnectionType::UnixStream
        };

        use crate::net::constants::GUEST_MAC;
        let endpoint = super::super::NetworkBackendEndpoint::UnixSocket {
            path: spec.socket_path.clone(),
            connection_type,
            mac_address: GUEST_MAC,
        };

        Ok((instance, endpoint))
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
    /// Call this on an existing gvproxy instance to inspect bandwidth counters
    /// and debugging metrics such as `forward_max_inflight_drop`.
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
        let instance = GvproxyInstance::new(
            socket_path.clone(),
            &[(8080, 80), (8443, 443)],
            Vec::new(),
            Vec::new(),
            None,
            None,
        )
        .unwrap();

        // Socket path matches what we provided
        assert_eq!(instance.socket_path(), socket_path);

        // Instance will be destroyed automatically when dropped
    }

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_multiple_instances() {
        let path1 = PathBuf::from("/tmp/test-gvproxy-1.sock");
        let path2 = PathBuf::from("/tmp/test-gvproxy-2.sock");

        let instance1 = GvproxyInstance::new(
            path1.clone(),
            &[(8080, 80)],
            Vec::new(),
            Vec::new(),
            None,
            None,
        )
        .unwrap();
        let instance2 = GvproxyInstance::new(
            path2.clone(),
            &[(9090, 90)],
            Vec::new(),
            Vec::new(),
            None,
            None,
        )
        .unwrap();

        assert_ne!(instance1.id(), instance2.id());
        assert_ne!(instance1.socket_path(), instance2.socket_path());
    }
}
