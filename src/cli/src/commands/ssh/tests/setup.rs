use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

/// Model the guest's reported status independently of the locally held host key;
/// trailing comments are intentionally irrelevant to identity comparisons.
fn managed_status(enabled: bool, generation: u64, host: &str) -> String {
    serde_json::to_string(&SshStatus {
        enabled,
        generation,
        listen_address: "0.0.0.0:22".into(),
        host_public_key: format!("{host} ignored-comment"),
        host_key_fingerprint: "SHA256:fixture".into(),
    })
    .unwrap()
}

/// Each persisted-state branch selects exactly one write (or status-only read),
/// carrying the same locally generated host/client credentials on configure.
#[tokio::test]
async fn prepare_selects_one_service_operation_and_preserves_healthy_configuration() {
    use super::super::tests::Server;
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("ssh");
    let (config, host) = managed_config(&directory).unwrap();
    for (existed, enabled, generation, operations) in [
        (false, false, 0, vec!["POST"]),
        (true, true, 4, vec!["GET"]),
        (true, false, 4, vec!["GET", "POST"]),
        (true, false, 0, vec!["GET", "POST"]),
    ] {
        let mut replies = Vec::new();
        if existed {
            replies.push((200, managed_status(enabled, generation, &host)));
        }
        if !existed || !enabled {
            replies.push((200, managed_status(true, generation + 1, &host)));
        }
        let server = Server::start(replies).await;
        let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(&server.url)).unwrap();
        let sandbox = runtime.get("box-1").await.unwrap().unwrap();
        let result = prepare_ssh(&sandbox, config.clone(), existed, &host)
            .await
            .unwrap();
        assert!(result.enabled);
        let requests = server.requests();
        assert_eq!(
            requests
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            operations
        );
        let last_path = &requests.last().unwrap().1;
        if existed && !enabled && generation > 0 {
            assert_eq!(last_path, "/v1/boxes/box-1/ssh/enable");
            assert!(server.bodies().last().unwrap().is_empty());
        } else if !existed || !enabled {
            assert_eq!(last_path, "/v1/boxes/box-1/ssh");
            let sent: serde_json::Value =
                serde_json::from_str(server.bodies().last().unwrap()).unwrap();
            assert_eq!(sent["host_private_key"], config.host_private_key);
            assert_eq!(
                sent["accounts"][0]["authorized_keys"][0],
                config.accounts[0].authorized_keys[0]
            );
            assert_eq!(sent["accounts"][0]["login"], "box");
            assert_eq!(sent["listen_address"], "0.0.0.0:22");
            assert!(sent["accounts"][0]["ca"].is_null());
        } else {
            assert_eq!(result.generation, generation);
        }
    }
}

/// A healthy service with a different host identity must not be overwritten.
#[tokio::test]
async fn changed_host_identity_is_rejected_without_mutation() {
    use super::super::tests::Server;
    let home = tempfile::tempdir().unwrap();
    let (config, host) = managed_config(&home.path().join("ssh")).unwrap();
    let server = Server::start(vec![(200, managed_status(true, 4, "ssh-ed25519 changed"))]).await;
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(&server.url)).unwrap();
    let sandbox = runtime.get("box-1").await.unwrap().unwrap();
    let error = prepare_ssh(&sandbox, config, true, &host)
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "SSH host key does not match the CLI-managed identity for box box-1; refusing to reconfigure or connect"
    );
    assert_eq!(
        server.requests(),
        [("GET".into(), "/v1/boxes/box-1/ssh".into())]
    );
}

/// A failed first configure leaves the on-disk identity for the next invocation,
/// which may configure again but must not regenerate either key.
#[tokio::test]
async fn failed_configure_retains_keys_for_the_next_invocation() {
    use super::super::tests::Server;
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("ssh");
    let (config, host) = managed_config(&directory).unwrap();
    let server = Server::start(vec![
        (
            500,
            r#"{"error":{"message":"configure failed","type":"Error","code":"internal"}}"#.into(),
        ),
        (200, managed_status(false, 0, "")),
        (200, managed_status(true, 1, &host)),
    ])
    .await;
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(&server.url)).unwrap();
    let sandbox = runtime.get("box-1").await.unwrap().unwrap();
    let error = prepare_ssh(&sandbox, config, false, &host)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("configure failed"), "{error:#}");
    let (config, host) = managed_config(&directory).unwrap();
    prepare_ssh(&sandbox, config, true, &host).await.unwrap();
    let bodies = server.bodies();
    assert_eq!(
        bodies[0], bodies[2],
        "next invocation reuses both identities"
    );
    assert_eq!(
        server
            .requests()
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["POST", "GET", "POST"]
    );
}

/// A rejected enable propagates immediately, without retry or reconfigure.
#[tokio::test]
async fn failed_enable_is_not_retried_or_reconfigured() {
    use super::super::tests::Server;
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("ssh");
    let (config, host) = managed_config(&directory).unwrap();
    let server = Server::start(vec![
        (200, managed_status(false, 3, &host)),
        (
            409,
            r#"{"error":{"message":"enable refused","type":"Error","code":"invalid_state"}}"#
                .into(),
        ),
    ])
    .await;
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(&server.url)).unwrap();
    let sandbox = runtime.get("box-1").await.unwrap().unwrap();
    let error = prepare_ssh(&sandbox, config, true, &host)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("enable refused"), "{error:#}");
    assert_eq!(
        server.requests(),
        [
            ("GET".into(), "/v1/boxes/box-1/ssh".into()),
            ("POST".into(), "/v1/boxes/box-1/ssh/enable".into()),
        ]
    );
}

/// Existing keys remain private and stable; corrupt, incomplete, or linked
/// identities must fail instead of being silently replaced.
#[test]
fn keys_are_private_reused_and_invalid_state_is_not_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("ssh");
    let (first, _) = managed_config(&directory).unwrap();
    let (second, _) = managed_config(&directory).unwrap();
    assert_eq!(first.host_private_key, second.host_private_key);
    assert_eq!(
        first.accounts[0].authorized_keys,
        second.accounts[0].authorized_keys
    );
    assert_eq!(first.accounts[0].login, "box");
    assert_eq!(first.listen_address, "0.0.0.0:22");
    for (path, mode) in [
        (directory.clone(), 0o700),
        (directory.join("client_key"), 0o600),
        (directory.join("host_key"), 0o600),
    ] {
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, mode);
    }
    let client = directory.join("client_key");
    fs::set_permissions(&client, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(managed_config(&directory).is_err());
    fs::set_permissions(&client, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(managed_config(&directory).is_err());
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&client, "corrupt").unwrap();
    assert!(managed_config(&directory).is_err());
    assert_eq!(fs::read_to_string(&client).unwrap(), "corrupt");
    fs::remove_file(&client).unwrap();
    symlink(directory.join("host_key"), &client).unwrap();
    assert!(managed_config(&directory).is_err());
    fs::remove_file(&client).unwrap();
    assert!(managed_config(&directory).is_err());
    assert_eq!(
        fs::read_to_string(directory.join("host_key")).unwrap(),
        first.host_private_key
    );
    let linked = temp.path().join("linked");
    symlink(&directory, &linked).unwrap();
    assert!(managed_config(&linked).is_err());
}

#[test]
fn credential_directory_inspection_errors_are_not_treated_as_missing_keys() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("not-a-directory");
    fs::write(&parent, "keep").unwrap();
    let error = managed_config(&parent.join("ssh")).unwrap_err();
    assert_eq!(error.to_string(), "inspect SSH key directory");
    assert_eq!(fs::read_to_string(&parent).unwrap(), "keep");
}
