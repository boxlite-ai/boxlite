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
    pub(crate) fn pin(
        payload_root: &Path,
        sub_path: &str,
        read_only: bool,
        create_missing: bool,
    ) -> BoxliteResult<Self> {
        Self::pin_with_hook(payload_root, sub_path, read_only, create_missing, || {})
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
        create_missing: bool,
        before_pin: impl FnOnce(),
    ) -> BoxliteResult<Self> {
        if read_only && create_missing {
            return Err(BoxliteError::InvalidArgument(
                "VOLUME_SUBPATH_INVALID: read-only mount requested missing-directory creation"
                    .into(),
            ));
        }
        let directory = open_subdir(payload_root, sub_path, create_missing)?;
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
fn open_subdir(
    payload_root: &Path,
    sub_path: &str,
    create_missing: bool,
) -> BoxliteResult<OwnedFd> {
    validate_sub_path(sub_path)?;
    // O_NOFOLLOW closes the TOCTOU gap on the boundary itself: the guest never
    // follows a volume root that was replaced by a symlink after the host's
    // lstat check. Every component below is opened with openat2 no-follow flags.
    let root = open(
        payload_root,
        OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| BoxliteError::Storage(format!("open volume payload: {error}")))?;
    // Own every descriptor immediately. Reassigning `current` closes the prior
    // component; returning the final OwnedFd leaves no descriptor behind.
    let mut current = unsafe { OwnedFd::from_raw_fd(root) };
    let how = OpenHow::new()
        .flags(OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
        .resolve(
            ResolveFlag::RESOLVE_BENEATH
                | ResolveFlag::RESOLVE_NO_SYMLINKS
                | ResolveFlag::RESOLVE_NO_MAGICLINKS,
        );
    for component in sub_path.split('/') {
        let mut component_bytes = component.as_bytes().to_vec();
        component_bytes.push(0);
        let component = std::ffi::CStr::from_bytes_with_nul(&component_bytes).map_err(|_| {
            BoxliteError::InvalidArgument(format!("invalid volume sub_path {sub_path:?}"))
        })?;
        let fd = match openat2(current.as_raw_fd(), component, how) {
            Ok(fd) => fd,
            Err(nix::errno::Errno::ENOENT) if create_missing => {
                // RW cloud mounts are the only caller with create_missing=true.
                // mkdirat stays beneath the current descriptor and mode is still
                // subject to the process umask, matching the cloud contract.
                let result = unsafe {
                    nix::libc::mkdirat(
                        current.as_raw_fd(),
                        component.as_ptr(),
                        Mode::from_bits_truncate(0o755).bits(),
                    )
                };
                if result != 0 && nix::errno::Errno::last() != nix::errno::Errno::EEXIST {
                    return Err(BoxliteError::Storage(format!(
                        "create volume sub_path {sub_path:?} component {component:?}: {}",
                        nix::errno::Errno::last()
                    )));
                }
                // Another RW Box may have created the same component after our
                // ENOENT. Re-resolve it with the same no-follow flags; a symlink
                // or file still fails closed here.
                openat2(current.as_raw_fd(), component, how)
                    .map_err(|error| sub_path_error(sub_path, error))?
            }
            Err(error) => return Err(sub_path_error(sub_path, error)),
        };
        current = unsafe { OwnedFd::from_raw_fd(fd) };
    }
    Ok(current)
}

fn sub_path_error(sub_path: &str, error: nix::errno::Errno) -> BoxliteError {
    match error {
        nix::errno::Errno::ENOENT => {
            BoxliteError::NotFound(format!(
            "VOLUME_SUBPATH_NOT_FOUND: volume sub_path {sub_path:?} does not exist"
        ))
        }
        nix::errno::Errno::ELOOP | nix::errno::Errno::ENOTDIR => BoxliteError::InvalidArgument(
            format!(
                "VOLUME_SUBPATH_INVALID: volume sub_path {sub_path:?} contains a symlink or non-directory component"
            ),
        ),
        nix::errno::Errno::ENOSYS => BoxliteError::Unsupported(format!(
            "VOLUME_SUBPATH_UNSUPPORTED: volume sub_path {sub_path:?} requires openat2 support: {error}"
        )),
        _ => BoxliteError::Storage(format!(
            "VOLUME_SUBPATH_INVALID: resolve volume sub_path {sub_path:?}: {error}"
        )),
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
            "VOLUME_SUBPATH_INVALID: invalid volume sub_path {sub_path:?}"
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

        let resolved =
            ResolvedMount::pin_with_hook(root.path(), "team/backend", true, false, || {
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

    #[cfg(target_os = "linux")]
    #[test]
    fn read_write_resolves_creates_missing_components_but_read_only_does_not() {
        let root = tempfile::tempdir().unwrap();

        let created = open_subdir(root.path(), "team/backend", true).unwrap();
        assert!(root.path().join("team/backend").is_dir());
        drop(created);

        let empty = tempfile::tempdir().unwrap();
        let error = open_subdir(empty.path(), "team/backend", false).unwrap_err();
        assert!(
            matches!(&error, BoxliteError::NotFound(_))
                && error.to_string().contains("VOLUME_SUBPATH_NOT_FOUND"),
            "{error:?}"
        );
        assert!(!empty.path().join("team").exists());
        assert!(!empty.path().join("team/backend").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolver_rejects_symlink_components_and_files_without_following_them() {
        let root = tempfile::tempdir().unwrap();
        let secret = root.path().join("secret");
        std::fs::create_dir(&secret).unwrap();
        std::fs::write(secret.join("value"), b"secret").unwrap();
        std::os::unix::fs::symlink(&secret, root.path().join("team")).unwrap();
        std::fs::write(root.path().join("file"), b"file").unwrap();

        for create_missing in [false, true] {
            let error = open_subdir(root.path(), "team/value", create_missing).unwrap_err();
            assert!(
                matches!(&error, BoxliteError::InvalidArgument(_)),
                "create_missing={create_missing}: {error:?}"
            );
            assert!(!root.path().join("team/value").exists());
        }

        let error = open_subdir(root.path(), "file", false).unwrap_err();
        assert!(
            matches!(&error, BoxliteError::InvalidArgument(_)),
            "{error:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolver_never_follows_a_symlink_volume_root() {
        let parent = tempfile::tempdir().unwrap();
        let real = parent.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("value"), b"secret").unwrap();
        let link = parent.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let error = open_subdir(&link, "value", false).unwrap_err();
        assert!(matches!(error, BoxliteError::Storage(_)), "{error:?}");
        assert!(std::fs::read(real.join("value")).is_ok());
    }

    #[test]
    fn pin_cleans_mountpoint_on_success_and_failure() {
        const CHILD: &str = "BOXLITE_RESOLVED_MOUNT_CLEANUP_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new("unshare")
                .args(["--user", "--map-root-user", "--mount"])
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::resolved_mount::tests::pin_cleans_mountpoint_on_success_and_failure",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .status()
                .expect("start isolated resolved-mount cleanup test");
            assert!(
                status.success(),
                "resolved-mount cleanup test failed: {status}"
            );
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
        let parent = tempfile::tempdir().unwrap();
        let payload = parent.path().join("payload");
        std::fs::create_dir_all(payload.join("subdir")).unwrap();

        let resolved = ResolvedMount::pin(&payload, "subdir", false, false)
            .expect("pin must succeed before testing cleanup");
        let mountpoint = resolved.path().to_path_buf();
        assert!(mountpoint.exists());
        drop(resolved);

        assert!(
            !mountpoint.exists(),
            "pin must remove the mountpoint directory"
        );
        let leftovers = std::fs::read_dir(parent.path())
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

        open_subdir(directory.path(), "team/backend", false).expect("real directory");
        for invalid in [
            "/etc",
            "../escape",
            "team//backend",
            "team/./backend",
            "team/link",
            "team/\0backend",
        ] {
            let error = open_subdir(directory.path(), invalid, false)
                .err()
                .unwrap_or_else(|| panic!("{invalid} must be rejected"));
            assert!(
                matches!(&error, BoxliteError::InvalidArgument(_))
                    && error.to_string().contains("VOLUME_SUBPATH_INVALID"),
                "{invalid}: {error:?}"
            );
        }
        let error =
            open_subdir(directory.path(), "team/missing", false).expect_err("missing subdirectory");
        assert!(
            matches!(&error, BoxliteError::NotFound(_))
                && error.to_string().contains("VOLUME_SUBPATH_NOT_FOUND"),
            "{error:?}"
        );
    }
}
