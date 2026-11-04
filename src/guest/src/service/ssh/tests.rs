use super::*;

mod setup;

pub(super) struct ActivationGate {
    pub(super) entered: tokio::sync::Notify,
    pub(super) release: tokio::sync::Semaphore,
}

impl ActivationGate {
    pub(super) async fn wait(&self) {
        self.entered.notify_one();
        self.release
            .acquire()
            .await
            .expect("activation gate closed")
            .forget();
    }
}
use crate::layout::GuestLayout;
use boxlite_shared::{
    guest_init_response, GuestClient, GuestInitRequest, SshCaConfig, SshClient, SshControlRequest,
};
use russh::keys::ssh_key::certificate::Builder;
use russh::keys::{Algorithm, Certificate, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tonic::transport::Channel;

#[tokio::test]
async fn repeated_configuration_restarts_and_disconnects_old_transport() {
    let mut guest = TestGuest::new().await;
    let host = private_key();
    let user = private_key();
    let mut configuration = config(&host, &[&user], None);
    let address = guest.start(configuration.clone()).await;
    configuration.listen_address = address.to_string();
    let mut client = connect(address, &host).await;
    assert!(client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(Arc::new(user), None))
        .await
        .unwrap()
        .success());
    let result = guest.configure(configuration).await;
    assert!(
        result.is_ok(),
        "repeated valid configuration must restart SSH: {result:?}"
    );
    tokio::time::timeout(Duration::from_secs(2), client)
        .await
        .expect("old transport must disconnect after Control")
        .ok();
    guest.stop().await;
}

fn private_key() -> PrivateKey {
    PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap()
}

/// OpenSSH key files embed both halves of the keypair and are stored
/// verbatim, so this file parses and signs fine, but every handshake
/// fails: the public half announced during kex belongs to another key.
fn mismatched_host_key() -> String {
    let ecdsa = || {
        PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            Algorithm::Ecdsa {
                curve: russh::keys::EcdsaCurve::NistP256,
            },
        )
        .unwrap()
    };
    let (a, b) = (ecdsa(), ecdsa());
    let russh::keys::ssh_key::private::EcdsaKeypair::NistP256 {
        private: a_private, ..
    } = a.key_data().ecdsa().unwrap()
    else {
        panic!("expected a NIST P-256 keypair")
    };
    let russh::keys::ssh_key::private::EcdsaKeypair::NistP256 {
        public: b_public, ..
    } = b.key_data().ecdsa().unwrap()
    else {
        panic!("expected a NIST P-256 keypair")
    };
    PrivateKey::from(russh::keys::ssh_key::private::EcdsaKeypair::NistP256 {
        public: *b_public,
        private: a_private.clone(),
    })
    .to_openssh(Default::default())
    .unwrap()
    .to_string()
}

/// Parses as an unencrypted OpenSSH key but cannot sign: security-key
/// (FIDO) keypairs keep the private half in hardware.
fn unsignable_host_key() -> String {
    let ed25519 = private_key();
    let public = russh::keys::ssh_key::public::SkEd25519::new(
        *ed25519.public_key().key_data().ed25519().unwrap(),
        "ssh:",
    );
    let sk = russh::keys::ssh_key::private::SkEd25519::new(public, 0x01, b"key-handle".to_vec())
        .unwrap();
    PrivateKey::from(sk)
        .to_openssh(Default::default())
        .unwrap()
        .to_string()
}

fn config(
    host: &PrivateKey,
    keys: &[&PrivateKey],
    ca: Option<&PrivateKey>,
) -> boxlite_shared::SshConfig {
    boxlite_shared::SshConfig {
        listen_address: "127.0.0.1:0".into(),
        host_private_key: host.to_openssh(Default::default()).unwrap().to_string(),
        accounts: vec![boxlite_shared::SshAccount {
            login: "root".into(),
            ca: ca.map(|key| SshCaConfig {
                public_key: key.public_key().to_openssh().unwrap(),
                principal: "box_123".into(),
            }),
            authorized_keys: keys
                .iter()
                .map(|key| key.public_key().to_openssh().unwrap())
                .collect(),
        }],
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
    ssh: SshClient<Channel>,
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
        let ssh_service = boxlite_shared::SshServer::from_arc(guest.clone());
        let task = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(service)
                .add_service(ssh_service)
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
        let ssh = SshClient::connect(format!("http://{address}"))
            .await
            .unwrap();
        Self {
            guest,
            client,
            ssh,
            stop,
            task,
            _root: root,
        }
    }

    async fn init(&mut self) -> boxlite_shared::GuestInitResponse {
        self.guest
            .ssh_manager
            .restore(self._root.path().to_path_buf())
            .await
            .unwrap();
        self.client
            .init(GuestInitRequest {
                volumes: vec![],
                network: None,
            })
            .await
            .unwrap()
            .into_inner()
    }

    async fn configure(
        &mut self,
        config: boxlite_shared::SshConfig,
    ) -> Result<boxlite_shared::SshStatus, Box<tonic::Status>> {
        self.ssh
            .control(SshControlRequest {
                enable: Some(true),
                config: Some(config),
            })
            .await
            .map(|r| r.into_inner().status.unwrap())
            .map_err(Box::new)
    }

    async fn status(&mut self) -> boxlite_shared::SshStatus {
        self.ssh
            .control(SshControlRequest::default())
            .await
            .unwrap()
            .into_inner()
            .status
            .unwrap()
    }

    async fn start(&mut self, config: boxlite_shared::SshConfig) -> SocketAddr {
        assert!(matches!(
            self.init().await.result,
            Some(guest_init_response::Result::Success(_))
        ));
        self.configure(config)
            .await
            .unwrap()
            .listen_address
            .parse()
            .unwrap()
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
        assert!(self.guest.ssh_manager.state.lock().await.tasks.is_none());
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
        for key in &mut ssh.accounts[0].authorized_keys {
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
                // OpenSSH sends an empty terminal type when the client has no TERM.
                let mut no_term = client.channel_open_session().await.unwrap();
                no_term
                    .request_pty(true, "", 80, 24, 0, 0, &[])
                    .await
                    .unwrap();
                assert!(matches!(
                    no_term.wait().await,
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
async fn grpc_ssh_invalid_inputs_preserve_running_listener() {
    let host = private_key();
    let user = private_key();
    let ca = private_key();
    let valid = config(&host, &[&user], Some(&ca));
    let mut invalid = Vec::new();
    let mut ssh = valid.clone();
    ssh.accounts.clear();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.accounts.push(ssh.accounts[0].clone());
    invalid.push(ssh);
    for login in ["", "../alice", "alice\n", "alice bob"] {
        let mut ssh = valid.clone();
        ssh.accounts[0].login = login.into();
        invalid.push(ssh);
    }
    let mut ssh = valid.clone();
    ssh.accounts[0].ca = None;
    ssh.accounts[0].authorized_keys.clear();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.accounts[0].authorized_keys.push("not a key".into());
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.accounts[0].authorized_keys[0] = format!("no-pty {}", ssh.accounts[0].authorized_keys[0]);
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.accounts[0].authorized_keys[0].push_str("\nssh-ed25519 bad");
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.accounts[0].ca.as_mut().unwrap().principal = "../invalid".into();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.accounts[0].ca.as_mut().unwrap().public_key = "invalid".into();
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
    let mut ssh = valid.clone();
    ssh.host_private_key = unsignable_host_key();
    invalid.push(ssh);
    let mut ssh = valid.clone();
    ssh.host_private_key = mismatched_host_key();
    invalid.push(ssh);
    for ssh in invalid {
        let mut fixture = TestGuest::new().await;
        let address = fixture.start(valid.clone()).await;
        let before = fixture.status().await;
        let error = fixture.configure(ssh).await.unwrap_err();
        assert_eq!(error.code(), tonic::Code::InvalidArgument);
        assert!(!error.message().contains("private-marker"));
        assert_eq!(fixture.status().await, before);
        let _client = connect(address, &host).await;
        fixture.stop().await;
    }
}

#[tokio::test]
async fn grpc_ssh_accounts_select_credentials_and_replacement_revokes_old_logins() {
    let host = private_key();
    let alice = Arc::new(private_key());
    let bob = Arc::new(private_key());
    let alice_ca = private_key();
    let bob_ca = private_key();
    let mut configuration = config(&host, &[&alice], Some(&alice_ca));
    configuration.accounts[0].login = "alice".into();
    let mut bob_account = config(&host, &[&bob], Some(&bob_ca)).accounts.remove(0);
    bob_account.login = "bob".into();
    bob_account.ca.as_mut().unwrap().principal = "bob_principal".into();
    configuration.accounts.push(bob_account);
    let mut fixture = TestGuest::new().await;
    let address = fixture.start(configuration.clone()).await;
    for (login, key, accepted) in [
        ("alice", alice.clone(), true),
        ("bob", bob.clone(), true),
        ("alice", bob.clone(), false),
        ("bob", alice.clone(), false),
        ("unknown", alice.clone(), false),
        ("root", alice.clone(), false),
    ] {
        let mut client = connect(address, &host).await;
        assert_eq!(
            client
                .authenticate_publickey(login, PrivateKeyWithHashAlg::new(key, None))
                .await
                .unwrap()
                .success(),
            accepted,
            "public key authentication for {login}"
        );
    }
    for (login, ca, principal, accepted) in [
        ("alice", &alice_ca, "box_123", true),
        ("bob", &bob_ca, "bob_principal", true),
        ("bob", &alice_ca, "bob_principal", false),
        ("bob", &bob_ca, "box_123", false),
        ("unknown", &alice_ca, "box_123", false),
    ] {
        let mut client = connect(address, &host).await;
        let cert = certificate(ca, &alice, principal, false, true);
        assert_eq!(
            client
                .authenticate_openssh_cert(login, alice.clone(), cert)
                .await
                .unwrap()
                .success(),
            accepted,
            "certificate authentication for {login}"
        );
    }
    let mut old_client = connect(address, &host).await;
    assert!(old_client
        .authenticate_publickey("alice", PrivateKeyWithHashAlg::new(alice.clone(), None))
        .await
        .unwrap()
        .success());
    configuration.listen_address = address.to_string();
    configuration.accounts.remove(0);
    fixture.configure(configuration).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), old_client)
        .await
        .expect("replacing accounts must disconnect old clients")
        .ok();
    let mut client = connect(address, &host).await;
    assert!(!client
        .authenticate_publickey("alice", PrivateKeyWithHashAlg::new(alice, None))
        .await
        .unwrap()
        .success());
    let mut client = connect(address, &host).await;
    assert!(client
        .authenticate_publickey("bob", PrivateKeyWithHashAlg::new(bob, None))
        .await
        .unwrap()
        .success());
    fixture.stop().await;
}

#[tokio::test]
async fn grpc_ssh_control_lifecycle_and_bind_failure() {
    let mut fixture = TestGuest::new().await;
    let host = private_key();
    let ssh = config(&host, &[&private_key()], None);
    assert_eq!(fixture.status().await, boxlite_shared::SshStatus::default());
    assert!(!fixture._root.path().join("etc/boxlite").exists());
    assert_eq!(
        fixture.configure(ssh.clone()).await.unwrap_err().code(),
        tonic::Code::FailedPrecondition
    );
    fixture.init().await;
    assert!(!fixture.status().await.enabled);
    let ready = fixture.configure(ssh.clone()).await.unwrap();
    assert_eq!(ready.generation, 1);
    assert_eq!(
        ready.host_public_key,
        host.public_key().to_openssh().unwrap()
    );
    assert_eq!(
        ready.host_key_fingerprint,
        host.public_key().fingerprint(HashAlg::Sha256).to_string()
    );
    assert_eq!(fixture.status().await, ready);
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut bad_bind = ssh.clone();
    bad_bind.listen_address = occupied.local_addr().unwrap().to_string();
    assert_eq!(
        fixture.configure(bad_bind).await.unwrap_err().code(),
        tonic::Code::Unavailable
    );
    assert!(!fixture.status().await.enabled);
    drop(occupied);
    let recovered = fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(true),
            config: None,
        })
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    assert!(recovered.enabled);
    assert_eq!(recovered.generation, 2);
    let ready = fixture.configure(ssh.clone()).await.unwrap();
    assert_eq!(ready.generation, 3);
    for _ in 0..2 {
        let stopped = fixture
            .ssh
            .control(SshControlRequest {
                enable: Some(false),
                config: None,
            })
            .await
            .unwrap()
            .into_inner()
            .status
            .unwrap();
        assert!(!stopped.enabled);
        assert!(stopped.host_public_key.is_empty());
    }
    assert_eq!(fixture.configure(ssh).await.unwrap().generation, 4);
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
async fn ssh_unauthenticated_connection_times_out_and_disable_drains_sessions() {
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

#[tokio::test]
async fn grpc_ssh_failure_does_not_hide_mount_or_network_errors() {
    for network_failure in [false, true] {
        let mut fixture = TestGuest::new().await;
        let response = fixture
            .client
            .init(GuestInitRequest {
                volumes: if network_failure {
                    vec![]
                } else {
                    vec![boxlite_shared::Volume {
                        source: Some(boxlite_shared::volume::Source::BlockDevice(
                            boxlite_shared::BlockDeviceSource {
                                device: fixture
                                    ._root
                                    .path()
                                    .join("missing-device")
                                    .to_string_lossy()
                                    .into_owned(),
                                ..Default::default()
                            },
                        )),
                        ..Default::default()
                    }]
                },
                network: network_failure.then(|| boxlite_shared::NetworkInit {
                    interface: "ssh-test-missing".into(),
                    ip: None,
                    gateway: None,
                }),
            })
            .await
            .unwrap()
            .into_inner();
        let Some(guest_init_response::Result::Error(error)) = response.result else {
            panic!("essential guest setup must fail");
        };
        assert!(error.reason.contains(if network_failure {
            "configure network"
        } else {
            "mount volumes"
        }));
        assert!(!fixture.guest.init_state.lock().await.initialized);
        assert!(fixture.guest.ssh_manager.state.lock().await.tasks.is_none());
        fixture.stop().await;
    }
}

#[derive(Clone, Default)]
struct CapturedLogs(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLogs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn ssh_failure_logs_and_status_redact_all_configuration_inputs() {
    use tracing::instrument::WithSubscriber;
    let host = private_key();
    let user = private_key();
    let ca = private_key();
    let secret = host.to_openssh(Default::default()).unwrap().to_string();
    let secret_line = secret.lines().nth(1).unwrap();
    for field in ["address", "host", "authorized", "ca", "principal"] {
        let fixture = TestGuest::new().await;
        fixture
            .guest
            .ssh_manager
            .restore(fixture._root.path().to_path_buf())
            .await
            .unwrap();
        let mut ssh = config(&host, &[&user], Some(&ca));
        match field {
            "address" => ssh.listen_address = secret.clone(),
            "host" => ssh.host_private_key = format!("invalid-{secret}"),
            "authorized" => ssh.accounts[0].authorized_keys.push(secret.clone()),
            "ca" => ssh.accounts[0].ca.as_mut().unwrap().public_key = secret.clone(),
            "principal" => ssh.accounts[0].ca.as_mut().unwrap().principal = secret.clone(),
            _ => unreachable!(),
        }
        let logs = CapturedLogs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer(move || writer.clone())
            .finish();
        let status = fixture
            .guest
            .ssh_manager
            .control(SshUpdate::Control(SshControlRequest {
                enable: Some(true),
                config: Some(ssh),
            }))
            .with_subscriber(subscriber)
            .await;
        assert_eq!(
            status.as_ref().unwrap_err().code(),
            tonic::Code::InvalidArgument
        );
        let logged = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        let reason = status.unwrap_err().to_string();
        for diagnostic in [&logged, &reason] {
            assert!(!diagnostic.contains(secret_line), "leaked {field}");
            assert!(!diagnostic.contains("PRIVATE KEY"), "leaked {field}");
        }
        assert!(fixture.guest.ssh_manager.state.lock().await.tasks.is_none());
        fixture.stop().await;
    }
}

#[tokio::test]
async fn stopping_disconnects_pre_authentication_and_forwarding_and_rotates_identity() {
    let mut fixture = TestGuest::new().await;
    let host = private_key();
    let user = Arc::new(private_key());
    let address = fixture.start(config(&host, &[&user], None)).await;
    let unauthenticated = connect(address, &host).await;
    let mut raw = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut client = connect(address, &host).await;
    assert!(client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(user.clone(), None))
        .await
        .unwrap()
        .success());
    let reverse_port = client.tcpip_forward("127.0.0.1", 0).await.unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_port = target.local_addr().unwrap().port();
    let mut forward = client
        .channel_open_direct_tcpip("127.0.0.1", target_port.into(), "127.0.0.1", 1234)
        .await
        .unwrap()
        .into_stream();
    let (_peer, _) = target.accept().await.unwrap();
    let next_host = private_key();
    let next_user = Arc::new(private_key());
    let mut next = config(&next_host, &[&next_user], None);
    next.listen_address = address.to_string();
    let status = fixture.configure(next.clone()).await.unwrap();
    assert_eq!(status.generation, 2);
    assert!(!fixture
        .guest
        .shutting_down
        .load(std::sync::atomic::Ordering::SeqCst));
    for connection in [client, unauthenticated] {
        let _ = tokio::time::timeout(Duration::from_secs(2), connection)
            .await
            .expect("old transport closed");
    }
    // Identification bytes may precede EOF on a pre-handshake transport.
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), raw.read_to_end(&mut bytes))
        .await
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(2), forward.read_to_end(&mut Vec::new()))
        .await
        .unwrap();
    let _rebound = TcpListener::bind(("127.0.0.1", reverse_port as u16))
        .await
        .unwrap();
    let mut client = connect(address, &next_host).await;
    assert!(!client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(user, None))
        .await
        .unwrap()
        .success());
    assert!(client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(next_user, None))
        .await
        .unwrap()
        .success());
    fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(false),
            config: None,
        })
        .await
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(2), client)
        .await
        .unwrap();
    for generation in 3..8 {
        assert_eq!(
            fixture.configure(next.clone()).await.unwrap().generation,
            generation
        );
    }
    fixture.stop().await;
}

#[tokio::test]
async fn stop_timeout_retains_cleanup_and_prevents_next_generation() {
    let mut fixture = TestGuest::new().await;
    let configuration = config(&private_key(), &[&private_key()], None);
    fixture.start(configuration.clone()).await;
    let outstanding_cleanup = fixture
        .guest
        .ssh_manager
        .state
        .lock()
        .await
        .tasks
        .as_ref()
        .unwrap()
        .token();
    let error = fixture.configure(configuration.clone()).await.unwrap_err();
    assert_eq!(error.code(), tonic::Code::DeadlineExceeded);
    let status = fixture.status().await;
    assert!(!status.enabled);
    assert_eq!(status.generation, 1);
    assert!(fixture.guest.ssh_manager.state.lock().await.tasks.is_some());
    drop(outstanding_cleanup);
    assert_eq!(
        fixture.configure(configuration).await.unwrap().generation,
        2
    );
    fixture.stop().await;
}

#[tokio::test]
async fn cancelled_disable_keeps_cleanup_ordered() {
    let mut fixture = TestGuest::new().await;
    let configuration = config(&private_key(), &[&private_key()], None);
    fixture.start(configuration.clone()).await;
    let tasks = fixture
        .guest
        .ssh_manager
        .state
        .lock()
        .await
        .tasks
        .clone()
        .unwrap();
    let cleanup = tasks.token();
    let mut client = fixture.ssh.clone();
    let operation = tokio::spawn(async move {
        client
            .control(SshControlRequest {
                enable: Some(false),
                config: None,
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !tasks.is_cancelled() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    operation.abort();
    drop(cleanup);
    let status = tokio::time::timeout(Duration::from_secs(5), fixture.status())
        .await
        .unwrap();
    assert!(!status.enabled);
    assert_eq!(
        fixture.configure(configuration).await.unwrap().generation,
        2
    );
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_partial_updates_persist_and_reenable_without_restart() {
    let mut fixture = TestGuest::new().await;
    fixture.init().await;
    let missing = fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(true),
            config: None,
        })
        .await
        .unwrap_err();
    assert_eq!(missing.code(), tonic::Code::FailedPrecondition);
    let path = fixture._root.path().join("etc/boxlite/ssh.cfg");
    assert!(!path.exists());
    let host = private_key();
    let user = Arc::new(private_key());
    let configuration = config(&host, &[&user], None);
    let saved = fixture
        .ssh
        .control(SshControlRequest {
            enable: None,
            config: Some(configuration.clone()),
        })
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    assert!(!saved.enabled);
    let active = fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(true),
            config: None,
        })
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    assert!(active.enabled);
    use std::os::unix::fs::MetadataExt;
    let inode = std::fs::metadata(&path).unwrap().ino();
    let observed = fixture
        .ssh
        .control(SshControlRequest {
            enable: None,
            config: None,
        })
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    assert_eq!(observed, active);
    assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
    let mut client = connect(active.listen_address.parse().unwrap(), &host).await;
    assert!(client
        .authenticate_publickey("root", PrivateKeyWithHashAlg::new(user, None))
        .await
        .unwrap()
        .success());
    let repeat = fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(true),
            config: None,
        })
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    assert_eq!(active, repeat);
    let channel = client
        .channel_open_session()
        .await
        .expect("repeated enable must retain the live connection");
    channel.close().await.unwrap();
    drop(client);
    fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(false),
            config: None,
        })
        .await
        .unwrap();
    let again = fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(true),
            config: None,
        })
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    assert_eq!(again.generation, active.generation + 1);
    assert_eq!(again.host_key_fingerprint, active.host_key_fingerprint);
    let replacement = fixture.configure(configuration).await.unwrap();
    assert_eq!(replacement.generation, again.generation + 1);
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_shutdown_serializes_with_admitted_activation() {
    let mut fixture = TestGuest::new().await;
    fixture.init().await;
    let configuration = config(&private_key(), &[&private_key()], None);
    let gate = Arc::new(ActivationGate {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Semaphore::new(0),
    });
    fixture.guest.ssh_manager.state.lock().await.activation_gate = Some(gate.clone());
    let mut update_client = fixture.ssh.clone();
    let update = tokio::spawn(async move {
        update_client
            .control(SshControlRequest {
                enable: Some(true),
                config: Some(configuration),
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
    let path = fixture._root.path().join("etc/boxlite/ssh.cfg");
    let saved = std::fs::read(&path).unwrap();
    let mut shutdown_client = fixture.client.clone();
    let shutdown = tokio::spawn(async move {
        shutdown_client
            .shutdown(boxlite_shared::ShutdownRequest {})
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture
            .guest
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let error = fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(false),
            config: None,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    gate.release.add_permits(1);
    update.await.unwrap().unwrap();
    shutdown.await.unwrap().unwrap();
    let stopped = fixture.status().await;
    assert!(!stopped.enabled);
    assert_eq!(fixture.status().await, stopped);
    assert_eq!(std::fs::read(path).unwrap(), saved);
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_requires_rootfs_and_full_configuration_repairs_corrupt_state() {
    let mut fixture = TestGuest::new().await;
    fixture
        .client
        .init(GuestInitRequest {
            volumes: vec![],
            network: None,
        })
        .await
        .unwrap();
    let configuration = config(&private_key(), &[&private_key()], None);
    assert_eq!(
        fixture
            .configure(configuration.clone())
            .await
            .unwrap_err()
            .code(),
        tonic::Code::FailedPrecondition
    );
    fixture
        .guest
        .ssh_manager
        .restore(fixture._root.path().to_path_buf())
        .await
        .unwrap();
    let active = fixture.configure(configuration.clone()).await.unwrap();
    let path = fixture._root.path().join("etc/boxlite/ssh.cfg");
    std::fs::write(&path, b"invalid JSON").unwrap();
    let replacement = config(&private_key(), &[&private_key()], None);
    let repaired = fixture
        .configure(replacement.clone())
        .await
        .expect("complete configuration must replace corrupt saved content");
    assert!(repaired.enabled);
    assert_eq!(repaired.generation, active.generation + 1);
    assert_ne!(repaired.host_key_fingerprint, active.host_key_fingerprint);
    let desired = persistence::load(fixture._root.path()).unwrap();
    assert!(desired.enable);
    assert_eq!(desired.config, Some(replacement));
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_disable_stops_live_listener_when_saved_state_is_corrupt() {
    let mut fixture = TestGuest::new().await;
    let address = fixture
        .start(config(&private_key(), &[&private_key()], None))
        .await;
    let path = fixture._root.path().join("etc/boxlite/ssh.cfg");
    std::fs::write(&path, b"invalid JSON").unwrap();
    assert_eq!(
        fixture
            .ssh
            .control(SshControlRequest {
                enable: Some(false),
                config: None,
            })
            .await
            .unwrap_err()
            .code(),
        tonic::Code::Internal
    );
    assert!(
        !fixture.status().await.enabled,
        "explicit disable must stop SSH even when saved state cannot be read"
    );
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"invalid JSON");
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_parallel_partial_updates_merge_both_fields() {
    let mut fixture = TestGuest::new().await;
    fixture.init().await;
    let first = config(&private_key(), &[&private_key()], None);
    let replacement = config(&private_key(), &[&private_key()], None);
    fixture
        .ssh
        .control(SshControlRequest {
            enable: None,
            config: Some(first),
        })
        .await
        .unwrap();
    let mut first_client = fixture.ssh.clone();
    let mut second_client = fixture.ssh.clone();
    let expected = replacement.clone();
    let (enable, configure) = tokio::join!(
        first_client.control(SshControlRequest {
            enable: Some(true),
            config: None
        }),
        second_client.control(SshControlRequest {
            enable: None,
            config: Some(replacement)
        }),
    );
    enable.unwrap();
    configure.unwrap();
    let desired = persistence::load(fixture._root.path()).unwrap();
    assert!(desired.enable);
    assert_eq!(desired.config, Some(expected));
    assert!(fixture.status().await.enabled);
    fixture.stop().await;
}

#[tokio::test]
async fn ssh_disable_stops_live_listener_when_save_fails() {
    let mut fixture = TestGuest::new().await;
    let active = fixture
        .start(config(&private_key(), &[&private_key()], None))
        .await;
    let before_status = fixture.status().await;
    let path = fixture._root.path().join("etc/boxlite/ssh.cfg");
    let before = std::fs::read(&path).unwrap();
    // Each nextest case has its own process. A zero file-size soft limit makes
    // the real temporary-file write fail without changing the saved state.
    let mut original = nix::libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: pointers reference live rlimit structures; SIGXFSZ is restored below.
    unsafe {
        assert_eq!(
            nix::libc::getrlimit(nix::libc::RLIMIT_FSIZE, &mut original),
            0
        );
        let old_signal = nix::libc::signal(nix::libc::SIGXFSZ, nix::libc::SIG_IGN);
        let limited = nix::libc::rlimit {
            rlim_cur: 0,
            rlim_max: original.rlim_max,
        };
        assert_eq!(nix::libc::setrlimit(nix::libc::RLIMIT_FSIZE, &limited), 0);
        let result = fixture
            .ssh
            .control(SshControlRequest {
                enable: Some(false),
                config: None,
            })
            .await;
        assert_eq!(nix::libc::setrlimit(nix::libc::RLIMIT_FSIZE, &original), 0);
        nix::libc::signal(nix::libc::SIGXFSZ, old_signal);
        assert_eq!(result.unwrap_err().code(), tonic::Code::Internal);
    }
    assert_eq!(std::fs::read(path).unwrap(), before);
    let stopped = fixture.status().await;
    assert!(
        !stopped.enabled,
        "explicit disable must stop SSH even when saved state cannot be written"
    );
    assert_eq!(stopped.generation, before_status.generation);
    assert!(tokio::net::TcpStream::connect(active).await.is_err());
    fixture.stop().await;
}

fn save_gate(after_rename: bool, fail: bool) -> Arc<persistence::SaveGate> {
    let gate = Arc::new(persistence::SaveGate {
        after_rename,
        fail,
        entered: tokio::sync::Notify::new(),
        released: std::sync::Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    *persistence::SAVE_GATE.lock().unwrap() = Some(gate.clone());
    gate
}

fn release_save(gate: &persistence::SaveGate) {
    *persistence::SAVE_GATE.lock().unwrap() = None;
    *gate.released.lock().unwrap() = true;
    gate.wake.notify_one();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_cancelled_storage_keeps_following_update_ordered() {
    let mut fixture = TestGuest::new().await;
    fixture
        .start(config(&private_key(), &[&private_key()], None))
        .await;
    for after_rename in [false, true] {
        let gate = save_gate(after_rename, false);
        let mut first_client = fixture.ssh.clone();
        let first = tokio::spawn(async move {
            first_client
                .control(SshControlRequest {
                    enable: Some(false),
                    config: None,
                })
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
            .await
            .unwrap();
        first.abort();
        let mut second_client = fixture.ssh.clone();
        let mut second = tokio::spawn(async move {
            second_client
                .control(SshControlRequest {
                    enable: Some(true),
                    config: None,
                })
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut second)
                .await
                .is_err()
        );
        release_save(&gate);
        assert!(
            second
                .await
                .unwrap()
                .unwrap()
                .into_inner()
                .status
                .unwrap()
                .enabled
        );
        assert!(persistence::load(fixture._root.path()).unwrap().enable);
    }
    fixture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_post_rename_sync_failure_reloads_for_next_update() {
    let mut fixture = TestGuest::new().await;
    fixture
        .start(config(&private_key(), &[&private_key()], None))
        .await;
    let before = fixture.status().await;
    let replacement = config(&private_key(), &[&private_key()], None);
    let gate = save_gate(true, true);
    let mut client = fixture.ssh.clone();
    let copy = replacement.clone();
    let update = tokio::spawn(async move {
        client
            .control(SshControlRequest {
                enable: None,
                config: Some(copy),
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
    release_save(&gate);
    assert_eq!(
        update.await.unwrap().unwrap_err().code(),
        tonic::Code::Internal
    );
    assert_eq!(fixture.status().await, before);
    let desired = persistence::load(fixture._root.path()).unwrap();
    assert_eq!(desired.config, Some(replacement.clone()));
    fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(false),
            config: None,
        })
        .await
        .unwrap();
    let desired = persistence::load(fixture._root.path()).unwrap();
    assert!(!desired.enable);
    assert_eq!(desired.config, Some(replacement));
    fixture.stop().await;
}
