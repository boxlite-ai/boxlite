//! gvisor-tap-vsock ("gvproxy") integration.
//!
//! ## Module structure
//!
//! - `services` — [`GvproxyBackend`], the host-side [`NetworkBackend`](super::NetworkBackend):
//!   it produces the wire spec and dials gvproxy's ServicesMux for runtime control.
//!   This side has no dependency on `libgvproxy-sys`.
//! - `ffi` — safe wrappers around the raw `libgvproxy-sys` FFI, compiled only
//!   with the `gvproxy` feature.
//! - `instance` — `GvproxyInstance`, the shim-side RAII handle that creates
//!   gvproxy through the FFI and produces the VM's
//!   [`NetworkBackendEndpoint`](super::NetworkBackendEndpoint)
//! - `logging` — Go `slog` → Rust `tracing` bridge (target `"gvproxy"`)
//! - `config` / `stats` — the JSON config sent to Go and the stats read back
//!
//! ## Logging integration
//!
//! When the `gvproxy` feature is enabled, logs from the Go side are forwarded
//! to Rust's `tracing` with the target `"gvproxy"`. To see them:
//!
//! ```bash
//! RUST_LOG=gvproxy=debug cargo run
//! ```
//!
//! ## Platform-specific behavior
//!
//! - **macOS**: VFKit protocol with `UnixDgram` sockets (`SOCK_DGRAM`)
//! - **Linux**: Qemu protocol with `UnixStream` sockets (`SOCK_STREAM`)

mod config;
#[cfg(feature = "gvproxy")]
mod ffi;
#[cfg(feature = "gvproxy")]
mod instance;
#[cfg(feature = "gvproxy")]
mod logging;
mod services;
mod stats;

// Re-export public API
pub use config::{DnsRecord, DnsZone, GvproxyConfig, GvproxySecretConfig, PortMapping};
#[cfg(feature = "gvproxy")]
pub use instance::GvproxyInstance;
#[cfg(feature = "gvproxy")]
pub use logging::init_logging;
pub use services::GvproxyBackend;
pub use stats::{NetworkStats, TcpStats};

use std::path::{Path, PathBuf};

/// Filename of gvproxy's control (ServicesMux) socket — a sibling of the data
/// socket (`net.sock`) in the box's sockets dir. Kept shorter than the longest
/// name `BoxSockets` tracks (`net.sock-krun.sock`, 18 bytes) so the `sun_path`
/// budget is unaffected. See [`crate::net::socket_path`].
const CONTROL_SOCK: &str = "gvproxy-ctl.sock";

/// gvproxy's control socket path, derived as a sibling of the data socket.
///
/// Deriving it here keeps this gvproxy-only detail out of the neutral
/// socket/layout/backend-config types: both the shim (which binds it) and the
/// core client (which dials it) compute it from the one `net.sock` path they
/// already share — mirroring how libkrun derives `net.sock-krun.sock`.
pub(crate) fn control_socket_path(data_socket: &Path) -> PathBuf {
    data_socket.with_file_name(CONTROL_SOCK)
}

/// Concrete [`NetworkBackendFactory`](super::NetworkBackendFactory) for gvproxy —
/// produces a [`GvproxyBackend`] from the box's [`NetworkBackendConfig`].
pub struct GvproxyFactory;

impl super::NetworkBackendFactory for GvproxyFactory {
    fn create(
        &self,
        config: &super::NetworkBackendConfig,
    ) -> Option<Box<dyn super::NetworkBackend>> {
        Some(Box::new(GvproxyBackend::from_config(config)) as Box<dyn super::NetworkBackend>)
    }
}
