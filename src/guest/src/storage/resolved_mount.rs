use std::ffi::CString;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::fcntl::{open, openat2, OFlag, OpenHow, ResolveFlag};
use nix::mount::{mount, umount, MsFlags};
use nix::sys::stat::Mode;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;

use super::idmap::sys;

pub(crate) struct ResolvedMount {
    path: PathBuf,
}

/// Owns a temporary mountpoint until the resolved mount is fully armed.
struct MountpointGuard {
    path: PathBuf,
    mounted: bool,
    armed: bool,
}

impl MountpointGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            mounted: false,
            armed: true,
        }
    }

    /// Transfer the mountpoint to `ResolvedMount` without cleanup on drop.
    fn disarm(mut self) -> PathBuf {
        self.armed = false;
        self.path.clone()
    }
}

/// Remove partial setup when mounting fails before ownership is transferred.
impl Drop for MountpointGuard {
    fn drop(&mut self) {
        if self.armed {
            cleanup_mountpoint(&self.path, self.mounted);
        }
    }
}

impl ResolvedMount {
    pub(crate) fn pin(payload_root: &Path, sub_path: &str, read_only: bool) -> BoxliteResult<Self> {
        Self::pin_with_hook(payload_root, sub_path, read_only, || {})
    }

    /// Pin a volume subdirectory at a temporary mountpoint.
    ///
    /// Clone the resolved directory into a mountable tree, move that tree onto
    /// a pre-created guarded directory, then remount the bind read-only when
    /// requested. The guard removes the mountpoint if any step fails.
    fn pin_with_hook(
        payload_root: &Path,
        sub_path: &str,
        read_only: bool,
        before_pin: impl FnOnce(),
    ) -> BoxliteResult<Self> {
        let directory = open_subdir(payload_root, sub_path)?;
        before_pin();
        // Pre-create a unique directory before mounting so the move target is
        // private and can be removed deterministically on error.
        let path = payload_root
            .parent()
            .unwrap_or(payload_root)
            .join(format!(".resolved-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&path).map_err(|error| {
            BoxliteError::Storage(format!(
                "create resolved mount point {}: {error}",
                path.display()
            ))
        })?;
        let mut guard = MountpointGuard::new(path);
        let target = CString::new(guard.path.as_os_str().as_bytes()).map_err(|_| {
            BoxliteError::InvalidArgument("resolved mount point contains NUL".into())
        })?;
        let empty = CString::new("").unwrap();
        let tree = sys::open_tree(
            directory.as_raw_fd(),
            &empty,
            sys::OPEN_TREE_CLONE | sys::OPEN_TREE_CLOEXEC | sys::AT_EMPTY_PATH,
        )
        .map_err(|error| {
            BoxliteError::Unsupported(format!(
                "open_tree is required for volume sub_path mounts: {error}"
            ))
        })?;
        sys::move_mount(
            tree.as_raw_fd(),
            &empty,
            nix::libc::AT_FDCWD,
            &target,
            sys::MOVE_MOUNT_F_EMPTY_PATH,
        )
        .map_err(|error| {
            BoxliteError::Unsupported(format!(
                "move_mount is required for volume sub_path mounts: {error}"
            ))
        })?;
        guard.mounted = true;
        if read_only {
            mount(
                None::<&str>,
                &guard.path,
                None::<&str>,
                MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
                None::<&str>,
            )
            .map_err(|error| {
                BoxliteError::Storage(format!(
                    "failed to make resolved volume mount read-only at {}: {error}",
                    guard.path.display()
                ))
            })?;
        }
        Ok(Self {
            path: guard.disarm(),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// Unmount and remove the mountpoint owned for the container's lifetime.
impl Drop for ResolvedMount {
    fn drop(&mut self) {
        cleanup_mountpoint(&self.path, true);
    }
}

/// Best-effort teardown; warnings do not mask the container outcome.
fn cleanup_mountpoint(path: &Path, mounted: bool) {
    if mounted {
        if let Err(error) = umount(path) {
            tracing::warn!(path = %path.display(), %error, "Failed to unmount resolved volume");
        }
    }
    if let Err(error) = std::fs::remove_dir(path) {
        tracing::warn!(path = %path.display(), %error, "Failed to remove resolved mount point");
    }
}

/// Open a payload-relative directory without allowing path-based escape.
///
/// `RESOLVE_BENEATH` keeps resolution under the volume root, while refusing
/// symlinks and magic links prevents a payload-controlled link from redirecting
/// to a host path outside the volume.
fn open_subdir(payload_root: &Path, sub_path: &str) -> BoxliteResult<OwnedFd> {
    validate_sub_path(sub_path)?;
    let root = open(
        payload_root,
        OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| BoxliteError::Storage(format!("open volume payload: {error}")))?;
    let how = OpenHow::new()
        .flags(OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
        .resolve(
            ResolveFlag::RESOLVE_BENEATH
                | ResolveFlag::RESOLVE_NO_SYMLINKS
                | ResolveFlag::RESOLVE_NO_MAGICLINKS,
        );
    let fd = openat2(root.as_raw_fd(), sub_path, how)
        .map_err(|error| sub_path_error(sub_path, error))?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn sub_path_error(sub_path: &str, error: nix::errno::Errno) -> BoxliteError {
    match error {
        nix::errno::Errno::ENOENT => {
            BoxliteError::NotFound(format!("volume sub_path {sub_path:?} does not exist"))
        }
        nix::errno::Errno::ELOOP | nix::errno::Errno::ENOTDIR => BoxliteError::InvalidArgument(
            format!("volume sub_path {sub_path:?} contains a symlink or non-directory component"),
        ),
        nix::errno::Errno::ENOSYS => BoxliteError::Unsupported(format!(
            "volume sub_path {sub_path:?} requires openat2 support: {error}"
        )),
        _ => BoxliteError::Storage(format!("resolve volume sub_path {sub_path:?}: {error}")),
    }
}

fn validate_sub_path(sub_path: &str) -> BoxliteResult<()> {
    if sub_path.is_empty()
        || sub_path.contains('\0')
        || sub_path.len() > 4096
        || sub_path.starts_with('/')
        || sub_path.ends_with('/')
        || sub_path.split('/').count() > 64
        || sub_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || sub_path.split('/').any(|part| part.len() > 255)
    {
        return Err(BoxliteError::InvalidArgument(format!(
            "invalid volume sub_path {sub_path:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_mount_survives_path_replacement_and_stays_read_only() {
        const CHILD: &str = "BOXLITE_RESOLVED_MOUNT_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new("unshare")
                .args(["--user", "--map-root-user", "--mount"])
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::resolved_mount::tests::resolved_mount_survives_path_replacement_and_stays_read_only",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .status()
                .expect("start isolated resolved-mount test");
            assert!(status.success(), "resolved-mount test failed: {status}");
            return;
        }
        mount(
            None::<&str>,
            Path::new("/"),
            None::<&str>,
            MsFlags::MS_REC | MsFlags::MS_PRIVATE,
            None::<&str>,
        )
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let backend = root.path().join("team/backend");
        let moved = root.path().join("team/moved");
        let sibling = root.path().join("sibling");
        std::fs::create_dir_all(&backend).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        std::fs::write(backend.join("result"), b"original").unwrap();
        std::fs::write(sibling.join("secret"), b"secret").unwrap();

        let resolved = ResolvedMount::pin_with_hook(root.path(), "team/backend", true, || {
            std::fs::rename(&backend, &moved).unwrap();
            std::os::unix::fs::symlink(&sibling, &backend).unwrap();
        });
        let resolved = resolved.expect("pin the original directory");
        assert_eq!(
            std::fs::read(resolved.path().join("result")).unwrap(),
            b"original"
        );
        assert!(!resolved.path().join("secret").exists());
        assert_eq!(
            std::fs::write(resolved.path().join("result"), b"changed")
                .unwrap_err()
                .raw_os_error(),
            Some(nix::libc::EROFS)
        );
        drop(resolved);
        assert_eq!(std::fs::read(moved.join("result")).unwrap(), b"original");
    }

    #[test]
    fn missing_openat2_is_unsupported() {
        let error = sub_path_error("workspace", nix::errno::Errno::ENOSYS);
        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
    }

    #[test]
    fn pin_cleans_mountpoint_on_success_and_failure() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("subdir")).unwrap();

        let result = ResolvedMount::pin(directory.path(), "subdir", false);
        drop(result);

        let leftovers = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().starts_with(".resolved-"))
            .count();
        assert_eq!(leftovers, 0, "pin must not leave mountpoint directories");
    }

    #[test]
    fn subdir_resolution_rejects_escape_and_symlink() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("team/backend")).unwrap();
        std::os::unix::fs::symlink("backend", directory.path().join("team/link")).unwrap();

        open_subdir(directory.path(), "team/backend").expect("real directory");
        for invalid in [
            "/etc",
            "../escape",
            "team//backend",
            "team/./backend",
            "team/link",
            "team/\0backend",
        ] {
            let error = open_subdir(directory.path(), invalid)
                .err()
                .unwrap_or_else(|| panic!("{invalid} must be rejected"));
            assert!(
                matches!(error, BoxliteError::InvalidArgument(_)),
                "{invalid}: {error:?}"
            );
        }
        let error =
            open_subdir(directory.path(), "team/missing").expect_err("missing subdirectory");
        assert!(matches!(error, BoxliteError::NotFound(_)), "{error:?}");
    }
}
