//! GvproxyInstance - High-level wrapper for gvproxy lifecycle management
//!
//! This module provides a safe, RAII-style wrapper around gvproxy instances.
//! Instances are automatically cleaned up when dropped.

use std::path::{Path, PathBuf};

use crate::net::{OutboundBootstrap, OutboundCapabilities, OutboundRevision};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::ffi;
use super::logging;
use super::platform::CloudGuardBootstrap;
use super::stats::NetworkStats;

/// Safe wrapper for gvproxy library with automatic resource management
///
/// This struct manages the lifecycle of a gvproxy (gvisor-tap-vsock) instance
/// and automatically sets up logging integration on first use.
///
/// ## Logging
///
/// On the first construction, a logging callback is registered
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
    /// Create a gvproxy instance from a fully-built config.
    ///
    /// Takes the assembled config rather than the individual pieces so the
    /// signature stops growing as gvproxy gains settings; [`Self::from_config`]
    /// is what maps a [`NetworkBackendSpec`] onto it.
    ///
    /// This automatically initializes the logging bridge on first use.
    ///
    /// [`NetworkBackendSpec`]: super::super::NetworkBackendSpec
    #[cfg(test)]
    pub(crate) fn new(config: super::config::GvproxyConfig) -> BoxliteResult<Self> {
        Self::new_with_policy(config, None, None, &[], None)
    }

    fn new_with_policy(
        config: super::config::GvproxyConfig,
        revision: Option<&OutboundRevision>,
        outbound: Option<&OutboundBootstrap>,
        protected_cidrs: &[String],
        cloud_guard: Option<&CloudGuardBootstrap>,
    ) -> BoxliteResult<Self> {
        // Initialize logging callback (one-time setup)
        logging::init_logging();

        let socket_path = config.socket_path.clone();
        let id = ffi::create_instance(&config, revision, outbound, protected_cidrs, cloud_guard)?;

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
        Self::from_config_with_outbound(spec, None, None, &[])
    }

    /// Restore a Runtime-owned snapshot identity while provisioning networking.
    pub fn from_config_with_revision(
        spec: &super::super::NetworkBackendSpec,
        revision: &OutboundRevision,
    ) -> BoxliteResult<(Self, super::super::NetworkBackendEndpoint)> {
        Self::from_config_with_outbound(spec, Some(revision), None, &[])
    }

    /// Install a committed policy and check the launch capability requirements.
    #[doc(hidden)]
    pub fn from_complete_config(
        spec: &super::super::NetworkBackendSpec,
        outbound: &OutboundBootstrap,
    ) -> BoxliteResult<(Self, super::super::NetworkBackendEndpoint)> {
        Self::from_config_with_outbound(spec, None, Some(outbound), &[])
    }

    /// Capabilities advertised by the Go archive statically linked into this process.
    #[doc(hidden)]
    pub fn outbound_capabilities() -> OutboundCapabilities {
        ffi::outbound_capabilities()
    }

    #[doc(hidden)]
    pub fn supports_platform_cidrs() -> bool {
        ffi::supports_platform_cidrs()
    }

    #[doc(hidden)]
    pub fn supports_cloud_guard() -> bool {
        ffi::supports_cloud_guard()
    }

    #[doc(hidden)]
    pub fn from_config_with_outbound(
        spec: &super::super::NetworkBackendSpec,
        revision: Option<&OutboundRevision>,
        outbound: Option<&OutboundBootstrap>,
        protected_cidrs: &[String],
    ) -> BoxliteResult<(Self, super::super::NetworkBackendEndpoint)> {
        Self::from_host_launch(spec, revision, outbound, protected_cidrs, None)
    }

    #[doc(hidden)]
    pub fn from_host_launch(
        spec: &super::super::NetworkBackendSpec,
        revision: Option<&OutboundRevision>,
        outbound: Option<&OutboundBootstrap>,
        protected_cidrs: &[String],
        cloud_guard: Option<&CloudGuardBootstrap>,
    ) -> BoxliteResult<(Self, super::super::NetworkBackendEndpoint)> {
        if cloud_guard.is_some() && !Self::supports_cloud_guard() {
            return Err(BoxliteError::Unsupported(
                "gvproxy does not support the Cloud platform guard".into(),
            ));
        }
        if !protected_cidrs.is_empty() && !Self::supports_platform_cidrs() {
            return Err(BoxliteError::Unsupported(
                "gvproxy does not support host-protected CIDRs".into(),
            ));
        }
        let secrets = spec.secrets.iter().map(Into::into).collect();

        // Derive gvproxy's control socket as a sibling of the data socket, so the
        // path is never plumbed through neutral config/layout/socket types.
        let control_socket_path = super::control_socket_path(&spec.socket_path);
        let mut config = crate::net::gvproxy::config::GvproxyConfig::new(spec.socket_path.clone())
            .with_control_socket_path(control_socket_path)
            .with_allow_net(spec.allow_net.clone())
            .with_secrets(secrets)
            .with_rate_limit(spec.rate_limit);
        config.outbound_disabled = spec.outbound_disabled;

        if let (Some(cert), Some(key)) = (spec.ca_cert_pem.as_deref(), spec.ca_key_pem.as_deref()) {
            config = config.with_ca(cert.to_string(), key.to_string());
        }

        let instance =
            Self::new_with_policy(config, revision, outbound, protected_cidrs, cloud_guard)?;

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
        let instance = GvproxyInstance::new(crate::net::gvproxy::config::GvproxyConfig::new(
            socket_path.clone(),
        ))
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

        let instance1 = GvproxyInstance::new(crate::net::gvproxy::config::GvproxyConfig::new(
            path1.clone(),
        ))
        .unwrap();
        let instance2 = GvproxyInstance::new(crate::net::gvproxy::config::GvproxyConfig::new(
            path2.clone(),
        ))
        .unwrap();

        assert_ne!(instance1.id(), instance2.id());
        assert_ne!(instance1.socket_path(), instance2.socket_path());
    }
}
