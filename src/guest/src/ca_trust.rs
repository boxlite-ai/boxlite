//! CA certificate installer for container trust stores.
//!
//! Appends PEM-encoded CA certificates to a system CA bundle file.
//! Source-agnostic — the caller provides the PEM bytes and bundle path.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

/// Installs CA certificates into a trust bundle file.
pub struct CaInstaller {
    bundle_path: PathBuf,
}

impl CaInstaller {
    /// Create an installer targeting a specific bundle file path.
    pub fn with_bundle(bundle_path: PathBuf) -> Self {
        Self { bundle_path }
    }

    /// Append a PEM-encoded CA certificate to the trust bundle.
    pub fn install(&self, pem: &[u8]) -> std::io::Result<()> {
        let mut file = OpenOptions::new().append(true).open(&self.bundle_path)?;
        file.write_all(b"\n")?;
        file.write_all(pem)?;
        file.write_all(b"\n")?;
        Ok(())
    }
}
