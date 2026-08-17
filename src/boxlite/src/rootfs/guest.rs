//! Guest rootfs types and metadata.

use std::fs;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::runtime::constants::guest_paths;

/// The immutable guest rootfs packaged with the BoxLite runtime.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GuestRootfs {
    /// Path to the merged/final rootfs directory
    pub path: PathBuf,

    /// Environment variables from the init image config (e.g., PATH)
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

impl GuestRootfs {
    /// Resolve and validate the immutable rootfs packaged with the runtime.
    pub fn from_bundled_rootfs(path: PathBuf) -> BoxliteResult<Self> {
        let path = path.canonicalize().map_err(|error| {
            BoxliteError::Storage(format!(
                "Failed to resolve bundled guest rootfs {}: {error}",
                path.display()
            ))
        })?;
        if !path.is_dir() {
            return Err(BoxliteError::Storage(format!(
                "Bundled guest rootfs is not a directory: {}",
                path.display()
            )));
        }

        for relative in [
            "dev",
            "proc",
            "run",
            "sys",
            "tmp",
            "var",
            "var/tmp",
            "boxlite",
            "boxlite/bin",
        ] {
            Self::validate_bundled_entry(&path, relative, true)?;
        }
        for relative in [
            "boxlite/bin/boxlite-guest",
            "boxlite/bin/mke2fs",
            "boxlite/bin/resize2fs",
        ] {
            Self::validate_bundled_entry(&path, relative, false)?;
            crate::vmm::guest_check::validate_guest_file(&path.join(relative))?;
        }

        Ok(Self {
            path,
            env: vec![("PATH".to_string(), guest_paths::BIN_DIR.to_string())],
        })
    }

    fn validate_bundled_entry(
        root: &Path,
        relative: &str,
        is_directory: bool,
    ) -> BoxliteResult<()> {
        let path = root.join(relative);
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            BoxliteError::Storage(format!(
                "Invalid bundled guest rootfs entry {}: {error}",
                path.display()
            ))
        })?;
        if metadata.file_type().is_symlink()
            || (is_directory && !metadata.is_dir())
            || (!is_directory && !metadata.is_file())
        {
            return Err(BoxliteError::Storage(format!(
                "Invalid bundled guest rootfs entry: {}",
                path.display()
            )));
        }
        #[cfg(unix)]
        if !is_directory {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(BoxliteError::Storage(format!(
                    "Bundled guest rootfs executable is not executable: {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn guest_elf() -> Vec<u8> {
        let mut binary = vec![0_u8; 120];
        binary[..4].copy_from_slice(b"\x7fELF");
        binary[4] = 2;
        binary[5] = 1;
        binary[6] = 1;
        let machine = match std::env::consts::ARCH {
            "x86_64" => 0x3e_u16,
            "aarch64" => 0xb7_u16,
            other => panic!("unsupported test architecture: {other}"),
        };
        binary[16..18].copy_from_slice(&2_u16.to_le_bytes());
        binary[18..20].copy_from_slice(&machine.to_le_bytes());
        binary[20..24].copy_from_slice(&1_u32.to_le_bytes());
        binary[24..32].copy_from_slice(&0x400040_u64.to_le_bytes());
        binary[32..40].copy_from_slice(&64_u64.to_le_bytes());
        binary[52..54].copy_from_slice(&64_u16.to_le_bytes());
        binary[54..56].copy_from_slice(&56_u16.to_le_bytes());
        binary[56..58].copy_from_slice(&1_u16.to_le_bytes());
        binary[64..68].copy_from_slice(&1_u32.to_le_bytes());
        binary[68..72].copy_from_slice(&1_u32.to_le_bytes());
        binary[80..88].copy_from_slice(&0x400000_u64.to_le_bytes());
        let file_len = binary.len() as u64;
        binary[96..104].copy_from_slice(&file_len.to_le_bytes());
        binary[104..112].copy_from_slice(&file_len.to_le_bytes());
        binary
    }

    fn bundled_rootfs() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for relative in ["dev", "proc", "run", "sys", "tmp", "var/tmp", "boxlite/bin"] {
            std::fs::create_dir_all(root.path().join(relative)).unwrap();
        }
        for binary in ["boxlite-guest", "mke2fs", "resize2fs"] {
            let path = root.path().join("boxlite/bin").join(binary);
            let contents = guest_elf();
            std::fs::write(&path, contents).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        root
    }

    #[test]
    fn bundled_rootfs_requires_the_complete_minimal_inventory() {
        let root = bundled_rootfs();
        let resolved = GuestRootfs::from_bundled_rootfs(root.path().to_path_buf()).unwrap();
        assert_eq!(
            resolved.env,
            vec![("PATH".into(), guest_paths::BIN_DIR.into())]
        );
    }

    #[test]
    fn bundled_rootfs_rejects_invalid_mke2fs() {
        let root = bundled_rootfs();
        let mke2fs = root.path().join("boxlite/bin/mke2fs");
        std::fs::write(&mke2fs, b"not an ELF").unwrap();

        let error = GuestRootfs::from_bundled_rootfs(root.path().to_path_buf()).unwrap_err();
        assert!(error.to_string().contains("mke2fs"));
        assert!(error.to_string().contains("ELF"));
    }

    #[test]
    fn bundled_rootfs_rejects_dynamic_guest_binary() {
        let root = bundled_rootfs();
        let guest = root.path().join("boxlite/bin/boxlite-guest");
        let mut binary = guest_elf();
        binary[64..68].copy_from_slice(&3_u32.to_le_bytes());
        std::fs::write(&guest, binary).unwrap();

        let error = GuestRootfs::from_bundled_rootfs(root.path().to_path_buf()).unwrap_err();
        assert!(error.to_string().contains("dynamically linked"));
    }

    #[test]
    fn bundled_rootfs_rejects_guest_without_loadable_segment() {
        let root = bundled_rootfs();
        let guest = root.path().join("boxlite/bin/boxlite-guest");
        let mut binary = guest_elf();
        binary[64..68].copy_from_slice(&0_u32.to_le_bytes());
        std::fs::write(&guest, binary).unwrap();

        let error = GuestRootfs::from_bundled_rootfs(root.path().to_path_buf()).unwrap_err();
        assert!(error.to_string().contains("no loadable ELF segment"));
    }

    #[test]
    fn bundled_rootfs_rejects_symlinked_executables() {
        let root = bundled_rootfs();
        let guest = root.path().join("boxlite/bin/boxlite-guest");
        std::fs::remove_file(&guest).unwrap();
        std::os::unix::fs::symlink("mke2fs", &guest).unwrap();

        let error = GuestRootfs::from_bundled_rootfs(root.path().to_path_buf()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid bundled guest rootfs entry")
        );
    }
}
