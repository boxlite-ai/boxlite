//! Tests for the SSH bindings; included from `ssh.rs` via `#[path]`.

use crate::ssh::{PySshAccount, PySshCaConfig, PySshConfig, PySshStatus};

const HOST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n";
const USER_KEY: &str = "ssh-ed25519 AAAAalice user@test";

fn config() -> PySshConfig {
    PySshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: HOST_KEY.into(),
        accounts: vec![PySshAccount {
            login: "alice".into(),
            authorized_keys: vec![USER_KEY.into()],
            ca: Some(PySshCaConfig {
                public_key: "ssh-ed25519 AAAAca ca@test".into(),
                principal: "alice".into(),
            }),
        }],
    }
}

/// The Python-facing constructors must produce the same core configuration
/// a Rust caller would build field by field, nesting included.
#[test]
fn converts_nested_configuration() {
    let core = boxlite::SshConfig::from(config());
    assert_eq!(core.listen_address, "0.0.0.0:2222");
    assert_eq!(core.host_private_key, HOST_KEY);
    let account = &core.accounts[0];
    assert_eq!(account.login, "alice");
    assert_eq!(account.authorized_keys, vec![USER_KEY]);
    let ca = account.ca.as_ref().expect("ca converts");
    assert_eq!(ca.public_key, "ssh-ed25519 AAAAca ca@test");
    assert_eq!(ca.principal, "alice");
}

#[test]
fn defaults_convert_to_empty_credentials() {
    let core = boxlite::SshConfig::from(PySshConfig::new(
        "127.0.0.1:22".into(),
        HOST_KEY.into(),
        vec![],
    ));
    assert!(core.accounts.is_empty());
    let bare = boxlite::SshAccount::from(PySshAccount::new("bob".into(), vec![], None));
    assert!(bare.authorized_keys.is_empty());
    assert!(bare.ca.is_none());
}

/// Generations are full `u64`s; anything routed through a float would lose
/// precision above 2^53. Python ints are arbitrary precision, so the field
/// must stay an exact integer end to end.
#[test]
fn status_generation_keeps_bigint_precision() {
    let generation = u64::MAX - 41;
    let status = PySshStatus::from(boxlite::SshStatus {
        enabled: true,
        generation,
        listen_address: String::new(),
        host_public_key: String::new(),
        host_key_fingerprint: String::new(),
    });
    assert_eq!(status.generation, generation);
    assert!(status.__repr__().contains(&generation.to_string()));
}

#[test]
fn repr_redacts_every_credential() {
    let cfg = config();
    for repr in [
        cfg.__repr__(),
        cfg.accounts[0].__repr__(),
        cfg.accounts[0].ca.as_ref().unwrap().__repr__(),
    ] {
        assert!(!repr.contains("secret"));
        assert!(!repr.contains("AAAAalice"));
        assert!(!repr.contains("AAAAca"));
        assert!(
            repr.contains("[REDACTED]"),
            "repr must mark credentials as redacted"
        );
    }
    // Diagnostics stay useful: the non-secret fields survive redaction.
    assert!(cfg.__repr__().contains("0.0.0.0:2222"));
    assert!(cfg.accounts[0].__repr__().contains("alice"));
}
