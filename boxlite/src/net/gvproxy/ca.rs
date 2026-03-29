//! Ephemeral ECDSA P-256 CA generation for MITM secret substitution.
//!
//! Generates a self-signed CA certificate used by the Go MITM proxy to
//! create per-hostname TLS certificates on the fly.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose};
use time::{Duration, OffsetDateTime};

/// Ephemeral CA certificate and private key in PEM format.
pub struct MitmCa {
    /// PEM-encoded CA certificate (for guest trust store + Go config).
    pub cert_pem: String,
    /// PEM-encoded PKCS8 private key (for Go config — used to sign host certs).
    pub key_pem: String,
}

/// Generate an ephemeral ECDSA P-256 CA for MITM secret substitution.
///
/// The CA is short-lived (24 hours), never persisted to disk, and destroyed
/// when the box stops. Go receives the cert+key via JSON config and uses
/// them to generate per-hostname TLS certificates.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_produces_valid_pem() {
        let ca = generate().unwrap();
        assert!(ca.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(ca.cert_pem.ends_with("-----END CERTIFICATE-----\n"));
        assert!(ca.key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
        assert!(ca.key_pem.ends_with("-----END PRIVATE KEY-----\n"));
    }

    #[test]
    fn test_generate_produces_unique_certs() {
        let ca1 = generate().unwrap();
        let ca2 = generate().unwrap();
        assert_ne!(ca1.cert_pem, ca2.cert_pem, "each CA should be unique");
        assert_ne!(ca1.key_pem, ca2.key_pem, "each key should be unique");
    }
}
