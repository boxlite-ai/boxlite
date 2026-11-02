// Legacy string fields: listen_address (1), ca_public_key (2), principal (3).
const LEGACY_SSH_CONFIGURATION: &[u8] = b"\x0a\x0e127.0.0.1:2222\x12\x08test-key\x1a\x04root";

#[test]
fn ssh_configuration_legacy_fields_decode_without_config() {
    use prost::Message;
    let decoded = super::SshConfigureRequest::decode(LEGACY_SSH_CONFIGURATION)
        .expect("legacy string fields must be ignored, not decoded as SshConfig");
    assert!(decoded.config.is_none());
}

#[test]
fn ssh_configuration_uses_wire_tag_four() {
    use prost::Message;
    let request = super::SshConfigureRequest {
        config: Some(super::SshConfig::default()),
        enable: None,
    };
    assert_eq!(request.encode_to_vec(), [0x22, 0x00]);
}

#[test]
fn ssh_enable_presence_roundtrips() {
    use prost::Message;
    for enable in [None, Some(false), Some(true)] {
        let request = super::SshConfigureRequest {
            config: None,
            enable,
        };
        let decoded =
            super::SshConfigureRequest::decode(request.encode_to_vec().as_slice()).unwrap();
        assert_eq!(decoded.enable, enable);
    }
}

#[test]
fn ssh_stored_config_json_roundtrips() {
    let config = super::SshConfig {
        listen_address: "127.0.0.1:22".into(),
        host_private_key: "private".into(),
        accounts: vec![super::SshAccount {
            login: "alice".into(),
            authorized_keys: vec!["key".into()],
            ca: Some(super::SshCaConfig {
                public_key: "ca".into(),
                principal: "alice".into(),
            }),
        }],
    };
    let encoded = serde_json::to_vec(&config).unwrap();
    assert_eq!(
        serde_json::from_slice::<super::SshConfig>(&encoded).unwrap(),
        config
    );
}

#[test]
fn ssh_configuration_global_credentials_do_not_create_an_account() {
    use prost::Message;
    // Previous SshConfig.ca (3) and authorized_keys (4) are reserved.
    let legacy = b"\x1a\x00\x22\x08test-key";
    let decoded = super::SshConfig::decode(legacy.as_slice()).unwrap();
    assert!(decoded.accounts.is_empty());
    let config = super::SshConfig {
        accounts: vec![super::SshAccount {
            login: "alice".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    assert_eq!(config.encode_to_vec(), b"\x2a\x07\x0a\x05alice");
}

#[test]
fn ssh_configuration_mixed_legacy_fields_preserve_new_config() {
    use prost::Message;
    // Field 4 contains SshConfig.listen_address (field 1).
    let current = b"\x22\x10\x0a\x0e127.0.0.1:2222";
    for wire in [
        [LEGACY_SSH_CONFIGURATION, current].concat(),
        [current.as_slice(), LEGACY_SSH_CONFIGURATION].concat(),
    ] {
        let decoded = super::SshConfigureRequest::decode(wire.as_slice())
            .expect("new configuration must decode alongside legacy fields");
        assert_eq!(
            decoded.config,
            Some(super::SshConfig {
                listen_address: "127.0.0.1:2222".into(),
                ..Default::default()
            })
        );
    }
}

#[test]
fn ssh_configuration_wire_roundtrip_redacts_credentials() {
    use prost::Message;
    let request = super::SshConfigureRequest {
        config: Some(super::SshConfig {
            listen_address: "127.0.0.1:2222".into(),
            host_private_key: "test-only-private-marker".into(),
            accounts: vec![super::SshAccount {
                login: "alice".into(),
                authorized_keys: vec!["test-public-body test-public-comment".into()],
                ca: Some(super::SshCaConfig {
                    public_key: "test-ca-body test-ca-comment".into(),
                    principal: "box_123".into(),
                }),
            }],
        }),
        enable: None,
    };
    let decoded = super::SshConfigureRequest::decode(request.encode_to_vec().as_slice()).unwrap();
    assert_eq!(request, decoded);
    let config = decoded.config.as_ref().unwrap();
    let account = &config.accounts[0];
    let ca = account.ca.as_ref().unwrap();
    for debug in [
        format!("{decoded:?}"),
        format!("{config:?}"),
        format!("{account:?}"),
        format!("{ca:?}"),
        format!("{decoded:#?}"),
    ] {
        for marker in [
            "test-only-private-marker",
            "test-public-body",
            "test-public-comment",
            "test-ca-body",
            "test-ca-comment",
        ] {
            assert!(!debug.contains(marker), "Debug exposed {marker}");
        }
    }
}

/// A missing commit is only legitimate when there is no tracked checkout to
/// read — the condition `build.rs` gates on.
///
/// The skip is decided by asking git directly rather than by inspecting
/// [`GIT_COMMIT`]: a test that skips itself whenever the value is absent
/// would go quiet precisely when the build script has stopped stamping, and
/// every consumer would silently degrade to "no commit".
#[test]
fn commit_is_stamped_when_built_from_a_tracked_checkout() {
    // Both probes, because `build.rs` needs both to succeed: an unborn
    // branch has a tracked manifest but no commit to name, and skipping
    // there is correct rather than a regression.
    let stampable = [
        ["ls-files", "--error-unmatch", "Cargo.toml"],
        ["rev-parse", "--short", "HEAD"],
    ]
    .iter()
    .all(|args| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .is_ok_and(|probe| probe.status.success())
    });
    if !stampable {
        return;
    }

    assert!(
        super::GIT_COMMIT.is_some(),
        "build.rs must stamp BOXLITE_GIT_COMMIT when built from a tracked checkout"
    );
}
