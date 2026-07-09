//! Network sub-resource on LiteBox.

use std::net::SocketAddr;
use std::sync::Arc;

use boxlite_shared::errors::BoxliteResult;

use crate::net::BoxTunnel;
use crate::runtime::backend::BoxNetworkBackend;

/// Handle for network operations on a LiteBox.
///
/// Obtained via `litebox.network()`. Owns backend handles and can be used
/// independently from the originating `LiteBox` borrow.
pub struct BoxNetworkHandle {
    network_backend: Arc<dyn BoxNetworkBackend>,
}

impl BoxNetworkHandle {
    pub(crate) fn new(network_backend: Arc<dyn BoxNetworkBackend>) -> Self {
        Self { network_backend }
    }

    /// Open a raw byte tunnel to a guest-network target.
    pub async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        self.network_backend.tunnel(target).await
    }
}
