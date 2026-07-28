//! TCP forwarding owned by one authenticated SSH connection.

use crate::service::ssh::limits::{
    FORWARD_CONNECT_TIMEOUT, MAX_FORWARD_CONNECTIONS, MAX_FORWARD_HOST_BYTES,
    MAX_REMOTE_FORWARD_LISTENERS,
};
use russh::server::{ChannelOpenHandle, Handle as SessionHandle, Msg};
use russh::{Channel, ChannelOpenFailure};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, warn};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ForwardKey {
    address: String,
    port: u16,
}

struct ReverseListenerEntry {
    identity: Arc<()>,
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<()>,
}

/// Shared registration state lets a listener remove itself after an accept
/// failure without awaiting or dropping its own task handle.
#[derive(Clone, Default)]
struct ReverseListenerRegistry {
    entries: Arc<Mutex<HashMap<ForwardKey, ReverseListenerEntry>>>,
}

impl ReverseListenerRegistry {
    fn register(
        &self,
        key: ForwardKey,
        max_listeners: usize,
    ) -> Option<ReverseListenerRegistration> {
        let mut entries = self.lock();
        if entries.len() >= max_listeners || entries.contains_key(&key) {
            return None;
        }

        let identity = Arc::new(());
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        entries.insert(
            key.clone(),
            ReverseListenerEntry {
                identity: identity.clone(),
                cancel: cancel_tx,
                stopped: stopped_rx,
            },
        );
        Some(ReverseListenerRegistration {
            registry: self.clone(),
            key,
            identity,
            cancel: cancel_rx,
            stopped: Some(stopped_tx),
        })
    }

    async fn cancel(&self, key: &ForwardKey) -> bool {
        let entry = self.lock().remove(key);
        let Some(entry) = entry else {
            return false;
        };

        let _ = entry.cancel.send(());
        // Closing this receiver also counts as completion: it means the
        // registration guard was dropped while its listener task unwound.
        let _ = entry.stopped.await;
        true
    }

    fn cancel_all(&self) {
        let entries = self
            .lock()
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        for entry in entries {
            let _ = entry.cancel.send(());
        }
    }

    fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<ForwardKey, ReverseListenerEntry>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct ReverseListenerRegistration {
    registry: ReverseListenerRegistry,
    key: ForwardKey,
    identity: Arc<()>,
    cancel: oneshot::Receiver<()>,
    stopped: Option<oneshot::Sender<()>>,
}

impl ReverseListenerRegistration {
    async fn cancelled(&mut self) {
        let _ = (&mut self.cancel).await;
    }
}

impl Drop for ReverseListenerRegistration {
    fn drop(&mut self) {
        let mut entries = self.registry.lock();
        let owns_entry = entries
            .get(&self.key)
            .is_some_and(|entry| Arc::ptr_eq(&entry.identity, &self.identity));
        if owns_entry {
            entries.remove(&self.key);
        }
        drop(entries);

        if let Some(stopped) = self.stopped.take() {
            let _ = stopped.send(());
        }
    }
}

/// Owns the socket relays and reverse listeners created by one SSH client.
///
/// TCP sockets can be opened by the guest because BoxLite containers share the
/// guest network namespace. Filesystem-backed forwarding lives elsewhere: a
/// guest path is not a container path once the mount namespace is created.
pub(crate) struct ForwardingManager {
    connection_permits: Arc<Semaphore>,
    reverse_listeners: ReverseListenerRegistry,
}

impl ForwardingManager {
    pub(crate) fn new() -> Self {
        Self {
            connection_permits: Arc::new(Semaphore::new(MAX_FORWARD_CONNECTIONS)),
            reverse_listeners: ReverseListenerRegistry::default(),
        }
    }

    /// Connect a client-opened `direct-tcpip` channel to its requested target.
    pub(crate) async fn open_direct_tcpip(
        &self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        reply: ChannelOpenHandle,
    ) {
        let Some(port) = valid_target(host, port) else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return;
        };

        let Ok(permit) = self.connection_permits.clone().try_acquire_owned() else {
            reply.reject(ChannelOpenFailure::ResourceShortage).await;
            return;
        };

        let stream =
            match tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, TcpStream::connect((host, port)))
                .await
            {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    debug!(host, port, %error, "SSH direct TCP connect failed");
                    reply.reject(ChannelOpenFailure::ConnectFailed).await;
                    return;
                }
                Err(_) => {
                    debug!(host, port, "SSH direct TCP connect timed out");
                    reply.reject(ChannelOpenFailure::ConnectFailed).await;
                    return;
                }
            };

        reply.accept().await;
        spawn_relay(channel, stream, permit);
    }

    /// Bind a loopback-only reverse forwarding listener.
    pub(crate) async fn listen_tcpip(
        &mut self,
        requested_address: &str,
        requested_port: &mut u32,
        session_handle: SessionHandle,
    ) -> bool {
        if self.reverse_listeners.len() >= MAX_REMOTE_FORWARD_LISTENERS {
            return false;
        }
        let Some(address) = loopback_bind_address(requested_address) else {
            return false;
        };
        let Ok(port) = u16::try_from(*requested_port) else {
            return false;
        };

        let listener = match TcpListener::bind((address.as_str(), port)).await {
            Ok(listener) => listener,
            Err(error) => {
                debug!(%address, port, %error, "SSH reverse TCP bind failed");
                return false;
            }
        };
        let Ok(bound_addr) = listener.local_addr() else {
            return false;
        };
        let bound_port = bound_addr.port();
        let key = ForwardKey {
            address: address.clone(),
            port: bound_port,
        };
        let Some(registration) = self
            .reverse_listeners
            .register(key, MAX_REMOTE_FORWARD_LISTENERS)
        else {
            return false;
        };

        *requested_port = u32::from(bound_port);
        spawn_reverse_listener(
            listener,
            address,
            bound_port,
            session_handle,
            self.connection_permits.clone(),
            registration,
        );
        true
    }

    pub(crate) async fn cancel_tcpip(&mut self, requested_address: &str, port: u32) -> bool {
        let Some(address) = loopback_bind_address(requested_address) else {
            return false;
        };
        let Ok(port) = u16::try_from(port) else {
            return false;
        };
        let key = ForwardKey { address, port };
        self.reverse_listeners.cancel(&key).await
    }
}

impl Drop for ForwardingManager {
    fn drop(&mut self) {
        self.reverse_listeners.cancel_all();
    }
}

fn valid_target(host: &str, port: u32) -> Option<u16> {
    if host.is_empty()
        || host.len() > MAX_FORWARD_HOST_BYTES
        || host.bytes().any(|byte| byte.is_ascii_control())
    {
        return None;
    }
    let port = u16::try_from(port).ok()?;
    (port != 0).then_some(port)
}

/// `GatewayPorts no`: remote forwards may listen only on guest loopback.
fn loopback_bind_address(requested: &str) -> Option<String> {
    match requested {
        "" | "localhost" | "127.0.0.1" => Some("127.0.0.1".to_string()),
        "::1" => Some("::1".to_string()),
        _ => None,
    }
}

fn spawn_relay(
    channel: Channel<Msg>,
    mut stream: TcpStream,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    tokio::spawn(async move {
        let mut channel = channel.into_stream();
        if let Err(error) = tokio::io::copy_bidirectional(&mut channel, &mut stream).await {
            debug!(%error, "SSH TCP relay ended with an error");
        }
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut channel).await;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut stream).await;
    });
}

fn spawn_reverse_listener(
    listener: TcpListener,
    connected_address: String,
    connected_port: u16,
    session_handle: SessionHandle,
    permits: Arc<Semaphore>,
    mut registration: ReverseListenerRegistration,
) {
    tokio::spawn(async move {
        let mut pending_opens = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = registration.cancelled() => break,
                completed = pending_opens.join_next(), if !pending_opens.is_empty() => {
                    if let Some(Err(error)) = completed {
                        warn!(%error, "SSH reverse TCP channel task failed");
                    }
                }
                accepted = listener.accept() => {
                    let (stream, originator) = match accepted {
                        Ok(accepted) => accepted,
                        Err(error) => {
                            warn!(%error, "SSH reverse TCP listener failed");
                            break;
                        }
                    };
                    let Ok(permit) = permits.clone().try_acquire_owned() else {
                        debug!(%originator, "SSH forwarding connection limit reached");
                        continue;
                    };

                    let handle = session_handle.clone();
                    let address = connected_address.clone();
                    pending_opens.spawn(async move {
                        let channel = tokio::time::timeout(
                            FORWARD_CONNECT_TIMEOUT,
                            handle.channel_open_forwarded_tcpip(
                                address,
                                u32::from(connected_port),
                                originator.ip().to_string(),
                                u32::from(originator.port()),
                            ),
                        )
                        .await;
                        match channel {
                            Ok(Ok(channel)) => spawn_relay(channel, stream, permit),
                            Ok(Err(error)) => {
                                debug!(%error, "SSH client rejected reverse TCP channel")
                            }
                            Err(_) => {
                                debug!(%originator, "SSH reverse TCP channel request timed out")
                            }
                        }
                    });
                }
            }
        }

        finish_reverse_listener(listener, pending_opens, registration).await;
    });
}

async fn finish_reverse_listener(
    listener: TcpListener,
    mut pending_opens: JoinSet<()>,
    registration: ReverseListenerRegistration,
) {
    // Stop accepting first, then wait for every already-accepted channel open
    // to resolve. Cancellation cannot report success while one of those tasks
    // could still open a forwarded channel afterward.
    drop(listener);
    while let Some(completed) = pending_opens.join_next().await {
        if let Err(error) = completed {
            warn!(%error, "SSH reverse TCP channel task failed");
        }
    }
    drop(registration);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_targets_are_bounded_and_require_a_real_port() {
        assert_eq!(valid_target("localhost", 22), Some(22));
        assert_eq!(valid_target("::1", 65_535), Some(65_535));
        assert_eq!(valid_target("localhost", 0), None);
        assert_eq!(valid_target("localhost", 65_536), None);
        assert_eq!(valid_target("bad\nhost", 22), None);
        assert_eq!(
            valid_target(&"a".repeat(MAX_FORWARD_HOST_BYTES + 1), 22),
            None
        );
    }

    #[test]
    fn reverse_forwarding_enforces_gateway_ports_no() {
        assert_eq!(loopback_bind_address(""), Some("127.0.0.1".into()));
        assert_eq!(loopback_bind_address("localhost"), Some("127.0.0.1".into()));
        assert_eq!(loopback_bind_address("::1"), Some("::1".into()));
        assert_eq!(loopback_bind_address("0.0.0.0"), None);
        assert_eq!(loopback_bind_address("192.0.2.10"), None);
    }

    #[tokio::test]
    async fn cancel_waits_for_the_listener_socket_and_pending_opens() {
        let registry = ReverseListenerRegistry::default();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let bound_address = listener.local_addr().unwrap();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: bound_address.port(),
        };
        let registration = registry.register(key.clone(), 1).unwrap();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let mut pending_opens = JoinSet::new();
        pending_opens.spawn(async move {
            let _ = finish_rx.await;
        });

        let registry_for_cancel = registry.clone();
        let cancel_task = tokio::spawn(async move { registry_for_cancel.cancel(&key).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while registry.len() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel must claim the registration");

        let listener_task = tokio::spawn(finish_reverse_listener(
            listener,
            pending_opens,
            registration,
        ));
        let replacement_listener = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Ok(listener) = TcpListener::bind(bound_address).await {
                    break listener;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel must close the listening socket");
        assert!(!cancel_task.is_finished());

        finish_tx.send(()).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), cancel_task)
                .await
                .expect("cancel must finish at the listener boundary")
                .unwrap()
        );
        listener_task.await.unwrap();
        assert_eq!(registry.len(), 0);
        drop(replacement_listener);
        assert!(TcpStream::connect(bound_address).await.is_err());
    }

    #[tokio::test]
    async fn spontaneous_listener_exit_removes_only_its_registration() {
        let registry = ReverseListenerRegistry::default();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: 32_002,
        };
        let registration = registry.register(key.clone(), 1).unwrap();
        assert_eq!(registry.len(), 1);

        drop(registration);

        assert_eq!(registry.len(), 0);
        assert!(!registry.cancel(&key).await);
    }

    #[test]
    fn an_old_listener_exit_cannot_remove_a_replacement_registration() {
        let registry = ReverseListenerRegistry::default();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: 32_003,
        };
        let old_registration = registry.register(key.clone(), 1).unwrap();
        registry.cancel_all();
        let replacement = registry.register(key, 1).unwrap();

        drop(old_registration);
        assert_eq!(registry.len(), 1);

        drop(replacement);
        assert_eq!(registry.len(), 0);
    }
}
