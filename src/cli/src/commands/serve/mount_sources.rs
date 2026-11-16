//! Operator-owned roots stay pinned for the server lifetime. Client paths are
//! resolved beneath those descriptors without following symlinks.
use std::fs::File;
use std::path::{Component, Path, PathBuf};

#[derive(Default)]
pub(super) struct MountSources(Vec<(PathBuf, File)>);

impl MountSources {
    pub(super) fn new(roots: &[PathBuf]) -> anyhow::Result<Self> {
        let mut grants = Vec::new();
        for root in roots {
            anyhow::ensure!(root.is_absolute(), "mount source root must be absolute");
            let canonical = root.canonicalize()?;
            anyhow::ensure!(
                canonical == *root,
                "mount source root must be canonical and contain no symlinks"
            );
            let directory = open_beneath(&File::open("/")?, root.strip_prefix("/")?)?;
            grants.push((canonical, directory));
        }
        Ok(Self(grants))
    }

    pub(super) fn pin(&self, source: &Path) -> anyhow::Result<File> {
        anyhow::ensure!(source.is_absolute(), "mount source must be absolute");
        anyhow::ensure!(
            source
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
            "mount source must be canonical"
        );
        for (root, directory) in &self.0 {
            if let Ok(relative) = source.strip_prefix(root) {
                return open_beneath(directory, relative);
            }
        }
        anyhow::bail!("host source is not authorized by --mount-source-root")
    }
}

#[cfg(target_os = "linux")]
fn open_beneath(root: &File, path: &Path) -> anyhow::Result<File> {
    use nix::libc;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    let path = CString::new(if path.as_os_str().is_empty() {
        b".".as_slice()
    } else {
        path.as_os_str().as_bytes()
    })?;
    let how = OpenHow {
        flags: (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
        mode: 0,
        // RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS.
        resolve: 0x08 | 0x04 | 0x02,
    };
    // SAFETY: both pointers reference live, initialized syscall arguments;
    // successful openat2 returns a fresh descriptor owned by this File.
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}

#[cfg(not(target_os = "linux"))]
fn open_beneath(_root: &File, _path: &Path) -> anyhow::Result<File> {
    anyhow::bail!("REST mount source grants require Linux openat2")
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    fn grants_deny_by_default_and_pin_only_real_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("allowed")).unwrap();
        assert!(MountSources::default().pin(&root).is_err());
        let grants = MountSources::new(std::slice::from_ref(&root)).unwrap();
        assert!(grants.pin(&root.join("allowed")).is_ok());
        assert!(grants.pin(&root.join("../outside")).is_err());
        assert!(grants.pin(Path::new("/etc")).is_err());
        std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
        assert!(grants.pin(&root.join("escape")).is_err());
        std::os::unix::fs::symlink(root.join("allowed"), root.join("alias")).unwrap();
        assert!(grants.pin(&root.join("alias")).is_err());
    }
    #[test]
    fn granted_root_and_source_identity_survive_path_replacement() {
        use std::os::unix::fs::MetadataExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("root");
        std::fs::create_dir_all(root.join("source")).unwrap();
        let grants = MountSources::new(std::slice::from_ref(&root)).unwrap();
        let source = grants.pin(&root.join("source")).unwrap();
        let inode = source.metadata().unwrap().ino();
        std::fs::rename(&root, root.with_file_name("moved")).unwrap();
        std::fs::create_dir_all(root.join("source")).unwrap();
        assert_eq!(
            grants
                .pin(&root.join("source"))
                .unwrap()
                .metadata()
                .unwrap()
                .ino(),
            inode
        );
        assert_eq!(source.metadata().unwrap().ino(), inode);
        assert_ne!(std::fs::metadata(root.join("source")).unwrap().ino(), inode);
    }
}
