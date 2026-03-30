//! CA certificate generation and persistence for MITM secret substitution.
//!
//! Generates ECDSA P-256 CA certificates and persists them to the box directory
//! so the same CA survives box restarts.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose};
use std::path::Path;
use time::{Duration, OffsetDateTime};

/// CA certificate and private key in PEM format.
pub struct MitmCa {
    pub cert_pem: String,
    pub key_pem: String,
}

/// Generate a fresh ECDSA P-256 CA certificate.
pub fn generate() -> BoxliteResult<MitmCa> {
    let key_pair = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|e| BoxliteError::Network(format!("MITM CA key generation failed: {e}")))?;

    let mut params = CertificateParams::default();
    params.distinguished_name = {
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "BoxLite MITM CA");
        dn
    };

    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::minutes(1);
    params.not_after = now + Duration::hours(24);
    params.is_ca = IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::CrlSign, KeyUsagePurpose::KeyCertSign];

    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| BoxliteError::Network(format!("MITM CA cert generation failed: {e}")))?;

    Ok(MitmCa {
        cert_pem: cert.pem(),
        key_pem: key_pair.serialize_pem(),
    })
}

/// Load CA from files if they exist, otherwise generate and persist.
///
/// Files: `{ca_dir}/cert.pem` (0644), `{ca_dir}/key.pem` (0600).
/// The CA directory must NOT be shared with the guest VM (it contains the private key).
pub fn load_or_generate(ca_dir: &Path) -> BoxliteResult<MitmCa> {
    let cert_path = ca_dir.join("cert.pem");
    let key_path = ca_dir.join("key.pem");

    // Restart path: load existing CA (matches cert already in container rootfs)
    if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path).map_err(|e| {
            BoxliteError::Network(format!(
                "Failed to read CA cert {}: {e}",
                cert_path.display()
            ))
        })?;
        let key_pem = std::fs::read_to_string(&key_path).map_err(|e| {
            BoxliteError::Network(format!("Failed to read CA key {}: {e}", key_path.display()))
        })?;
        tracing::info!("MITM: loaded persisted CA from {}", ca_dir.display());
        return Ok(MitmCa { cert_pem, key_pem });
    }

    // First start: generate + persist
    let ca = generate()?;

    std::fs::create_dir_all(ca_dir).map_err(|e| {
        BoxliteError::Network(format!("Failed to create CA dir {}: {e}", ca_dir.display()))
    })?;

    std::fs::write(&cert_path, &ca.cert_pem)
        .map_err(|e| BoxliteError::Network(format!("Failed to write CA cert: {e}")))?;

    std::fs::write(&key_path, &ca.key_pem)
        .map_err(|e| BoxliteError::Network(format!("Failed to write CA key: {e}")))?;

    // Private key: owner-only permissions
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    tracing::info!("MITM: generated and persisted CA to {}", ca_dir.display());
    Ok(ca)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_produces_valid_pem() {
        let ca = generate().unwrap();
        assert!(ca.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(ca.key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn test_generate_produces_unique_certs() {
        let ca1 = generate().unwrap();
        let ca2 = generate().unwrap();
        assert_ne!(ca1.cert_pem, ca2.cert_pem);
    }

    #[test]
    fn test_load_or_generate_persists_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");

        // First call generates and writes files
        let ca1 = load_or_generate(&ca_dir).unwrap();
        assert!(ca_dir.join("cert.pem").exists());
        assert!(ca_dir.join("key.pem").exists());

        // Second call loads the same CA (restart scenario)
        let ca2 = load_or_generate(&ca_dir).unwrap();
        assert_eq!(ca1.cert_pem, ca2.cert_pem);
        assert_eq!(ca1.key_pem, ca2.key_pem);
    }
}
