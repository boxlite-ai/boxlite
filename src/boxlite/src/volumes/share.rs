//! How a volume host path maps onto a virtio-fs share.

use std::path::{Path, PathBuf};

/// How a volume host path is exposed over virtio-fs.
///
/// virtio-fs can only share a directory, so a single file is staged into a
/// dedicated directory and bind-mounted by name inside the guest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VolumeShare {
    /// Share the whole directory as-is.
    Dir(PathBuf),
    /// A single file; the value is its file name.
    File(String),
}

/// Classify a volume host path for virtio-fs sharing. Returns `None` when the
/// path is neither a file nor a directory (or a file without a usable name),
/// leaving the error to the caller.
pub fn classify_volume_share(host_path: &Path) -> Option<VolumeShare> {
    if host_path.is_dir() {
        Some(VolumeShare::Dir(host_path.to_path_buf()))
    } else if host_path.is_file() {
        let name = host_path.file_name()?.to_str()?.to_string();
        Some(VolumeShare::File(name))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_directory_as_whole_dir_share() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            classify_volume_share(tmp.path()),
            Some(VolumeShare::Dir(tmp.path().to_path_buf()))
        );
    }

    #[test]
    fn classifies_file_as_its_name() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("app.conf");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            classify_volume_share(&file),
            Some(VolumeShare::File("app.conf".to_string()))
        );
    }

    #[test]
    fn classifies_nonexistent_path_as_none() {
        assert_eq!(classify_volume_share(Path::new("/no/such/path/xyz")), None);
    }
}
