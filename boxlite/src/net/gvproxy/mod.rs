//! gvisor-tap-vsock backend with Go-Rust logging bridge
//!
//! This module provides a userspace net backend using gvisor-tap-vsock
//! from the containers/podman project, integrated via a CGO bridge.
//!
//! ## Module Structure
//!
//! - `logging` - Logging bridge between Go's slog and Rust's tracing
//! - `ffi` - Safe wrappers around raw FFI functions from libgvproxy-sys
//! - `instance` - High-level `GvproxyInstance` with RAII resource management
//! - `GvisorTapBackend` - Network backend implementation (this file)
//!
//! ## Logging Integration
//!
//! All logs from the Go side (gvisor-tap-vsock) are automatically forwarded to Rust's
//! tracing system with the target `"gvproxy"`. To see gvproxy logs:
//!
//! ```bash
//! RUST_LOG=gvproxy=debug cargo run
//! ```
//!
//! The logging bridge uses Go's standard `log/slog` package with a custom `RustTracingHandler`
//! that calls into Rust via CGO, providing unified logging across the FFI boundary.
//!
//! ## Platform-Specific Behavior
//!
//! - **macOS**: Uses VFKit protocol with UnixDgram sockets (SOCK_DGRAM)
//! - **Linux**: Uses Qemu protocol with UnixStream sockets (SOCK_STREAM)
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────┐
//! │ Rust                                                        │
//! │  ┌────────────────┐     ┌──────────────┐                   │
//! │  │ GvisorTapBackend│────▶│ GvproxyInstance│                │
//! │  └────────────────┘     └───────┬──────┘                   │
//! │                                 │                           │
//! │  ┌─────────┐        ┌──────────▼──────┐                    │
//! │  │ tracing │◀───────│ logging::callback│                   │
//! │  └─────────┘        └─────────────────┘                    │
//! │                              ▲                              │
//! ├──────────────────────────────┼──────────────────────────────┤
//! │ FFI (CGO)                    │                              │
//! ├──────────────────────────────┼──────────────────────────────┤
//! │ Go                           │                              │
//! │  ┌──────────────────┐   ┌────┴──────────────┐              │
//! │  │ gvisor-tap-vsock │   │ RustTracingHandler│              │
//! │  │  (net)    │   │   (slog.Handler)  │              │
//! │  └──────────────────┘   └───────────────────┘              │
//! └─────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## Example Usage
//!
//! ```no_run
//! use boxlite::net::{NetworkBackendConfig, GvisorTapBackend, NetworkBackend};
//! use std::path::PathBuf;
//!
//! let config = NetworkBackendConfig::new(
//!     vec![(8080, 80), (8443, 443)],
//!     PathBuf::from("/tmp/my-box/net.sock"),
//! );
//!
//! // Create backend - logs from gvproxy will appear in tracing
//! let backend = GvisorTapBackend::new(config)?;
//!
//! // Get endpoint for VM configuration
//! let endpoint = backend.endpoint()?;
//! # Ok::<(), boxlite_shared::errors::BoxliteError>(())
//! ```

mod config;
mod ffi;
mod instance;
mod logging;
mod stats;

use super::{ConnectionType, NetworkBackend, NetworkBackendConfig, NetworkBackendEndpoint};
use boxlite_shared::errors::BoxliteResult;
use std::path::PathBuf;
use std::sync::Arc;

// Re-export public API
pub use config::{DnsZone, GvproxyConfig, PortMapping};
pub use instance::GvproxyInstance;
pub use logging::init_logging;
pub use stats::{NetworkStats, TcpStats};

/// gvisor-tap-vsock backend with integrated Go→Rust logging
///
/// This backend provides userspace net via gvisor-tap-vsock, with all logs
/// from the Go side automatically forwarded to Rust's tracing system.
///
/// ## Resource Management
///
/// The backend holds an `Arc<GvproxyInstance>`, allowing it to be cloned cheaply
/// while sharing the underlying gvproxy instance. The instance is automatically
/// cleaned up when the last reference is dropped.
///
/// ## Thread Safety
///
/// `GvisorTapBackend` is `Send` and `Sync`, as the underlying `GvproxyInstance`
/// handles thread safety internally via the CGO layer.
#[derive(Debug, Clone)]
pub struct GvisorTapBackend {
    /// The gvproxy instance (Arc for cheap cloning and thread safety)
    instance: Arc<GvproxyInstance>,
    /// Socket path for cross-process communication
    socket_path: PathBuf,
}

impl GvisorTapBackend {
    /// Create a new gvisor-tap-vsock backend
    ///
    /// This initializes a gvproxy instance with the specified port mappings.
    /// On first use, the logging bridge is automatically initialized.
    ///
    /// # Arguments
    ///
    /// * `config` - Network configuration including port mappings
    ///
    /// # Returns
    ///
    /// A new `GvisorTapBackend` instance with a Unix socket for communication
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::net::{NetworkBackendConfig, GvisorTapBackend};
    /// use std::path::PathBuf;
    ///
    /// let config = NetworkBackendConfig::new(
    ///     vec![(8080, 80), (8443, 443)],
    ///     PathBuf::from("/tmp/my-box/net.sock"),
    /// );
    ///
    /// let backend = GvisorTapBackend::new(config)?;
    /// # Ok::<(), boxlite_shared::errors::BoxliteError>(())
    /// ```
    pub fn new(config: NetworkBackendConfig) -> BoxliteResult<Self> {
        tracing::debug!(
            socket_path = ?config.socket_path,
            port_mappings = ?config.port_mappings,
            "Creating gvisor-tap-vsock backend",
        );

        // Create gvproxy instance with caller-provided socket path
        let instance = Arc::new(GvproxyInstance::new(
            config.socket_path.clone(),
            &config.port_mappings,
        )?);

        // Start background stats logging thread
        instance::start_stats_logging(Arc::downgrade(&instance));

        let socket_path = config.socket_path;

        tracing::info!(
            ?socket_path,
            version = ?ffi::get_version()?,
            "Created gvisor-tap-vsock backend"
        );

        Ok(Self {
            instance,
            socket_path,
        })
    }

    /// Get network statistics from the backend
    ///
    /// Returns current network counters including bandwidth, TCP metrics,
    /// and critical debugging counters like forward_max_inflight_drop.
    ///
    /// # Returns
    ///
    /// NetworkStats struct or an error
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::net::{NetworkBackendConfig, GvisorTapBackend};
    /// use std::path::PathBuf;
    ///
    /// let config = NetworkBackendConfig::new(
    ///     vec![(8080, 80)],
    ///     PathBuf::from("/tmp/my-box/net.sock"),
    /// );
    /// let backend = GvisorTapBackend::new(config)?;
    ///
    /// // Get stats
    /// let stats = backend.get_stats()?;
    /// println!("Sent: {} bytes, TCP drops: {}",
    ///     stats.bytes_sent, stats.tcp.forward_max_inflight_drop);
    /// # Ok::<(), boxlite_shared::errors::BoxliteError>(())
    /// ```
    pub fn get_stats(&self) -> BoxliteResult<NetworkStats> {
        self.instance.get_stats()
    }
}

impl NetworkBackend for GvisorTapBackend {
    fn endpoint(&self) -> BoxliteResult<NetworkBackendEndpoint> {
        // Platform-specific connection type
        // macOS: UnixDgram with VFKit protocol (SOCK_DGRAM)
        // Linux: UnixStream with Qemu protocol (SOCK_STREAM)
        let connection_type = if cfg!(target_os = "macos") {
            ConnectionType::UnixDgram
        } else {
            ConnectionType::UnixStream
        };

        // Use GUEST_MAC constant - this must match the DHCP static lease in gvproxy config
        use crate::net::constants::GUEST_MAC;

        Ok(NetworkBackendEndpoint::UnixSocket {
            path: self.socket_path.clone(),
            connection_type,
            mac_address: GUEST_MAC,
        })
    }

    fn name(&self) -> &'static str {
        "gvisor-tap-vsock"
    }

    fn metrics(&self) -> BoxliteResult<Option<super::NetworkMetrics>> {
        let stats = self.get_stats()?;
        Ok(Some(super::NetworkMetrics {
            bytes_sent: stats.bytes_sent,
            bytes_received: stats.bytes_received,
            tcp_connections: Some(stats.tcp.current_established),
            tcp_connection_errors: Some(stats.tcp.failed_connection_attempts),
        }))
    }
}

impl Drop for GvisorTapBackend {
    fn drop(&mut self) {
        tracing::debug!(
            socket_path = ?self.socket_path,
            "Dropping gvisor-tap-vsock backend"
        );
    }
}
