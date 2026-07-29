//! Persistent Ed25519 host identity for the embedded SSH server.

use russh::keys::{Algorithm, PrivateKey};
use std::path::{Path, PathBuf};

pub(crate) const DEFAULT_HOST_KEY_PATH: &str = "/var/lib/boxlite/ssh/ssh_host_ed25519_key";

#[derive(Debug)]
pub(crate) enum HostKeyError {
    Io(std::io::Error),
    InvalidFile(String),
    Parse(String),
}

impl std::fmt::Display for HostKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "host key I/O error: {error}"),
            Self::InvalidFile(error) => write!(f, "invalid host key file: {error}"),
            Self::Parse(error) => write!(f, "host key parse error: {error}"),
        }
    }
}

impl std::error::Error for HostKeyError {}

pub(crate) fn default_path() -> PathBuf {
    PathBuf::from(DEFAULT_HOST_KEY_PATH)
}

/// Load the stable host key, or create it atomically on first boot.
pub(crate) fn load_or_create(path: &Path) -> Result<PrivateKey, HostKeyError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => load_existing(path, &metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_atomic(path),
        Err(error) => Err(HostKeyError::Io(error)),
    }
}

fn load_existing(path: &Path, metadata: &std::fs::Metadata) -> Result<PrivateKey, HostKeyError> {
    use std::os::unix::fs::PermissionsExt;

    if !metadata.file_type().is_file() {
        return Err(HostKeyError::InvalidFile(
            "path must be a regular file".into(),
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(HostKeyError::InvalidFile(
            "group or other permissions are not allowed".into(),
        ));
    }

    let encoded = std::fs::read(path).map_err(HostKeyError::Io)?;
    let key = PrivateKey::from_openssh(&encoded)
        .map_err(|error| HostKeyError::Parse(error.to_string()))?;
    if key.algorithm() != Algorithm::Ed25519 {
        return Err(HostKeyError::InvalidFile(format!(
            "unsupported algorithm {}; expected Ed25519",
            key.algorithm()
        )));
    }
    Ok(key)
}

fn create_atomic(path: &Path) -> Result<PrivateKey, HostKeyError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let parent = path.parent().ok_or_else(|| {
        HostKeyError::InvalidFile("host key path must have a parent directory".into())
    })?;
    std::fs::create_dir_all(parent).map_err(HostKeyError::Io)?;

    let mut rng = russh::keys::key::safe_rng();
    let key = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|error| HostKeyError::Parse(error.to_string()))?;
    let encoded = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|error| HostKeyError::Parse(error.to_string()))?;

    let temp_path = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let write_result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp_path)
            .map_err(HostKeyError::Io)?;
        file.write_all(encoded.as_bytes())
            .map_err(HostKeyError::Io)?;
        file.sync_all().map_err(HostKeyError::Io)?;
        std::fs::rename(&temp_path, path).map_err(HostKeyError::Io)?;
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(HostKeyError::Io)?;
        Ok::<(), HostKeyError>(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result?;

    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_private_ed25519_key_and_reuses_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("ssh").join("host_key");

        let first = load_or_create(&path).unwrap();
        let second = load_or_create(&path).unwrap();

        assert_eq!(first.algorithm(), Algorithm::Ed25519);
        assert_eq!(
            first.public_key().to_openssh().unwrap(),
            second.public_key().to_openssh().unwrap()
        );

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn rejects_corrupt_or_overexposed_existing_keys() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("host_key");
        std::fs::write(&path, b"not an openssh private key").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(load_or_create(&path), Err(HostKeyError::Parse(_))));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            load_or_create(&path),
            Err(HostKeyError::InvalidFile(_))
        ));
    }

    #[test]
    fn rejects_a_non_ed25519_existing_host_key() {
        use russh::keys::EcdsaCurve;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("host_key");
        let mut rng = russh::keys::key::safe_rng();
        let key = PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        std::fs::write(
            &path,
            key.to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        assert!(matches!(
            load_or_create(&path),
            Err(HostKeyError::InvalidFile(_))
        ));
    }

    #[test]
    fn production_key_is_not_under_the_late_mounted_runtime_tree() {
        assert!(!default_path().starts_with("/run/boxlite"));
    }
}
