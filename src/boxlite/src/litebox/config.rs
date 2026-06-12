use crate::BoxID;
use crate::net::socket_path::BoxSockets;
use crate::runtime::types::ContainerID;
use boxlite_shared::Transport;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Container runtime configuration.
///
/// Holds the container's identity.
/// Owned by BoxConfig since each box runs exactly one container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerRuntimeConfig {
    /// Container ID (64-char hex, generated at box creation).
    pub id: ContainerID,
}

/// Static box configuration (set once at creation, never changes).
///
/// This is persisted to database and remains immutable throughout the box lifecycle.
/// Separates static configuration from dynamic state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoxConfig {
    // === Identity & Timestamps ===
    /// Unique box identifier.
    pub id: BoxID,
    /// User-defined name (optional, must be unique if provided).
    pub name: Option<String>,
    /// Creation timestamp (UTC).
    pub created_at: DateTime<Utc>,

    // === Container Configuration ===
    /// Container configuration (id).
    pub container: ContainerRuntimeConfig,

    // === User Options (preserved for restart) ===
    /// User-provided options at creation time.
    /// These are preserved to allow proper restart with the same configuration.
    pub options: crate::runtime::options::BoxOptions,

    // === Runtime-Generated Configuration ===
    /// VMM engine type.
    pub engine_kind: crate::vmm::VmmKind,
    /// Box home directory.
    pub box_home: PathBuf,
}

impl BoxConfig {
    /// Socket-path authority for this box, derived from identity
    /// (`box_home` + `id`) — never persisted. Legacy DB rows may still
    /// carry old `transport` / `ready_socket_path` fields; they are
    /// ignored on deserialize and must never be read: socket paths are
    /// derived at point of use so they can never go stale.
    pub fn sockets(&self) -> BoxSockets {
        BoxSockets::new(
            self.id.as_str(),
            self.box_home
                .join(crate::runtime::layout::dirs::SOCKETS_DIR),
        )
    }

    /// Transport for guest gRPC communication (Unix socket via the
    /// short binding path).
    pub fn transport(&self) -> Transport {
        Transport::unix(self.sockets().box_sock())
    }

    /// Transport for the guest-ready notification socket.
    pub fn ready_transport(&self) -> Transport {
        Transport::unix(self.sockets().ready_sock())
    }
}
