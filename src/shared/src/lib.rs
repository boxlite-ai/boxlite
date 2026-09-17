//! BoxLite Core - Shared code for host and guest
//!
//! This crate contains common types, protocols, and utilities
//! used by both the host-side runtime (boxlite) and guest agent.

/// Short git commit of the checkout this build came from.
///
/// `None` when the build script found no git checkout to read (published
/// crate, vendored source, container without `.git`) — see `build.rs`.
///
/// Provenance, never correctness. The same commit can produce different bytes
/// (debug vs release, a dirty tree), and a binary reached through
/// `BOXLITE_RUNTIME_DIR` need not come from it at all — so nothing may depend
/// on two artifacts sharing a commit meaning they share contents.
///
/// It may still *appear* in a cache path, where it costs a split for
/// byte-identical content and buys the ability to say which checkout produced
/// an artifact. That trade is only worth taking where the split is bounded —
/// see `EmbeddedRuntime::dir_name`, and note the guest rootfs key deliberately
/// declines it.
pub const GIT_COMMIT: Option<&str> = option_env!("BOXLITE_GIT_COMMIT");

/// A stream of byte chunks carrying a terminal `Err` item on producer failure.
///
/// The transfer wire format (today: tar) is deliberately absent from the name —
/// callers move opaque bytes and never inspect them.
pub type BoxByteStream =
    std::pin::Pin<Box<dyn futures::Stream<Item = std::io::Result<Vec<u8>>> + Send + 'static>>;

pub mod constants;
pub mod errors;
pub mod layout;
pub mod tar;
pub mod transport;

// Generated protobuf types
pub mod generated {
    #![allow(clippy::all, unused_qualifications)]
    tonic::include_proto!("boxlite.v1");
}

pub use errors::{BoxliteError, BoxliteResult};
pub use transport::BoxTransport;

// Container service
pub use generated::container_client::ContainerClient;
pub use generated::container_server::{Container, ContainerServer};

// Guest service
pub use generated::guest_client::GuestClient;
pub use generated::guest_server::{Guest, GuestServer};

// Execution service
pub use generated::execution_client::ExecutionClient;
pub use generated::execution_server::{Execution, ExecutionServer};

// Files service
pub use generated::files_client::FilesClient;
pub use generated::files_server::{Files, FilesServer};

pub use generated::ssh_client::SshClient;
pub use generated::ssh_server::{Ssh, SshServer};

// All generated types
pub use generated::*;

impl std::fmt::Debug for generated::SshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConfig")
            .field("listen_address", &self.listen_address)
            .field("host_private_key", &"[REDACTED]")
            .field("account_count", &self.accounts.len())
            .finish()
    }
}

impl std::fmt::Debug for generated::SshAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshAccount")
            .field("login", &self.login)
            .field("authorized_key_count", &self.authorized_keys.len())
            .field("has_ca", &self.ca.is_some())
            .finish()
    }
}

impl std::fmt::Debug for generated::SshCaConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshCaConfig")
            .field("public_key", &"[REDACTED]")
            .field("principal", &self.principal)
            .finish()
    }
}

#[cfg(test)]
mod tests {
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
        };
        assert_eq!(request.encode_to_vec(), [0x22, 0x00]);
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
        };
        let decoded =
            super::SshConfigureRequest::decode(request.encode_to_vec().as_slice()).unwrap();
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
}
