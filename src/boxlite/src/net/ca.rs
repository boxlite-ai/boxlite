//! CA certificate generation and persistence for MITM secret substitution.
//!
//! Generates ECDSA P-256 CA certificates and persists them to the box directory
//! so the same CA survives box restarts.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose};
use std::io::Write;
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

    write_private_key(&key_path, &ca.key_pem)?;

    tracing::info!("MITM: generated and persisted CA to {}", ca_dir.display());
    Ok(ca)
}

#[cfg(unix)]
fn write_private_key(path: &Path, contents: &str) -> BoxliteResult<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let parent = path.parent().ok_or_else(|| {
        BoxliteError::Network(format!("CA key path has no parent: {}", path.display()))
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        BoxliteError::Network(format!("CA key path has no file name: {}", path.display()))
    })?;
    let tmp_path = parent.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));

    let write_result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp_path)
            .map_err(|e| BoxliteError::Network(format!("Failed to open CA key temp file: {e}")))?;

        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| {
                BoxliteError::Network(format!("Failed to secure CA key permissions: {e}"))
            })?;
        file.write_all(contents.as_bytes())
            .map_err(|e| BoxliteError::Network(format!("Failed to write CA key: {e}")))?;
        file.sync_all()
            .map_err(|e| BoxliteError::Network(format!("Failed to sync CA key: {e}")))?;
        drop(file);

        // `ca_dir` is runtime-owned and must not be shared with the guest. The
        // temp+rename path prevents following an existing key.pem symlink or
        // truncating an existing hardlinked file at the final path.
        std::fs::rename(&tmp_path, path)
            .map_err(|e| BoxliteError::Network(format!("Failed to install CA key: {e}")))?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }

    write_result
}

#[cfg(not(unix))]
fn write_private_key(path: &Path, contents: &str) -> BoxliteResult<()> {
    std::fs::write(path, contents)
        .map_err(|e| BoxliteError::Network(format!("Failed to write CA key: {e}")))
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

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_writes_private_key_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");

        load_or_generate(&ca_dir).unwrap();

        let mode = std::fs::metadata(ca_dir.join("key.pem"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn test_write_private_key_replaces_symlink_without_writing_target() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        let key_path = ca_dir.join("key.pem");
        let outside_target = dir.path().join("outside-key.pem");
        std::fs::write(&outside_target, "sentinel").unwrap();
        std::os::unix::fs::symlink(&outside_target, &key_path).unwrap();

        write_private_key(&key_path, "private-key").unwrap();

        assert_eq!(
            std::fs::read_to_string(&outside_target).unwrap(),
            "sentinel"
        );
        let metadata = std::fs::symlink_metadata(&key_path).unwrap();
        assert!(
            !metadata.file_type().is_symlink(),
            "key.pem should be replaced, not followed"
        );
        assert!(metadata.file_type().is_file());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&key_path).unwrap(), "private-key");
    }
}
