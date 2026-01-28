//! High-level guest session.
//!
//! Thin facade over service interfaces.

use crate::portal::connection::Connection;
use crate::portal::interfaces::FilesInterface;
use crate::portal::interfaces::{ContainerInterface, ExecutionInterface, GuestInterface};
use boxlite_shared::{BoxliteResult, Transport};

/// High-level guest session.
///
/// Provides access to service interfaces.
#[derive(Clone)]
pub struct GuestSession {
    connection: Connection,
}

impl GuestSession {
    /// Create a session (connects lazily on first use).
    pub fn new(transport: Transport) -> Self {
        Self {
            connection: Connection::new(transport),
        }
    }

    /// Get execution interface.
    pub async fn execution(&self) -> BoxliteResult<ExecutionInterface> {
        let channel = self.connection.channel().await?;
        Ok(ExecutionInterface::new(channel))
    }

    /// Get container interface.
    pub async fn container(&self) -> BoxliteResult<ContainerInterface> {
        let channel = self.connection.channel().await?;
        Ok(ContainerInterface::new(channel))
    }

    /// Get guest interface.
    pub async fn guest(&self) -> BoxliteResult<GuestInterface> {
        let channel = self.connection.channel().await?;
        Ok(GuestInterface::new(channel))
    }

    /// Get files interface.
    pub async fn files(&self) -> BoxliteResult<FilesInterface> {
        let channel = self.connection.channel().await?;
        Ok(FilesInterface::new(channel))
    }
}

// ============================================================================
// THREAD SAFETY ASSERTIONS
// ============================================================================

// Compile-time assertions to ensure GuestSession is Send + Sync
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    let _ = assert_send_sync::<GuestSession>;
};
