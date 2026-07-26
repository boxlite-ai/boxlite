//! Hosted SSH certificate credentials for a box.
//!
//! The Hosted API runs an organization-scoped SSH certificate authority. A
//! caller generates an Ed25519 key pair locally, sends only the public half,
//! and gets back a short-lived OpenSSH user certificate bound to this box,
//! this organization and the `root` login user.
//!
//! The private key never leaves the client. Nothing in this module sends,
//! returns, persists or logs it, and [`SshCredentialBundle`]'s `Debug` redacts
//! it so it cannot leak through a log line or an error report.

use crate::runtime::backend::BoxSshCertificateBackend;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fmt;
use std::sync::Arc;

/// Public metadata for one issued certificate credential.
///
/// Every field here is safe to display, log and persist: there is no private
/// key material of any kind, by construction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshCertificateCredential {
    /// Opaque credential ID. This is the revoke target, not an authenticator.
    pub id: String,
    pub box_id: String,
    /// The signed public OpenSSH user certificate.
    pub certificate: String,
    /// The public key this certificate binds.
    pub public_key: String,
    /// SHA-256 fingerprint of the bound public key.
    pub fingerprint: String,
    /// Certificate serial, unique within the signing CA.
    pub serial: u64,
    /// Non-secret signer/version ID, for audit and rotation diagnostics.
    pub ca_key_id: String,
    pub valid_after: String,
    pub expires_at: String,
    /// Set once revoked. A revoked credential is no longer active, but a
    /// certificate already issued stays usable until `expires_at`.
    pub revoked_at: Option<String>,
    /// Region-aware direct-tunnel hostname for guest port 22.
    pub host: String,
    pub port: u16,
    /// SSH command template; `<private-key>`/`<certificate>` are placeholders.
    pub ssh_command: String,
    pub proxy_command: String,
    /// `known_hosts` line for the box's persistent SSH host key.
    ///
    /// Currently always empty: the server has no path to the guest's host key
    /// yet. Learn and pin it on first connect rather than disabling strict
    /// host-key checking.
    pub known_hosts: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A locally generated private key.
///
/// Serialization is deliberately not implemented and `Debug` is redacted: this
/// value exists only to be handed to an SSH client by the caller that created
/// it. If it ever needs to be written somewhere, that must be an explicit,
/// reviewed decision at the call site — not something a derived trait does by
/// accident.
#[derive(Clone, PartialEq, Eq)]
pub struct ClientPrivateKey(String);

impl ClientPrivateKey {
    pub(crate) fn new(pem: String) -> Self {
        Self(pem)
    }

    /// The OpenSSH-format private key. Naming it `expose_` keeps every read
    /// visible in review.
    pub fn expose_openssh(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ClientPrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClientPrivateKey([REDACTED])")
    }
}

impl fmt::Display for ClientPrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

/// Everything needed to open an SSH session: the client-held private key plus
/// the issued certificate and endpoint metadata.
#[derive(Clone, PartialEq, Eq)]
pub struct SshCredentialBundle {
    /// Generated locally and never transmitted.
    pub private_key: ClientPrivateKey,
    pub credential: SshCertificateCredential,
}

impl fmt::Debug for SshCredentialBundle {
    /// Hand-written so the private key is redacted even when the whole bundle
    /// is formatted, which is what a `tracing` field or an error chain does.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshCredentialBundle")
            .field("private_key", &self.private_key)
            .field("credential", &self.credential)
            .finish()
    }
}

/// Certificate lifecycle operations for one box.
#[derive(Clone)]
pub struct SshCertificateHandle {
    backend: Arc<dyn BoxSshCertificateBackend>,
}

impl SshCertificateHandle {
    pub(crate) fn new(backend: Arc<dyn BoxSshCertificateBackend>) -> Self {
        Self { backend }
    }

    /// Sign a certificate for a public key the caller already holds.
    ///
    /// `ttl_minutes` defaults to the server policy (5 minutes) when `None`.
    pub async fn create(
        &self,
        public_key: &str,
        ttl_minutes: Option<u32>,
    ) -> BoxliteResult<SshCertificateCredential> {
        self.backend.create(public_key, ttl_minutes).await
    }

    /// Public metadata for this box's credentials.
    pub async fn list(&self) -> BoxliteResult<Vec<SshCertificateCredential>> {
        self.backend.list().await
    }

    /// Revoke one credential by ID.
    ///
    /// This takes effect in the API immediately. It does not invalidate a certificate
    /// that was already issued: the guest verifies offline, so that
    /// certificate keeps working until it expires. The short default TTL is
    /// what bounds the window.
    pub async fn revoke(&self, credential_id: &str) -> BoxliteResult<()> {
        self.backend.revoke(credential_id).await
    }

    /// Generate a fresh Ed25519 key pair locally and get a certificate for it.
    ///
    /// This is the recommended entry point. The private key is created here,
    /// on the client, and only the public half is ever sent — so a compromise
    /// of the control plane cannot yield a usable credential, and a lost
    /// private key is unrecoverable by design rather than by omission.
    ///
    /// Because certificates are short-lived (5 minutes by default), issue one
    /// immediately before connecting rather than ahead of time.
    pub async fn issue(&self, ttl_minutes: Option<u32>) -> BoxliteResult<SshCredentialBundle> {
        let (private_key, public_key) = generate_ed25519_keypair()?;
        let credential = self.create(&public_key, ttl_minutes).await?;
        Ok(SshCredentialBundle {
            private_key,
            credential,
        })
    }
}

/// Generate an Ed25519 key pair in OpenSSH format.
///
/// Returns the private key (which never leaves this process unless the caller
/// deliberately exposes it) and the canonical public key line to submit.
fn generate_ed25519_keypair() -> BoxliteResult<(ClientPrivateKey, String)> {
    let key = ssh_key::PrivateKey::random(&mut rand::rng(), ssh_key::Algorithm::Ed25519)
        .map_err(|e| BoxliteError::Internal(format!("failed to generate ssh key: {e}")))?;
    let openssh = key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|e| BoxliteError::Internal(format!("failed to encode ssh private key: {e}")))?;
    let public_key = key
        .public_key()
        .to_openssh()
        .map_err(|e| BoxliteError::Internal(format!("failed to encode ssh public key: {e}")))?;
    Ok((ClientPrivateKey::new(openssh.to_string()), public_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential() -> SshCertificateCredential {
        SshCertificateCredential {
            id: "cred-1".into(),
            box_id: "box-1".into(),
            certificate: "ssh-ed25519-cert-v01@openssh.com AAAA".into(),
            public_key: "ssh-ed25519 AAAA".into(),
            fingerprint: "SHA256:abc".into(),
            serial: 7,
            ca_key_id: "ca-key-1".into(),
            valid_after: "2026-07-25T12:00:00Z".into(),
            expires_at: "2026-07-25T12:05:00Z".into(),
            revoked_at: None,
            host: "22-d-abc.example.com".into(),
            port: 22,
            ssh_command: "ssh ...".into(),
            proxy_command: "proxytunnel ...".into(),
            known_hosts: "[22-d-abc.example.com]:22 ssh-ed25519 AAAA".into(),
            created_at: "2026-07-25T12:00:00Z".into(),
            updated_at: "2026-07-25T12:00:00Z".into(),
        }
    }

    const SECRET_MARKER: &str = "SUPER-SECRET-KEY-BODY";

    #[test]
    fn debug_redacts_the_client_private_key() {
        let key = ClientPrivateKey::new(format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{SECRET_MARKER}\n"
        ));
        let rendered = format!("{key:?}");
        assert!(!rendered.contains(SECRET_MARKER), "got {rendered}");
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn display_redacts_the_client_private_key() {
        let key = ClientPrivateKey::new(SECRET_MARKER.to_string());
        assert_eq!(key.to_string(), "[REDACTED]");
    }

    #[test]
    fn debug_of_the_whole_bundle_redacts_the_private_key() {
        // The realistic leak path: a bundle formatted into a log field or an
        // error chain, not the key formatted on its own.
        let bundle = SshCredentialBundle {
            private_key: ClientPrivateKey::new(SECRET_MARKER.to_string()),
            credential: credential(),
        };
        let rendered = format!("{bundle:?}");
        assert!(!rendered.contains(SECRET_MARKER), "got {rendered}");
        assert!(rendered.contains("[REDACTED]"));
        // Public metadata must still be visible — redaction is targeted.
        assert!(rendered.contains("cred-1"));
        assert!(rendered.contains("SHA256:abc"));
    }

    #[test]
    fn generated_key_pairs_are_ed25519_and_parse_as_openssh() {
        let (private_key, public_key) = generate_ed25519_keypair().unwrap();

        assert!(public_key.starts_with("ssh-ed25519 "), "got {public_key}");
        assert!(
            private_key
                .expose_openssh()
                .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
        );

        // Round-trip through the real OpenSSH parser, and prove the public key
        // we submit is the one belonging to the private key we kept.
        let parsed = ssh_key::PrivateKey::from_openssh(private_key.expose_openssh()).unwrap();
        assert_eq!(parsed.algorithm(), ssh_key::Algorithm::Ed25519);
        assert_eq!(parsed.public_key().to_openssh().unwrap(), public_key);
    }

    #[test]
    fn every_generated_key_pair_is_distinct() {
        let (_, first) = generate_ed25519_keypair().unwrap();
        let (_, second) = generate_ed25519_keypair().unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn the_private_key_is_only_readable_through_an_explicit_accessor() {
        let key = ClientPrivateKey::new(SECRET_MARKER.to_string());
        assert_eq!(key.expose_openssh(), SECRET_MARKER);
    }
}
