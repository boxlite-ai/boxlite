//! High-level guest session.
//!
//! Thin facade over service interfaces.

use crate::portal::connection::Connection;
use crate::portal::interfaces::FilesInterface;
use crate::portal::interfaces::SshInterface;
use crate::portal::interfaces::{ContainerInterface, ExecutionInterface, GuestInterface};
use boxlite_shared::{BoxTransport, BoxliteResult};

/// High-level guest session.
///
/// Provides access to service interfaces.
#[derive(Clone)]
pub struct GuestSession {
    connection: Connection,
}

impl GuestSession {
    /// Create a session (connects lazily on first use).
    pub fn new(transport: BoxTransport) -> Self {
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

    /// Get SSH interface.
    pub(crate) async fn ssh(&self) -> BoxliteResult<SshInterface> {
        let channel = self.connection.channel().await?;
        Ok(SshInterface::new(channel))
    }

    /// Clear any cached transport channel so the next RPC reconnects.
    pub async fn reset(&self) {
        self.connection.reset().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite_shared::{Ssh, SshControlRequest, SshControlResponse, SshServer};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::UnixListener;
    use tonic::{Request, Response, Status};

    struct Control;

    #[tonic::async_trait]
    impl Ssh for Control {
        async fn control(
            &self,
            _: Request<SshControlRequest>,
        ) -> Result<Response<SshControlResponse>, Status> {
            Ok(Response::new(SshControlResponse::default()))
        }
    }

    #[tokio::test]
    async fn guest_session_reset_forces_new_connection() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("box.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let accepts = Arc::new(AtomicUsize::new(0));
        let accepts_server = Arc::clone(&accepts);
        let (stop, stopped) = tokio::sync::oneshot::channel();

        let incoming = futures::stream::unfold(listener, move |listener| {
            let accepts_server = Arc::clone(&accepts_server);
            async move {
                let res = listener.accept().await.map(|(stream, _)| {
                    accepts_server.fetch_add(1, Ordering::SeqCst);
                    stream
                });
                Some((res, listener))
            }
        });

        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(SshServer::new(Control))
                .serve_with_incoming_shutdown(incoming, async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });

        let session = GuestSession::new(BoxTransport::unix(sock));
        session
            .ssh()
            .await
            .unwrap()
            .control(SshControlRequest::default())
            .await
            .unwrap();
        assert_eq!(accepts.load(Ordering::SeqCst), 1);

        session.reset().await;
        session
            .ssh()
            .await
            .unwrap()
            .control(SshControlRequest::default())
            .await
            .unwrap();
        assert_eq!(accepts.load(Ordering::SeqCst), 2);

        let _ = stop.send(());
        server.await.unwrap();
    }
}
