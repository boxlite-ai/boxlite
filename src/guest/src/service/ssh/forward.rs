//! TCP forwarding owned by one authenticated SSH connection.

use crate::service::ssh::limits::{
    FORWARD_CONNECT_TIMEOUT, MAX_FORWARD_CONNECTIONS, MAX_FORWARD_HOST_BYTES,
    MAX_REMOTE_FORWARD_LISTENERS,
};
use futures::FutureExt;
use russh::server::{ChannelOpenHandle, Handle as SessionHandle, Msg};
use russh::{Channel, ChannelOpenFailure};
use std::collections::HashMap;
use std::panic::{resume_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_util::task::task_tracker::TaskTrackerToken;
use tracing::{debug, warn};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ForwardKey {
    address: String,
    port: u16,
}

struct ReverseListenerEntry {
    listener_tasks: Arc<super::TaskGroup>,
}

/// Shared registration state lets a listener remove itself after an accept
/// failure without awaiting or dropping its own task handle.
#[derive(Clone, Default)]
struct ReverseListenerRegistry {
    entries: Arc<Mutex<HashMap<ForwardKey, Arc<ReverseListenerEntry>>>>,
}

impl ReverseListenerRegistry {
    fn register(
        &self,
        key: ForwardKey,
        max_listeners: usize,
        connection_tasks: &super::TaskGroup,
    ) -> Option<ReverseListenerRegistration> {
        let mut entries = self.lock();
        if entries.len() >= max_listeners || entries.contains_key(&key) {
            return None;
        }

        let entry = Arc::new(ReverseListenerEntry {
            listener_tasks: connection_tasks.child(),
        });
        // Count the listener before publishing it, even before its task starts.
        let lifetime = entry.listener_tasks.token();
        entries.insert(key.clone(), entry.clone());
        Some(ReverseListenerRegistration {
            registry: self.clone(),
            key,
            entry,
            _lifetime: lifetime,
        })
    }

    async fn cancel(&self, key: &ForwardKey) -> bool {
        let entry = self.lock().remove(key);
        let Some(entry) = entry else {
            return false;
        };

        entry.listener_tasks.cancel();
        entry.listener_tasks.wait().await;
        true
    }

    fn cancel_all(&self) {
        let entries = self
            .lock()
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        for entry in entries {
            entry.listener_tasks.cancel();
        }
    }

    fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<ForwardKey, Arc<ReverseListenerEntry>>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct ReverseListenerRegistration {
    registry: ReverseListenerRegistry,
    key: ForwardKey,
    entry: Arc<ReverseListenerEntry>,
    _lifetime: TaskTrackerToken,
}

#[cfg(test)]
impl ReverseListenerRegistration {
    async fn cancelled(&self) {
        self.entry.listener_tasks.cancelled().await;
    }
}

impl Drop for ReverseListenerRegistration {
    fn drop(&mut self) {
        self.entry.listener_tasks.cancel();
        let mut entries = self.registry.lock();
        let owns_entry = entries
            .get(&self.key)
            .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry));
        if owns_entry {
            entries.remove(&self.key);
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
    connection_tasks: Arc<super::TaskGroup>,
}

impl ForwardingManager {
    pub(crate) fn new(connection_tasks: Arc<super::TaskGroup>) -> Self {
        Self {
            connection_permits: Arc::new(Semaphore::new(MAX_FORWARD_CONNECTIONS)),
            reverse_listeners: ReverseListenerRegistry::default(),
            connection_tasks,
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
        spawn_relay(channel, stream, permit, self.connection_tasks.clone());
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
        let Some(registration) = self.reverse_listeners.register(
            key,
            MAX_REMOTE_FORWARD_LISTENERS,
            &self.connection_tasks,
        ) else {
            return false;
        };

        *requested_port = u32::from(bound_port);
        self.spawn_reverse_listener(listener, address, bound_port, session_handle, registration);
        true
    }

    fn spawn_reverse_listener(
        &self,
        listener: TcpListener,
        connected_address: String,
        connected_port: u16,
        session_handle: SessionHandle,
        registration: ReverseListenerRegistration,
    ) {
        let connection_tasks = self.connection_tasks.clone();
        let permits = self.connection_permits.clone();
        let listener_tasks = registration.entry.listener_tasks.clone();
        listener_tasks.clone().spawn(async move {
            // Capture the guard before the first poll, so abort also cancels opens.
            let _registration = registration;
            loop {
                let (stream, originator) = match listener.accept().await {
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
                let connection_tasks = connection_tasks.clone();
                listener_tasks.spawn(async move {
                    let open = async move {
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
                            Ok(Ok(channel)) => {
                                spawn_relay(channel, stream, permit, connection_tasks)
                            }
                            Ok(Err(error)) => {
                                debug!(%error, "SSH client rejected reverse TCP channel")
                            }
                            Err(_) => {
                                debug!(%originator, "SSH reverse TCP channel request timed out")
                            }
                        }
                    };
                    if let Err(panic) = AssertUnwindSafe(open).catch_unwind().await {
                        warn!(%originator, "SSH reverse TCP channel task failed: panic");
                        resume_unwind(panic);
                    }
                });
            }
        });
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
    permit: tokio::sync::OwnedSemaphorePermit,
    connection_tasks: Arc<super::TaskGroup>,
) {
    connection_tasks.spawn(async move {
        let _permit = permit;
        let mut channel = channel.into_stream();
        let result = tokio::io::copy_bidirectional(&mut channel, &mut stream).await;
        if let Err(error) = result {
            debug!(%error, "SSH TCP relay ended with an error");
        }
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut channel).await;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut stream).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn listener_cancellation_is_isolated_until_connection_cancel() {
        let connection_tasks = super::super::TaskGroup::default();
        let registry = ReverseListenerRegistry::default();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: 32001,
        };
        let first = registry
            .register(key.clone(), 2, &connection_tasks)
            .unwrap();
        let sibling = registry
            .register(
                ForwardKey {
                    address: "127.0.0.1".into(),
                    port: 32002,
                },
                2,
                &connection_tasks,
            )
            .unwrap();
        let (finish_tx, finish_rx) = oneshot::channel();
        let relay = connection_tasks.spawn_tracked(|cancel| async move {
            finish_rx.await.unwrap();
            assert!(!cancel.is_cancelled());
        });
        let cancel = registry.cancel(&key);
        tokio::pin!(cancel);
        assert!(futures::poll!(&mut cancel).is_pending());
        first.cancelled().await;
        assert!(futures::poll!(std::pin::pin!(sibling.cancelled())).is_pending());
        drop(first);
        assert!(cancel.await);
        finish_tx.send(()).unwrap();
        relay.await.unwrap();
        connection_tasks.cancel();
        sibling.cancelled().await;
        drop(sibling);
        tokio::time::timeout(std::time::Duration::from_secs(1), connection_tasks.wait())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn abandoned_cancel_waiter_cannot_remove_replacement_or_leak_child() {
        let connection_tasks = super::super::TaskGroup::default();
        let registry = ReverseListenerRegistry::default();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: 32001,
        };
        let old = registry
            .register(key.clone(), 1, &connection_tasks)
            .unwrap();
        {
            let cancel = registry.cancel(&key);
            tokio::pin!(cancel);
            assert!(futures::poll!(&mut cancel).is_pending());
            old.cancelled().await;
        }
        let replacement = registry
            .register(key.clone(), 1, &connection_tasks)
            .unwrap();
        drop(old);
        assert_eq!(registry.len(), 1);
        assert!(futures::poll!(std::pin::pin!(replacement.cancelled())).is_pending());
        registry.cancel_all();
        replacement.cancelled().await;
        let wait = connection_tasks.wait();
        tokio::pin!(wait);
        assert!(futures::poll!(&mut wait).is_pending());
        drop(replacement);
        tokio::time::timeout(std::time::Duration::from_secs(1), wait)
            .await
            .unwrap();
        assert_eq!(registry.len(), 0);
        assert!(!registry.cancel(&key).await);
    }

    #[tokio::test]
    async fn registration_release_cancels_pending_tasks_on_return_abort_and_panic() {
        for exit in ["return", "abort", "panic"] {
            let connection_tasks = super::super::TaskGroup::default();
            let registry = ReverseListenerRegistry::default();
            let key = ForwardKey {
                address: "127.0.0.1".into(),
                port: 32001,
            };
            let registration = registry.register(key, 1, &connection_tasks).unwrap();
            let listener_tasks = registration.entry.listener_tasks.clone();
            let (started_tx, started_rx) = oneshot::channel();
            let (held_tx, held_rx) = oneshot::channel::<()>();
            listener_tasks.spawn(async move {
                let _held = held_tx;
                started_tx.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            started_rx.await.unwrap();
            let listener = listener_tasks.spawn(async move {
                let _registration = registration;
                if exit == "panic" {
                    panic!("listener failed");
                }
            });
            // The current-thread runtime cannot poll the listener before abort.
            if exit == "abort" {
                listener.abort();
            }
            let result = listener.await;
            match exit {
                "abort" => assert!(result.unwrap_err().is_cancelled()),
                "panic" => assert!(result.unwrap_err().is_panic()),
                _ => result.unwrap(),
            }
            assert!(listener_tasks.is_cancelled());
            drop(listener_tasks);
            tokio::time::timeout(std::time::Duration::from_secs(1), connection_tasks.wait())
                .await
                .unwrap();
            assert!(held_rx.await.is_err());
            assert_eq!(registry.len(), 0);
        }
    }

    #[tokio::test]
    async fn rejected_registrations_and_natural_exit_leave_no_child_waiters() {
        let connection_tasks = super::super::TaskGroup::default();
        let registry = ReverseListenerRegistry::default();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: 32001,
        };
        let registration = registry
            .register(key.clone(), 2, &connection_tasks)
            .unwrap();
        assert!(registry
            .register(key.clone(), 2, &connection_tasks)
            .is_none());
        assert!(registry
            .register(
                ForwardKey {
                    address: "127.0.0.1".into(),
                    port: 32002
                },
                1,
                &connection_tasks
            )
            .is_none());
        drop(registration);
        assert_eq!(registry.len(), 0);
        tokio::time::timeout(std::time::Duration::from_secs(1), connection_tasks.wait())
            .await
            .unwrap();
    }

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
    async fn spontaneous_listener_exit_removes_only_its_registration() {
        let connection_tasks = super::super::TaskGroup::default();
        let registry = ReverseListenerRegistry::default();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: 32_002,
        };
        let registration = registry
            .register(key.clone(), 1, &connection_tasks)
            .unwrap();
        assert_eq!(registry.len(), 1);

        drop(registration);

        assert_eq!(registry.len(), 0);
        assert!(!registry.cancel(&key).await);
    }

    #[tokio::test]
    async fn an_old_listener_exit_cannot_remove_a_replacement_registration() {
        let connection_tasks = super::super::TaskGroup::default();
        let registry = ReverseListenerRegistry::default();
        let key = ForwardKey {
            address: "127.0.0.1".into(),
            port: 32_003,
        };
        let old_registration = registry
            .register(key.clone(), 1, &connection_tasks)
            .unwrap();
        registry.cancel_all();
        let replacement = registry.register(key, 1, &connection_tasks).unwrap();

        drop(old_registration);
        assert_eq!(registry.len(), 1);

        drop(replacement);
        assert_eq!(registry.len(), 0);
    }
}

#[cfg(test)]
mod shutdown_tests;
