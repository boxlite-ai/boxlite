//! Network backend abstraction for Boxes.
//!
//! This module provides a trait-based architecture for pluggable network backends,
//! allowing different net implementations (libslirp, gvproxy, passt, etc.) to be
//! used without changing engine code.
//!
//! When no backend is configured (None), the engine uses its default net
//! implementation.

use boxlite_shared::errors::BoxliteResult;
use std::path::PathBuf;

pub(crate) mod ca;
pub mod constants;
pub mod socket_path;

#[cfg(feature = "libslirp")]
mod libslirp;

#[cfg(feature = "gvproxy")]
pub mod gvproxy;

#[cfg(feature = "libslirp")]
pub use libslirp::LibslirpBackend;

#[cfg(feature = "gvproxy")]
pub use gvproxy::GvisorTapBackend;

/// How the Box connects to the network backend.
///
/// This represents the connection information that needs to be passed to the engine.
/// Different backends provide different connection methods that the engine must handle.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum NetworkBackendEndpoint {
    /// Path to a Unix socket to connect to.
    /// The path can be passed across process boundaries via JSON.
    /// Used by: gvproxy, passt, libslirp, socket_vmnet
    UnixSocket {
        path: PathBuf,
        connection_type: ConnectionType,
        /// MAC address for the guest network interface
        /// This must match the DHCP static lease configured in the network backend
        mac_address: [u8; 6],
    },
}

/// Configuration for network backend initialization.
///
/// This is the only struct that callers need to know about - they don't need
/// to know which backend will be used.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkBackendConfig {
    /// Port mappings: (host_port, guest_port)
    pub port_mappings: Vec<(u16, u16)>,
    /// Unix socket path for the network backend.
    pub socket_path: PathBuf,
    /// Network allowlist. When non-empty, DNS sinkhole blocks unlisted hosts.
    #[serde(default)]
    pub allow_net: Vec<String>,
    /// Secrets for MITM proxy injection. Passed through to gvproxy.
    #[serde(default)]
    pub secrets: Vec<crate::runtime::options::Secret>,
    /// PEM-encoded MITM CA certificate (generated when secrets are configured).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_cert_pem: Option<String>,
    /// PEM-encoded MITM CA private key (PKCS8, generated when secrets are configured).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_key_pem: Option<String>,
}

impl NetworkBackendConfig {
    pub fn new(port_mappings: Vec<(u16, u16)>, socket_path: PathBuf) -> Self {
        Self {
            port_mappings,
            socket_path,
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_cert_pem: None,
            ca_key_pem: None,
        }
    }
}

/// Network metrics from a network backend.
///
/// Contains bandwidth counters and connection statistics.
#[derive(Debug, Clone, Default)]
pub struct NetworkMetrics {
    /// Total bytes sent from host to guest
    pub bytes_sent: u64,
    /// Total bytes received from guest to host
    pub bytes_received: u64,
    /// Current TCP connections in ESTABLISHED state
    pub tcp_connections: Option<u64>,
    /// Total failed connection attempts
    pub tcp_connection_errors: Option<u64>,
}

/// Network backend trait that all net implementations must implement.
///
/// This trait allows engines to work with any network backend without knowing
/// the specific implementation details.
pub trait NetworkBackend: Send + Sync + std::fmt::Debug {
    /// Get the connection information for this backend.
    ///
    /// This is called by the engine to determine how to connect the Box
    /// to the network backend.
    fn endpoint(&self) -> BoxliteResult<NetworkBackendEndpoint>;

    /// Get a human-readable name for this backend.
    fn name(&self) -> &'static str;

    /// Get network statistics from this backend.
    ///
    /// Returns current network counters including bytes transferred,
    /// TCP metrics, and connection statistics.
    ///
    /// Returns None for backends that don't support metrics.
    fn metrics(&self) -> BoxliteResult<Option<NetworkMetrics>> {
        Ok(None)
    }
}

/// The protocol type for network connections.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub enum ConnectionType {
    /// Unix stream socket (SOCK_STREAM) - used by passt, socket_vmnet, libslirp, gvproxy (Linux)
    UnixStream,

    /// Unix datagram socket (SOCK_DGRAM) - used by gvproxy (macOS)
    UnixDgram,
}

/// Factory for creating network backends.
///
/// This hides the backend selection logic from callers - they only need to
/// provide a NetworkConfig and get back an initialized backend.
pub struct NetworkBackendFactory;

impl NetworkBackendFactory {
    /// Create an appropriate network backend based on configuration.
    ///
    /// Backend selection (in priority order):
    /// 1. gvisor-tap-vsock (when gvproxy feature is enabled)
    /// 2. libslirp (when libslirp feature is enabled)
    /// 3. None (no backend features enabled)
    ///
    /// Returns None when no backend features are enabled, which means the
    /// engine will use its default net implementation.
    pub fn create(config: NetworkBackendConfig) -> BoxliteResult<Option<Box<dyn NetworkBackend>>> {
        // Priority 1: gvisor-tap-vsock
        #[cfg(feature = "gvproxy")]
        {
            tracing::info!("Using gvisor-tap-vsock backend");
            let backend = GvisorTapBackend::new(config)?;
            Ok(Some(Box::new(backend)))
        }

        // Priority 2: libslirp
        #[cfg(all(feature = "libslirp", not(feature = "gvproxy")))]
        {
            tracing::info!("Using libslirp backend");
            let backend = LibslirpBackend::new(config)?;
            Ok(Some(Box::new(backend)))
        }

        // No backend: engine will use its default net
        #[cfg(all(not(feature = "libslirp"), not(feature = "gvproxy")))]
        {
            let _ = config; // Unused when no backend features enabled
            tracing::info!("No network backend - engine will use default net");
            Ok(None)
        }
    }
}
