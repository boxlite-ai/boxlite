//! libslirp network backend.
//!
//! libslirp is a userspace TCP/IP stack (originally from QEMU) that provides
//! full network connectivity without requiring external processes or elevated
//! privileges. It's commonly used for Box networking.
//!
//! Key characteristics:
//! - Userspace TCP/IP implementation (no kernel interaction required)
//! - Supports explicit port forwarding
//! - Works via Unix socket pair or file descriptor
//! - Requires libslirp-helper binary in PATH

use super::{NetworkBackend, NetworkBackendConfig, NetworkBackendEndpoint};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::os::unix::io::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};

/// libslirp backend implementation.
///
/// This backend spawns a libslirp-helper process and communicates via Unix sockets.
#[derive(Debug)]
pub struct LibslirpBackend {
    /// Port mappings: (host_port, guest_port)
    #[allow(dead_code)]
    port_mappings: Vec<(u16, u16)>,

    /// The socket file descriptor for communication with libslirp
    #[allow(dead_code)]
    socket_fd: RawFd,

    /// The libslirp helper process
    #[allow(dead_code)]
    helper_process: Option<Child>,
}

impl LibslirpBackend {
    /// Create a new libslirp backend with the given configuration.
    ///
    /// This will:
    /// 1. Create a Unix socket pair
    /// 2. Spawn libslirp-helper process
    /// 3. Configure port forwarding
    ///
    /// # Errors
    ///
    /// Returns error if:
    /// - Socket pair creation fails
    /// - libslirp-helper binary not found in PATH
    /// - Helper process fails to start
    pub fn new(config: NetworkBackendConfig) -> BoxliteResult<Self> {
        tracing::info!(
            port_count = config.port_mappings.len(),
            "Initializing libslirp backend"
        );

        // Create a Unix socket pair for communication with libslirp
        let (host_socket, guest_socket) = UnixStream::pair().map_err(|e| {
            BoxliteError::Engine(format!("Failed to create socket pair for libslirp: {}", e))
        })?;

        let host_fd = host_socket.as_raw_fd();
        let guest_fd = guest_socket.as_raw_fd();

        tracing::debug!(
            host_fd = host_fd,
            guest_fd = guest_fd,
            "Created Unix socket pair for libslirp"
        );

        // Build port forwarding arguments for libslirp-helper
        let mut helper_args = vec![];

        // The guest socket FD will be used by libslirp-helper
        helper_args.push(format!("--fd={}", guest_fd));

        // Add port forwarding configuration
        for (host_port, guest_port) in &config.port_mappings {
            let forward_spec = format!("tcp:127.0.0.1:{}::{}:tcp", host_port, guest_port);
            helper_args.push(format!("--forward={}", forward_spec));

            tracing::info!(
                host_port = host_port,
                guest_port = guest_port,
                "Configuring libslirp port forwarding"
            );
        }

        // Spawn libslirp-helper process
        tracing::debug!(args = ?helper_args, "Spawning libslirp-helper");

        let helper_process = Command::new("libslirp-helper")
            .args(&helper_args)
            .spawn()
            .map_err(|e| {
                BoxliteError::Engine(format!(
                    "Failed to spawn libslirp-helper (is it installed and in PATH?): {}",
                    e
                ))
            })?;

        tracing::info!(pid = helper_process.id(), "libslirp-helper started");

        // Keep the guest socket alive by leaking it (the helper process needs it)
        std::mem::forget(guest_socket);

        Ok(Self {
            port_mappings: config.port_mappings,
            socket_fd: host_fd,
            helper_process: Some(helper_process),
        })
    }
}

impl NetworkBackend for LibslirpBackend {
    fn endpoint(&self) -> BoxliteResult<NetworkBackendEndpoint> {
        // TODO: libslirp uses file descriptor approach, not socket path
        // This needs to be redesigned to work with the current trait
        Err(BoxliteError::Engine(
            "libslirp backend not yet updated for new NetworkBackend trait".to_string(),
        ))
    }

    fn name(&self) -> &'static str {
        "libslirp"
    }
}

impl Drop for LibslirpBackend {
    fn drop(&mut self) {
        // Clean up: kill the helper process
        if let Some(mut process) = self.helper_process.take() {
            tracing::debug!(pid = process.id(), "Terminating libslirp-helper");
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}
