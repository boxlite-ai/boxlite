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
mod tests;
