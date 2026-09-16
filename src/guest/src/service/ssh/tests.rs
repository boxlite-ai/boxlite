use super::*;
use crate::layout::GuestLayout;
use boxlite_shared::{guest_init_response, GuestClient, GuestInitRequest, SshCaConfig};
use russh::keys::ssh_key::certificate::Builder;
use russh::keys::{Algorithm, Certificate, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tonic::transport::Channel;

fn private_key() -> PrivateKey {
    PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap()
}

fn config(
    host: &PrivateKey,
    keys: &[&PrivateKey],
    ca: Option<&PrivateKey>,
) -> boxlite_shared::SshConfig {
    boxlite_shared::SshConfig {
        listen_address: "127.0.0.1:0".into(),
        host_private_key: host.to_openssh(Default::default()).unwrap().to_string(),
        ca: ca.map(|key| SshCaConfig {
            public_key: key.public_key().to_openssh().unwrap(),
            principal: "box_123".into(),
        }),
        authorized_keys: keys
            .iter()
            .map(|key| key.public_key().to_openssh().unwrap())
            .collect(),
    }
}

fn certificate(
    ca: &PrivateKey,
    subject: &PrivateKey,
    principal: &str,
    expired: bool,
    permissions: bool,
) -> Certificate {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut builder = Builder::new_with_random_nonce(
        &mut russh::keys::key::safe_rng(),
        subject.public_key(),
        now - 120,
        if expired { now - 60 } else { now + 600 },
    )
    .unwrap();
    builder.valid_principal(principal).unwrap();
    if permissions {
        builder.extension("permit-pty", "").unwrap();
        builder.extension("permit-port-forwarding", "").unwrap();
    }
    builder.sign(ca).unwrap()
}

struct TestGuest {
    guest: Arc<GuestServer>,
    client: GuestClient<Channel>,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
    _root: tempfile::TempDir,
}

impl TestGuest {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let guest = Arc::new(GuestServer::new(GuestLayout::with_base(root.path())));
        guest.ssh_manager.attach_guest(&guest);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel();
        let service = boxlite_shared::GuestServer::from_arc(guest.clone());
        let task = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(service)
                .serve_with_incoming_shutdown(
                    tokio_stream::wrappers::TcpListenerStream::new(listener),
                    async {
                        let _ = stopped.await;
                    },
                )
                .await
                .unwrap();
        });
        let client = GuestClient::connect(format!("http://{address}"))
            .await
            .unwrap();
        Self {
            guest,
            client,
            stop,
            task,
            _root: root,
        }
    }

    async fn init(
        &mut self,
        ssh_config: Option<boxlite_shared::SshConfig>,
    ) -> Result<boxlite_shared::GuestInitResponse, Box<tonic::Status>> {
        self.client
            .init(GuestInitRequest {
                volumes: vec![],
                network: None,
                ssh_config,
            })
            .await
            .map(tonic::Response::into_inner)
            .map_err(Box::new)
    }

    async fn start(&mut self, mut config: boxlite_shared::SshConfig) -> SocketAddr {
        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        config.listen_address = address.to_string();
        drop(socket);
        assert!(matches!(
            self.init(Some(config)).await.unwrap().result,
            Some(guest_init_response::Result::Success(_))
        ));
        address
    }

    async fn stop(self) {
        self.guest.ssh_manager.shutdown().await.unwrap();
        assert_eq!(
            self.guest
                .ssh_manager
                .connection_permits
                .available_permits(),
            limits::MAX_CONNECTIONS
        );
        assert!(self.guest.ssh_manager.listener.lock().await.is_none());
        let _ = self.stop.send(());
        self.task.await.unwrap();
    }
}

struct CheckHostKey(PublicKey);

struct InvalidSignature;

impl russh::Signer for InvalidSignature {
    type Error = russh::AgentAuthError;

    async fn auth_sign(
        &mut self,
        _key: &russh::keys::agent::AgentIdentity,
        _hash_alg: Option<HashAlg>,
        mut message: Vec<u8>,
    ) -> Result<Vec<u8>, Self::Error> {
        // A well-formed Ed25519 signature envelope with an invalid signature.
        message.extend_from_slice(&83_u32.to_be_bytes());
        message.extend_from_slice(&11_u32.to_be_bytes());
        message.extend_from_slice(b"ssh-ed25519");
        message.extend_from_slice(&64_u32.to_be_bytes());
        message.extend_from_slice(&[0; 64]);
        Ok(message)
    }
}
impl russh::client::Handler for CheckHostKey {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        assert_eq!(
            key.fingerprint(HashAlg::Sha256),
            self.0.fingerprint(HashAlg::Sha256)
        );
        Ok(true)
    }
}

async fn connect(address: SocketAddr, host: &PrivateKey) -> russh::client::Handle<CheckHostKey> {
    tokio::time::timeout(
        Duration::from_secs(5),
        russh::client::connect(
            Arc::new(russh::client::Config::default()),
            address,
            CheckHostKey(host.public_key().clone()),
        ),
    )
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn grpc_ssh_accepts_ca_keys_and_both_with_injected_host_identity() {
    let host = private_key();
    let ca = private_key();
    let first = Arc::new(private_key());
    let second = Arc::new(
        PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            Algorithm::Ecdsa {
                curve: russh::keys::EcdsaCurve::NistP256,
            },
        )
        .unwrap(),
    );
    for (use_ca, use_keys) in [(true, false), (false, true), (true, true)] {
        let mut fixture = TestGuest::new().await;
        let keys = if use_keys {
            vec![first.as_ref(), second.as_ref()]
        } else {
            vec![]
        };
        let mut ssh = config(&host, &keys, use_ca.then_some(&ca));
        for key in &mut ssh.authorized_keys {
            key.push_str(" optional comment");
        }
        let address = fixture.start(ssh).await;
        if !use_keys {
            let mut client = connect(address, &host).await;
            assert!(!client
                .authenticate_publickey("root", PrivateKeyWithHashAlg::new(first.clone(), None))
                .await
                .unwrap()
                .success());
        }
        if !use_ca {
            let mut client = connect(address, &host).await;
            assert!(!client
                .authenticate_openssh_cert(
                    "root",
                    first.clone(),
                    certificate(&ca, &first, "box_123", false, true)
                )
                .await
                .unwrap()
                .success());
        }
        if use_keys {
            for key in [&first, &second] {
                let mut client = connect(address, &host).await;
                assert!(client
                    .authenticate_publickey("root", PrivateKeyWithHashAlg::new(key.clone(), None))
                    .await
                    .unwrap()
                    .success());
                let mut channel = client.channel_open_session().await.unwrap();
                channel
                    .request_pty(true, "xterm", 80, 24, 0, 0, &[])
                    .await
                    .unwrap();
                assert!(matches!(
                    channel.wait().await,
                    Some(russh::ChannelMsg::Success)
                ));
                let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = target.local_addr().unwrap().port();
                let forward = client
                    .channel_open_direct_tcpip("127.0.0.1", u32::from(port), "127.0.0.1", 1234)
                    .await
                    .unwrap();
                let (mut peer, _) = target.accept().await.unwrap();
                peer.write_all(b"forwarded").await.unwrap();
                let mut stream = forward.into_stream();
                let mut bytes = [0; 9];
                stream.read_exact(&mut bytes).await.unwrap();
                assert_eq!(&bytes, b"forwarded");
                // The fixture has no OCI container: an allowed Unix forward
                // reaches the workload boundary and fails to connect there.
                assert!(matches!(
                    client
                        .channel_open_direct_streamlocal("/tmp/ssh-test.sock")
                        .await,
                    Err(russh::Error::ChannelOpenFailure(
                        russh::ChannelOpenFailure::ConnectFailed
                    ))
                ));
            }
        }
        if use_ca {
            let mut client = connect(address, &host).await;
            assert!(client
                .authenticate_openssh_cert(
                    "root",
                    first.clone(),
                    certificate(&ca, &first, "box_123", false, false)
                )
                .await
                .unwrap()
                .success());
            let mut channel = client.channel_open_session().await.unwrap();
            channel
                .request_pty(true, "xterm", 80, 24, 0, 0, &[])
                .await
                .unwrap();
            assert!(matches!(
                channel.wait().await,
                Some(russh::ChannelMsg::Failure)
            ));
            assert!(client
                .channel_open_direct_tcpip("127.0.0.1", 1, "127.0.0.1", 1234)
                .await
                .is_err());
            assert!(matches!(
                client
                    .channel_open_direct_streamlocal("/tmp/ssh-test.sock")
                    .await,
                Err(russh::Error::ChannelOpenFailure(
                    russh::ChannelOpenFailure::AdministrativelyProhibited
                ))
            ));
        }
        fixture.stop().await;
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
    }
}

#[tokio::test]
async fn grpc_ssh_rejects_untrusted_credentials_and_invalid_signatures() {
    let host = private_key();
    let ca = private_key();
    let other_ca = private_key();
    let user = Arc::new(private_key());
    let unknown = Arc::new(private_key());
    let mut fixture = TestGuest::new().await;
    let address = fixture.start(config(&host, &[&user], Some(&ca))).await;
    let mut client = connect(address, &host).await;
    assert!(!client
        .authenticate_publickey_with(
            "root",
            user.public_key().clone(),
            None,
            &mut InvalidSignature
        )
        .await
        .unwrap()
        .success());
    for (name, key) in [("root", unknown.clone()), ("nobody", user.clone())] {
        let mut client = connect(address, &host).await;
        assert!(!client
            .authenticate_publickey(name, PrivateKeyWithHashAlg::new(key, None))
            .await
            .unwrap()
            .success());
    }
    for (signer, cert) in [
        (
            user.clone(),
            certificate(&other_ca, &user, "box_123", false, true),
        ),
        (user.clone(), certificate(&ca, &user, "wrong", false, true)),
        (user.clone(), certificate(&ca, &user, "box_123", true, true)),
        (
            unknown.clone(),
            certificate(&ca, &user, "box_123", false, true),
        ),
    ] {
        let mut client = connect(address, &host).await;
        assert!(!client
            .authenticate_openssh_cert("root", signer, cert)
            .await
            .unwrap()
            .success());
        // The certificate subject is allowlisted, but a failed certificate
        // attempt must not fall back to raw-key authorization.
    }
    fixture.stop().await;
}

#[tokio::test]
async fn grpc_ssh_validates_all_inputs_before_mounting_and_leaves_no_listener() {
    let host = private_key();
    let user = private_key();
    let ca = private_key();
    let valid = config(&host, &[&user], Some(&ca));
    let mut invalid = Vec::new();
    let mut ssh = valid.clone();
    ssh.ca = None;
    ssh.authorized_keys.clear();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.authorized_keys.push("not a key".into());
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.authorized_keys[0] = format!("no-pty {}", ssh.authorized_keys[0]);
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.authorized_keys[0].push_str("\nssh-ed25519 bad");
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.ca.as_mut().unwrap().principal = "../invalid".into();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.ca.as_mut().unwrap().public_key = "invalid".into();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.listen_address = "invalid".into();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.host_private_key = "private-marker".into();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.host_private_key = host
        .encrypt(&mut russh::keys::key::safe_rng(), "test-password")
        .unwrap()
        .to_openssh(Default::default())
        .unwrap()
        .to_string();
    invalid.push(ssh);
    for ssh in invalid {
        let mut fixture = TestGuest::new().await;
        let status = fixture
            .client
            .init(GuestInitRequest {
                ssh_config: Some(ssh),
                network: None,
                // This mount would fail if reached. SSH validation must win first.
                volumes: vec![boxlite_shared::Volume {
                    mount_point: "/nonexistent/ssh-test".into(),
                    container_id: String::new(),
                    source: Some(boxlite_shared::volume::Source::BlockDevice(
                        boxlite_shared::BlockDeviceSource {
                            device: "/nonexistent/ssh-test-device".into(),
                            ..Default::default()
                        },
                    )),
                }],
            })
            .await
            .unwrap_err();
        assert_eq!(status.code(), tonic::Code::InvalidArgument);
        assert!(!status.message().contains("private-marker"));
        assert!(!fixture.guest.init_state.lock().await.initialized);
        fixture.stop().await;
    }
}

#[tokio::test]
async fn grpc_ssh_bind_failure_can_retry_and_duplicate_init_is_rejected() {
    let host = private_key();
    let user = private_key();
    let mut fixture = TestGuest::new().await;
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = occupied.local_addr().unwrap();
    let mut ssh = config(&host, &[&user], None);
    ssh.listen_address = address.to_string();
    assert_eq!(
        fixture.init(Some(ssh.clone())).await.unwrap_err().code(),
        tonic::Code::FailedPrecondition
    );
    assert!(!fixture.guest.init_state.lock().await.initialized);
    assert!(fixture.guest.ssh_manager.listener.lock().await.is_none());
    drop(occupied);
    assert!(matches!(
        fixture.init(Some(ssh.clone())).await.unwrap().result,
        Some(guest_init_response::Result::Success(_))
    ));
    assert!(matches!(
        fixture.init(Some(ssh)).await.unwrap().result,
        Some(guest_init_response::Result::Error(_))
    ));
    let _client = connect(address, &host).await;
    fixture.stop().await;
    let _rebound = TcpListener::bind(address).await.unwrap();
}

#[tokio::test]
async fn grpc_without_ssh_does_not_start_a_listener() {
    let mut fixture = TestGuest::new().await;
    assert!(matches!(
        fixture.init(None).await.unwrap().result,
        Some(guest_init_response::Result::Success(_))
    ));
    assert!(fixture.guest.ssh_manager.listener.lock().await.is_none());
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_connection_and_channel_limits_remain_enforced() {
    let host = private_key();
    let user = Arc::new(private_key());
    let mut fixture = TestGuest::new().await;
    let address = fixture.start(config(&host, &[&user], None)).await;
    // Reserve all but one connection slot without opening 127 idle transports.
    let reserved = fixture
        .guest
        .ssh_manager
        .connection_permits
        .clone()
        .acquire_many_owned((limits::MAX_CONNECTIONS - 1) as u32)
        .await
        .unwrap();
    let mut client = connect(address, &host).await;
    assert!(client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(user, None))
        .await
        .unwrap()
        .success());
    let rejected = tokio::time::timeout(
        Duration::from_secs(5),
        russh::client::connect(
            Arc::new(russh::client::Config::default()),
            address,
            CheckHostKey(host.public_key().clone()),
        ),
    )
    .await
    .unwrap();
    assert!(rejected.is_err());
    let mut channels = Vec::new();
    for _ in 0..limits::MAX_CHANNELS_PER_CONNECTION {
        channels.push(client.channel_open_session().await.unwrap());
    }
    assert!(client.channel_open_session().await.is_err());
    drop(reserved);
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_init_after_shutdown_cannot_reopen_a_listener() {
    let mut fixture = TestGuest::new().await;
    fixture.guest.ssh_manager.shutdown().await.unwrap();
    let status = fixture
        .init(Some(config(&private_key(), &[&private_key()], None)))
        .await
        .unwrap_err();
    assert_eq!(status.code(), tonic::Code::FailedPrecondition);
    assert!(!fixture.guest.init_state.lock().await.initialized);
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_unauthenticated_connection_times_out_and_shutdown_drains_sessions() {
    let host = private_key();
    let user = private_key();
    let mut fixture = TestGuest::new().await;
    let address = fixture.start(config(&host, &[&user], None)).await;
    let client = connect(address, &host).await;
    let _ = tokio::time::timeout(
        limits::AUTHENTICATION_TIMEOUT + Duration::from_secs(5),
        client,
    )
    .await
    .expect("unauthenticated SSH transport must time out");
    let mut authenticated = connect(address, &host).await;
    assert!(authenticated
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(Arc::new(user), None))
        .await
        .unwrap()
        .success());
    let _channel = authenticated.channel_open_session().await.unwrap();
    fixture.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(2), authenticated)
        .await
        .unwrap();
}
