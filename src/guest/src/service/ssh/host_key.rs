//! Stable guest SSH host identity.
//!
//! The private key is created once, atomically, with `0600` permissions
//! under the box's persistent shared-mount area (`GuestLayout::shared_dir()`
//! -- host-backed at `~/.boxlite/boxes/{box-id}/mounts/`, distinct from any
//! single container's rootfs so a container can never read or tamper with
//! it) and reused on every subsequent boot, so ordinary stop/start keeps the
//! same fingerprint. It never leaves the guest.

use russh::keys::{Algorithm, PrivateKey};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub(crate) enum HostKeyError {
    Io(std::io::Error),
    Parse(String),
}

impl std::fmt::Display for HostKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostKeyError::Io(e) => write!(f, "host key io error: {e}"),
            HostKeyError::Parse(e) => write!(f, "host key parse error: {e}"),
        }
    }
}

impl std::error::Error for HostKeyError {}

/// Path to the persisted host key under the guest-agent-owned area of
/// `shared_dir`, e.g. `{shared_dir}/agent/ssh/ssh_host_ed25519_key`.
pub(crate) fn host_key_path(shared_dir: &Path) -> PathBuf {
    shared_dir
        .join("agent")
        .join("ssh")
        .join("ssh_host_ed25519_key")
}

/// Load the persisted host key, or atomically create one on first boot.
///
/// "Atomic" means: generate into a sibling temp file, `set_permissions(0600)`,
/// then `rename` into place -- a crash or concurrent boot can never observe a
/// partially-written key file.
pub(crate) fn load_or_create(path: &Path) -> Result<PrivateKey, HostKeyError> {
    match std::fs::read_to_string(path) {
        Ok(pem) => {
            PrivateKey::from_openssh(pem.as_bytes()).map_err(|e| HostKeyError::Parse(e.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_atomic(path),
        Err(e) => Err(HostKeyError::Io(e)),
    }
}

fn create_atomic(path: &Path) -> Result<PrivateKey, HostKeyError> {
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(HostKeyError::Io)?;
    }

    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|e| HostKeyError::Parse(e.to_string()))?;
    let pem = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|e| HostKeyError::Parse(e.to_string()))?;

    let tmp_path = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(HostKeyError::Io)?;
        use std::io::Write;
        file.write_all(pem.as_bytes()).map_err(HostKeyError::Io)?;
        file.sync_all().map_err(HostKeyError::Io)?;
    }
    std::fs::rename(&tmp_path, path).map_err(HostKeyError::Io)?;

    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_boot_creates_key_with_0600_permissions() {
        let tmp = tempfile::tempdir().unwrap();
        let path = host_key_path(tmp.path());
        assert!(!path.exists());

        let key = load_or_create(&path).unwrap();
        assert_eq!(key.algorithm(), Algorithm::Ed25519);

        let meta = std::fs::metadata(&path).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn reuses_persisted_key_across_reloads() {
        let tmp = tempfile::tempdir().unwrap();
        let path = host_key_path(tmp.path());

        let first = load_or_create(&path).unwrap();
        let second = load_or_create(&path).unwrap();

        assert_eq!(
            first.public_key().to_openssh().unwrap(),
            second.public_key().to_openssh().unwrap(),
            "stop/start must reuse the same host key, not mint a new one"
        );
    }

    #[test]
    fn key_lives_outside_any_container_rootfs_subtree() {
        let tmp = tempfile::tempdir().unwrap();
        let path = host_key_path(tmp.path());
        let container_rootfs = tmp.path().join("containers").join("c1").join("rootfs");
        assert!(!path.starts_with(&container_rootfs));
    }

    #[test]
    fn rejects_corrupt_key_file_instead_of_silently_regenerating() {
        let tmp = tempfile::tempdir().unwrap();
        let path = host_key_path(tmp.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not a valid openssh private key").unwrap();

        let err = load_or_create(&path).unwrap_err();
        assert!(matches!(err, HostKeyError::Parse(_)));
    }
}
