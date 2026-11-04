use super::*;

/// Isolate the fixed port so this test works beside a host SSH daemon.
#[tokio::test]
async fn ssh_setup_persists_identity_and_replaces_credentials() {
    use futures::TryStreamExt;
    use nix::sched::{unshare, CloneFlags};
    use std::os::unix::fs::MetadataExt;
    unshare(CloneFlags::CLONE_NEWNET).unwrap();
    let (connection, handle, _) = rtnetlink::new_connection().unwrap();
    let netlink = tokio::spawn(connection);
    let link = handle
        .link()
        .get()
        .match_name("lo".into())
        .execute()
        .try_next()
        .await
        .unwrap()
        .unwrap();
    handle
        .link()
        .set(link.header.index)
        .up()
        .execute()
        .await
        .unwrap();

    let mut fixture = TestGuest::new().await;
    let user = private_key();
    let key = user.public_key().to_openssh().unwrap();
    let request = || boxlite_shared::SshSetupRequest {
        client_public_key: key.clone(),
    };
    assert_eq!(
        fixture.ssh.setup(request()).await.unwrap_err().code(),
        tonic::Code::FailedPrecondition
    );
    fixture.init().await;
    let mut other = fixture.ssh.clone();
    let (a, b) = tokio::join!(fixture.ssh.setup(request()), other.setup(request()));
    let a = a.unwrap().into_inner().status.unwrap();
    let b = b.unwrap().into_inner().status.unwrap();
    assert_eq!(a.host_key_fingerprint, b.host_key_fingerprint);
    let first = fixture.status().await;
    assert!(first.enabled);
    assert_eq!(first.listen_address, "0.0.0.0:22");
    let saved = persistence::load(fixture._root.path()).unwrap();
    assert!(saved.enable);
    let saved = saved.config.unwrap();
    assert_eq!(saved.accounts.len(), 1);
    assert_eq!(saved.accounts[0].login, "box");
    assert_eq!(
        saved.accounts[0].authorized_keys.as_slice(),
        std::slice::from_ref(&key)
    );
    assert!(saved.accounts[0].ca.is_none());
    let host = PrivateKey::from_openssh(&saved.host_private_key).unwrap();
    assert_eq!(host.algorithm(), Algorithm::Ed25519);
    assert_eq!(
        host.public_key().fingerprint(HashAlg::Sha256).to_string(),
        first.host_key_fingerprint
    );
    let path = fixture._root.path().join("etc/boxlite/ssh.cfg");
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);

    for (login, accepted) in [("root", false), ("box", true)] {
        let mut client = connect("127.0.0.1:22".parse().unwrap(), &host).await;
        assert_eq!(
            client
                .authenticate_publickey(
                    login,
                    PrivateKeyWithHashAlg::new(Arc::new(user.clone()), None)
                )
                .await
                .unwrap()
                .success(),
            accepted
        );
    }
    let before = std::fs::read(&path).unwrap();
    let cert = certificate(&private_key(), &user, "box", false, true)
        .to_openssh()
        .unwrap();
    for invalid in [
        String::new(),
        "not a key".into(),
        format!("{key}\n{key}"),
        cert,
    ] {
        let error = fixture
            .ssh
            .setup(boxlite_shared::SshSetupRequest {
                client_public_key: invalid,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::InvalidArgument);
        assert_eq!(fixture.status().await, first);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    let replacement = private_key();
    let new_key = replacement.public_key().to_openssh().unwrap();
    fixture
        .ssh
        .setup(boxlite_shared::SshSetupRequest {
            client_public_key: new_key,
        })
        .await
        .unwrap();
    for (client_key, accepted) in [(user, false), (replacement, true)] {
        let mut client = connect("127.0.0.1:22".parse().unwrap(), &host).await;
        assert_eq!(
            client
                .authenticate_publickey(
                    "box",
                    PrivateKeyWithHashAlg::new(Arc::new(client_key), None)
                )
                .await
                .unwrap()
                .success(),
            accepted
        );
    }
    fixture
        .ssh
        .control(SshControlRequest {
            enable: Some(false),
            config: None,
        })
        .await
        .unwrap();
    let enabled = fixture
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
    assert_eq!(enabled.host_key_fingerprint, first.host_key_fingerprint);

    // A new manager restores the generated identity from the actual saved file.
    fixture.guest.ssh_manager.shutdown().await.unwrap();
    let restored = Arc::new(GuestServer::new(GuestLayout::with_base(
        fixture._root.path(),
    )));
    restored.ssh_manager.attach_guest(&restored);
    restored
        .ssh_manager
        .restore(fixture._root.path().into())
        .await
        .unwrap();
    assert_eq!(
        restored.ssh_manager.status().await.host_key_fingerprint,
        first.host_key_fingerprint
    );
    restored.ssh_manager.shutdown().await.unwrap();

    let explicit = fixture
        .configure(config(&private_key(), &[&private_key()], None))
        .await
        .unwrap();
    let setup = fixture
        .ssh
        .setup(request())
        .await
        .unwrap()
        .into_inner()
        .status
        .unwrap();
    assert_eq!(setup.host_key_fingerprint, explicit.host_key_fingerprint);
    assert_eq!(setup.listen_address, "0.0.0.0:22");
    std::fs::write(&path, b"corrupt saved state").unwrap();
    assert_eq!(
        fixture.ssh.setup(request()).await.unwrap_err().code(),
        tonic::Code::Internal
    );
    assert_eq!(fixture.status().await, setup);
    fixture.stop().await;
    netlink.abort();
}
