//! Ephemeral Ed25519 host identity for the embedded SSH server.
//!
//! The guest rootfs is read-only, so the host key is generated fresh each boot
//! rather than persisted (see [`generate`]).

use russh::keys::{Algorithm, PrivateKey};

#[derive(Debug)]
pub(crate) enum HostKeyError {
    Parse(String),
}

impl std::fmt::Display for HostKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(error) => write!(f, "host key parse error: {error}"),
        }
    }
}

impl std::error::Error for HostKeyError {}

/// Generate a fresh ephemeral host key (not persisted — the guest root is
/// read-only).
pub(crate) fn generate() -> Result<PrivateKey, HostKeyError> {
    let mut rng = russh::keys::key::safe_rng();
    PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|error| HostKeyError::Parse(error.to_string()))
}
