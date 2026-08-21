//! SSH host identity is intentionally absent.
//!
//! The guest rootfs is read-only and the host key is neither persisted nor
//! generated, so the embedded SSH server cannot start (ignored for now).

#[derive(Debug)]
pub(crate) enum HostKeyError {
    Unavailable,
}

impl std::fmt::Display for HostKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => write!(f, "SSH host key unavailable"),
        }
    }
}

impl std::error::Error for HostKeyError {}
