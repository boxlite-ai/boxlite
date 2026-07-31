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

// SSH control service
pub use generated::ssh_server::{Ssh, SshServer};

// Execution service
pub use generated::execution_client::ExecutionClient;
pub use generated::execution_server::{Execution, ExecutionServer};

// Files service
pub use generated::files_client::FilesClient;
pub use generated::files_server::{Files, FilesServer};

// All generated types
pub use generated::*;

#[cfg(test)]
mod tests {
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
