//! Network sub-resource on LiteBox.

use std::net::SocketAddr;
use std::sync::Arc;

use boxlite_shared::errors::BoxliteResult;

use crate::net::BoxTunnel;
use crate::runtime::backend::BoxNetworkBackend;

/// Public preview URL for a box port.
#[derive(Debug, Clone)]
pub struct PortPreviewUrl {
    pub box_id: String,
    pub url: String,
    pub token: String,
}

/// Signed preview URL for a box port.
#[derive(Debug, Clone)]
pub struct SignedPortPreviewUrl {
    pub box_id: String,
    pub port: u16,
    pub token: String,
    pub url: String,
}

/// Handle for network operations on a LiteBox.
///
/// Obtained via `litebox.network()`. Owns backend handles and can be used
/// independently from the originating `LiteBox` borrow.
pub struct NetworkHandle {
    network_backend: Arc<dyn BoxNetworkBackend>,
}

impl NetworkHandle {
    pub(crate) fn new(network_backend: Arc<dyn BoxNetworkBackend>) -> Self {
        Self { network_backend }
    }

    /// Open a raw byte tunnel to a guest-network target.
    pub async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        self.network_backend.tunnel(target).await
    }

    /// Get a public preview URL for a guest port.
    pub async fn preview_url(&self, port: u16) -> BoxliteResult<PortPreviewUrl> {
        self.network_backend.preview_url(port).await
    }

    /// Get a signed preview URL for a guest port.
    pub async fn signed_preview_url(
        &self,
        port: u16,
        expires_in_seconds: Option<u32>,
    ) -> BoxliteResult<SignedPortPreviewUrl> {
        self.network_backend
            .signed_preview_url(port, expires_in_seconds)
            .await
    }

    /// Expire a signed preview URL token for a guest port.
    pub async fn expire_signed_preview_url(&self, port: u16, token: &str) -> BoxliteResult<()> {
        self.network_backend
            .expire_signed_preview_url(port, token)
            .await
    }
}
