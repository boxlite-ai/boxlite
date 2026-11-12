//! Install through the private account-home boundary; execute installed proxies
//! with the actual CLI binary, never the unit-test harness executable.

use std::path::Path;

use assert_cmd::Command;
use axum::http::Method;

use super::super::install_support::install;
use crate::ssh_cloud_fixture::*;

/// Launch system OpenSSH with the installed user config; handshake failure is
/// expected because this fixture authenticates CONNECT but never speaks SSH.
fn installed_ssh(home: &Path, user_home: &Path, alias: &str) -> Command {
    let mut command = Command::new("ssh");
    isolated(&mut command, home);
    command
        .env("HOME", user_home)
        .arg("-F")
        .arg(user_home.join(".ssh/config"))
        .args(["-o", "ConnectTimeout=5", alias]);
    command
}

/// Assert the installed ProxyCommand reached the selected REST root and CONNECT
/// with the saved bearer, not that the remote SSH handshake succeeded.
fn assert_installed_proxy(cloud: &Cloud, root: &str, token: &str) {
    let state = cloud.state.lock().unwrap();
    let target = format!("{root}/boxes/-remote");
    assert_eq!(state.requests.len(), 3, "lookup, SSH status, tunnel");
    assert!(
        state.requests.iter().all(|(_, path, auth)| {
            path.starts_with(&format!("{root}/boxes/")) && auth == &format!("Bearer {token}")
        }),
        "{:?}",
        state.requests
    );
    assert_eq!(
        state
            .requests
            .iter()
            .filter(|(method, path, _)| {
                method == Method::POST && path == &format!("{target}/network/tunnel?port=22")
            })
            .count(),
        1
    );
    assert_eq!(state.connects.len(), 1);
    assert!(
        state.connects[0].starts_with("CONNECT ")
            && state.connects[0]
                .to_ascii_lowercase()
                .contains(&format!("x-boxlite-authorization: bearer {token}")),
        "{}",
        state.connects[0]
    );
}

/// Managed aliases must not inherit a host-key helper from handwritten defaults.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_install_does_not_inherit_host_key_commands() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    std::fs::create_dir(user_home.path().join(".ssh")).unwrap();
    std::fs::write(
        user_home.path().join(".ssh/config"),
        "Host *\n  KnownHostsCommand /usr/bin/true\n",
    )
    .unwrap();
    install(home.path(), user_home.path(), &[]).await.unwrap();

    let output = std::process::Command::new("ssh")
        .arg("-G")
        .arg("-F")
        .arg(user_home.path().join(".ssh/config"))
        .arg("dev")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let effective = String::from_utf8(output.stdout).unwrap();
    assert!(
        !effective.lines().any(|line| {
            line.starts_with("knownhostscommand ") && line.contains("/usr/bin/true")
        }),
        "managed alias inherited a host-key command:\n{effective}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_install_keeps_excluded_identities_out_of_canonicalization_pass() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    let root = user_home.path().join(".ssh/config");
    std::fs::create_dir(root.parent().unwrap()).unwrap();
    std::fs::write(
        &root,
        "Host *\n  CanonicalizeHostname yes\nHost * !dev\n  IdentityFile /manual/personal\n  CertificateFile /manual/personal-cert\n",
    )
    .unwrap();
    install(home.path(), user_home.path(), &[]).await.unwrap();

    for (host, personal_identity_expected) in [("dev", false), ("127.0.0.1", true)] {
        let output = std::process::Command::new("ssh")
            .args(["-G", "-F"])
            .arg(&root)
            .arg(host)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let effective = String::from_utf8(output.stdout).unwrap();
        for identity in [
            "identityfile /manual/personal",
            "certificatefile /manual/personal-cert",
        ] {
            assert_eq!(
                effective.lines().any(|line| line == identity),
                personal_identity_expected,
                "{host} resolved an unexpected identity set:\n{effective}"
            );
        }
    }
}

/// Installing twice keeps keys and alias files byte-stable and never connects;
/// using the installed alias later proves proxy routing only, not SSH login.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_install_prepares_without_connecting_and_repeats_idempotently() {
    let cloud = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    install(home.path(), user_home.path(), &[]).await.unwrap();

    let directory = only_credential_directory(home.path());
    let client_key = std::fs::read(directory.join("client_key")).unwrap();
    let host_key = std::fs::read(directory.join("host_key")).unwrap();
    let known_hosts = std::fs::read(directory.join("known_hosts")).unwrap();
    let config = std::fs::read(user_home.path().join(".ssh/config")).unwrap();
    let managed = std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap();
    install(home.path(), user_home.path(), &[]).await.unwrap();
    assert_eq!(
        std::fs::read(directory.join("client_key")).unwrap(),
        client_key
    );
    assert_eq!(std::fs::read(directory.join("host_key")).unwrap(), host_key);
    assert_eq!(
        std::fs::read(directory.join("known_hosts")).unwrap(),
        known_hosts
    );
    assert_eq!(
        std::fs::read(user_home.path().join(".ssh/config")).unwrap(),
        config
    );
    assert_eq!(
        std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap(),
        managed
    );
    {
        let mut state = cloud.state.lock().unwrap();
        assert_eq!(state.configs.len(), 1);
        assert_eq!(state.generation, 1);
        assert_eq!(
            state.configs[0]["host_private_key"],
            String::from_utf8(host_key).unwrap()
        );
        assert!(state.connects.is_empty());
        assert!(
            state
                .requests
                .iter()
                .all(|(_, path, _)| !path.contains("/network/tunnel")),
            "{:?}",
            state.requests
        );
        state.requests.clear();
    }

    // This listener deliberately cannot authenticate SSH; CONNECT is the evidence.
    installed_ssh(home.path(), user_home.path(), "dev")
        .assert()
        .code(255)
        .stdout(predicates::str::is_empty());
    assert_installed_proxy(&cloud, "/v1/team", "stored-key");
    assert_eq!(cloud.state.lock().unwrap().generation, 1);
}

/// Conflicting aliases fail before guest writes; overwrite changes only the
/// selected alias while existing aliases retain their original endpoints.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_install_conflicts_before_guest_writes_and_overwrites_only_selected_alias() {
    let cloud = Cloud::start(false).await;
    let other = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let other_home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    cloud.save_context(home.path(), "cloud", "team");
    cloud.save_context(other_home.path(), "cloud", "team");
    let credentials = home.path().join("credentials.toml");
    let mut profiles: toml::Value =
        toml::from_str(&std::fs::read_to_string(&credentials).unwrap()).unwrap();
    profiles["profiles"]["other"]["url"] = toml::Value::String(other.url.clone());
    profiles["profiles"]["other"]["path_prefix"] = toml::Value::String("second".into());
    std::fs::write(&credentials, toml::to_string(&profiles).unwrap()).unwrap();
    std::fs::create_dir(user_home.path().join(".ssh")).unwrap();
    let handwritten = "Host handwritten\n  HostName 192.0.2.1\n";
    std::fs::write(user_home.path().join(".ssh/config"), handwritten).unwrap();

    for flags in [vec![], vec!["--alias", "keep"]] {
        install(home.path(), user_home.path(), &flags)
            .await
            .unwrap();
    }
    let config = std::fs::read(user_home.path().join(".ssh/config")).unwrap();
    let managed = std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap();
    let identities = credential_directories(home.path());
    for (candidate_home, flags) in [
        (home.path(), vec!["--context", "other"]),
        (other_home.path(), vec![]),
    ] {
        let error = install(candidate_home, user_home.path(), &flags)
            .await
            .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("--alias"), "{message}");
        assert!(message.contains("--overwrite"), "{message}");
        assert_eq!(
            std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap(),
            managed
        );
    }
    assert_eq!(credential_directories(home.path()), identities);
    assert!(credential_directories(other_home.path()).is_empty());
    assert_eq!(cloud.state.lock().unwrap().attempted_configs.len(), 1);
    assert!(other.state.lock().unwrap().attempted_configs.is_empty());
    assert!(
        cloud
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(method, path, _)| {
                method != Method::DELETE && !path.ends_with("/ssh/enable")
            })
    );
    assert!(cloud.state.lock().unwrap().connects.is_empty());
    assert!(other.state.lock().unwrap().connects.is_empty());

    install(
        home.path(),
        user_home.path(),
        &["--context", "other", "--alias", "alternate"],
    )
    .await
    .unwrap();
    install(
        home.path(),
        user_home.path(),
        &["--context", "other", "--alias", "dev", "--overwrite"],
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(user_home.path().join(".ssh/config")).unwrap(),
        config
    );
    assert!(
        std::fs::read_to_string(user_home.path().join(".ssh/config"))
            .unwrap()
            .ends_with(handwritten)
    );
    assert_eq!(cloud.state.lock().unwrap().configs.len(), 1);
    assert_eq!(other.state.lock().unwrap().configs.len(), 1);
    for (alias, endpoint, root) in [
        ("keep", &cloud, "/v1/team"),
        ("alternate", &other, "/v1/second"),
        ("dev", &other, "/v1/second"),
    ] {
        {
            let mut state = endpoint.state.lock().unwrap();
            state.requests.clear();
            state.connects.clear();
        }
        installed_ssh(home.path(), user_home.path(), alias)
            .assert()
            .code(255)
            .stdout(predicates::str::is_empty());
        assert_installed_proxy(endpoint, root, "stored-key");
    }
}

/// Installed proxy arguments freeze the selected routing despite later profile
/// and ambient changes; shell metacharacters must not execute.
#[rstest::rstest]
#[case::named("-cloud ' \" \\ % ; $(touch injected)")]
#[case::default_context("default")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_install_freezes_routing_and_quotes_real_proxy_arguments(#[case] context: &str) {
    let cloud = Cloud::start(false).await;
    let other = Cloud::start(false).await;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home ' \" \\ % ; $(touch injected)");
    let user_home = temp.path().join("user ' \" \\ % ; $(touch injected)");
    std::fs::create_dir(&home).unwrap();
    std::fs::create_dir(&user_home).unwrap();
    let prefix = "-team ' \" \\ % ; $(touch injected)";
    cloud.save_context(&home, context, prefix);
    let credentials = home.join("credentials.toml");
    let mut profiles: toml::Value =
        toml::from_str(&std::fs::read_to_string(&credentials).unwrap()).unwrap();
    profiles["profiles"][context]["api_key"] = toml::Value::String("selected-key".into());
    std::fs::write(&credentials, toml::to_string(&profiles).unwrap()).unwrap();
    install(&home, &user_home, &[]).await.unwrap();
    let root = {
        let mut state = cloud.state.lock().unwrap();
        assert!(state.connects.is_empty());
        assert_eq!(state.configs.len(), 1);
        let root = state
            .requests
            .iter()
            .find_map(|(_, path, _)| path.strip_suffix("/boxes/dev"))
            .expect("installation resolves the name")
            .to_owned();
        assert_ne!(root, "/v1", "nonempty prefix must be retained");
        assert!(
            state
                .requests
                .iter()
                .all(|(_, _, auth)| auth == "Bearer selected-key")
        );
        state.requests.clear();
        root
    };
    profiles["profiles"][context]["url"] = toml::Value::String(other.url.clone());
    profiles["profiles"][context]["path_prefix"] = toml::Value::String("changed".into());
    profiles["profiles"]["other"]["api_key"] = toml::Value::String("wrong-key".into());
    std::fs::write(&credentials, toml::to_string(&profiles).unwrap()).unwrap();
    std::fs::write(home.join("cli.toml"), "current_context = 'other'\n").unwrap();

    installed_ssh(&home, &user_home, "dev")
        .current_dir(temp.path())
        .env("BOXLITE_HOME", temp.path().join("wrong-home"))
        .env("BOXLITE_CONTEXT", "other")
        .env("BOXLITE_PROFILE", "other")
        .env("BOXLITE_REST_URL", &other.url)
        .env("BOXLITE_REST_PATH_PREFIX", "ambient")
        .assert()
        .code(255)
        .stdout(predicates::str::is_empty());
    assert_installed_proxy(&cloud, &root, "selected-key");
    assert!(other.state.lock().unwrap().requests.is_empty());
    assert!(other.state.lock().unwrap().connects.is_empty());
    assert!(
        !temp.path().join("injected").exists(),
        "shell injection executed"
    );
    assert_eq!(cloud.state.lock().unwrap().generation, 1);
}

/// URL-only installation needs no stored credentials; the real proxy later
/// resolves its bearer from subprocess environment while preserving an empty prefix.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_install_url_only_preserves_explicit_empty_prefix() {
    let cloud = Cloud::start(false).await;
    let other = Cloud::start(false).await;
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    // Installation itself is unauthenticated here: never mutate global test env.
    install(
        home.path(),
        user_home.path(),
        &["--url", &cloud.url, "--path-prefix="],
    )
    .await
    .unwrap();
    assert!(!home.path().join("credentials.toml").exists());
    {
        let mut state = cloud.state.lock().unwrap();
        assert_eq!(state.configs.len(), 1);
        assert!(state.connects.is_empty());
        assert!(state.requests.iter().all(|(_, path, auth)| {
            path.starts_with("/v1/boxes/") && auth.is_empty() && !path.contains("/network/tunnel")
        }));
        state.requests.clear();
    }
    other.save_context(home.path(), "other", "changed");
    installed_ssh(home.path(), user_home.path(), "dev")
        .env("BOXLITE_CONTEXT", "other")
        .env("BOXLITE_PROFILE", "other")
        .env("BOXLITE_REST_URL", &other.url)
        .env("BOXLITE_REST_PATH_PREFIX", "ambient")
        .env("BOXLITE_API_KEY", "environment-key")
        .assert()
        .code(255)
        .stdout(predicates::str::is_empty());
    assert_installed_proxy(&cloud, "/v1", "environment-key");
    assert!(other.state.lock().unwrap().requests.is_empty());
}
