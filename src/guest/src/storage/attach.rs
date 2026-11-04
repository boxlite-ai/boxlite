//! Attach a shared folder into a running container, read-only.
//!
//! The folder lives in the guest's own mount namespace, inside the Box share
//! under `/run/boxlite/shared`. It is cloned with `open_tree`, made read-only,
//! and moved by a forked child into the mount namespace of a process in the
//! container, so the caller's namespace never changes. Every process in the
//! container then sees the folder. The container's root filesystem gains only
//! the empty mount point, and a destination that already has entries is
//! refused, so no image content is hidden.
//!
//! It forks, so the guest calls it only from the single-threaded zygote: a
//! child forked from the multithreaded runtime can inherit musl's allocator
//! lock held and deadlock (`main.rs`, concurrent-exec-deadlock.md). The child
//! makes only system calls on buffers prepared before the fork.

use std::ffi::{CStr, CString};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::libc;
use nix::unistd::{fork, ForkResult, Pid};

use super::idmap::sys;

/// Accept only an absolute path of normal components other than `/`.
pub(crate) fn validate_destination(destination: &Path) -> BoxliteResult<()> {
    let mut components = destination.components();
    let rooted = components.next() == Some(Component::RootDir);
    let mut parts = 0;
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return Err(bad_destination(destination));
        }
        parts += 1;
    }
    if !rooted || parts == 0 {
        return Err(bad_destination(destination));
    }
    Ok(())
}

fn bad_destination(destination: &Path) -> BoxliteError {
    BoxliteError::InvalidArgument(format!(
        "mount destination must be an absolute path below /, without `..`: {:?}",
        destination
    ))
}

/// Bind `source` read-only at `destination` inside the mount namespace of
/// `target`. A missing destination is created; one with entries is refused.
pub(crate) fn attach_read_only(
    source: &Path,
    target: Pid,
    destination: &Path,
) -> BoxliteResult<()> {
    validate_destination(destination)?;
    let namespace = File::open(format!("/proc/{target}/ns/mnt")).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            BoxliteError::NotFound(format!("container process {target} is gone"))
        } else {
            BoxliteError::Storage(format!("open the mount namespace of {target}: {error}"))
        }
    })?;
    let tree = clone_read_only(source)?;
    // Everything the child needs is allocated here: after fork it may only
    // make system calls.
    let prefixes = path_prefixes(destination)?;
    let (report_read, report_write) = nix::unistd::pipe()
        .map_err(|error| BoxliteError::Storage(format!("create a report pipe: {error}")))?;

    // SAFETY: the child makes only system calls on prepared buffers, then exits.
    match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            drop(report_read);
            let report = attach_in_child(namespace.as_raw_fd(), tree.as_raw_fd(), &prefixes);
            let bytes = report.encode();
            // SAFETY: a plain write of a stack buffer to an owned pipe, then exit.
            unsafe {
                libc::write(report_write.as_raw_fd(), bytes.as_ptr().cast(), bytes.len());
                libc::_exit(0)
            }
        }
        Ok(ForkResult::Parent { child }) => {
            drop(report_write);
            let report = Report::read(&report_read);
            // The child may already be reaped where SIGCHLD is ignored; the
            // report pipe, not the exit status, carries the outcome.
            let _ = nix::sys::wait::waitpid(child, None);
            report.into_result(target, destination)
        }
        Err(error) => Err(BoxliteError::Storage(format!(
            "fork to enter the mount namespace of {target}: {error}"
        ))),
    }
}

/// Clone `source` as a detached, read-only mount tree.
fn clone_read_only(source: &Path) -> BoxliteResult<OwnedFd> {
    let path = c_path(source)?;
    let tree = sys::open_tree(
        libc::AT_FDCWD,
        &path,
        sys::OPEN_TREE_CLONE | sys::OPEN_TREE_CLOEXEC | sys::AT_RECURSIVE,
    )
    .map_err(|error| BoxliteError::Storage(format!("clone {}: {error}", source.display())))?;
    let read_only = sys::MountAttr {
        attr_set: sys::MOUNT_ATTR_RDONLY,
        attr_clr: 0,
        propagation: 0,
        userns_fd: 0,
    };
    sys::mount_setattr(
        tree.as_raw_fd(),
        c"",
        sys::AT_EMPTY_PATH | sys::AT_RECURSIVE,
        &read_only,
    )
    .map_err(|error| {
        BoxliteError::Storage(format!("make {} read-only: {error}", source.display()))
    })?;
    Ok(tree)
}

/// `/a`, `/a/b`, `/a/b/c` for `/a/b/c`: the directories to create, in order.
fn path_prefixes(destination: &Path) -> BoxliteResult<Vec<CString>> {
    let mut prefix = PathBuf::from("/");
    let mut prefixes = Vec::new();
    for component in destination.components().skip(1) {
        prefix.push(component);
        prefixes.push(c_path(&prefix)?);
    }
    Ok(prefixes)
}

fn c_path(path: &Path) -> BoxliteResult<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| BoxliteError::InvalidArgument(format!("path has a NUL byte: {:?}", path)))
}

/// Where the child stopped, and the errno there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Attached = 0,
    JoinNamespace = 1,
    CreateMountPoint = 2,
    HasEntries = 3,
    OpenMountPoint = 4,
    ListMountPoint = 5,
    Attach = 6,
}

struct Report {
    stage: Option<Stage>,
    errno: i32,
}

impl Report {
    fn new(stage: Stage, errno: i32) -> Self {
        Self {
            stage: Some(stage),
            errno,
        }
    }

    fn encode(&self) -> [u8; 5] {
        let [a, b, c, d] = self.errno.to_le_bytes();
        [self.stage.map_or(u8::MAX, |stage| stage as u8), a, b, c, d]
    }

    fn read(pipe: &OwnedFd) -> Self {
        let mut bytes = [0u8; 5];
        let complete = matches!(nix::unistd::read(pipe.as_raw_fd(), &mut bytes), Ok(5));
        let stage = [
            Stage::Attached,
            Stage::JoinNamespace,
            Stage::CreateMountPoint,
            Stage::HasEntries,
            Stage::OpenMountPoint,
            Stage::ListMountPoint,
            Stage::Attach,
        ]
        .into_iter()
        .find(|stage| complete && *stage as u8 == bytes[0]);
        Self {
            stage,
            errno: i32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]),
        }
    }

    fn into_result(self, target: Pid, destination: &Path) -> BoxliteResult<()> {
        let errno = io::Error::from_raw_os_error(self.errno);
        let place = destination.display();
        match self.stage {
            Some(Stage::Attached) => Ok(()),
            Some(Stage::HasEntries) => Err(BoxliteError::InvalidState(format!(
                "{place} already has entries in the container; mounting there would hide them"
            ))),
            Some(Stage::JoinNamespace) => Err(BoxliteError::Storage(format!(
                "join the mount namespace of {target}: {errno}"
            ))),
            Some(Stage::CreateMountPoint) => {
                Err(BoxliteError::Storage(format!("create {place}: {errno}")))
            }
            Some(Stage::OpenMountPoint) | Some(Stage::ListMountPoint) => {
                Err(BoxliteError::Storage(format!("read {place}: {errno}")))
            }
            Some(Stage::Attach) => Err(BoxliteError::Storage(format!(
                "mount at {place} in {target}: {errno}"
            ))),
            None => Err(BoxliteError::Internal(format!(
                "the child entering {target} exited without a report"
            ))),
        }
    }
}

/// Runs in the forked child: join the namespace, create the mount point, check
/// it is empty, attach. System calls only. The mount goes onto the directory
/// fd that was checked, so a container process cannot swap in another
/// directory between the check and the mount.
fn attach_in_child(namespace: RawFd, tree: RawFd, prefixes: &[CString]) -> Report {
    let errno = || io::Error::last_os_error().raw_os_error().unwrap_or(0);
    // SAFETY: plain system calls on owned descriptors and prepared paths.
    unsafe {
        if libc::setns(namespace, libc::CLONE_NEWNS) != 0 {
            return Report::new(Stage::JoinNamespace, errno());
        }
        for prefix in prefixes {
            if libc::mkdir(prefix.as_ptr(), 0o755) != 0 && errno() != libc::EEXIST {
                return Report::new(Stage::CreateMountPoint, errno());
            }
        }
        let Some(mount_point) = prefixes.last() else {
            return Report::new(Stage::CreateMountPoint, libc::EINVAL);
        };
        let directory = libc::open(
            mount_point.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        );
        if directory < 0 {
            return Report::new(Stage::OpenMountPoint, errno());
        }
        let report = match has_entries(directory) {
            Err(code) => Report::new(Stage::ListMountPoint, code),
            Ok(true) => Report::new(Stage::HasEntries, 0),
            Ok(false) => match sys::move_mount(
                tree,
                c"",
                directory,
                c"",
                sys::MOVE_MOUNT_F_EMPTY_PATH | sys::MOVE_MOUNT_T_EMPTY_PATH,
            ) {
                Ok(()) => Report::new(Stage::Attached, 0),
                Err(error) => Report::new(Stage::Attach, error.raw_os_error().unwrap_or(0)),
            },
        };
        libc::close(directory);
        report
    }
}

/// Whether the open directory `directory` has any entry besides `.` and `..`,
/// read with `getdents64` into a stack buffer.
fn has_entries(directory: RawFd) -> Result<bool, i32> {
    let mut buffer = [0u8; 1024];
    loop {
        // SAFETY: the kernel fills at most `buffer.len()` bytes.
        let read = unsafe {
            libc::syscall(
                libc::SYS_getdents64,
                directory,
                buffer.as_mut_ptr(),
                buffer.len(),
            )
        };
        if read < 0 {
            return Err(io::Error::last_os_error().raw_os_error().unwrap_or(0));
        }
        if read == 0 {
            return Ok(false);
        }
        // Each record: d_ino (8), d_off (8), d_reclen (2), d_type (1), d_name.
        let mut offset = 0usize;
        while offset < read as usize {
            let length = u16::from_ne_bytes([buffer[offset + 16], buffer[offset + 17]]) as usize;
            let name = &buffer[offset + 19..offset + length];
            let name = CStr::from_bytes_until_nul(name).map_or(name, CStr::to_bytes);
            if name != b"." && name != b".." {
                return Ok(true);
            }
            offset += length;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite_shared::errors::BoxliteError;
    use nix::libc;
    use std::fs;
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::path::PathBuf;

    #[test]
    fn destination_must_be_absolute_and_normal() {
        for bad in ["opt/boxlite/agents", "/opt/../etc", "/", ""] {
            let error = validate_destination(Path::new(bad)).expect_err(bad);
            assert!(
                matches!(error, BoxliteError::InvalidArgument(_)),
                "{bad:?}: {error}"
            );
        }
        validate_destination(Path::new("/opt/boxlite/agents")).unwrap();
    }

    /// A child process in its own mount namespace that lives until dropped,
    /// standing in for a running container. The child makes only raw system
    /// calls, because the test harness forks it from a multithreaded process.
    struct NamespaceHolder {
        pid: Pid,
        release: Option<OwnedFd>,
    }

    impl NamespaceHolder {
        fn spawn() -> Self {
            let (ready_read, ready_write) = nix::unistd::pipe().unwrap();
            let (release_read, release_write) = nix::unistd::pipe().unwrap();
            // SAFETY: the child calls only async-signal-safe functions.
            match unsafe { nix::unistd::fork() }.unwrap() {
                nix::unistd::ForkResult::Child => unsafe {
                    // Drop the inherited parent ends, or the release read
                    // below never sees end-of-file.
                    libc::close(ready_read.as_raw_fd());
                    libc::close(release_write.as_raw_fd());
                    let ok = libc::unshare(libc::CLONE_NEWNS) == 0
                        && libc::mount(
                            std::ptr::null(),
                            c"/".as_ptr(),
                            std::ptr::null(),
                            libc::MS_REC | libc::MS_PRIVATE,
                            std::ptr::null(),
                        ) == 0;
                    let byte = [u8::from(ok)];
                    libc::write(ready_write.as_raw_fd(), byte.as_ptr().cast(), 1);
                    let mut sink = [0u8; 1];
                    libc::read(release_read.as_raw_fd(), sink.as_mut_ptr().cast(), 1);
                    libc::_exit(0);
                },
                nix::unistd::ForkResult::Parent { child } => {
                    drop(ready_write);
                    drop(release_read);
                    let mut byte = [0u8; 1];
                    nix::unistd::read(ready_read.as_raw_fd(), &mut byte).unwrap();
                    assert_eq!(byte[0], 1, "holder could not enter its own mount namespace");
                    Self {
                        pid: child,
                        release: Some(release_write),
                    }
                }
            }
        }

        /// `path` as the holder's mount namespace shows it.
        fn view(&self, path: &Path) -> PathBuf {
            let relative = path.strip_prefix("/").unwrap();
            PathBuf::from(format!("/proc/{}/root", self.pid)).join(relative)
        }
    }

    impl Drop for NamespaceHolder {
        fn drop(&mut self) {
            drop(self.release.take());
            let _ = nix::sys::wait::waitpid(self.pid, None);
        }
    }

    #[test]
    #[ignore = "needs root in a private mount namespace: make test:guest-perms"]
    fn privileged_attached_folder_is_read_only_and_only_in_the_target_namespace() {
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("agent"), b"agent-bytes").unwrap();
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("opt/boxlite/agents");
        let holder = NamespaceHolder::spawn();

        attach_read_only(source.path(), holder.pid, &destination).unwrap();

        let seen = holder.view(&destination);
        assert_eq!(fs::read(seen.join("agent")).unwrap(), b"agent-bytes");
        let write = fs::write(seen.join("new"), b"x").unwrap_err();
        assert_eq!(write.raw_os_error(), Some(libc::EROFS));
        // The caller sees the created mount point, empty: the mount went only
        // into the holder's namespace.
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    }

    #[test]
    #[ignore = "needs root in a private mount namespace: make test:guest-perms"]
    fn privileged_destination_with_entries_is_refused_and_left_visible() {
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("agent"), b"agent-bytes").unwrap();
        let destination = tempfile::tempdir().unwrap();
        fs::write(destination.path().join("image-file"), b"from the image").unwrap();
        let holder = NamespaceHolder::spawn();

        let error = attach_read_only(source.path(), holder.pid, destination.path()).unwrap_err();

        assert!(matches!(error, BoxliteError::InvalidState(_)), "{error}");
        let seen = holder.view(destination.path());
        assert_eq!(
            fs::read(seen.join("image-file")).unwrap(),
            b"from the image"
        );
        assert!(!seen.join("agent").exists());
    }

    #[test]
    #[ignore = "needs root in a private mount namespace: make test:guest-perms"]
    fn privileged_missing_target_process_is_not_found() {
        let source = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("agents");
        let holder = NamespaceHolder::spawn();
        let gone = holder.pid;
        drop(holder);

        let error = attach_read_only(source.path(), gone, &destination).unwrap_err();

        assert!(matches!(error, BoxliteError::NotFound(_)), "{error}");
        assert!(!destination.exists());
    }
}
