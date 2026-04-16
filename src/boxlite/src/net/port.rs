//! TCP port allocation for Windows transport.
//!
//! On Unix, each box gets deterministic socket paths (`box.sock`, `ready.sock`,
//! `net.sock`). On Windows, Unix sockets are unavailable — libkrun WHPX bridges
//! vsock to TCP. This module allocates ephemeral TCP ports for each box.
//!
//! # Approach
//!
//! Bind `TcpListener` to `127.0.0.1:0`, read the OS-assigned port, then drop
//! the listener. Stateless — no global registry needed. The small TOCTOU window
//! is acceptable because the ephemeral port pool is large (~16k ports).

#![cfg(not(unix))]

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

/// TCP ports assigned to a single box.
///
/// Replaces the three Unix socket paths (`socket_path`, `ready_socket_path`,
/// `net_backend_socket_path`) on platforms without Unix domain sockets.
#[derive(Debug, Clone, Copy)]
pub struct BoxPorts {
    /// gRPC transport port (host ↔ guest communication).
    pub grpc_port: u16,
    /// Ready-signal port (guest notifies host of readiness).
    pub ready_port: u16,
    /// Network backend port (network traffic).
    pub net_port: u16,
}

/// Allocate a single ephemeral TCP port on localhost.
///
/// Binds to `127.0.0.1:0` to let the OS assign a port, then drops the listener.
/// The port is briefly unoccupied between drop and the caller's bind — acceptable
/// given the ~16k ephemeral port pool.
pub fn allocate_port() -> BoxliteResult<u16> {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0);
    let listener = TcpListener::bind(addr)
        .map_err(|e| BoxliteError::Network(format!("Failed to bind ephemeral TCP port: {}", e)))?;
    let port = listener
        .local_addr()
        .map_err(|e| {
            BoxliteError::Network(format!(
                "Failed to get local address of bound socket: {}",
                e
            ))
        })?
        .port();
    Ok(port)
}

/// Allocate three unique TCP ports for a box's transport needs.
pub fn allocate_box_ports() -> BoxliteResult<BoxPorts> {
    let grpc_port = allocate_port()?;
    let ready_port = allocate_port()?;
    let net_port = allocate_port()?;
    Ok(BoxPorts {
        grpc_port,
        ready_port,
        net_port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allocate_port_returns_nonzero() {
        let port = allocate_port().unwrap();
        assert_ne!(port, 0, "Allocated port must be nonzero");
    }

    #[test]
    fn test_allocate_port_unique_across_calls() {
        // Allocate several ports and verify they differ (OS should assign distinct ports)
        let ports: Vec<u16> = (0..5).map(|_| allocate_port().unwrap()).collect();
        let unique: std::collections::HashSet<u16> = ports.iter().copied().collect();
        // At minimum, most should be unique (OS ephemeral port allocation)
        assert!(
            unique.len() >= 3,
            "Expected mostly unique ports, got {:?}",
            ports
        );
    }

    #[test]
    fn test_allocate_box_ports_all_different() {
        let ports = allocate_box_ports().unwrap();
        let set: std::collections::HashSet<u16> =
            [ports.grpc_port, ports.ready_port, ports.net_port]
                .iter()
                .copied()
                .collect();
        assert_eq!(
            set.len(),
            3,
            "All three box ports must be different: grpc={}, ready={}, net={}",
            ports.grpc_port,
            ports.ready_port,
            ports.net_port
        );
    }

    #[test]
    fn test_allocated_port_is_usable() {
        let port = allocate_port().unwrap();
        // Verify we can bind to the allocated port (it's free after drop)
        let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        let result = TcpListener::bind(addr);
        assert!(
            result.is_ok(),
            "Should be able to bind to allocated port {}",
            port
        );
    }
}
