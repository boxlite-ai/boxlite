//! CA certificate installer for container trust stores.
//!
//! Installs and renews PEM-encoded CA certificates in a system CA bundle file.
//! Source-agnostic — the caller provides the PEM bytes and bundle path.

use std::io::{self, Write};
use std::path::PathBuf;
use x509_cert::der::DecodePem;

/// Installs CA certificates into a trust bundle file.
pub struct CaInstaller {
    bundle_path: PathBuf,
}

impl CaInstaller {
    /// Create an installer targeting a specific bundle file path.
    pub fn with_bundle(bundle_path: PathBuf) -> Self {
        Self { bundle_path }
    }

    /// Replace certificates with the same subject and key, preserving other roots.
    pub fn install(&self, pem: &[u8]) -> std::io::Result<()> {
        let incoming = x509_cert::Certificate::from_pem(pem)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?
            .tbs_certificate;
        let bundle = std::fs::read_to_string(&self.bundle_path)?;
        let mut file = tempfile::NamedTempFile::new_in(
            self.bundle_path
                .parent()
                .ok_or_else(|| io::Error::other("CA bundle has no parent"))?,
        )?;
        for block in bundle.split_inclusive("-----END CERTIFICATE-----") {
            let Some(start) = block.find("-----BEGIN CERTIFICATE-----") else {
                file.write_all(block.as_bytes())?;
                continue;
            };
            let matches = x509_cert::Certificate::from_pem(&block[start..]).is_ok_and(|cert| {
                let existing = cert.tbs_certificate;
                existing.subject == incoming.subject
                    && existing.subject_public_key_info == incoming.subject_public_key_info
            });
            if matches {
                file.write_all(&block.as_bytes()[..start])?;
            } else {
                file.write_all(block.as_bytes())?;
            }
        }
        file.write_all(b"\n")?;
        file.write_all(pem)?;
        file.write_all(b"\n")?;
        file.as_file()
            .set_permissions(std::fs::metadata(&self.bundle_path)?.permissions())?;
        file.persist(&self.bundle_path)?;
        Ok(())
    }
}
