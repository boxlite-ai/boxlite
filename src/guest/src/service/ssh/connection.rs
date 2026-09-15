//! Owns one SSH transport and waits for all connection work to finish.

use super::{limits, server, ConnectionContext};
use std::future::Future;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{debug, warn};

#[derive(Clone)]
pub(super) struct ConnectionTasks {
    tracker: TaskTracker,
    shutdown: CancellationToken,
}

impl ConnectionTasks {
    pub(super) fn new(generation: &CancellationToken) -> Self {
        Self {
            tracker: TaskTracker::new(),
            shutdown: generation.child_token(),
        }
    }

    // Cleanup futures must run to completion. Work loops observe cancellation
    // themselves; wrapping every future in select! would discard cleanup too.
    pub(super) fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.tracker.spawn(future)
    }

    pub(super) fn stop(&self) {
        self.shutdown.cancel();
    }

    /// Call only after the russh handler has exited. Tracked parents may still
    /// spawn cleanup, but must register children before they themselves exit.
    pub(super) async fn finish(&self) {
        self.tracker.close();
        self.tracker.wait().await;
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.shutdown.is_cancelled()
    }

    pub(super) async fn cancelled(&self) {
        self.shutdown.cancelled().await;
    }
}

#[cfg(test)]
impl ConnectionTasks {
    pub(in crate::service::ssh) fn for_test() -> (Self, CancellationToken) {
        let generation = CancellationToken::new();
        (Self::new(&generation), generation)
    }
}

pub(super) struct Connection;

impl Connection {
    pub(super) async fn run<S>(
        socket: S,
        peer_addr: String,
        config: Arc<russh::server::Config>,
        context: ConnectionContext,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + AsFd + Unpin + Send + 'static,
    {
        let _permit = permit;
        let tasks = ConnectionTasks::new(&context.shutdown);
        let (socket, shutdown_socket) = match socket_with_shutdown_handle(socket) {
            Ok((socket, shutdown_socket)) => (socket, ShutdownSocket(shutdown_socket)),
            Err(error) => {
                warn!(%peer_addr, %error, "failed to prepare SSH connection socket");
                return;
            }
        };
        let (authenticated_tx, authenticated_rx) = oneshot::channel();
        let handler = server::SshConnection::new(
            context.guest,
            context.authorizer,
            tasks.clone(),
            authenticated_tx,
        );
        let handshake = tokio::time::timeout(
            limits::AUTHENTICATION_TIMEOUT,
            russh::server::run_stream(config, socket, handler),
        );
        let handshake_result = tokio::select! {
            biased;
            _ = tasks.cancelled() => None,
            result = handshake => Some(result),
        };
        match handshake_result {
            Some(Ok(Ok(running))) => {
                monitor_session(
                    running,
                    authenticated_rx,
                    &tasks,
                    &shutdown_socket,
                    peer_addr,
                )
                .await
            }
            Some(Ok(Err(error))) => debug!(%peer_addr, %error, "SSH handshake failed"),
            Some(Err(_)) => warn!(%peer_addr, "SSH identification exchange timed out"),
            None => {}
        }
        tasks.stop();
        shutdown_socket.close();
        tasks.finish().await;
    }
}

async fn monitor_session(
    mut running: russh::server::RunningSession<server::SshConnection>,
    mut authenticated: oneshot::Receiver<()>,
    tasks: &ConnectionTasks,
    shutdown_socket: &ShutdownSocket,
    peer_addr: String,
) {
    let timeout = tokio::time::sleep(limits::AUTHENTICATION_TIMEOUT);
    tokio::pin!(timeout);
    let mut is_authenticated = false;
    let reason = loop {
        tokio::select! {
            biased;
            _ = tasks.cancelled() => break "SSH service restarted or disabled",
            result = &mut running => {
                if let Err(error) = result {
                    debug!(%peer_addr, %error, "SSH session ended");
                }
                return;
            }
            result = &mut authenticated, if !is_authenticated => {
                if result.is_err() {
                    break "authentication cancelled";
                }
                is_authenticated = true;
            }
            _ = &mut timeout, if !is_authenticated => break "authentication timeout",
        }
    };
    tasks.stop();
    disconnect_transport(&running.handle(), &shutdown_socket.0, reason).await;
    if let Err(error) = running.await {
        debug!(%peer_addr, %error, "SSH session ended during disconnect");
    }
}

async fn disconnect_transport(
    handle: &russh::server::Handle,
    shutdown_socket: &OwnedFd,
    reason: &'static str,
) {
    let disconnect = handle.disconnect(
        russh::Disconnect::ByApplication,
        reason.into(),
        String::new(),
    );
    let _ = tokio::time::timeout(limits::DISCONNECT_GRACE_TIMEOUT, disconnect).await;
    if let Err(error) = shutdown_fd(shutdown_socket) {
        debug!(%error, reason, "failed to shut down SSH transport");
    }
}

pub(super) struct ShutdownSocket(pub(super) OwnedFd);

impl ShutdownSocket {
    fn close(&self) {
        if let Err(error) = shutdown_fd(&self.0) {
            debug!(%error, "failed to shut down SSH transport during cleanup");
        }
    }
}

impl Drop for ShutdownSocket {
    fn drop(&mut self) {
        self.close();
    }
}

pub(super) fn socket_with_shutdown_handle<S: AsFd>(socket: S) -> std::io::Result<(S, OwnedFd)> {
    let shutdown_socket = socket.as_fd().try_clone_to_owned()?;
    Ok((socket, shutdown_socket))
}

pub(super) fn shutdown_fd(socket: &OwnedFd) -> std::io::Result<()> {
    nix::sys::socket::shutdown(socket.as_raw_fd(), nix::sys::socket::Shutdown::Both)
        .map_err(std::io::Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::GuestLayout;
    use crate::service::server::GuestServer;
    use crate::service::ssh::auth::SshAuthorizer;
    use std::time::Duration;

    #[tokio::test]
    async fn connection_stop_is_isolated_but_generation_stop_reaches_every_connection() {
        let generation = CancellationToken::new();
        let first = ConnectionTasks::new(&generation);
        let second = ConnectionTasks::new(&generation);
        first.stop();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!generation.is_cancelled());
        generation.cancel();
        assert!(second.is_cancelled());
    }

    #[tokio::test]
    async fn finish_waits_for_cleanup_spawned_by_a_tracked_parent() {
        let (tasks, _) = ConnectionTasks::for_test();
        let (spawn_tx, spawn_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let child_tasks = tasks.clone();
        let parent = tasks.spawn(async move {
            spawn_rx.await.unwrap();
            child_tasks.spawn(async move {
                finish_rx.await.unwrap();
            });
        });
        tasks.stop();
        let mut finished = Box::pin(tasks.finish());
        assert!(futures::poll!(&mut finished).is_pending());
        spawn_tx.send(()).unwrap();
        parent.await.unwrap();
        assert!(futures::poll!(&mut finished).is_pending());
        finish_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), finished)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn supervisor_closes_identification_and_authentication_transports() {
        for send_identification in [false, true] {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let generation = CancellationToken::new();
            let permits = Arc::new(tokio::sync::Semaphore::new(1));
            let context = ConnectionContext {
                guest: Arc::new(GuestServer::new(GuestLayout::new())),
                authorizer: Arc::new(SshAuthorizer::NoAuth),
                permits: permits.clone(),
                shutdown: generation.clone(),
            };
            let host_key = {
                let mut rng = russh::keys::key::safe_rng();
                russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap()
            };
            let config = Arc::new(server::build_config(host_key, russh::MethodKind::None));
            let (socket, mut peer) = tokio::net::UnixStream::pair().unwrap();
            let supervisor = tokio::spawn(Connection::run(
                socket,
                "test peer".into(),
                config,
                context,
                permits.clone().try_acquire_owned().unwrap(),
            ));
            if send_identification {
                peer.write_all(b"SSH-2.0-lifecycle-test\r\n").await.unwrap();
            }
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(1), peer.read_exact(&mut byte))
                .await
                .unwrap()
                .unwrap();
            if send_identification {
                // A binary KEX packet comes from russh's spawned session;
                // the server identification alone does not prove it started.
                tokio::time::timeout(Duration::from_secs(1), async {
                    while byte[0] != b'\n' {
                        peer.read_exact(&mut byte).await.unwrap();
                    }
                    peer.read_exact(&mut byte).await.unwrap();
                })
                .await
                .unwrap();
            }
            assert_eq!(permits.available_permits(), 0);
            generation.cancel();
            tokio::time::timeout(Duration::from_secs(2), supervisor)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(permits.available_permits(), 1);
            let mut remaining = Vec::new();
            tokio::time::timeout(Duration::from_secs(1), peer.read_to_end(&mut remaining))
                .await
                .unwrap()
                .unwrap();
        }
    }
}
