use super::connection::{shutdown_fd, socket_with_shutdown_handle, ShutdownSocket};
use super::*;
use crate::layout::GuestLayout;
use russh::keys::ssh_key::certificate::{Builder, CertType};
use russh::keys::{Algorithm, Certificate, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

pub(super) struct RelayChannelHandler {
    channel: Option<oneshot::Sender<russh::Channel<russh::server::Msg>>>,
}

impl russh::server::Handler for RelayChannelHandler {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.channel.take().unwrap().send(channel).unwrap();
        reply.accept().await;
        Ok(())
    }
}

pub(super) async fn relay_channel() -> (
    russh::Channel<russh::server::Msg>,
    russh::client::Handle<TrustTestHostKey>,
    russh::Channel<russh::client::Msg>,
    russh::server::RunningSession<RelayChannelHandler>,
) {
    let (server_stream, client_stream) = tokio::io::duplex(64 * 1024);
    let (channel_tx, channel_rx) = oneshot::channel();
    let server = tokio::spawn(russh::server::run_stream(
        Arc::new(server::build_config(private_key(), russh::MethodKind::None)),
        server_stream,
        RelayChannelHandler {
            channel: Some(channel_tx),
        },
    ));
    let mut client = russh::client::connect_stream(
        Arc::new(russh::client::Config::default()),
        client_stream,
        TrustTestHostKey,
    )
    .await
    .unwrap();
    assert!(client.authenticate_none("root").await.unwrap().success());
    let client_channel = client.channel_open_session().await.unwrap();
    (
        channel_rx.await.unwrap(),
        client,
        client_channel,
        server.await.unwrap().unwrap(),
    )
}

fn private_key() -> PrivateKey {
    let mut rng = russh::keys::key::safe_rng();
    PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap()
}

fn ca_public_key() -> String {
    private_key().public_key().to_openssh().unwrap()
}

fn certificate_config(ca: impl AsRef<str>, principal: &str) -> BoxliteResult<SshConfig> {
    static HOST_KEY: OnceLock<String> = OnceLock::new();
    SshConfig::from_request(boxlite_shared::SshConfigureRequest {
        host_private_key: HOST_KEY
            .get_or_init(|| {
                private_key()
                    .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                    .unwrap()
                    .to_string()
            })
            .clone(),
        principal: principal.into(),
        auth: Some(boxlite_shared::ssh_configure_request::Auth::Keys(
            boxlite_shared::SshKeyAuth {
                ca_public_keys: vec![ca.as_ref().into()],
                public_keys: vec![],
            },
        )),
    })
}

fn key_config(
    host_key: &PrivateKey,
    auth: boxlite_shared::ssh_configure_request::Auth,
) -> SshConfig {
    SshConfig::from_request(boxlite_shared::SshConfigureRequest {
        host_private_key: host_key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .to_string(),
        principal: "box_123".into(),
        auth: Some(auth),
    })
    .unwrap()
}

fn keys_auth(
    cas: &[PrivateKey],
    users: &[PrivateKey],
) -> boxlite_shared::ssh_configure_request::Auth {
    boxlite_shared::ssh_configure_request::Auth::Keys(boxlite_shared::SshKeyAuth {
        ca_public_keys: cas
            .iter()
            .map(|key| key.public_key().to_openssh().unwrap())
            .collect(),
        public_keys: users
            .iter()
            .map(|key| key.public_key().to_openssh().unwrap())
            .collect(),
    })
}

#[tokio::test]
async fn wire_publickey_and_multiple_cas_are_alternatives_and_require_proof() {
    let ca_a = private_key();
    let ca_b = private_key();
    let raw = private_key();
    let config = key_config(
        &private_key(),
        keys_auth(&[ca_a.clone(), ca_b.clone()], std::slice::from_ref(&raw)),
    );

    for ca in [&ca_a, &ca_b] {
        let (subject, certificate) = user_certificate(ca, "box_123");
        let mut client = TestSession::connect(&config).await;
        assert!(!client
            .client
            .authenticate_none("root")
            .await
            .unwrap()
            .success());
        assert!(client
            .client
            .authenticate_openssh_cert("root", subject, certificate)
            .await
            .unwrap()
            .success());
        client.finish().await;
    }
    let mut client = TestSession::connect(&config).await;
    assert!(!client
        .client
        .authenticate_publickey(
            "root",
            PrivateKeyWithHashAlg::new(Arc::new(private_key()), None)
        )
        .await
        .unwrap()
        .success());
    let mut impostor = private_key().key_data().ed25519().unwrap().clone();
    impostor.public = raw.key_data().ed25519().unwrap().public;
    let impostor = PrivateKey::new(impostor.into(), "").unwrap();
    let wrong_signature = client
        .client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(Arc::new(impostor), None))
        .await;
    assert!(
        wrong_signature.is_err() || !wrong_signature.unwrap().success(),
        "a listed public key signed by the wrong private key must fail"
    );
    client.finish().await;
    let mut client = TestSession::connect(&config).await;
    assert!(client
        .client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(Arc::new(raw), None))
        .await
        .unwrap()
        .success());
    client
        .client
        .channel_open_session()
        .await
        .unwrap()
        .close()
        .await
        .unwrap();

    client.finish().await;
    for (signer, principal) in [(&ca_a, "wrong_box"), (&private_key(), "box_123")] {
        let (subject, certificate) = user_certificate(signer, principal);
        let mut client = TestSession::connect(&config).await;
        assert!(!client
            .client
            .authenticate_openssh_cert("root", subject, certificate)
            .await
            .unwrap()
            .success());
        client.finish().await;
    }
    let (_, certificate) = user_certificate(&ca_a, "box_123");
    let mut client = TestSession::connect(&config).await;
    let result = client
        .client
        .authenticate_openssh_cert("root", Arc::new(private_key()), certificate)
        .await;
    assert!(
        result.is_err() || !result.unwrap().success(),
        "a certificate without its subject's private key must fail"
    );

    client.finish().await;
    let (subject, _) = user_certificate(&ca_a, "box_123");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut rng = russh::keys::key::safe_rng();
    let mut expired =
        Builder::new_with_random_nonce(&mut rng, subject.public_key(), now - 120, now - 60)
            .unwrap();
    expired.valid_principal("box_123").unwrap();
    let mut client = TestSession::connect(&config).await;
    assert!(!client
        .client
        .authenticate_openssh_cert("root", subject, expired.sign(&ca_a).unwrap())
        .await
        .unwrap()
        .success());
    client.finish().await;
}

#[tokio::test]
async fn ssh_control_rejects_missing_auth_and_host_key_without_guest_network() {
    use boxlite_shared::{ssh_configure_request::Auth, Ssh, SshConfigureRequest, SshNoAuth};
    use tonic::{Code, Request};
    let guest = Arc::new(GuestServer::new(GuestLayout::new()));
    guest.ssh_manager.attach_guest(&guest);
    let request = SshConfigureRequest {
        host_private_key: private_key()
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .to_string(),
        principal: "box_123".into(),
        auth: Some(Auth::NoAuth(SshNoAuth {})),
    };
    assert_eq!(
        Ssh::configure(guest.as_ref(), Request::new(request.clone()))
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    guest.init_state.lock().await.initialized = true;
    let original = guest.ssh_manager.status().await;
    for invalid in [
        SshConfigureRequest {
            auth: None,
            ..request.clone()
        },
        SshConfigureRequest {
            host_private_key: String::new(),
            ..request.clone()
        },
        SshConfigureRequest {
            host_private_key: "invalid host key".into(),
            ..request.clone()
        },
        SshConfigureRequest {
            auth: Some(keys_auth(&[], &[])),
            ..request.clone()
        },
    ] {
        assert_eq!(
            Ssh::configure(guest.as_ref(), Request::new(invalid))
                .await
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );
        assert_eq!(guest.ssh_manager.status().await, original);
    }
    guest.ssh_manager.disable().await.unwrap();
}

fn user_certificate(ca_key: &PrivateKey, principal: &str) -> (Arc<PrivateKey>, Certificate) {
    let subject_key = Arc::new(private_key());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut rng = russh::keys::key::safe_rng();
    let mut builder = Builder::new_with_random_nonce(
        &mut rng,
        subject_key.public_key(),
        now.saturating_sub(60),
        now.saturating_add(60),
    )
    .unwrap();
    builder.cert_type(CertType::User).unwrap();
    builder.key_id("boxlite-test").unwrap();
    builder.valid_principal(principal).unwrap();
    builder.extension("permit-pty", "").unwrap();
    builder.extension("permit-port-forwarding", "").unwrap();
    (subject_key, builder.sign(ca_key).unwrap())
}

#[derive(Clone)]
pub(super) struct TrustTestHostKey;

impl russh::client::Handler for TrustTestHostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[test]
fn ssh_config_is_disabled_by_absence_and_rejects_bad_auth_inputs() {
    assert!(certificate_config("not a key", "box_123").is_err());
    assert!(certificate_config(ca_public_key(), "../box").is_err());
}

#[tokio::test]
async fn shutdown_handle_forces_a_live_transport_to_finish() {
    let (socket, peer) = tokio::net::UnixStream::pair().unwrap();
    let (mut socket, shutdown_socket) = socket_with_shutdown_handle(socket).unwrap();

    shutdown_fd(&shutdown_socket).unwrap();
    let mut byte = [0_u8; 1];
    let read_result =
        tokio::time::timeout(std::time::Duration::from_secs(1), socket.read(&mut byte)).await;

    assert!(read_result.is_ok(), "local shutdown must unblock the read");
    drop(peer);
}

#[tokio::test]
async fn stop_timeout_aborts_owned_tasks_and_closes_their_transport() {
    let (socket, mut peer) = tokio::net::UnixStream::pair().unwrap();
    let (_, shutdown_socket) = socket_with_shutdown_handle(socket).unwrap();
    let shutdown_socket = ShutdownSocket(shutdown_socket);
    let (ready_tx, ready_rx) = oneshot::channel();
    let shutdown = CancellationToken::new();
    let task = tokio::spawn(async move {
        let _socket = shutdown_socket;
        let _ = ready_tx.send(());
        std::future::pending::<()>().await;
    });
    ready_rx.await.unwrap();
    let mut running = RunningListener {
        host_key_fingerprint: "test fingerprint".into(),
        shutdown,
        task: Some(task),
        connections: TaskTracker::new(),
    };
    running.stop().await.unwrap();
    assert!(running.task.is_none());
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn wire_rejected_session_requests_close_the_accepted_channel() {
    let ca_key = private_key();
    let (subject_key, certificate) = user_certificate(&ca_key, "box_123");
    let config = certificate_config(ca_key.public_key().to_openssh().unwrap(), "box_123").unwrap();
    let mut client = TestSession::connect(&config).await;
    assert!(
        !client
            .client
            .authenticate_publickey(
                "root",
                PrivateKeyWithHashAlg::new(Arc::new(private_key()), None),
            )
            .await
            .unwrap()
            .success(),
        "CA-only authentication must reject raw user keys"
    );
    assert!(client
        .client
        .authenticate_openssh_cert("root", subject_key, certificate)
        .await
        .unwrap()
        .success());

    let mut invalid_exec = client.client.channel_open_session().await.unwrap();
    invalid_exec
        .exec(true, b"bad\0command".to_vec())
        .await
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), invalid_exec.wait())
            .await
            .expect("invalid exec must receive a failure reply"),
        Some(russh::ChannelMsg::Failure)
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), invalid_exec.wait())
            .await
            .expect("invalid exec must close its accepted channel"),
        Some(russh::ChannelMsg::Close) | None
    ));

    let mut unsupported_subsystem = client.client.channel_open_session().await.unwrap();
    unsupported_subsystem
        .request_subsystem(true, "not-sftp")
        .await
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), unsupported_subsystem.wait())
            .await
            .expect("unsupported subsystem must receive a failure reply"),
        Some(russh::ChannelMsg::Failure)
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), unsupported_subsystem.wait())
            .await
            .expect("unsupported subsystem must close its accepted channel"),
        Some(russh::ChannelMsg::Close) | None
    ));

    client.finish().await;
}

impl SshManager {
    pub(crate) async fn stall_connection_cleanup_for_test(&self) -> oneshot::Sender<()> {
        let connections = TaskTracker::new();
        let (finish_tx, finish_rx) = oneshot::channel();
        connections.spawn(async move {
            let _ = finish_rx.await;
        });
        self.state.lock().await.listener = Some(RunningListener {
            host_key_fingerprint: "test fingerprint".into(),
            shutdown: CancellationToken::new(),
            task: None,
            connections,
        });
        finish_tx
    }
}

struct ExpectedHostKey(PublicKey);

impl russh::client::Handler for ExpectedHostKey {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        assert_eq!(key, &self.0, "handshake must use the supplied host key");
        Ok(true)
    }
}

struct TestSession {
    client: russh::client::Handle<ExpectedHostKey>,
    server: russh::server::RunningSession<server::SshConnection>,
    shutdown: CancellationToken,
    _authenticated_rx: oneshot::Receiver<()>,
    tasks: ConnectionTasks,
}

impl TestSession {
    async fn connect(config: &SshConfig) -> Self {
        let guest = Arc::new(GuestServer::new(GuestLayout::new()));
        let shutdown = CancellationToken::new();
        let (authenticated_tx, authenticated_rx) = oneshot::channel();
        let tasks = ConnectionTasks::new(&shutdown);
        let handler = server::SshConnection::new(
            guest,
            config.authorizer.clone(),
            tasks.clone(),
            authenticated_tx,
        );
        let (server_stream, client_stream) = tokio::io::duplex(64 * 1024);
        let (server, client) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                russh::server::run_stream(prepare_listener(config).config, server_stream, handler),
                russh::client::connect_stream(
                    Arc::new(russh::client::Config::default()),
                    client_stream,
                    ExpectedHostKey(config.host_key.public_key().clone()),
                )
            )
        })
        .await
        .expect("SSH handshake timed out");
        Self {
            client: client.expect("client handshake failed"),
            server: server.expect("server handshake failed"),
            shutdown,
            _authenticated_rx: authenticated_rx,
            tasks,
        }
    }

    async fn finish(self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            // Invalid signature tests can already have closed the protocol task.
            if let Err(error) = self
                .client
                .disconnect(russh::Disconnect::ByApplication, "test complete", "")
                .await
            {
                eprintln!("client already disconnected: {error}");
            }
            self.shutdown.cancel();
            if let Err(error) = self.client.await {
                eprintln!("client session ended: {error}");
            }
            if let Err(error) = self.server.await {
                eprintln!("server session ended: {error}");
            }
            self.tasks.finish().await;
        })
        .await
        .expect("SSH session or connection cleanup timed out");
    }
}

#[tokio::test]
async fn wire_no_auth_requires_root_and_uses_supplied_host_key() {
    // Each handshake checks the key received by the client, including a new identity.
    for host_key in [private_key(), private_key()] {
        let config = key_config(
            &host_key,
            boxlite_shared::ssh_configure_request::Auth::NoAuth(boxlite_shared::SshNoAuth {}),
        );
        let mut anonymous = TestSession::connect(&config).await;
        assert!(!anonymous
            .client
            .authenticate_none("nobody")
            .await
            .unwrap()
            .success());
        anonymous.finish().await;
        let mut root = TestSession::connect(&config).await;
        assert!(root
            .client
            .authenticate_none("root")
            .await
            .unwrap()
            .success());
        root.finish().await;
    }
}

#[tokio::test]
async fn dropping_listener_cancels_its_generation() {
    let shutdown = CancellationToken::new();
    let listener = RunningListener {
        host_key_fingerprint: "test fingerprint".into(),
        shutdown: shutdown.clone(),
        task: None,
        connections: TaskTracker::new(),
    };
    let mut cancelled = Box::pin(shutdown.cancelled());
    assert!(futures::poll!(&mut cancelled).is_pending());
    drop(listener);
    tokio::time::timeout(Duration::from_secs(1), cancelled)
        .await
        .expect("dropping the listener must wake cancellation waiters");
    assert!(shutdown.is_cancelled());
}

#[tokio::test]
async fn manager_disable_drains_cancelled_stop_and_is_idempotent() {
    let manager = SshManager::default();
    let shutdown = CancellationToken::new();
    let (finish_tx, finish_rx) = oneshot::channel();
    let (ready_tx, ready_rx) = oneshot::channel();
    let task_shutdown = shutdown.clone();
    let task = tokio::spawn(async move {
        let _ = ready_tx.send(());
        task_shutdown.cancelled().await;
        finish_rx.await.unwrap();
    });
    ready_rx.await.unwrap();
    *manager.state.lock().await = ManagerState {
        generation: 7,
        listener: Some(RunningListener {
            host_key_fingerprint: "test fingerprint".into(),
            shutdown,
            task: Some(task),
            connections: TaskTracker::new(),
        }),
    };
    let active = manager.status().await;
    assert!(active.enabled);
    assert_eq!(
        active.host_key_fingerprint.as_deref(),
        Some("test fingerprint")
    );
    let mut disabling = Box::pin(manager.disable());
    assert!(futures::poll!(&mut disabling).is_pending());
    drop(disabling);
    let stopping = manager.status().await;
    assert!(!stopping.enabled);
    assert_eq!(stopping.generation, active.generation + 1);
    assert!(stopping.host_key_fingerprint.is_none());
    assert!(manager.state.lock().await.listener.is_some());
    finish_tx.send(()).unwrap();
    let disabled = tokio::time::timeout(Duration::from_secs(1), manager.disable())
        .await
        .unwrap()
        .unwrap();
    assert!(!disabled.enabled);
    assert!(manager.state.lock().await.listener.is_none());
    assert_eq!(manager.disable().await.unwrap(), disabled);
    assert_eq!(manager.shutdown().await.unwrap(), disabled);
}

#[tokio::test]
async fn incomplete_handler_cleanup_prevents_the_next_listener_from_starting() {
    let guest = Arc::new(GuestServer::new(GuestLayout::new()));
    guest.ssh_manager.attach_guest(&guest);
    let config = certificate_config(ca_public_key(), "box_123").unwrap();
    let finish = guest.ssh_manager.stall_connection_cleanup_for_test().await;
    for _ in 0..2 {
        assert!(matches!(
            guest.ssh_manager.configure(config.clone()).await,
            Err(SshStartError::Stop(SshShutdownError::TimedOut))
        ));
        assert!(!guest.ssh_manager.status().await.enabled);
        assert!(guest.ssh_manager.state.lock().await.listener.is_some());
    }
    finish.send(()).unwrap();
    guest.ssh_manager.disable().await.unwrap();
    assert!(guest.ssh_manager.state.lock().await.listener.is_none());
    assert_eq!(
        guest.ssh_manager.disable().await.unwrap(),
        guest.ssh_manager.status().await
    );
}

#[tokio::test]
async fn manager_rejects_configuration_after_shutdown_or_without_guest() {
    let config = certificate_config(ca_public_key(), "box_123").unwrap();
    assert!(matches!(
        SshManager::default().configure(config.clone()).await,
        Err(SshStartError::NotAttached)
    ));
    let guest = Arc::new(GuestServer::new(GuestLayout::new()));
    guest.ssh_manager.attach_guest(&guest);
    guest.ssh_manager.shutdown().await.unwrap();
    assert!(matches!(
        guest.ssh_manager.configure(config.clone()).await,
        Err(SshStartError::ShuttingDown)
    ));
    let guest = Arc::new(GuestServer::new(GuestLayout::new()));
    guest.ssh_manager.attach_guest(&guest);
    guest
        .shutting_down
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        guest.ssh_manager.configure(config).await,
        Err(SshStartError::ShuttingDown)
    ));
}

#[tokio::test]
async fn cancelled_connection_drain_keeps_the_same_generation_until_retry() {
    let manager = SshManager::default();
    let finish = manager.stall_connection_cleanup_for_test().await;
    let mut disable = Box::pin(manager.disable());
    assert!(futures::poll!(&mut disable).is_pending());
    drop(disable);
    assert!(manager.state.lock().await.listener.is_some());
    assert!(!manager.status().await.enabled);
    finish.send(()).unwrap();
    manager.disable().await.unwrap();
    assert!(manager.state.lock().await.listener.is_none());
}

#[tokio::test]
async fn forced_listener_stop_keeps_connection_cleanup_tracked() {
    let manager = SshManager::default();
    let finish = manager.stall_connection_cleanup_for_test().await;
    manager.state.lock().await.listener.as_mut().unwrap().task =
        Some(tokio::spawn(std::future::pending()));
    assert!(matches!(
        manager.disable().await,
        Err(SshShutdownError::TimedOut)
    ));
    {
        let state = manager.state.lock().await;
        let listener = state.listener.as_ref().unwrap();
        assert!(listener.task.is_none());
        assert_eq!(listener.connections.len(), 1);
    }
    finish.send(()).unwrap();
    manager.disable().await.unwrap();
    assert!(manager.state.lock().await.listener.is_none());
}
