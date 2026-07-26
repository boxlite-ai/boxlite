//! Node.js bindings for hosted SSH certificate credentials.
//!
//! The private key is generated on the client by the Rust core and is never
//! sent anywhere. These bindings keep that property observable from
//! JavaScript: the bundle is a class, not an `#[napi(object)]` struct, so the
//! key is not an own enumerable property and cannot fall out of a
//! `console.log` or a `JSON.stringify`. It is reachable only through the
//! explicit `exposePrivateKey()` call.

use std::sync::Arc;

use boxlite::{LiteBox, SshCertificateCredential};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// Public metadata for one issued certificate credential.
///
/// Every field is safe to display, log and persist — there is no private key
/// material here by construction, so a plain object is the right shape.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsSshCertificateCredential {
    pub id: String,
    #[napi(js_name = "boxId")]
    pub box_id: String,
    pub certificate: String,
    #[napi(js_name = "publicKey")]
    pub public_key: String,
    pub fingerprint: String,
    /// Certificate serial, as a decimal string.
    ///
    /// The core type is `u64`, which no JS number can hold exactly above
    /// 2^53 — which is why `openapi/box.openapi.yaml` puts it on the wire as
    /// a string. Narrowing it to a napi `i64` here would reintroduce exactly
    /// the precision loss that encoding is there to prevent, so the string
    /// form is carried through instead.
    pub serial: String,
    #[napi(js_name = "caKeyId")]
    pub ca_key_id: String,
    #[napi(js_name = "validAfter")]
    pub valid_after: String,
    #[napi(js_name = "expiresAt")]
    pub expires_at: String,
    #[napi(js_name = "revokedAt")]
    pub revoked_at: Option<String>,
    pub host: String,
    pub port: u16,
    #[napi(js_name = "sshCommand")]
    pub ssh_command: String,
    #[napi(js_name = "proxyCommand")]
    pub proxy_command: String,
    #[napi(js_name = "knownHosts")]
    pub known_hosts: String,
    #[napi(js_name = "createdAt")]
    pub created_at: String,
    #[napi(js_name = "updatedAt")]
    pub updated_at: String,
}

impl From<SshCertificateCredential> for JsSshCertificateCredential {
    fn from(c: SshCertificateCredential) -> Self {
        Self {
            id: c.id,
            box_id: c.box_id,
            certificate: c.certificate,
            public_key: c.public_key,
            fingerprint: c.fingerprint,
            serial: c.serial.to_string(),
            ca_key_id: c.ca_key_id,
            valid_after: c.valid_after,
            expires_at: c.expires_at,
            revoked_at: c.revoked_at,
            host: c.host,
            port: c.port,
            ssh_command: c.ssh_command,
            proxy_command: c.proxy_command,
            known_hosts: c.known_hosts,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }
    }
}

/// What `JSON.stringify` sees for a credential bundle.
///
/// `privateKey` is always the literal `[REDACTED]`: the shape stays useful for
/// debugging while the secret stays out of every serialized form.
#[napi(object)]
pub struct JsRedactedSshCredentialBundle {
    #[napi(js_name = "privateKey")]
    pub private_key: String,
    pub credential: JsSshCertificateCredential,
}

/// Everything needed to open an SSH session: the client-held private key plus
/// the issued certificate and endpoint metadata.
#[napi]
pub struct JsSshCredentialBundle {
    private_key_openssh: String,
    credential: JsSshCertificateCredential,
}

#[napi]
impl JsSshCredentialBundle {
    /// Public certificate metadata for this credential.
    #[napi(getter)]
    pub fn credential(&self) -> JsSshCertificateCredential {
        self.credential.clone()
    }

    /// The locally generated OpenSSH private key.
    ///
    /// Named `expose` so every read of the secret is visible at the call site
    /// and in review. Nothing else on this class returns it.
    #[napi(js_name = "exposePrivateKey")]
    pub fn expose_private_key(&self) -> String {
        self.private_key_openssh.clone()
    }

    /// `JSON.stringify` hook. Redacts the private key.
    #[napi(js_name = "toJSON")]
    pub fn to_json(&self) -> JsRedactedSshCredentialBundle {
        JsRedactedSshCredentialBundle {
            private_key: "[REDACTED]".to_string(),
            credential: self.credential.clone(),
        }
    }
}

/// Handle for SSH certificate operations on a Box.
///
/// Accessed as a property: `box.sshCertificates.issue()`.
#[napi]
pub struct JsSshCertificateHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsSshCertificateHandle {
    /// Sign a certificate for a public key the caller already holds.
    ///
    /// `ttlMinutes` defaults to the server policy when omitted.
    #[napi]
    pub async fn create(
        &self,
        public_key: String,
        ttl_minutes: Option<u32>,
    ) -> Result<JsSshCertificateCredential> {
        let handle = Arc::clone(&self.handle);
        let credential = handle
            .ssh_certificates()
            .create(&public_key, ttl_minutes)
            .await
            .map_err(map_err)?;
        Ok(JsSshCertificateCredential::from(credential))
    }

    /// Public metadata for this box's credentials.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsSshCertificateCredential>> {
        let handle = Arc::clone(&self.handle);
        let credentials = handle.ssh_certificates().list().await.map_err(map_err)?;
        Ok(credentials
            .into_iter()
            .map(JsSshCertificateCredential::from)
            .collect())
    }

    /// Revoke one credential by ID.
    #[napi]
    pub async fn revoke(&self, credential_id: String) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle
            .ssh_certificates()
            .revoke(&credential_id)
            .await
            .map_err(map_err)
    }

    /// Generate a fresh Ed25519 key pair locally and get a certificate for it.
    ///
    /// This is the recommended entry point: only the public half is ever sent.
    /// Certificates are short-lived, so issue one immediately before
    /// connecting rather than ahead of time.
    #[napi]
    pub async fn issue(&self, ttl_minutes: Option<u32>) -> Result<JsSshCredentialBundle> {
        let handle = Arc::clone(&self.handle);
        let bundle = handle
            .ssh_certificates()
            .issue(ttl_minutes)
            .await
            .map_err(map_err)?;
        Ok(JsSshCredentialBundle {
            private_key_openssh: bundle.private_key.expose_openssh().to_string(),
            credential: JsSshCertificateCredential::from(bundle.credential),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_credential() -> SshCertificateCredential {
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
            ssh_command: "ssh -i key -o CertificateFile=cert root@host".into(),
            proxy_command: "proxytunnel -p gateway:443".into(),
            known_hosts: "[22-d-abc.example.com]:22 ssh-ed25519 AAAA".into(),
            created_at: "2026-07-25T12:00:00Z".into(),
            updated_at: "2026-07-25T12:00:00Z".into(),
        }
    }

    #[test]
    fn credential_from_core_maps_every_field() {
        let js: JsSshCertificateCredential = core_credential().into();
        assert_eq!(js.id, "cred-1");
        assert_eq!(js.box_id, "box-1");
        assert_eq!(js.certificate, "ssh-ed25519-cert-v01@openssh.com AAAA");
        assert_eq!(js.public_key, "ssh-ed25519 AAAA");
        assert_eq!(js.fingerprint, "SHA256:abc");
        assert_eq!(js.serial, "7");
        assert_eq!(js.ca_key_id, "ca-key-1");
        assert_eq!(js.valid_after, "2026-07-25T12:00:00Z");
        assert_eq!(js.expires_at, "2026-07-25T12:05:00Z");
        assert_eq!(js.revoked_at, None);
        assert_eq!(js.host, "22-d-abc.example.com");
        assert_eq!(js.port, 22);
        assert_eq!(
            js.ssh_command,
            "ssh -i key -o CertificateFile=cert root@host"
        );
        assert_eq!(js.proxy_command, "proxytunnel -p gateway:443");
        assert_eq!(js.known_hosts, "[22-d-abc.example.com]:22 ssh-ed25519 AAAA");
        assert_eq!(js.created_at, "2026-07-25T12:00:00Z");
        assert_eq!(js.updated_at, "2026-07-25T12:00:00Z");
    }

    #[test]
    fn credential_serial_survives_values_no_js_number_can_hold() {
        let mut core = core_credential();
        core.serial = u64::MAX;
        let js: JsSshCertificateCredential = core.into();
        assert_eq!(js.serial, "18446744073709551615");
    }

    #[test]
    fn to_json_redacts_the_private_key() {
        let bundle = JsSshCredentialBundle {
            private_key_openssh: "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n".into(),
            credential: core_credential().into(),
        };
        let json = bundle.to_json();
        assert_eq!(json.private_key, "[REDACTED]");
        assert_eq!(json.credential.id, "cred-1");
        assert_eq!(
            bundle.expose_private_key(),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n"
        );
    }
}
