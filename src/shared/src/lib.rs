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

// All generated types
pub use generated::*;

impl std::fmt::Debug for generated::SshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConfig")
            .field("listen_address", &self.listen_address)
            .field("host_private_key", &"[REDACTED]")
            .field("ca", &self.ca)
            .field("authorized_keys", &self.authorized_keys)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ssh_init_wire_roundtrip_redacts_private_key_debug() {
        use prost::Message;
        let request = super::GuestInitRequest {
            ssh_config: Some(super::SshConfig {
                listen_address: "0.0.0.0:22".into(),
                host_private_key: "test-only-private-marker".into(),
                ca: Some(super::SshCaConfig {
                    public_key: "test-ca".into(),
                    principal: "box_123".into(),
                }),
                authorized_keys: vec!["test-user comment".into()],
            }),
            ..Default::default()
        };
        let decoded = super::GuestInitRequest::decode(request.encode_to_vec().as_slice()).unwrap();
        assert_eq!(decoded, request);
        assert!(!format!("{decoded:?}").contains("test-only-private-marker"));
        let legacy = super::GuestInitRequest::decode(&[][..]).unwrap();
        assert!(legacy.ssh_config.is_none());
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
