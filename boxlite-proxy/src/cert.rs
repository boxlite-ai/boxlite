//! Per-box CA and per-host certificate generation for MITM.

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair};
use std::sync::Arc;

/// Ephemeral CA for a single box, used to sign per-host MITM certs.
pub struct BoxCA {
    pub key_pair: Arc<KeyPair>,
    pub cert_der: Vec<u8>,
    pub cert_pem: String,
    ca_cert: rcgen::Certificate,
}

impl BoxCA {
    /// Generate a new ephemeral CA.
    pub fn new() -> Result<Self, String> {
        let key_pair = KeyPair::generate().map_err(|e| format!("CA key generation failed: {e}"))?;

        let mut params = CertificateParams::default();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let mut dn = DistinguishedName::new();
        dn.push(DnType::OrganizationName, "BoxLite Sandbox CA");
        dn.push(DnType::CommonName, "BoxLite Ephemeral CA");
        params.distinguished_name = dn;

        let ca_cert = params
            .self_signed(&key_pair)
            .map_err(|e| format!("CA self-sign failed: {e}"))?;

        let cert_der = ca_cert.der().to_vec();
        let cert_pem = ca_cert.pem();

        Ok(Self {
            key_pair: Arc::new(key_pair),
            cert_der,
            cert_pem,
            ca_cert,
        })
    }

    /// Generate a TLS certificate for a specific hostname, signed by this CA.
    pub fn generate_host_cert(&self, hostname: &str) -> Result<(Vec<u8>, KeyPair), String> {
        let host_key =
            KeyPair::generate().map_err(|e| format!("host key generation failed: {e}"))?;

        let mut params = CertificateParams::new(vec![hostname.to_string()])
            .map_err(|e| format!("host cert params failed: {e}"))?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, hostname);
        params.distinguished_name = dn;

        let host_cert = params
            .signed_by(&host_key, &self.ca_cert, &self.key_pair)
            .map_err(|e| format!("host cert signing failed: {e}"))?;

        Ok((host_cert.der().to_vec(), host_key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_cert_verifies_against_ca() {
        use rustls::client::danger::ServerCertVerifier;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let ca = BoxCA::new().unwrap();
        let (host_cert_der, _host_key) = ca.generate_host_cert("api.openai.com").unwrap();

        // Parse and verify the chain
        let ca_cert = rustls::pki_types::CertificateDer::from(ca.cert_der.clone());
        let host_cert = rustls::pki_types::CertificateDer::from(host_cert_der);

        let mut root_store = rustls::RootCertStore::empty();
        root_store.add(ca_cert).unwrap();

        let verifier = rustls::client::WebPkiServerVerifier::builder(Arc::new(root_store))
            .build()
            .unwrap();

        let server_name = rustls::pki_types::ServerName::try_from("api.openai.com").unwrap();
        let result = verifier.verify_server_cert(
            &host_cert,
            &[],
            &server_name,
            &[],
            rustls::pki_types::UnixTime::now(),
        );

        assert!(
            result.is_ok(),
            "host cert should verify against CA: {result:?}"
        );
    }

    #[test]
    fn ca_cert_pem_is_valid() {
        let ca = BoxCA::new().unwrap();
        assert!(ca.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(ca.cert_pem.trim().ends_with("-----END CERTIFICATE-----"));
    }
}
