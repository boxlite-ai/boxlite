//! CA certificate generation and persistence for MITM secret substitution.
//!
//! Generates ECDSA P-256 CA certificates and persists them to the box directory
//! so the same CA survives box restarts.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use rcgen::{CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose};
use std::io::{Read, Write};
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
    ensure_ca_dir(ca_dir)?;

    let cert_path = ca_dir.join("cert.pem");
    let key_path = ca_dir.join("key.pem");

    // Restart path: load existing CA (matches cert already in container rootfs)
    if cert_path.exists() && key_path.exists() {
        let cert_pem = read_ca_cert(&cert_path)?;
        let key_pem = read_private_key(&key_path)?;
        tracing::info!("MITM: loaded persisted CA from {}", ca_dir.display());
        return Ok(MitmCa { cert_pem, key_pem });
    }

    // First start: generate + persist
    let ca = generate()?;

    std::fs::create_dir_all(ca_dir).map_err(|e| {
        BoxliteError::Network(format!("Failed to create CA dir {}: {e}", ca_dir.display()))
    })?;
    ensure_ca_dir(ca_dir)?;

    write_ca_cert(&cert_path, &ca.cert_pem)?;
    write_private_key(&key_path, &ca.key_pem)?;

    tracing::info!("MITM: generated and persisted CA to {}", ca_dir.display());
    Ok(ca)
}

#[cfg(unix)]
fn ensure_ca_dir(path: &Path) -> BoxliteResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            let current_uid = unsafe { libc::geteuid() };
            if metadata.uid() != current_uid {
                return Err(BoxliteError::Network(format!(
                    "CA dir is not owned by the current user: {}",
                    path.display()
                )));
            }

            let mode = metadata.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o700))
                    .map_err(|e| {
                        BoxliteError::Network(format!(
                            "Failed to secure CA dir permissions {}: {e}",
                            path.display()
                        ))
                    })?;
            }

            Ok(())
        }
        Ok(_) => Err(BoxliteError::Network(format!(
            "CA dir is not a real directory: {}",
            path.display()
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(BoxliteError::Network(format!(
            "Failed to inspect CA dir {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(not(unix))]
fn ensure_ca_dir(path: &Path) -> BoxliteResult<()> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(BoxliteError::Network(format!(
            "CA dir is not a directory: {}",
            path.display()
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(BoxliteError::Network(format!(
            "Failed to inspect CA dir {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(unix)]
fn read_ca_cert(path: &Path) -> BoxliteResult<String> {
    read_persisted_file(path, "CA cert")
}

#[cfg(not(unix))]
fn read_ca_cert(path: &Path) -> BoxliteResult<String> {
    std::fs::read_to_string(path).map_err(|e| {
        BoxliteError::Network(format!("Failed to read CA cert {}: {e}", path.display()))
    })
}

#[cfg(unix)]
fn read_private_key(path: &Path) -> BoxliteResult<String> {
    use std::os::unix::fs::PermissionsExt;

    let file = open_persisted_file(path, "CA key")?;
    let metadata = file.metadata().map_err(|e| {
        BoxliteError::Network(format!("Failed to inspect CA key {}: {e}", path.display()))
    })?;
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        let owner_bits = mode & 0o700;
        let secured_mode = if owner_bits & 0o200 == 0 {
            0o400
        } else {
            0o600
        };
        file.set_permissions(std::fs::Permissions::from_mode(secured_mode))
            .map_err(|e| {
                BoxliteError::Network(format!(
                    "Failed to secure CA key permissions {}: {e}",
                    path.display()
                ))
            })?;
    }

    read_to_string(file, path, "CA key")
}

#[cfg(unix)]
fn read_persisted_file(path: &Path, label: &str) -> BoxliteResult<String> {
    let file = open_persisted_file(path, label)?;
    read_to_string(file, path, label)
}

#[cfg(unix)]
fn open_persisted_file(path: &Path, label: &str) -> BoxliteResult<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let parent = path.parent().ok_or_else(|| {
        BoxliteError::Network(format!("{label} path has no parent: {}", path.display()))
    })?;
    ensure_ca_dir(parent)?;

    let path_metadata = std::fs::symlink_metadata(path).map_err(|e| {
        BoxliteError::Network(format!("Failed to inspect {label} {}: {e}", path.display()))
    })?;
    validate_persisted_file_metadata(path, label, &path_metadata)?;

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| {
            BoxliteError::Network(format!("Failed to open {label} {}: {e}", path.display()))
        })?;

    let file_metadata = file.metadata().map_err(|e| {
        BoxliteError::Network(format!("Failed to inspect {label} {}: {e}", path.display()))
    })?;
    validate_persisted_file_metadata(path, label, &file_metadata)?;

    Ok(file)
}

#[cfg(unix)]
fn read_to_string(mut file: std::fs::File, path: &Path, label: &str) -> BoxliteResult<String> {
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|e| {
        BoxliteError::Network(format!("Failed to read {label} {}: {e}", path.display()))
    })?;
    Ok(contents)
}

#[cfg(unix)]
fn validate_persisted_file_metadata(
    path: &Path,
    label: &str,
    metadata: &std::fs::Metadata,
) -> BoxliteResult<()> {
    use std::os::unix::fs::MetadataExt;

    if !metadata.file_type().is_file() {
        return Err(BoxliteError::Network(format!(
            "{label} is not a regular file: {}",
            path.display()
        )));
    }
    if metadata.nlink() != 1 {
        return Err(BoxliteError::Network(format!(
            "{label} has multiple hard links: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn read_private_key(path: &Path) -> BoxliteResult<String> {
    std::fs::read_to_string(path).map_err(|e| {
        BoxliteError::Network(format!("Failed to read CA key {}: {e}", path.display()))
    })
}

#[cfg(unix)]
fn write_ca_cert(path: &Path, contents: &str) -> BoxliteResult<()> {
    write_persisted_file(path, contents, 0o644, "CA cert")
}

#[cfg(not(unix))]
fn write_ca_cert(path: &Path, contents: &str) -> BoxliteResult<()> {
    std::fs::write(path, contents)
        .map_err(|e| BoxliteError::Network(format!("Failed to write CA cert: {e}")))
}

#[cfg(unix)]
fn write_private_key(path: &Path, contents: &str) -> BoxliteResult<()> {
    write_persisted_file(path, contents, 0o600, "CA key")
}

#[cfg(unix)]
fn write_persisted_file(path: &Path, contents: &str, mode: u32, label: &str) -> BoxliteResult<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let parent = path.parent().ok_or_else(|| {
        BoxliteError::Network(format!("{label} path has no parent: {}", path.display()))
    })?;
    ensure_ca_dir(parent)?;
    let file_name = path.file_name().ok_or_else(|| {
        BoxliteError::Network(format!("{label} path has no file name: {}", path.display()))
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
            .mode(mode)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp_path)
            .map_err(|e| BoxliteError::Network(format!("Failed to open {label} temp file: {e}")))?;

        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|e| {
                BoxliteError::Network(format!("Failed to secure {label} permissions: {e}"))
            })?;
        file.write_all(contents.as_bytes())
            .map_err(|e| BoxliteError::Network(format!("Failed to write {label}: {e}")))?;
        file.sync_all()
            .map_err(|e| BoxliteError::Network(format!("Failed to sync {label}: {e}")))?;
        drop(file);

        // `ca_dir` is runtime-owned and must not be shared with the guest. The
        // temp+rename path prevents following an existing link or truncating an
        // existing hardlinked file at the final path.
        std::fs::rename(&tmp_path, path)
            .map_err(|e| BoxliteError::Network(format!("Failed to install {label}: {e}")))?;
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
    fn test_load_or_generate_secures_new_private_key_ca_dir_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");

        load_or_generate(&ca_dir).unwrap();

        let mode = std::fs::metadata(&ca_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_secures_private_key_ca_dir_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::set_permissions(&ca_dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::write(ca_dir.join("cert.pem"), "cert").unwrap();
        let key_path = ca_dir.join("key.pem");
        std::fs::write(&key_path, "private-key").unwrap();
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let ca = load_or_generate(&ca_dir).unwrap();

        assert_eq!(ca.key_pem, "private-key");
        let mode = std::fs::metadata(&ca_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
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

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_replaces_ca_cert_symlink_without_writing_target() {
        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        let cert_path = ca_dir.join("cert.pem");
        let outside_target = dir.path().join("outside-cert.pem");
        std::fs::write(&outside_target, "sentinel").unwrap();
        std::os::unix::fs::symlink(&outside_target, &cert_path).unwrap();

        let ca = load_or_generate(&ca_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(&outside_target).unwrap(),
            "sentinel"
        );
        let metadata = std::fs::symlink_metadata(&cert_path).unwrap();
        assert!(
            !metadata.file_type().is_symlink(),
            "cert.pem should be replaced, not followed"
        );
        assert!(metadata.file_type().is_file());
        assert_eq!(std::fs::read_to_string(&cert_path).unwrap(), ca.cert_pem);
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_does_not_follow_ca_cert_symlink_on_reload() {
        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        let outside_target = dir.path().join("outside-cert.pem");
        std::fs::write(&outside_target, "sentinel").unwrap();
        std::os::unix::fs::symlink(&outside_target, ca_dir.join("cert.pem")).unwrap();
        write_private_key(&ca_dir.join("key.pem"), "private-key").unwrap();

        let err = match load_or_generate(&ca_dir) {
            Ok(_) => panic!("expected symlinked CA cert reload to fail"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("CA cert is not a regular file"),
            "unexpected error: {err}"
        );
        assert_eq!(
            std::fs::read_to_string(&outside_target).unwrap(),
            "sentinel"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_does_not_follow_private_key_symlink_on_reload() {
        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::write(ca_dir.join("cert.pem"), "cert").unwrap();
        let outside_target = dir.path().join("outside-key.pem");
        std::fs::write(&outside_target, "sentinel").unwrap();
        std::os::unix::fs::symlink(&outside_target, ca_dir.join("key.pem")).unwrap();

        let err = match load_or_generate(&ca_dir) {
            Ok(_) => panic!("expected symlinked CA key reload to fail"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("not a regular file"),
            "unexpected error: {err}"
        );
        assert_eq!(
            std::fs::read_to_string(&outside_target).unwrap(),
            "sentinel"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_rejects_hardlinked_private_key_on_reload() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::write(ca_dir.join("cert.pem"), "cert").unwrap();
        let outside_target = dir.path().join("outside-key.pem");
        std::fs::write(&outside_target, "sentinel").unwrap();
        std::fs::set_permissions(&outside_target, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::hard_link(&outside_target, ca_dir.join("key.pem")).unwrap();

        let err = match load_or_generate(&ca_dir) {
            Ok(_) => panic!("expected hardlinked CA key reload to fail"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("multiple hard links"),
            "unexpected error: {err}"
        );
        assert_eq!(
            std::fs::read_to_string(&outside_target).unwrap(),
            "sentinel"
        );
        let mode = std::fs::metadata(&outside_target)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o644);
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_rejects_symlinked_ca_dir_on_reload() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let real_ca_dir = dir.path().join("real-ca");
        std::fs::create_dir_all(&real_ca_dir).unwrap();
        std::fs::write(real_ca_dir.join("cert.pem"), "cert").unwrap();
        let key_path = real_ca_dir.join("key.pem");
        std::fs::write(&key_path, "private-key").unwrap();
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let linked_ca_dir = dir.path().join("linked-ca");
        std::os::unix::fs::symlink(&real_ca_dir, &linked_ca_dir).unwrap();

        let err = match load_or_generate(&linked_ca_dir) {
            Ok(_) => panic!("expected symlinked CA dir reload to fail"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("not a real directory"),
            "unexpected error: {err}"
        );
        assert_eq!(std::fs::read_to_string(&key_path).unwrap(), "private-key");
        let mode = std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644);
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_rejects_fifo_private_key_on_reload() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::write(ca_dir.join("cert.pem"), "cert").unwrap();
        let key_path = ca_dir.join("key.pem");
        let key_path_c = CString::new(key_path.as_os_str().as_bytes()).unwrap();
        let mkfifo_result = unsafe { libc::mkfifo(key_path_c.as_ptr(), 0o600) };
        assert_eq!(mkfifo_result, 0);

        let err = match load_or_generate(&ca_dir) {
            Ok(_) => panic!("expected FIFO CA key reload to fail"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("not a regular file"),
            "unexpected error: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_secures_existing_private_key_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::write(ca_dir.join("cert.pem"), "cert").unwrap();
        let key_path = ca_dir.join("key.pem");
        std::fs::write(&key_path, "private-key").unwrap();
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let ca = load_or_generate(&ca_dir).unwrap();

        assert_eq!(ca.key_pem, "private-key");
        let mode = std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn test_load_or_generate_preserves_strict_private_key_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca");
        std::fs::create_dir_all(&ca_dir).unwrap();
        std::fs::write(ca_dir.join("cert.pem"), "cert").unwrap();
        let key_path = ca_dir.join("key.pem");
        std::fs::write(&key_path, "private-key").unwrap();
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o400)).unwrap();

        let ca = load_or_generate(&ca_dir).unwrap();

        assert_eq!(ca.key_pem, "private-key");
        let mode = std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o400);
    }
}
