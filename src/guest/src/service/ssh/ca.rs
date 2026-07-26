//! Offline verification of the short-lived OpenSSH user certificates the
//! Hosted API's organization-scoped SSH CA issues.
//!
//! The guest never talks to the Hosted API to authenticate. It is handed an
//! immutable trust bundle at VM-generation boot time (`--ssh-ca-key`,
//! `--ssh-org-id`, `--ssh-box-id`) and decides locally.
//!
//! russh does *not* establish CA trust for us. Before calling
//! `Handler::auth_openssh_certificate` it only checks the validity window and
//! `Certificate::verify_signature()`, which verifies the signature against the
//! CA key **embedded in the certificate itself** -- a self-signed forgery
//! passes that check. Establishing that the signer is a CA we trust, that the
//! certificate is a *user* certificate, and that its principals name exactly
//! this organization/box/login user is entirely this module's job.

use russh::keys::ssh_key::certificate::CertType;
use russh::keys::ssh_key::{Certificate, Fingerprint};
use russh::keys::{Algorithm, HashAlg, PublicKey};
use std::time::SystemTime;

/// The only login user this design accepts over SSH.
pub(crate) const SSH_LOGIN_USER: &str = "root";

/// Upper bound on one accepted OpenSSH public-key line. Keeps a malformed
/// boot argument from turning into an unbounded allocation.
const MAX_PUBLIC_KEY_LINE_BYTES: usize = 8192;

/// Principal prefix binding a certificate to one canonical box ID.
const BOX_PRINCIPAL_PREFIX: &str = "box:";

/// Principal prefix binding a certificate to one organization ID.
const ORG_PRINCIPAL_PREFIX: &str = "org:";

/// True only for the user/CA key algorithm this first round supports.
///
/// The design fixes Ed25519 as the first (and, until parser plus
/// interoperability tests land, only) accepted algorithm; the AWS KMS signer
/// is provisioned as `ECC_NIST_EDWARDS25519` for the same reason. RSA-SHA2 is
/// deliberately *not* accepted yet -- adding it here without those tests would
/// widen the accepted signature surface silently.
fn is_supported_algorithm(algorithm: &Algorithm) -> bool {
    matches!(algorithm, Algorithm::Ed25519)
}

/// SHA-256 fingerprint string (`SHA256:...`) for logs -- never the key body.
pub(crate) fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

#[derive(Debug)]
pub(crate) enum TrustConfigError {
    MissingOrganizationId,
    MissingBoxId,
    NoCaKeys,
    KeyTooLarge,
    MalformedKey(String),
    UnsupportedKeyAlgorithm(String),
    DuplicateCaKey(String),
}

impl std::fmt::Display for TrustConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrustConfigError::MissingOrganizationId => {
                write!(f, "ssh trust config requires --ssh-org-id")
            }
            TrustConfigError::MissingBoxId => write!(f, "ssh trust config requires --ssh-box-id"),
            TrustConfigError::NoCaKeys => {
                write!(f, "ssh trust config requires at least one --ssh-ca-key")
            }
            TrustConfigError::KeyTooLarge => write!(
                f,
                "ssh CA public key exceeds {MAX_PUBLIC_KEY_LINE_BYTES} bytes"
            ),
            TrustConfigError::MalformedKey(e) => write!(f, "malformed ssh CA public key: {e}"),
            TrustConfigError::UnsupportedKeyAlgorithm(algo) => {
                write!(f, "unsupported ssh CA key algorithm: {algo}")
            }
            TrustConfigError::DuplicateCaKey(fp) => {
                write!(f, "duplicate ssh CA public key: {fp}")
            }
        }
    }
}

impl std::error::Error for TrustConfigError {}

/// Why a presented certificate was refused. Kept as a typed value (rather than
/// a formatted string) so every rejection is logged from one stable, low
/// cardinality vocabulary, and so nothing derived from attacker-supplied bytes
/// reaches the log line. It is also the label set the planned
/// `boxlite_ssh_auth_total{reason}` metric is specified to use; no metric is
/// emitted yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CertRejectReason {
    WrongLoginUser,
    NotUserCertificate,
    UnsupportedKeyAlgorithm,
    UntrustedCaOrInvalidSignature,
    OutsideValidityWindow,
    PrincipalMismatch,
    UnrecognizedCriticalOption,
}

impl CertRejectReason {
    /// Stable, low-cardinality label for logs and metrics.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CertRejectReason::WrongLoginUser => "wrong_login_user",
            CertRejectReason::NotUserCertificate => "not_user_certificate",
            CertRejectReason::UnsupportedKeyAlgorithm => "unsupported_key_algorithm",
            CertRejectReason::UntrustedCaOrInvalidSignature => "untrusted_ca_or_invalid_signature",
            CertRejectReason::OutsideValidityWindow => "outside_validity_window",
            CertRejectReason::PrincipalMismatch => "principal_mismatch",
            CertRejectReason::UnrecognizedCriticalOption => "unrecognized_critical_option",
        }
    }
}

/// One trusted CA public key. `key_id` is the non-secret signer/version ID
/// carried in the OpenSSH key line's comment field, used for audit and to make
/// a stale trust bundle diagnosable during rotation.
#[derive(Clone, Debug)]
struct TrustedCaKey {
    key_id: String,
    fingerprint: Fingerprint,
}

/// Non-secret facts about an accepted certificate, for the audit log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedIdentity {
    pub(crate) ca_key_id: String,
    pub(crate) serial: u64,
    /// SHA-256 fingerprint of the *client* key the certificate binds.
    pub(crate) fingerprint: String,
}

/// The immutable per-VM-generation SSH trust bundle.
///
/// Immutable is load-bearing: a plain stop/start reuses the persisted box
/// options and therefore this exact bundle. Rotating the CA set requires
/// recreating or replacing the box, never a restart.
#[derive(Clone, Debug)]
pub(crate) struct SshTrust {
    expected_box_principal: String,
    expected_org_principal: String,
    ca_keys: Vec<TrustedCaKey>,
}

impl SshTrust {
    /// Build the trust bundle from boot arguments.
    ///
    /// Fails closed: an empty organization ID, box ID or CA set is a
    /// configuration error, not a permissive default.
    pub(crate) fn new(
        organization_id: &str,
        box_id: &str,
        ca_key_lines: &[String],
    ) -> Result<Self, TrustConfigError> {
        if organization_id.trim().is_empty() {
            return Err(TrustConfigError::MissingOrganizationId);
        }
        if box_id.trim().is_empty() {
            return Err(TrustConfigError::MissingBoxId);
        }
        if ca_key_lines.is_empty() {
            return Err(TrustConfigError::NoCaKeys);
        }

        let mut ca_keys: Vec<TrustedCaKey> = Vec::with_capacity(ca_key_lines.len());
        for line in ca_key_lines {
            let key = parse_ca_public_key(line)?;
            let fingerprint = key.fingerprint(HashAlg::Sha256);
            if ca_keys.iter().any(|k| k.fingerprint == fingerprint) {
                return Err(TrustConfigError::DuplicateCaKey(fingerprint.to_string()));
            }
            // The comment field carries the non-secret CA key/version ID. It
            // is optional in the wire format, so fall back to the fingerprint
            // rather than leaving diagnostics blank.
            let key_id = if key.comment().is_empty() {
                fingerprint.to_string()
            } else {
                key.comment().to_string()
            };
            ca_keys.push(TrustedCaKey {
                key_id,
                fingerprint,
            });
        }

        Ok(Self {
            expected_box_principal: format!("{BOX_PRINCIPAL_PREFIX}{box_id}"),
            expected_org_principal: format!("{ORG_PRINCIPAL_PREFIX}{organization_id}"),
            ca_keys,
        })
    }

    /// Non-secret CA key IDs this generation trusts, for readiness/diagnostics.
    pub(crate) fn ca_key_ids(&self) -> Vec<String> {
        self.ca_keys.iter().map(|k| k.key_id.clone()).collect()
    }

    /// Verify a presented OpenSSH user certificate against this bundle.
    ///
    /// Every dimension the design names is checked here; passing russh's
    /// built-in checks alone is not sufficient (see module docs).
    pub(crate) fn verify_user_certificate(
        &self,
        user: &str,
        cert: &Certificate,
        now: SystemTime,
    ) -> Result<VerifiedIdentity, CertRejectReason> {
        if user != SSH_LOGIN_USER {
            return Err(CertRejectReason::WrongLoginUser);
        }
        if cert.cert_type() != CertType::User {
            return Err(CertRejectReason::NotUserCertificate);
        }
        if !is_supported_algorithm(&cert.public_key().algorithm()) {
            return Err(CertRejectReason::UnsupportedKeyAlgorithm);
        }

        // Unrecognized critical options must fail closed: by the OpenSSH
        // certificate contract a critical option the server does not
        // understand means the certificate must be refused. We implement none
        // of them, so any critical option is unrecognized.
        if !cert.critical_options().is_empty() {
            return Err(CertRejectReason::UnrecognizedCriticalOption);
        }

        let now_unix = unix_seconds(now);
        // Separate the "is the CA trusted / is the signature good" failure
        // from "is it in its validity window" so the metric reason is
        // actionable. `validate_at` conflates them, so pre-check the window.
        if now_unix < cert.valid_after() || now_unix >= cert.valid_before() {
            return Err(CertRejectReason::OutsideValidityWindow);
        }

        let trusted: Vec<&Fingerprint> = self.ca_keys.iter().map(|k| &k.fingerprint).collect();
        cert.validate_at(now_unix, trusted)
            .map_err(|_| CertRejectReason::UntrustedCaOrInvalidSignature)?;

        if !self.principals_match(cert.valid_principals()) {
            return Err(CertRejectReason::PrincipalMismatch);
        }

        let signer_fingerprint = cert.signature_key().fingerprint(HashAlg::Sha256);
        let ca_key_id = self
            .ca_keys
            .iter()
            .find(|k| k.fingerprint == signer_fingerprint)
            .map(|k| k.key_id.clone())
            // Unreachable: `validate_at` already proved the signer is one of
            // `self.ca_keys`. Degrade to the fingerprint rather than panic.
            .unwrap_or_else(|| signer_fingerprint.to_string());

        Ok(VerifiedIdentity {
            ca_key_id,
            serial: cert.serial(),
            fingerprint: cert.public_key().fingerprint(HashAlg::Sha256).to_string(),
        })
    }

    /// The certificate must name exactly this login user, this box and this
    /// organization -- no more, no less.
    ///
    /// Exact set equality (rather than "contains") is deliberate: it is what
    /// makes one certificate bind to exactly one organization, one box and one
    /// login user. A certificate listing two boxes would otherwise be accepted
    /// by both, which is precisely the cross-box reach this design forbids.
    fn principals_match(&self, principals: &[String]) -> bool {
        if principals.len() != 3 {
            return false;
        }
        principals.iter().any(|p| p == SSH_LOGIN_USER)
            && principals.iter().any(|p| p == &self.expected_box_principal)
            && principals.iter().any(|p| p == &self.expected_org_principal)
    }
}

fn unix_seconds(now: SystemTime) -> u64 {
    now.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        // A pre-epoch clock cannot satisfy any real validity window; 0 makes
        // every certificate look not-yet-valid, which is the fail-closed side.
        .unwrap_or(0)
}

fn parse_ca_public_key(line: &str) -> Result<PublicKey, TrustConfigError> {
    if line.len() > MAX_PUBLIC_KEY_LINE_BYTES {
        return Err(TrustConfigError::KeyTooLarge);
    }
    let key =
        PublicKey::from_openssh(line).map_err(|e| TrustConfigError::MalformedKey(e.to_string()))?;
    if !is_supported_algorithm(&key.algorithm()) {
        return Err(TrustConfigError::UnsupportedKeyAlgorithm(
            key.algorithm().to_string(),
        ));
    }
    Ok(key)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use russh::keys::ssh_key::certificate::Builder;
    use russh::keys::PrivateKey;
    use std::time::Duration;

    pub(crate) const TEST_ORG_ID: &str = "org-11111111";
    pub(crate) const TEST_BOX_ID: &str = "box-22222222";

    pub(crate) fn generate_ed25519() -> PrivateKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
    }

    /// OpenSSH public-key line with `key_id` in the comment field, matching
    /// how the Runner delivers `--ssh-ca-key`.
    pub(crate) fn ca_key_line(ca: &PrivateKey, key_id: &str) -> String {
        let mut public = ca.public_key().clone();
        public.set_comment(key_id);
        public.to_openssh().unwrap()
    }

    pub(crate) fn default_principals() -> Vec<String> {
        vec![
            SSH_LOGIN_USER.to_string(),
            format!("{BOX_PRINCIPAL_PREFIX}{TEST_BOX_ID}"),
            format!("{ORG_PRINCIPAL_PREFIX}{TEST_ORG_ID}"),
        ]
    }

    pub(crate) fn trust_for(ca_lines: &[String]) -> SshTrust {
        SshTrust::new(TEST_ORG_ID, TEST_BOX_ID, ca_lines).unwrap()
    }

    /// Mint a user certificate the way the Hosted API signer does.
    pub(crate) fn sign_cert(
        ca: &PrivateKey,
        user_key: &PrivateKey,
        principals: &[String],
        valid_after: SystemTime,
        valid_before: SystemTime,
    ) -> Certificate {
        sign_cert_with(ca, user_key, principals, valid_after, valid_before, |b| {
            b.cert_type(CertType::User).unwrap();
        })
    }

    pub(crate) fn sign_cert_with(
        ca: &PrivateKey,
        user_key: &PrivateKey,
        principals: &[String],
        valid_after: SystemTime,
        valid_before: SystemTime,
        customize: impl FnOnce(&mut Builder),
    ) -> Certificate {
        let mut builder = Builder::new_with_random_nonce(
            &mut rand::rng(),
            user_key.public_key(),
            unix_seconds(valid_after),
            unix_seconds(valid_before),
        )
        .unwrap();
        builder.serial(7).unwrap();
        builder.key_id("ssh-access-record-id").unwrap();
        for principal in principals {
            builder.valid_principal(principal).unwrap();
        }
        customize(&mut builder);
        builder.sign(ca).unwrap()
    }

    pub(crate) fn now() -> SystemTime {
        SystemTime::now()
    }

    pub(crate) fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use russh::keys::PrivateKey;

    fn valid_window() -> (SystemTime, SystemTime) {
        (now() - secs(30), now() + secs(300))
    }

    #[test]
    fn accepts_a_certificate_signed_by_the_current_ca() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let cert = sign_cert(&ca, &user, &default_principals(), after, before);

        let identity = trust
            .verify_user_certificate(SSH_LOGIN_USER, &cert, now())
            .expect("certificate should be accepted");

        assert_eq!(identity.ca_key_id, "ca-key-1");
        assert_eq!(identity.serial, 7);
        assert_eq!(identity.fingerprint, fingerprint(user.public_key()));
    }

    #[test]
    fn accepts_a_certificate_signed_by_the_next_ca_during_rotation() {
        let current = generate_ed25519();
        let next = generate_ed25519();
        let trust = trust_for(&[
            ca_key_line(&current, "ca-key-1"),
            ca_key_line(&next, "ca-key-2"),
        ]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let cert = sign_cert(&next, &user, &default_principals(), after, before);

        let identity = trust
            .verify_user_certificate(SSH_LOGIN_USER, &cert, now())
            .expect("next CA should be trusted during rotation");
        assert_eq!(identity.ca_key_id, "ca-key-2");
    }

    #[test]
    fn rejects_a_certificate_from_an_untrusted_ca() {
        let trusted = generate_ed25519();
        let attacker = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&trusted, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let cert = sign_cert(&attacker, &user, &default_principals(), after, before);

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::UntrustedCaOrInvalidSignature)
        );
    }

    #[test]
    fn rejects_a_host_certificate_presented_as_a_user_certificate() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let cert = sign_cert_with(&ca, &user, &default_principals(), after, before, |b| {
            b.cert_type(CertType::Host).unwrap();
        });

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::NotUserCertificate)
        );
    }

    #[test]
    fn rejects_a_login_user_other_than_root() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let cert = sign_cert(&ca, &user, &default_principals(), after, before);

        assert_eq!(
            trust.verify_user_certificate("ubuntu", &cert, now()),
            Err(CertRejectReason::WrongLoginUser)
        );
    }

    #[test]
    fn rejects_a_certificate_bound_to_another_box() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let principals = vec![
            SSH_LOGIN_USER.to_string(),
            "box:box-99999999".to_string(),
            format!("org:{TEST_ORG_ID}"),
        ];
        let cert = sign_cert(&ca, &user, &principals, after, before);

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::PrincipalMismatch)
        );
    }

    #[test]
    fn rejects_a_certificate_bound_to_another_organization() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let principals = vec![
            SSH_LOGIN_USER.to_string(),
            format!("box:{TEST_BOX_ID}"),
            "org:org-99999999".to_string(),
        ];
        let cert = sign_cert(&ca, &user, &principals, after, before);

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::PrincipalMismatch)
        );
    }

    #[test]
    fn rejects_a_certificate_that_also_names_another_box() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let mut principals = default_principals();
        principals.push("box:box-99999999".to_string());
        let cert = sign_cert(&ca, &user, &principals, after, before);

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::PrincipalMismatch)
        );
    }

    #[test]
    fn rejects_a_certificate_missing_the_root_principal() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let principals = vec![
            format!("box:{TEST_BOX_ID}"),
            format!("org:{TEST_ORG_ID}"),
            "operator".to_string(),
        ];
        let cert = sign_cert(&ca, &user, &principals, after, before);

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::PrincipalMismatch)
        );
    }

    #[test]
    fn rejects_an_expired_certificate() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let cert = sign_cert(
            &ca,
            &user,
            &default_principals(),
            now() - secs(600),
            now() - secs(300),
        );

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::OutsideValidityWindow)
        );
    }

    #[test]
    fn rejects_a_not_yet_valid_certificate() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let cert = sign_cert(
            &ca,
            &user,
            &default_principals(),
            now() + secs(300),
            now() + secs(600),
        );

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::OutsideValidityWindow)
        );
    }

    #[test]
    fn rejects_a_certificate_carrying_an_unrecognized_critical_option() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let user = generate_ed25519();
        let (after, before) = valid_window();
        let cert = sign_cert_with(&ca, &user, &default_principals(), after, before, |b| {
            b.cert_type(CertType::User).unwrap();
            b.critical_option("force-command", "/bin/false").unwrap();
        });

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::UnrecognizedCriticalOption)
        );
    }

    #[test]
    fn trust_config_requires_organization_box_and_ca_key() {
        let ca = generate_ed25519();
        let line = ca_key_line(&ca, "ca-key-1");
        assert!(matches!(
            SshTrust::new("", TEST_BOX_ID, std::slice::from_ref(&line)),
            Err(TrustConfigError::MissingOrganizationId)
        ));
        assert!(matches!(
            SshTrust::new(TEST_ORG_ID, "", &[line]),
            Err(TrustConfigError::MissingBoxId)
        ));
        assert!(matches!(
            SshTrust::new(TEST_ORG_ID, TEST_BOX_ID, &[]),
            Err(TrustConfigError::NoCaKeys)
        ));
    }

    #[test]
    fn trust_config_rejects_malformed_oversized_and_duplicate_ca_keys() {
        assert!(matches!(
            SshTrust::new(TEST_ORG_ID, TEST_BOX_ID, &["not-a-key".to_string()]),
            Err(TrustConfigError::MalformedKey(_))
        ));
        assert!(matches!(
            SshTrust::new(
                TEST_ORG_ID,
                TEST_BOX_ID,
                &["x".repeat(MAX_PUBLIC_KEY_LINE_BYTES + 1)]
            ),
            Err(TrustConfigError::KeyTooLarge)
        ));

        let ca = generate_ed25519();
        assert!(matches!(
            SshTrust::new(
                TEST_ORG_ID,
                TEST_BOX_ID,
                &[ca_key_line(&ca, "ca-key-1"), ca_key_line(&ca, "ca-key-2")]
            ),
            Err(TrustConfigError::DuplicateCaKey(_))
        ));
    }

    #[test]
    fn trust_config_rejects_an_unsupported_ca_key_algorithm() {
        let rsa = PrivateKey::random(&mut rand::rng(), Algorithm::Rsa { hash: None }).unwrap();
        let line = rsa.public_key().to_openssh().unwrap();
        assert!(matches!(
            SshTrust::new(TEST_ORG_ID, TEST_BOX_ID, &[line]),
            Err(TrustConfigError::UnsupportedKeyAlgorithm(_))
        ));
    }

    #[test]
    fn rejects_a_user_key_algorithm_that_is_not_ed25519() {
        let ca = generate_ed25519();
        let trust = trust_for(&[ca_key_line(&ca, "ca-key-1")]);
        let rsa_user = PrivateKey::random(&mut rand::rng(), Algorithm::Rsa { hash: None }).unwrap();
        let (after, before) = valid_window();
        let cert = sign_cert(&ca, &rsa_user, &default_principals(), after, before);

        assert_eq!(
            trust.verify_user_certificate(SSH_LOGIN_USER, &cert, now()),
            Err(CertRejectReason::UnsupportedKeyAlgorithm)
        );
    }

    #[test]
    fn ca_key_id_falls_back_to_the_fingerprint_when_the_comment_is_empty() {
        let ca = generate_ed25519();
        let line = ca.public_key().to_openssh().unwrap();
        let trust = SshTrust::new(TEST_ORG_ID, TEST_BOX_ID, &[line]).unwrap();
        assert_eq!(trust.ca_key_ids(), vec![fingerprint(ca.public_key())]);
    }
}
