//! OpenSSH user-certificate authorization for the embedded server.

use russh::keys::ssh_key::certificate::CertType;
use russh::keys::{Algorithm, Certificate, HashAlg, PublicKey};

pub(crate) const SSH_USER: &str = "root";

#[derive(Debug)]
pub(crate) enum AuthorizerError {
    InvalidCaKey(String),
    UnsupportedCaAlgorithm(Algorithm),
    InvalidPrincipal,
}

impl std::fmt::Display for AuthorizerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCaKey(error) => write!(f, "invalid SSH CA public key: {error}"),
            Self::UnsupportedCaAlgorithm(algorithm) => write!(
                f,
                "unsupported SSH CA algorithm {algorithm}; only Ed25519 is enabled"
            ),
            Self::InvalidPrincipal => write!(
                f,
                "SSH certificate principal must be a non-empty URL-safe identifier"
            ),
        }
    }
}

impl std::error::Error for AuthorizerError {}

#[derive(Clone)]
pub(crate) struct CertificateAuthorizer {
    ca_fingerprint: russh::keys::ssh_key::Fingerprint,
    principal: String,
}

/// Capabilities granted by the authenticated OpenSSH user certificate.
///
/// OpenSSH certificates are deny-by-default: a capability is available only
/// when its `permit-*` extension is present. Server-wide policy is applied on
/// top of this identity at the request handler.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct CertificatePermissions {
    pub(crate) pty: bool,
    pub(crate) port_forwarding: bool,
    pub(crate) agent_forwarding: bool,
    pub(crate) x11_forwarding: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedIdentity {
    pub(crate) permissions: CertificatePermissions,
}

impl CertificateAuthorizer {
    pub(crate) fn new(
        ca_public_key: &str,
        principal: impl Into<String>,
    ) -> Result<Self, AuthorizerError> {
        let principal = principal.into();
        if !is_valid_principal(&principal) {
            return Err(AuthorizerError::InvalidPrincipal);
        }

        let ca_public_key = PublicKey::from_openssh(ca_public_key.trim())
            .map_err(|error| AuthorizerError::InvalidCaKey(error.to_string()))?;
        if ca_public_key.algorithm() != Algorithm::Ed25519 {
            return Err(AuthorizerError::UnsupportedCaAlgorithm(
                ca_public_key.algorithm(),
            ));
        }

        Ok(Self {
            ca_fingerprint: ca_public_key.fingerprint(HashAlg::Sha256),
            principal,
        })
    }

    /// Validate every security-relevant certificate field that russh leaves
    /// to the application after it verifies proof of possession.
    pub(crate) fn authorize(
        &self,
        user: &str,
        certificate: &Certificate,
    ) -> Option<AuthorizedIdentity> {
        if user != SSH_USER
            || certificate.cert_type() != CertType::User
            || certificate.validate([&self.ca_fingerprint]).is_err()
            || !certificate
                .valid_principals()
                .iter()
                .any(|principal| principal == &self.principal)
            || !certificate.critical_options().is_empty()
        {
            return None;
        }

        let extensions = certificate.extensions();
        Some(AuthorizedIdentity {
            permissions: CertificatePermissions {
                pty: extensions.contains_key("permit-pty"),
                port_forwarding: extensions.contains_key("permit-port-forwarding"),
                agent_forwarding: extensions.contains_key("permit-agent-forwarding"),
                x11_forwarding: extensions.contains_key("permit-X11-forwarding"),
            },
        })
    }

    #[cfg(test)]
    fn is_authorized(&self, user: &str, certificate: &Certificate) -> bool {
        self.authorize(user, certificate).is_some()
    }
}

fn is_valid_principal(principal: &str) -> bool {
    !principal.is_empty()
        && principal.len() <= 128
        && principal
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::certificate::Builder;
    use russh::keys::{Algorithm, EcdsaCurve, PrivateKey};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn private_key() -> PrivateKey {
        let mut rng = russh::keys::key::safe_rng();
        PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap()
    }

    fn public_key() -> String {
        private_key().public_key().to_openssh().unwrap()
    }

    fn certificate(
        ca_key: &PrivateKey,
        principal: &str,
        cert_type: CertType,
        critical_option: bool,
        valid_after: u64,
        valid_before: u64,
    ) -> Certificate {
        let subject_key = private_key();
        let mut rng = russh::keys::key::safe_rng();
        let mut builder = Builder::new_with_random_nonce(
            &mut rng,
            subject_key.public_key(),
            valid_after,
            valid_before,
        )
        .unwrap();
        builder.cert_type(cert_type).unwrap();
        builder.valid_principal(principal).unwrap();
        if critical_option {
            builder
                .critical_option("force-command", "echo unsafe")
                .unwrap();
        }
        builder.sign(ca_key).unwrap()
    }

    #[test]
    fn parses_a_ca_public_key_without_retaining_its_body() {
        let authorizer = CertificateAuthorizer::new(&public_key(), "box_123").unwrap();
        assert_eq!(authorizer.principal, "box_123");
    }

    #[test]
    fn rejects_invalid_ca_and_unscoped_principal() {
        assert!(matches!(
            CertificateAuthorizer::new("not a key", "box_123"),
            Err(AuthorizerError::InvalidCaKey(_))
        ));
        assert!(matches!(
            CertificateAuthorizer::new(&public_key(), ""),
            Err(AuthorizerError::InvalidPrincipal)
        ));
        assert!(matches!(
            CertificateAuthorizer::new(&public_key(), "../other-box"),
            Err(AuthorizerError::InvalidPrincipal)
        ));

        let mut rng = russh::keys::key::safe_rng();
        let ecdsa_ca = PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap()
        .public_key()
        .to_openssh()
        .unwrap();
        assert!(matches!(
            CertificateAuthorizer::new(&ecdsa_ca, "box_123"),
            Err(AuthorizerError::UnsupportedCaAlgorithm(_))
        ));
    }

    #[test]
    fn accepts_only_current_user_certificates_for_the_box_principal() {
        let ca_key = private_key();
        let other_ca = private_key();
        let ca_public_key = ca_key.public_key().to_openssh().unwrap();
        let authorizer = CertificateAuthorizer::new(&ca_public_key, "box_123").unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let valid = certificate(
            &ca_key,
            "box_123",
            CertType::User,
            false,
            now - 60,
            now + 60,
        );
        assert!(authorizer.is_authorized("root", &valid));
        assert!(!authorizer.is_authorized("nobody", &valid));

        let wrong_ca = certificate(
            &other_ca,
            "box_123",
            CertType::User,
            false,
            now - 60,
            now + 60,
        );
        assert!(!authorizer.is_authorized("root", &wrong_ca));

        let wrong_principal = certificate(
            &ca_key,
            "box_456",
            CertType::User,
            false,
            now - 60,
            now + 60,
        );
        assert!(!authorizer.is_authorized("root", &wrong_principal));

        let host_certificate = certificate(
            &ca_key,
            "box_123",
            CertType::Host,
            false,
            now - 60,
            now + 60,
        );
        assert!(!authorizer.is_authorized("root", &host_certificate));
    }

    #[test]
    fn rejects_expired_certificates_and_unknown_critical_options() {
        let ca_key = private_key();
        let ca_public_key = ca_key.public_key().to_openssh().unwrap();
        let authorizer = CertificateAuthorizer::new(&ca_public_key, "box_123").unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let expired = certificate(
            &ca_key,
            "box_123",
            CertType::User,
            false,
            now - 120,
            now - 60,
        );
        assert!(!authorizer.is_authorized("root", &expired));

        let critical = certificate(&ca_key, "box_123", CertType::User, true, now - 60, now + 60);
        assert!(!authorizer.is_authorized("root", &critical));
    }

    #[test]
    fn certificate_extensions_grant_only_named_capabilities() {
        let ca_key = private_key();
        let authorizer =
            CertificateAuthorizer::new(&ca_key.public_key().to_openssh().unwrap(), "box_123")
                .unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let subject_key = private_key();
        let mut rng = russh::keys::key::safe_rng();
        let mut builder =
            Builder::new_with_random_nonce(&mut rng, subject_key.public_key(), now - 60, now + 60)
                .unwrap();
        builder.valid_principal("box_123").unwrap();
        builder.extension("permit-pty", "").unwrap();
        builder.extension("permit-port-forwarding", "").unwrap();
        builder.extension("unknown-future-extension", "").unwrap();
        let certificate = builder.sign(&ca_key).unwrap();

        let identity = authorizer.authorize("root", &certificate).unwrap();
        assert_eq!(
            identity.permissions,
            CertificatePermissions {
                pty: true,
                port_forwarding: true,
                agent_forwarding: false,
                x11_forwarding: false,
            }
        );
    }

    #[test]
    fn accepts_an_rsa_subject_certificate_signed_by_the_ed25519_ca() {
        let ca_key = private_key();
        let authorizer =
            CertificateAuthorizer::new(&ca_key.public_key().to_openssh().unwrap(), "box_123")
                .unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut rng = russh::keys::key::safe_rng();
        let subject_key = PrivateKey::random(
            &mut rng,
            Algorithm::Rsa {
                hash: Some(HashAlg::Sha512),
            },
        )
        .unwrap();
        let mut builder =
            Builder::new_with_random_nonce(&mut rng, subject_key.public_key(), now - 60, now + 60)
                .unwrap();
        builder.valid_principal("box_123").unwrap();
        let certificate = builder.sign(&ca_key).unwrap();

        assert!(authorizer.is_authorized("root", &certificate));
    }
}
