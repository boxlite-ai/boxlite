//! SSH key validation shared by the host configuration boundary and guest RPC.

use crate::{BoxliteError, BoxliteResult, SshConfigureRequest};
use ssh_key::{Algorithm, EcdsaCurve, Fingerprint, HashAlg, PrivateKey, PublicKey};

/// Keep both peers on the exact key representation used by the SSH transport.
pub use ssh_key;

/// Parsed, validated credentials. Comments in OpenSSH public keys are not identity.
#[derive(Clone, Debug)]
pub struct SshKeySet {
    pub ca_fingerprints: Vec<Fingerprint>,
    pub public_keys: Vec<ssh_key::public::KeyData>,
}

impl SshKeySet {
    pub fn parse(ca_public_keys: &[String], public_keys: &[String]) -> BoxliteResult<Self> {
        if ca_public_keys.is_empty() && public_keys.is_empty() {
            return Err(BoxliteError::InvalidArgument(
                "SSH keys authentication requires at least one CA or user public key".into(),
            ));
        }
        let mut ca_fingerprints = Vec::with_capacity(ca_public_keys.len());
        for (index, key) in ca_public_keys.iter().enumerate() {
            let key = parse_public_key(key, "CA", index)?;
            if key.algorithm() != Algorithm::Ed25519 {
                return Err(BoxliteError::InvalidArgument(format!(
                    "SSH CA public key [{index}] must use Ed25519"
                )));
            }
            ca_fingerprints.push(key.fingerprint(HashAlg::Sha256));
        }
        let public_keys = public_keys
            .iter()
            .enumerate()
            .map(|(index, key)| {
                parse_public_key(key, "user", index).map(|key| key.key_data().clone())
            })
            .collect::<BoxliteResult<_>>()?;
        Ok(Self {
            ca_fingerprints,
            public_keys,
        })
    }
}

fn parse_public_key(encoded: &str, kind: &str, index: usize) -> BoxliteResult<PublicKey> {
    let key = PublicKey::from_openssh(encoded.trim()).map_err(|error| {
        BoxliteError::InvalidArgument(format!("invalid SSH {kind} public key [{index}]: {error}"))
    })?;
    match key.algorithm() {
        Algorithm::Ed25519
        | Algorithm::SkEd25519
        | Algorithm::SkEcdsaSha2NistP256
        | Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256 | EcdsaCurve::NistP384 | EcdsaCurve::NistP521,
        }
        | Algorithm::Rsa { .. } => Ok(key),
        algorithm => Err(BoxliteError::InvalidArgument(format!(
            "unsupported SSH {kind} public key [{index}] algorithm: {algorithm}"
        ))),
    }
}

/// Only this format is accepted, even if a parser can decode other private keys.
pub fn parse_host_key(encoded: &str) -> BoxliteResult<PrivateKey> {
    let key = PrivateKey::from_openssh(encoded.trim()).map_err(|error| {
        BoxliteError::InvalidArgument(format!("invalid SSH host private key: {error}"))
    })?;
    if key.is_encrypted() || key.algorithm() != Algorithm::Ed25519 {
        return Err(BoxliteError::InvalidArgument(
            "SSH host private key must be an unencrypted OpenSSH Ed25519 key".into(),
        ));
    }
    Ok(key)
}

impl std::fmt::Debug for SshConfigureRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConfigureRequest")
            .field("principal", &self.principal)
            .field("host_private_key", &"[REDACTED]")
            .field("auth", &self.auth)
            .finish()
    }
}
