//! CA certificate installer for container trust stores.
//!
//! Installs and renews PEM-encoded CA certificates in a system CA bundle file.
//! Source-agnostic — the caller provides the PEM bytes and bundle path.

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::SystemTime;
use x509_cert::der::DecodePem;
use x509_cert::ext::pkix::{BasicConstraints, KeyUsage};

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
        let incoming = parse_usable_ca(pem)?;
        let bundle = std::fs::read(&self.bundle_path)?;
        let parent = self
            .bundle_path
            .parent()
            .ok_or_else(|| io::Error::other("CA bundle has no parent"))?;
        atomic_replace(&self.bundle_path, |file| {
            for block in certificate_blocks(&bundle) {
                let begin = b"-----BEGIN CERTIFICATE-----";
                let Some(start) = block.windows(begin.len()).rposition(|part| part == begin) else {
                    file.write_all(block)?;
                    continue;
                };
                let matches = x509_cert::Certificate::from_pem(&block[start..]).is_ok_and(|cert| {
                    let existing = cert.tbs_certificate;
                    existing.subject == incoming.subject
                        && existing.subject_public_key_info == incoming.subject_public_key_info
                });
                file.write_all(if matches { &block[..start] } else { block })?;
            }
            file.write_all(b"\n")?;
            file.write_all(pem)?;
            file.write_all(b"\n")?;
            file.set_permissions(std::fs::metadata(&self.bundle_path)?.permissions())?;
            file.sync_all()
        })?;
        std::fs::File::open(parent)?.sync_all()
    }
}

/// Write and replace a file using a private temporary file on the same filesystem.
/// The callback prepares and syncs the file; callers can sync the parent after rename.
#[cfg(unix)]
pub(crate) fn atomic_replace(
    dest: &std::path::Path,
    write: impl FnOnce(&mut std::fs::File) -> io::Result<()>,
) -> io::Result<()> {
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::OpenOptionsExt;

    let parent = dest
        .parent()
        .ok_or_else(|| io::Error::other("destination has no parent"))?;
    let temp = parent.join(format!(".boxlite-{}", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = write(&mut file).and_then(|()| fs::rename(&temp, dest));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Reject unusable incoming issuers before any replacement file is created.
fn parse_usable_ca(pem: &[u8]) -> io::Result<x509_cert::TbsCertificate> {
    let invalid_der = |error| io::Error::new(io::ErrorKind::InvalidData, error);
    let certificate = x509_cert::Certificate::from_pem(pem)
        .map_err(invalid_der)?
        .tbs_certificate;
    let is_ca = certificate
        .get::<BasicConstraints>()
        .map_err(invalid_der)?
        .is_some_and(|(_, constraints)| constraints.ca);
    let can_sign = certificate
        .get::<KeyUsage>()
        .map_err(invalid_der)?
        .is_some_and(|(_, usage)| usage.key_cert_sign());
    if !is_ca || !can_sign {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "incoming CA must have CA basic constraints and certificate-signing key usage",
        ));
    }
    let now = SystemTime::now();
    if now < certificate.validity.not_before.to_system_time()
        || now >= certificate.validity.not_after.to_system_time()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "incoming CA is outside its validity interval",
        ));
    }
    Ok(certificate)
}

/// Split at ASCII PEM endings without decoding or modifying surrounding bytes.
fn certificate_blocks(mut bundle: &[u8]) -> impl Iterator<Item = &[u8]> {
    std::iter::from_fn(move || {
        if bundle.is_empty() {
            return None;
        }
        let boundary = b"-----END CERTIFICATE-----";
        let end = bundle
            .windows(boundary.len())
            .position(|part| part == boundary)
            .map_or(bundle.len(), |start| start + boundary.len());
        let (block, rest) = bundle.split_at(end);
        bundle = rest;
        Some(block)
    })
}
