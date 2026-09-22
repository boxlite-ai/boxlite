//! Immutable, per-login SSH authorization parsed before replacing a server.

use russh::keys::ssh_key::certificate::CertType;
use russh::keys::{Algorithm, Certificate, HashAlg, PublicKey};

use std::collections::HashMap;

// Application configuration limits; the login limit follows the existing principal limit.
const MAX_LOGIN_BYTES: usize = 128;
const MAX_PRINCIPAL_BYTES: usize = 128;

#[derive(Debug)]
pub(crate) enum AuthorizerError {
    MissingAccounts,
    InvalidLogin,
    DuplicateLogin,
    MissingAuthentication,
    InvalidPublicKey(usize),
    InvalidCaKey,
    UnsupportedCaAlgorithm,
    InvalidPrincipal,
}

impl std::fmt::Display for AuthorizerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingAccounts => write!(f, "SSH requires a non-empty accounts list; global credentials are no longer supported"),
            Self::InvalidLogin => write!(f, "SSH login must be a non-empty identifier of at most {MAX_LOGIN_BYTES} ASCII letters, digits, '.', '_', or '-'"),
            Self::DuplicateLogin => write!(f, "duplicate SSH login"),
            Self::MissingAuthentication => write!(f, "SSH requires a CA or at least one authorized key"),
            Self::InvalidPublicKey(index) => write!(f, "invalid SSH authorized key at index {index}: expected one OpenSSH public key without options"),
            Self::InvalidCaKey => write!(f, "invalid SSH CA public key: expected an OpenSSH public key"),
            Self::UnsupportedCaAlgorithm => write!(
                f,
                "unsupported SSH CA algorithm; only Ed25519 is enabled"
            ),
            Self::InvalidPrincipal => write!(
                f,
                "SSH certificate principal must be a non-empty URL-safe identifier"
            ),
        }
    }
}

impl std::error::Error for AuthorizerError {}

pub(crate) struct SshAuthorizer {
    accounts: HashMap<String, AccountAuthorizer>,
}

struct AccountAuthorizer {
    ca: Option<CertificateAuthorizer>,
    authorized_keys: Vec<PublicKey>,
}

impl SshAuthorizer {
    pub(crate) fn new(config: &boxlite_shared::SshConfig) -> Result<Self, AuthorizerError> {
        if config.accounts.is_empty() {
            return Err(AuthorizerError::MissingAccounts);
        }
        let mut accounts = HashMap::new();
        for account in &config.accounts {
            if account.login.is_empty()
                || account.login.len() > MAX_LOGIN_BYTES
                || !account
                    .login
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            {
                return Err(AuthorizerError::InvalidLogin);
            }
            if accounts.contains_key(&account.login) {
                return Err(AuthorizerError::DuplicateLogin);
            }
            accounts.insert(account.login.clone(), AccountAuthorizer::new(account)?);
        }
        Ok(Self { accounts })
    }

    pub(crate) fn authorize_public_key(
        &self,
        login: &str,
        key: &PublicKey,
    ) -> Option<AuthorizedIdentity> {
        self.accounts.get(login)?.authorize_public_key(key)
    }

    pub(crate) fn authorize_certificate(
        &self,
        login: &str,
        certificate: &Certificate,
    ) -> Option<AuthorizedIdentity> {
        self.accounts
            .get(login)?
            .ca
            .as_ref()?
            .authorize(certificate)
    }
}

impl AccountAuthorizer {
    fn new(config: &boxlite_shared::SshAccount) -> Result<Self, AuthorizerError> {
        if config.ca.is_none() && config.authorized_keys.is_empty() {
            return Err(AuthorizerError::MissingAuthentication);
        }
        let ca = config
            .ca
            .as_ref()
            .map(|ca| CertificateAuthorizer::new(&ca.public_key, &ca.principal))
            .transpose()?;
        let authorized_keys = config
            .authorized_keys
            .iter()
            .enumerate()
            .map(|(index, key)| {
                let key = key.trim();
                if key.contains(['\r', '\n']) {
                    return Err(AuthorizerError::InvalidPublicKey(index));
                }
                PublicKey::from_openssh(key).map_err(|_| AuthorizerError::InvalidPublicKey(index))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            ca,
            authorized_keys,
        })
    }

    fn authorize_public_key(&self, key: &PublicKey) -> Option<AuthorizedIdentity> {
        self.authorized_keys
            .iter()
            .any(|allowed| allowed.key_data() == key.key_data())
            .then_some(AuthorizedIdentity {
                permissions: SessionPermissions {
                    pty: true,
                    port_forwarding: true,
                    agent_forwarding: false,
                    x11_forwarding: false,
                },
            })
    }
}

struct CertificateAuthorizer {
    ca_fingerprint: russh::keys::ssh_key::Fingerprint,
    principal: String,
}

/// Capabilities granted by a successfully authenticated SSH identity.
///
/// Certificates grant capabilities through `permit-*` extensions; raw keys
/// grant PTY and forwarding. The handler also applies server-wide limits.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct SessionPermissions {
    pub(crate) pty: bool,
    pub(crate) port_forwarding: bool,
    pub(crate) agent_forwarding: bool,
    pub(crate) x11_forwarding: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedIdentity {
    pub(crate) permissions: SessionPermissions,
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
            .map_err(|_| AuthorizerError::InvalidCaKey)?;
        if ca_public_key.algorithm() != Algorithm::Ed25519 {
            return Err(AuthorizerError::UnsupportedCaAlgorithm);
        }

        Ok(Self {
            ca_fingerprint: ca_public_key.fingerprint(HashAlg::Sha256),
            principal,
        })
    }

    /// Validate every security-relevant certificate field that russh leaves
    /// to the application after it verifies proof of possession.
    pub(crate) fn authorize(&self, certificate: &Certificate) -> Option<AuthorizedIdentity> {
        if certificate.cert_type() != CertType::User
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
            permissions: SessionPermissions {
                pty: extensions.contains_key("permit-pty"),
                port_forwarding: extensions.contains_key("permit-port-forwarding"),
                agent_forwarding: extensions.contains_key("permit-agent-forwarding"),
                x11_forwarding: extensions.contains_key("permit-X11-forwarding"),
            },
        })
    }

    #[cfg(test)]
    fn is_authorized(&self, certificate: &Certificate) -> bool {
        self.authorize(certificate).is_some()
    }
}

fn is_valid_principal(principal: &str) -> bool {
    !principal.is_empty()
        && principal.len() <= MAX_PRINCIPAL_BYTES
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

    #[test]
    fn login_and_principal_enforce_separate_identifier_limits() {
        let key = public_key();
        for login in ["a".repeat(128), "Alice_01.test-user".into()] {
            let config = boxlite_shared::SshConfig {
                accounts: vec![boxlite_shared::SshAccount {
                    login,
                    authorized_keys: vec![key.clone()],
                    ca: None,
                }],
                ..Default::default()
            };
            assert!(SshAuthorizer::new(&config).is_ok());
        }
        for login in [
            "a".repeat(129),
            "".into(),
            "a/b".into(),
            "a b".into(),
            "é".into(),
            "a\0b".into(),
        ] {
            let config = boxlite_shared::SshConfig {
                accounts: vec![boxlite_shared::SshAccount {
                    login,
                    authorized_keys: vec![key.clone()],
                    ca: None,
                }],
                ..Default::default()
            };
            assert!(matches!(
                SshAuthorizer::new(&config),
                Err(AuthorizerError::InvalidLogin)
            ));
        }
        for principal in ["a".repeat(128), "Box_01-user".into()] {
            assert!(CertificateAuthorizer::new(&key, principal).is_ok());
        }
        for principal in [
            "a".repeat(129),
            "".into(),
            "a.b".into(),
            "a/b".into(),
            "a b".into(),
            "é".into(),
            "a\0b".into(),
        ] {
            assert!(matches!(
                CertificateAuthorizer::new(&key, principal),
                Err(AuthorizerError::InvalidPrincipal)
            ));
        }
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
            Err(AuthorizerError::InvalidCaKey)
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
            Err(AuthorizerError::UnsupportedCaAlgorithm)
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
        assert!(authorizer.is_authorized(&valid));

        let wrong_ca = certificate(
            &other_ca,
            "box_123",
            CertType::User,
            false,
            now - 60,
            now + 60,
        );
        assert!(!authorizer.is_authorized(&wrong_ca));

        let wrong_principal = certificate(
            &ca_key,
            "box_456",
            CertType::User,
            false,
            now - 60,
            now + 60,
        );
        assert!(!authorizer.is_authorized(&wrong_principal));

        let host_certificate = certificate(
            &ca_key,
            "box_123",
            CertType::Host,
            false,
            now - 60,
            now + 60,
        );
        assert!(!authorizer.is_authorized(&host_certificate));
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
        assert!(!authorizer.is_authorized(&expired));

        let critical = certificate(&ca_key, "box_123", CertType::User, true, now - 60, now + 60);
        assert!(!authorizer.is_authorized(&critical));
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

        let identity = authorizer.authorize(&certificate).unwrap();
        assert_eq!(
            identity.permissions,
            SessionPermissions {
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

        assert!(authorizer.is_authorized(&certificate));
    }
}
