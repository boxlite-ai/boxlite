//! Local SSH persistence → fixed Unix bridge and optional shim TCP forwarding → guest vsock → OCI execution.

mod common;

use boxlite::{
    BoxStatus, BoxliteOptions, BoxliteRuntime, LiteBox, SshApplyResult, SshAuth, SshConfig,
    SshStatus,
};
use boxlite_test_utils::home::PerTestBoxHome;
use russh::keys::ssh_key::{LineEnding, certificate::Builder};
use russh::keys::{Algorithm, Certificate, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn private_key() -> PrivateKey {
    PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap()
}

fn config() -> SshConfig {
    SshConfig {
        enabled: true,
        tcp_listen_address: Some("127.0.0.1:0".parse().unwrap()),
        host_private_key: None,
        auth: SshAuth::NoAuth,
    }
}

fn runtime(home: &PerTestBoxHome) -> BoxliteRuntime {
    BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap()
}

fn database(home: &PerTestBoxHome) -> rusqlite::Connection {
    rusqlite::Connection::open(home.path.join("db/boxlite.db")).unwrap()
}

fn saved_json(home: &PerTestBoxHome, litebox: &LiteBox) -> Option<String> {
    use rusqlite::OptionalExtension;
    database(home)
        .query_row(
            "SELECT json FROM ssh_config WHERE box_id = ?1",
            [litebox.id().as_str()],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

fn reject_ssh_writes(home: &PerTestBoxHome) {
    database(home).execute_batch("CREATE TRIGGER reject_ssh_update AFTER UPDATE OF json ON ssh_config BEGIN SELECT RAISE(ABORT, 'injected SQLite failure'); END;").unwrap();
}

fn allow_ssh_writes(home: &PerTestBoxHome) {
    database(home)
        .execute_batch("DROP TRIGGER reject_ssh_update")
        .unwrap();
}

fn fingerprint(config: &SshConfig) -> String {
    PrivateKey::from_openssh(config.host_private_key.as_ref().unwrap())
        .unwrap()
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string()
}

fn applied(result: SshApplyResult) -> SshStatus {
    match result {
        SshApplyResult::Applied(status) => status,
        SshApplyResult::Saved => panic!("running box must acknowledge the SSH configuration"),
    }
}

struct ExpectedHostKey(
    String,
    Option<tokio::sync::mpsc::Sender<russh::Channel<russh::client::Msg>>>,
);

struct FailureLogs(PathBuf);

impl Drop for FailureLogs {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        let mut paths = vec![self.0.join("shim.stderr"), self.0.join("console.log")];
        if let Ok(files) = std::fs::read_dir(self.0.join("logs")) {
            paths.extend(files.flatten().map(|file| file.path()));
        }
        for path in paths {
            if let Ok(log) = std::fs::read_to_string(&path) {
                eprintln!("{}:\n{log}", path.display());
            }
        }
    }
}

impl russh::client::Handler for ExpectedHostKey {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(key.fingerprint(HashAlg::Sha256).to_string() == self.0)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _: &str,
        _: u32,
        _: &str,
        _: u32,
        reply: russh::client::ChannelOpenHandle,
        _: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        self.1
            .as_ref()
            .expect("forward receiver")
            .send(channel)
            .await
            .unwrap();
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _: &str,
        reply: russh::client::ChannelOpenHandle,
        _: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        self.1
            .as_ref()
            .expect("forward receiver")
            .send(channel)
            .await
            .unwrap();
        Ok(())
    }
}

async fn connect(status: &SshStatus) -> russh::client::Handle<ExpectedHostKey> {
    connect_forwarding(status, None).await
}

fn unix_status(status: &SshStatus) -> SshStatus {
    assert!(status.socket_path.is_some());
    SshStatus {
        tcp_listen_address: None,
        ..status.clone()
    }
}

type SshTransport = tokio_util::either::Either<tokio::net::TcpStream, tokio::net::UnixStream>;

async fn connect_transport(status: &SshStatus) -> SshTransport {
    match status.tcp_listen_address.as_ref() {
        Some(address) => {
            tokio_util::either::Either::Left(tokio::net::TcpStream::connect(address).await.unwrap())
        }
        None => {
            let path = status.socket_path.as_ref().unwrap();
            tokio_util::either::Either::Right(tokio::net::UnixStream::connect(path).await.unwrap())
        }
    }
}

async fn incomplete_handshake(status: &SshStatus) -> SshTransport {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut stream = connect_transport(status).await;
        let mut identification = Vec::new();
        // The banner proves acceptance by the guest; withhold our identification.
        loop {
            let byte = stream.read_u8().await.unwrap();
            identification.push(byte);
            assert!(
                identification.len() <= 255,
                "SSH identification is too long"
            );
            if byte == b'\n' {
                break;
            }
        }
        assert!(identification.starts_with(b"SSH-"));
        stream
    })
    .await
    .expect("guest SSH identification timed out")
}

async fn assert_transport_closed(mut stream: SshTransport) {
    let result = tokio::time::timeout(Duration::from_secs(10), stream.read_u8())
        .await
        .expect("unfinished SSH handshake must close after update or disable");
    let error = result.expect_err("unfinished handshake unexpectedly received more data");
    assert!(
        matches!(
            error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
        ),
        "unexpected transport read failure: {error}"
    );
}

async fn connect_forwarding(
    status: &SshStatus,
    forwarded: Option<tokio::sync::mpsc::Sender<russh::Channel<russh::client::Msg>>>,
) -> russh::client::Handle<ExpectedHostKey> {
    let connection = connect_transport(status).await;
    tokio::time::timeout(
        Duration::from_secs(10),
        russh::client::connect_stream(
            Arc::new(russh::client::Config::default()),
            connection,
            ExpectedHostKey(status.host_key_fingerprint.clone(), forwarded),
        ),
    )
    .await
    .unwrap_or_else(|error| panic!("SSH handshake timed out: {error}; {status:?}"))
    .unwrap()
}

async fn assert_disconnected(client: russh::client::Handle<ExpectedHostKey>) {
    // Handle's Future resolves when its connection task exits, regardless of
    // whether the peer used an SSH disconnect message or closed the transport.
    let _ = tokio::time::timeout(Duration::from_secs(10), client)
        .await
        .expect("the previous SSH generation retained a connection");
}

fn certificate(ca: &PrivateKey, subject: &PrivateKey, box_id: &str) -> Certificate {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut rng = russh::keys::key::safe_rng();
    let mut builder =
        Builder::new_with_random_nonce(&mut rng, subject.public_key(), now - 60, now + 300)
            .unwrap();
    builder.valid_principal(box_id).unwrap();
    builder.extension("permit-pty", "").unwrap();
    builder.extension("permit-port-forwarding", "").unwrap();
    builder.sign(ca).unwrap()
}

async fn exec_in_container(client: &russh::client::Handle<ExpectedHostKey>) {
    let mut channel = client.channel_open_session().await.unwrap();
    channel
        .exec(
            true,
            "test -f /etc/alpine-release && printf 'ssh-container-ok'",
        )
        .await
        .unwrap();
    let (output, status) = tokio::time::timeout(Duration::from_secs(10), async {
        let mut output = Vec::new();
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => output.extend_from_slice(&data),
                russh::ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                russh::ChannelMsg::Failure => panic!("SSH exec request failed"),
                _ => {}
            }
        }
        (output, status)
    })
    .await
    .expect("SSH container command timed out");
    assert_eq!(status, Some(0));
    assert_eq!(output, b"ssh-container-ok");
}

#[tokio::test]
async fn ssh_offline_configuration_is_private_persistent_and_does_not_boot() {
    let home = PerTestBoxHome::isolated();
    let (box_id, saved) = {
        let runtime = runtime(&home);
        let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
        let ssh = litebox.ssh();
        assert!(ssh.config().await.unwrap().is_none());
        assert!(ssh.status().await.unwrap().is_none());
        assert!(matches!(
            ssh.configure(config()).await.unwrap(),
            SshApplyResult::Saved
        ));
        let first = ssh.config().await.unwrap().unwrap();
        assert!(first.host_private_key.is_some());
        let path = home.path.join("db/boxlite.db");
        let persisted: SshConfig =
            serde_json::from_str(&saved_json(&home, &litebox).unwrap()).unwrap();
        assert_eq!(fingerprint(&persisted), fingerprint(&first));
        for (path, mode) in [
            (path.clone(), 0o600),
            (path.parent().unwrap().into(), 0o700),
            (path.with_file_name("boxlite.db-wal"), 0o600),
            (path.with_file_name("boxlite.db-shm"), 0o600),
        ] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
        assert!(
            !home
                .path
                .join("boxes")
                .join(litebox.id().as_str())
                .join("ssh")
                .exists()
        );

        let mut disabled = config();
        disabled.enabled = false;
        disabled.tcp_listen_address = None;
        assert!(matches!(
            ssh.configure(disabled).await.unwrap(),
            SshApplyResult::Saved
        ));
        let saved = ssh.config().await.unwrap().unwrap();
        assert_eq!(fingerprint(&saved), fingerprint(&first));
        assert!(!saved.enabled);
        assert_eq!(saved.tcp_listen_address, None);
        assert!(ssh.status().await.unwrap().is_none());
        let info = litebox.info().await.unwrap();
        assert_eq!(info.status, BoxStatus::Configured);
        assert!(info.pid.is_none());
        let box_id = litebox.id().to_string();
        runtime
            .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
            .await
            .unwrap();
        (box_id, saved)
    };

    let reopened = runtime(&home);
    let litebox = reopened.get(&box_id).await.unwrap().unwrap();
    let restored = litebox.ssh().config().await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(saved).unwrap()
    );
    assert!(litebox.ssh().status().await.unwrap().is_none());
    assert!(litebox.info().await.unwrap().pid.is_none());
    reopened.remove(&box_id, false).await.unwrap();
    reopened
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_offline_invalid_configuration_and_write_failure_preserve_saved_state() {
    let home = PerTestBoxHome::isolated();
    let runtime = runtime(&home);
    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    let ssh = litebox.ssh();
    let mut invalid = config();
    invalid.host_private_key = Some("invalid private key".into());
    assert!(ssh.configure(invalid).await.is_err());
    assert!(saved_json(&home, &litebox).is_none());
    ssh.configure(config()).await.unwrap();
    let original = saved_json(&home, &litebox).unwrap();
    let mut invalid = config();
    invalid.auth = SshAuth::Keys {
        ca_public_keys: vec![],
        public_keys: vec![],
    };
    assert!(ssh.configure(invalid).await.is_err());
    assert_eq!(saved_json(&home, &litebox).unwrap(), original);

    reject_ssh_writes(&home);
    let mut replacement = config();
    replacement.host_private_key = Some(
        private_key()
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string(),
    );
    assert!(ssh.configure(replacement).await.is_err());
    allow_ssh_writes(&home);
    assert_eq!(saved_json(&home, &litebox).unwrap(), original);
    assert!(ssh.status().await.unwrap().is_none());
    assert_eq!(litebox.info().await.unwrap().status, BoxStatus::Configured);
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_startup_and_updates_share_coordination_across_box_handles() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    let ssh = litebox.ssh();
    let mut latest = config();
    latest.tcp_listen_address = None;
    let (started, configured) = tokio::join!(litebox.start(), ssh.configure(latest));
    started.unwrap();
    configured.unwrap();
    let initial = ssh.status().await.unwrap().unwrap();
    assert!(initial.enabled);
    assert_eq!(initial.tcp_listen_address, None);
    let original_fingerprint = initial.host_key_fingerprint.clone();
    let mut client = connect(&initial).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    exec_in_container(&client).await;
    litebox.stop().await.unwrap();
    assert_disconnected(client).await;
    assert!(ssh.status().await.unwrap().is_none());

    assert!(matches!(
        ssh.configure(config()).await.unwrap(),
        SshApplyResult::Saved
    ));
    let mut edited = ssh.config().await.unwrap().unwrap();
    edited.tcp_listen_address = None;
    ssh.configure(edited).await.unwrap();
    let current = runtime.get(litebox.id().as_str()).await.unwrap().unwrap();
    current.start().await.unwrap_or_else(|error| {
        let box_home = home.path.join("boxes").join(current.id().as_str());
        let stderr = std::fs::read_to_string(box_home.join("shim.stderr")).unwrap_or_default();
        let mut logs = String::new();
        if let Ok(files) = std::fs::read_dir(box_home.join("logs")) {
            for file in files.flatten() {
                logs.push_str(&std::fs::read_to_string(file.path()).unwrap_or_default());
            }
        }
        panic!("restart failed: {error}\n{stderr}\n{logs}");
    });
    let restarted = ssh.status().await.unwrap().unwrap();
    assert_eq!(restarted.tcp_listen_address, None);
    assert_eq!(restarted.host_key_fingerprint, original_fingerprint);
    let mut client = connect(&restarted).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    let reconnected = runtime.get(current.id().as_str()).await.unwrap().unwrap();
    assert_eq!(
        reconnected
            .ssh()
            .status()
            .await
            .unwrap()
            .unwrap()
            .generation,
        restarted.generation
    );
    exec_in_container(&client).await;
    let mut disabled = config();
    disabled.enabled = false;
    assert!(!applied(ssh.configure(disabled).await.unwrap()).enabled);
    assert_disconnected(client).await;
    assert!(!current.ssh().status().await.unwrap().unwrap().enabled);
    current.stop().await.unwrap();
    runtime.remove(current.id().as_str(), false).await.unwrap();
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_every_runtime_update_disconnects_all_clients_and_applies_full_configuration() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    let _logs = FailureLogs(home.path.join("boxes").join(litebox.id().as_str()));
    let ssh = litebox.ssh();
    ssh.configure(config()).await.unwrap();
    litebox.start().await.unwrap();
    let box_pid = litebox.info().await.unwrap().pid;
    let user_keys = [Arc::new(private_key()), Arc::new(private_key())];
    let ca_keys = [private_key(), private_key()];
    let public_keys = user_keys
        .each_ref()
        .map(|key| key.public_key().to_openssh().unwrap());
    let ca_public_keys = ca_keys
        .each_ref()
        .map(|key| key.public_key().to_openssh().unwrap());
    let mut configs = vec![config()]; // Identical submissions also restart.
    let mut next = config();
    next.tcp_listen_address = None;
    configs.push(next.clone());
    next.tcp_listen_address = config().tcp_listen_address;
    configs.push(next.clone());
    next.host_private_key = Some(
        private_key()
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string(),
    );
    configs.push(next.clone());
    next.host_private_key = None;
    for public in &public_keys {
        next.auth = SshAuth::Keys {
            ca_public_keys: vec![],
            public_keys: vec![public.clone()],
        };
        configs.push(next.clone());
    }
    for ca in &ca_public_keys {
        next.auth = SshAuth::Keys {
            ca_public_keys: vec![ca.clone()],
            public_keys: vec![],
        };
        configs.push(next.clone());
    }
    next.auth = SshAuth::Keys {
        ca_public_keys: vec![ca_public_keys[1].clone()],
        public_keys: vec![public_keys[1].clone()],
    };
    configs.push(next.clone());
    next.auth = SshAuth::NoAuth;
    configs.push(next.clone());
    next.enabled = false;
    configs.push(next.clone());
    next.enabled = true;
    configs.push(next);

    let initial = ssh.status().await.unwrap().unwrap();
    let mut last_generation = initial.generation;
    let mut authenticated = connect(&initial).await;
    assert!(
        authenticated
            .authenticate_none("root")
            .await
            .unwrap()
            .success()
    );
    let mut clients = Some((
        authenticated,
        connect(&initial).await,
        incomplete_handshake(&initial).await,
    ));
    let mut direct = connect(&unix_status(&initial)).await;
    assert!(direct.authenticate_none("root").await.unwrap().success());
    let mut direct_clients = Some((
        direct,
        connect(&unix_status(&initial)).await,
        incomplete_handshake(&unix_status(&initial)).await,
    ));
    for requested in configs {
        let status = applied(ssh.configure(requested.clone()).await.unwrap());
        if let Some((authenticated, unauthenticated, unfinished)) = clients.take() {
            tokio::join!(
                assert_disconnected(authenticated),
                assert_disconnected(unauthenticated),
                assert_transport_closed(unfinished)
            );
        }
        if let Some((direct, unauthenticated, unfinished)) = direct_clients.take() {
            tokio::join!(
                assert_disconnected(direct),
                assert_disconnected(unauthenticated),
                assert_transport_closed(unfinished)
            );
        }
        assert_eq!(status.enabled, requested.enabled);
        assert_eq!(litebox.info().await.unwrap().pid, box_pid);
        assert_eq!(litebox.info().await.unwrap().status, BoxStatus::Running);
        let saved = ssh.config().await.unwrap().unwrap();
        assert_eq!(saved.tcp_listen_address, requested.tcp_listen_address);
        assert_eq!(saved.enabled, requested.enabled);
        assert_eq!(
            serde_json::to_value(&saved.auth).unwrap(),
            serde_json::to_value(&requested.auth).unwrap()
        );
        if !status.enabled {
            continue;
        }
        assert!(status.generation > last_generation);
        match (&status.tcp_listen_address, &requested.tcp_listen_address) {
            (Some(actual), Some(requested)) => {
                assert_eq!(actual.ip(), requested.ip());
                assert_ne!(actual.port(), 0);
            }
            (actual, requested) => assert_eq!(actual, requested),
        }
        assert_eq!(status.host_key_fingerprint, fingerprint(&saved));
        if requested.host_private_key.is_some() {
            assert_eq!(status.host_key_fingerprint, fingerprint(&requested));
        }
        let mut direct = connect(&unix_status(&status)).await;
        let mut client = connect(&status).await;
        match requested.auth {
            SshAuth::NoAuth => {
                assert!(client.authenticate_none("root").await.unwrap().success());
                assert!(direct.authenticate_none("root").await.unwrap().success());
            }
            SshAuth::Keys {
                ca_public_keys: trusted_cas,
                public_keys: trusted_users,
            } => {
                assert!(!client.authenticate_none("root").await.unwrap().success());
                if !trusted_users.is_empty() {
                    for (index, key) in user_keys.iter().enumerate() {
                        if !trusted_users.contains(&public_keys[index]) {
                            assert!(
                                !client
                                    .authenticate_publickey(
                                        "root",
                                        PrivateKeyWithHashAlg::new(key.clone(), None)
                                    )
                                    .await
                                    .unwrap()
                                    .success()
                            );
                        }
                    }
                    let index = public_keys
                        .iter()
                        .position(|key| trusted_users.contains(key))
                        .unwrap();
                    assert!(
                        client
                            .authenticate_publickey(
                                "root",
                                PrivateKeyWithHashAlg::new(user_keys[index].clone(), None)
                            )
                            .await
                            .unwrap()
                            .success()
                    );
                } else {
                    for (index, ca) in ca_keys.iter().enumerate() {
                        if !trusted_cas.contains(&ca_public_keys[index]) {
                            assert!(
                                !client
                                    .authenticate_openssh_cert(
                                        "root",
                                        user_keys[0].clone(),
                                        certificate(ca, &user_keys[0], litebox.id().as_str())
                                    )
                                    .await
                                    .unwrap()
                                    .success()
                            );
                        }
                    }
                    let index = ca_public_keys
                        .iter()
                        .position(|key| trusted_cas.contains(key))
                        .unwrap();
                    assert!(
                        client
                            .authenticate_openssh_cert(
                                "root",
                                user_keys[0].clone(),
                                certificate(&ca_keys[index], &user_keys[0], litebox.id().as_str())
                            )
                            .await
                            .unwrap()
                            .success()
                    );
                }
                if let Some(index) = public_keys
                    .iter()
                    .position(|key| trusted_users.contains(key))
                {
                    assert!(
                        direct
                            .authenticate_publickey(
                                "root",
                                PrivateKeyWithHashAlg::new(user_keys[index].clone(), None)
                            )
                            .await
                            .unwrap()
                            .success()
                    );
                } else {
                    let index = ca_public_keys
                        .iter()
                        .position(|key| trusted_cas.contains(key))
                        .unwrap();
                    assert!(
                        direct
                            .authenticate_openssh_cert(
                                "root",
                                user_keys[0].clone(),
                                certificate(&ca_keys[index], &user_keys[0], litebox.id().as_str())
                            )
                            .await
                            .unwrap()
                            .success()
                    );
                }
                if !trusted_cas.is_empty() && !trusted_users.is_empty() {
                    let mut certificate_client = connect(&status).await;
                    assert!(
                        certificate_client
                            .authenticate_openssh_cert(
                                "root",
                                user_keys[0].clone(),
                                certificate(&ca_keys[1], &user_keys[0], litebox.id().as_str())
                            )
                            .await
                            .unwrap()
                            .success()
                    );
                    exec_in_container(&certificate_client).await;
                    certificate_client
                        .disconnect(russh::Disconnect::ByApplication, "test complete", "")
                        .await
                        .unwrap();
                    assert_disconnected(certificate_client).await;
                }
            }
        }
        exec_in_container(&client).await;
        exec_in_container(&direct).await;
        direct_clients = Some((
            direct,
            connect(&unix_status(&status)).await,
            incomplete_handshake(&unix_status(&status)).await,
        ));
        clients = Some((
            client,
            connect(&status).await,
            incomplete_handshake(&status).await,
        ));
        last_generation = status.generation;
    }
    litebox.stop().await.unwrap();
    if let Some((direct, unauthenticated, unfinished)) = direct_clients {
        tokio::join!(
            assert_disconnected(direct),
            assert_disconnected(unauthenticated),
            assert_transport_closed(unfinished)
        );
    }
    if let Some((authenticated, unauthenticated, unfinished)) = clients {
        tokio::join!(
            assert_disconnected(authenticated),
            assert_disconnected(unauthenticated),
            assert_transport_closed(unfinished)
        );
    }
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_invalid_runtime_update_preserves_database_and_existing_connections() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    let ssh = litebox.ssh();
    ssh.configure(config()).await.unwrap();
    litebox.start().await.unwrap();
    let initial = ssh.status().await.unwrap().unwrap();
    let mut client = connect(&initial).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    let original = saved_json(&home, &litebox).unwrap();
    let mut invalid = config();
    invalid.auth = SshAuth::Keys {
        ca_public_keys: vec![],
        public_keys: vec![],
    };
    assert!(ssh.configure(invalid).await.is_err());
    assert_eq!(saved_json(&home, &litebox).unwrap(), original);
    assert_eq!(
        ssh.status().await.unwrap().unwrap().generation,
        initial.generation
    );
    exec_in_container(&client).await;

    reject_ssh_writes(&home);
    assert!(ssh.configure(config()).await.is_err());
    allow_ssh_writes(&home);
    assert_eq!(saved_json(&home, &litebox).unwrap(), original);
    assert_eq!(
        ssh.status().await.unwrap().unwrap().generation,
        initial.generation
    );
    exec_in_container(&client).await;
    litebox.stop().await.unwrap();
    assert_disconnected(client).await;
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_failed_listener_bind_retains_saved_configuration_and_can_be_retried() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    let ssh = litebox.ssh();
    ssh.configure(config()).await.unwrap();
    litebox.start().await.unwrap();
    let initial = ssh.status().await.unwrap().unwrap();
    let mut client = connect(&initial).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    let mut unavailable = config();
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    unavailable.tcp_listen_address = Some(occupied.local_addr().unwrap());
    unavailable.host_private_key = Some(
        private_key()
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string(),
    );
    let error = ssh.configure(unavailable.clone()).await.unwrap_err();
    assert!(error.to_string().contains("saved"), "{error}");
    assert_disconnected(client).await;
    let saved = ssh.config().await.unwrap().unwrap();
    assert_eq!(saved.tcp_listen_address, unavailable.tcp_listen_address);
    assert_eq!(fingerprint(&saved), fingerprint(&unavailable));
    assert_ne!(fingerprint(&saved), initial.host_key_fingerprint);
    assert!(!ssh.status().await.unwrap().unwrap().enabled);
    assert_eq!(litebox.info().await.unwrap().status, BoxStatus::Running);

    let retried = applied(ssh.configure(config()).await.unwrap());
    assert!(retried.enabled);
    assert_eq!(retried.host_key_fingerprint, fingerprint(&saved));
    let mut client = connect(&retried).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    exec_in_container(&client).await;
    litebox.stop().await.unwrap();
    assert_disconnected(client).await;
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_clone_and_import_exclude_all_configuration_and_host_keys() {
    use boxlite::{CloneOptions, ExportOptions};

    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let explicit_key = private_key()
        .to_openssh(LineEnding::LF)
        .unwrap()
        .to_string();
    let export_dir = tempfile::tempdir().unwrap();
    for supplied in [None, Some(explicit_key)] {
        let source = runtime.create(common::alpine_opts(), None).await.unwrap();
        let mut requested = config();
        requested.host_private_key = supplied;
        source.ssh().configure(requested).await.unwrap();
        source.start().await.unwrap();
        assert!(source.ssh().status().await.unwrap().unwrap().enabled);
        let cloned = source
            .clone_box(CloneOptions::default(), None)
            .await
            .unwrap();
        source.stop().await.unwrap();
        let archive = source
            .export(ExportOptions::default(), export_dir.path())
            .await
            .unwrap();
        let imported = runtime.import_box(archive, None).await.unwrap();
        for derived in [cloned, imported] {
            assert!(derived.ssh().config().await.unwrap().is_none());
            assert!(saved_json(&home, &derived).is_none());
            derived.start().await.unwrap();
            assert!(!derived.ssh().status().await.unwrap().unwrap().enabled);
            assert!(derived.ssh().config().await.unwrap().is_none());
            derived.stop().await.unwrap();
            runtime.remove(derived.id().as_str(), false).await.unwrap();
        }
        runtime.remove(source.id().as_str(), false).await.unwrap();
    }
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
async fn ssh_tcp_and_unix_exec_pty_sftp_work_without_guest_network() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let mut options = common::alpine_opts();
    options.network = boxlite::NetworkSpec::Disabled;
    let litebox = runtime.create(options, None).await.unwrap();
    litebox.start().await.unwrap();
    for address in [config().tcp_listen_address, None] {
        let mut requested = config();
        requested.tcp_listen_address = address;
        let status = applied(litebox.ssh().configure(requested).await.unwrap());
        let mut client = connect(&status).await;
        assert!(client.authenticate_none("root").await.unwrap().success());
        exec_in_container(&client).await;
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut channel = client.channel_open_session().await.unwrap();
            channel.exec(true, "cat").await.unwrap();
            let request = vec![0x53; 512 * 1024];
            channel.data(&request[..]).await.unwrap();
            channel.eof().await.unwrap();
            let mut reply = Vec::new();
            let mut exit = None;
            while let Some(message) = channel.wait().await {
                match message {
                    russh::ChannelMsg::Data { data } => reply.extend_from_slice(&data),
                    russh::ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                    russh::ChannelMsg::Failure => panic!("half-close exec failed"),
                    _ => {}
                }
            }
            assert_eq!(reply, request);
            assert_eq!(exit, Some(0));
        })
        .await
        .expect("SSH response after channel EOF timed out");
        let mut pty = client.channel_open_session().await.unwrap();
        pty.request_pty(true, "xterm", 80, 24, 0, 0, &[])
            .await
            .unwrap();
        pty.exec(true, "test -t 0 && test -t 1 && printf 'pty-ok'")
            .await
            .unwrap();
        let mut bytes = Vec::new();
        let mut exit = None;
        while let Some(message) = pty.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => bytes.extend_from_slice(&data),
                russh::ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                russh::ChannelMsg::Failure => panic!("PTY request failed"),
                _ => {}
            }
        }
        assert_eq!(exit, Some(0));
        assert_eq!(bytes, b"pty-ok");
        let channel = client.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .unwrap();
        let mut file = sftp.create("/tmp/ssh-vsock.txt").await.unwrap();
        file.write_all(b"sftp over vsock").await.unwrap();
        file.shutdown().await.unwrap();
        let mut file = sftp.open("/tmp/ssh-vsock.txt").await.unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).await.unwrap();
        assert_eq!(contents, "sftp over vsock");
        file.shutdown().await.unwrap();
        sftp.remove_file("/tmp/ssh-vsock.txt").await.unwrap();
        sftp.close().await.unwrap();
        client
            .disconnect(russh::Disconnect::ByApplication, "test complete", "")
            .await
            .unwrap();
    }
    // The isolated workload shares the guest network namespace. No TCP listener
    // exists there, even while host TCP SSH remains available through vsock.
    let execution = litebox.exec(boxlite::BoxCommand::new("sh").args(["-c",
        "! awk 'NR > 1 && $4 == \"0A\" { found=1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6"])).await.unwrap();
    assert_eq!(execution.wait().await.unwrap().exit_code, 0);
    litebox.stop().await.unwrap();
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn ssh_host_ip_permission_rejects_tcp_but_unix_works_in_sandbox() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let mut options = common::alpine_opts();
    options.network = boxlite::NetworkSpec::Disabled;
    options.advanced.security.network_enabled = false;
    let litebox = runtime.create(options, None).await.unwrap();
    assert!(
        litebox
            .ssh()
            .configure(config())
            .await
            .unwrap_err()
            .to_string()
            .contains("security.network_enabled")
    );
    let mut requested = config();
    requested.tcp_listen_address = None;
    litebox.ssh().configure(requested).await.unwrap();
    litebox.start().await.unwrap_or_else(|error| {
        let box_home = home.path.join("boxes").join(litebox.id().as_str());
        let stderr = std::fs::read_to_string(box_home.join("shim.stderr")).unwrap_or_default();
        let mut logs = String::new();
        if let Ok(files) = std::fs::read_dir(box_home.join("logs")) {
            for file in files.flatten() {
                logs.push_str(&std::fs::read_to_string(file.path()).unwrap_or_default());
            }
        }
        panic!("sandbox start failed: {error}\n{stderr}\n{logs}");
    });
    let status = litebox.ssh().status().await.unwrap().unwrap();
    let mut client = connect(&status).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    exec_in_container(&client).await;
    litebox.stop().await.unwrap();
    // The libkrun bridge follows VM process cleanup; verify SSH session teardown.
    assert_disconnected(client).await;
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
}

#[tokio::test]
#[ignore = "subprocess helper invoked by ssh_detached_listener_survives_runtime_process_exit"]
async fn ssh_detached_runtime_subprocess() {
    let home = std::env::var("BOXLITE_SSH_DETACH_TEST_HOME")
        .expect("parent must provide the detached test home");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.clone().into(),
        image_registries: common::test_registries(),
    })
    .unwrap();
    let mut options = common::alpine_opts();
    options.detach = true;
    options.network = boxlite::NetworkSpec::Disabled;
    let litebox = runtime.create(options, None).await.unwrap();
    litebox.ssh().configure(config()).await.unwrap();
    litebox.start().await.unwrap();
    let status = litebox.ssh().status().await.unwrap().unwrap();
    std::fs::write(
        PathBuf::from(home).join("detached.json"),
        serde_json::to_vec(&(litebox.id().as_str(), status)).unwrap(),
    )
    .unwrap();
    // Both the Rust runtime and this test process exit, leaving only the shim.
}

#[tokio::test]
async fn ssh_detached_listener_survives_runtime_process_exit() {
    let home = PerTestBoxHome::new();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "ssh_detached_runtime_subprocess",
            "--ignored",
            "--nocapture",
        ])
        .env("BOXLITE_SSH_DETACH_TEST_HOME", &home.path)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "detached setup failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let (id, status): (String, SshStatus) =
        serde_json::from_slice(&std::fs::read(home.path.join("detached.json")).unwrap()).unwrap();
    let reopened = runtime(&home);
    let litebox = reopened.get(&id).await.unwrap().unwrap();
    assert_eq!(
        litebox
            .ssh()
            .status()
            .await
            .unwrap()
            .unwrap()
            .tcp_listen_address,
        status.tcp_listen_address
    );
    let mut client = connect(&status).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    exec_in_container(&client).await;
    let mut direct = connect(&unix_status(&status)).await;
    assert!(direct.authenticate_none("root").await.unwrap().success());
    exec_in_container(&direct).await;
    litebox.stop().await.unwrap();
    tokio::join!(assert_disconnected(client), assert_disconnected(direct));
    reopened.remove(&id, false).await.unwrap();
}

#[tokio::test]
async fn ssh_wire_authentication_timeout_and_password_rejection() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    let mut requested = config();
    requested.auth = SshAuth::Keys {
        ca_public_keys: vec![],
        public_keys: vec![private_key().public_key().to_openssh().unwrap()],
    };
    litebox.ssh().configure(requested).await.unwrap();
    litebox.start().await.unwrap();
    let status = litebox.ssh().status().await.unwrap().unwrap();
    let mut client = connect(&status).await;
    assert!(
        !client
            .authenticate_password("root", "wrong-password")
            .await
            .unwrap()
            .success()
    );
    let start = std::time::Instant::now();
    let idle = connect(&status).await;
    let _ = tokio::time::timeout(Duration::from_secs(35), idle)
        .await
        .expect("unauthenticated SSH session survived authentication deadline");
    assert!(
        start.elapsed() >= Duration::from_secs(29),
        "session closed before authentication timeout"
    );
    litebox.stop().await.unwrap();
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
}

#[tokio::test]
async fn ssh_wire_tcp_streamlocal_forwarding_and_resource_limits() {
    let home = PerTestBoxHome::new();
    let runtime = runtime(&home);
    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    litebox.ssh().configure(config()).await.unwrap();
    litebox.start().await.unwrap();
    let status = litebox.ssh().status().await.unwrap().unwrap();
    let (forwarded, mut incoming) = tokio::sync::mpsc::channel(1);
    let mut client = connect_forwarding(&status, Some(forwarded)).await;
    assert!(client.authenticate_none("root").await.unwrap().success());
    let port = client.tcpip_forward("127.0.0.1", 0).await.unwrap();
    let path = "/tmp/ssh-wire-forward.sock";
    client.streamlocal_forward(path).await.unwrap();
    for unix in [false, true] {
        let channel = if unix {
            client.channel_open_direct_streamlocal(path).await.unwrap()
        } else {
            client
                .channel_open_direct_tcpip("127.0.0.1", port, "127.0.0.1", 12345)
                .await
                .unwrap()
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut direct = channel.into_stream();
            let mut reverse = incoming.recv().await.unwrap().into_stream();
            let request = async {
                direct.write_all(b"forward request").await.unwrap();
                direct.shutdown().await.unwrap();
                let mut reply = Vec::new();
                direct.read_to_end(&mut reply).await.unwrap();
                assert_eq!(reply, b"forward response");
            };
            let response = async {
                let mut request = Vec::new();
                reverse.read_to_end(&mut request).await.unwrap();
                assert_eq!(request, b"forward request");
                reverse.write_all(b"forward response").await.unwrap();
                reverse.shutdown().await.unwrap();
            };
            tokio::join!(request, response);
        })
        .await
        .expect("forwarding did not preserve bidirectional half-close");
    }
    client
        .cancel_tcpip_forward("127.0.0.1", port)
        .await
        .unwrap();
    client.cancel_streamlocal_forward(path).await.unwrap();
    // Use a fresh connection so closed forwarding channels cannot affect the cap.
    let mut limited = connect(&status).await;
    assert!(limited.authenticate_none("root").await.unwrap().success());
    let mut channels = Vec::new();
    for _ in 0..16 {
        channels.push(limited.channel_open_session().await.unwrap());
    }
    assert!(
        limited.channel_open_session().await.is_err(),
        "session channel limit was not enforced"
    );
    let mut ports = Vec::new();
    for _ in 0..16 {
        ports.push(limited.tcpip_forward("127.0.0.1", 0).await.unwrap());
    }
    assert!(
        limited.tcpip_forward("127.0.0.1", 0).await.is_err(),
        "reverse listener limit was not enforced"
    );
    for port in ports {
        limited
            .cancel_tcpip_forward("127.0.0.1", port)
            .await
            .unwrap();
    }
    litebox.stop().await.unwrap();
    runtime.remove(litebox.id().as_str(), false).await.unwrap();
}
