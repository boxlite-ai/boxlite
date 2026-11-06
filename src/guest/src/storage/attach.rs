//! Mount a share folder read-only into a running container.
//!
//! The folder lives in the guest's own mount namespace, inside the Box share
//! under `/run/boxlite/shared`. The agent clones it with `open_tree`, makes the
//! clone read-only with `mount_setattr`, and a child moves the clone into the
//! mount namespace of a process in the container, so every process there sees
//! the folder and the agent's own namespace never changes. The container's
//! root filesystem gains only the destination directory and any missing
//! parents, created without following links; a destination that already has
//! entries is refused, so no image content is hidden.
//!
//! The child is cloned with exit signal 0 and a pidfd. The reaper's
//! `waitpid(-1)` sweep waits only for children that exit with `SIGCHLD`, so it
//! never takes this one and no reap fence is needed. Cloned from the
//! multithreaded agent, the child may inherit locks other threads held, so it
//! makes only system calls on buffers prepared before the clone; it first
//! closes every descriptor but its own four, so a blocked child keeps no
//! exec's stdin open. It reports ready after its checks and mounts only after
//! the agent answers go, which the agent does only within [`ATTACH_DEADLINE`];
//! past that the agent kills it, so a late child never mounts.

use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};
use std::time::{Duration, Instant};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::fcntl::OFlag;
use nix::libc;
use nix::unistd::Pid;

use super::idmap::sys;

/// How long the agent waits for the child to get ready before killing it.
pub(crate) const ATTACH_DEADLINE: Duration = Duration::from_secs(30);

/// How long the agent waits for a killed child to exit before leaving it to a
/// later attach (see [`Attacher`]).
const KILL_GRACE: Duration = Duration::from_millis(500);

// Syscall numbers, the same on aarch64 and x86_64.
const NR_PIDFD_SEND_SIGNAL: libc::c_long = 424;
const NR_CLONE3: libc::c_long = 435;
const NR_CLOSE_RANGE: libc::c_long = 436;
const P_PIDFD: libc::idtype_t = 3;

/// Accept only an absolute path of normal components other than `/`, shorter
/// than `PATH_MAX`.
pub(crate) fn validate_destination(destination: &Path) -> BoxliteResult<()> {
    if destination.as_os_str().len() >= libc::PATH_MAX as usize {
        return Err(BoxliteError::InvalidArgument(format!(
            "mount destination is longer than {} bytes",
            libc::PATH_MAX - 1
        )));
    }
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

/// Attaches share folders into one container, one child at a time.
///
/// A child killed at the deadline normally exits at once. One stuck in an
/// uninterruptible wait lives on, and until it exits every attach is refused,
/// so a container never has two attach children.
#[derive(Debug, Default)]
pub(crate) struct Attacher {
    /// Pidfd of a killed child that had not exited yet.
    straggler: Option<OwnedFd>,
}

/// The mount namespace of a process in the container, opened at once so the
/// attach uses it even if the process exits and its PID is reused later.
pub(crate) struct Target {
    pid: Pid,
    namespace: File,
}

impl Target {
    /// Open the mount namespace of `pid`; `NotFound` once the process is gone.
    pub(crate) fn open(pid: Pid) -> BoxliteResult<Self> {
        let namespace = File::open(format!("/proc/{pid}/ns/mnt")).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                BoxliteError::NotFound(format!("container process {pid} is gone"))
            } else {
                BoxliteError::Storage(format!("open the mount namespace of {pid}: {error}"))
            }
        })?;
        Ok(Self { pid, namespace })
    }
}

impl Attacher {
    /// Bind `source` read-only at `destination` inside the mount namespace of
    /// `target`. A missing destination is created; one with entries, or one
    /// reached through a link, is refused. Waits at most [`ATTACH_DEADLINE`]
    /// for the child to get ready (use from `spawn_blocking`).
    pub(crate) fn attach_read_only(
        &mut self,
        source: &Path,
        target: &Target,
        destination: &Path,
    ) -> BoxliteResult<()> {
        validate_destination(destination)?;
        self.reap_straggler()?;
        let tree = clone_read_only(source)?;
        let components = components(destination)?;
        let child = Child::spawn(&target.namespace, &tree, &components, Stall::No)?;
        let report = match child.report_within(ATTACH_DEADLINE) {
            Some(report) if report.stage == Some(Stage::Ready) => child.go(),
            Some(report) => {
                child.reap();
                report
            }
            None => {
                self.straggler = child.kill();
                return Err(BoxliteError::Storage(format!(
                    "mount at {} in {} was not ready within {ATTACH_DEADLINE:?}; the attempt was stopped",
                    destination.display(),
                    target.pid
                )));
            }
        };
        report.into_result(target.pid, destination)
    }

    /// Reap a killed child that has exited since; refuse while it still runs.
    fn reap_straggler(&mut self) -> BoxliteResult<()> {
        if let Some(pidfd) = &self.straggler {
            if !wait_readable(pidfd, Duration::ZERO) {
                return Err(BoxliteError::InvalidState(
                    "an earlier mount into this container is still being stopped".to_string(),
                ));
            }
            reap(pidfd);
            self.straggler = None;
        }
        Ok(())
    }
}

impl Drop for Attacher {
    fn drop(&mut self) {
        // Nothing else waits for a child without an exit signal: reap it once
        // it exits, without blocking the caller.
        if let Some(pidfd) = self.straggler.take() {
            std::thread::spawn(move || reap(&pidfd));
        }
    }
}

/// Clone `source` as a detached, read-only mount tree.
fn clone_read_only(source: &Path) -> BoxliteResult<OwnedFd> {
    let path = c_string(source.as_os_str())?;
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

/// The destination's components below `/`, prepared before the clone.
fn components(destination: &Path) -> BoxliteResult<Vec<CString>> {
    destination
        .components()
        .skip(1)
        .map(|component| c_string(component.as_os_str()))
        .collect()
}

fn c_string(value: &OsStr) -> BoxliteResult<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| BoxliteError::InvalidArgument(format!("path has a NUL byte: {:?}", value)))
}

/// Whether the child blocks before it joins the namespace. Only tests block,
/// standing in for a container path that never answers.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stall {
    No,
    #[cfg(test)]
    BeforeReady,
}

/// `clone3` arguments up to `tls` (`CLONE_ARGS_SIZE_VER0`).
#[repr(C)]
#[derive(Default)]
struct CloneArgs {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
}

/// The descriptors the child keeps, all opened before the clone.
struct ChildFds {
    namespace: RawFd,
    tree: RawFd,
    reports: RawFd,
    go: RawFd,
}

/// The agent's side of one attach child.
struct Child {
    pidfd: OwnedFd,
    /// The child's reports: ready, then the result.
    reports: OwnedFd,
    /// Closed without a byte when the agent gives up.
    go: OwnedFd,
}

impl Child {
    fn spawn(
        namespace: &File,
        tree: &OwnedFd,
        components: &[CString],
        stall: Stall,
    ) -> BoxliteResult<Self> {
        let pipe = || {
            nix::unistd::pipe2(OFlag::O_CLOEXEC)
                .map_err(|error| BoxliteError::Storage(format!("create a pipe: {error}")))
        };
        let (reports, report_end) = pipe()?;
        let (go_end, go) = pipe()?;
        let fds = ChildFds {
            namespace: namespace.as_raw_fd(),
            tree: tree.as_raw_fd(),
            reports: report_end.as_raw_fd(),
            go: go_end.as_raw_fd(),
        };
        let mut keep = [fds.namespace, fds.tree, fds.reports, fds.go];
        keep.sort_unstable();
        let mut pidfd: RawFd = -1;
        let mut args = CloneArgs {
            flags: libc::CLONE_PIDFD as u64,
            pidfd: &mut pidfd as *mut RawFd as u64,
            ..CloneArgs::default()
        };
        // SAFETY: without CLONE_VM the child runs on a copy of this process,
        // only in `run_child`, which makes system calls on the buffers above
        // and exits.
        let pid = unsafe {
            libc::syscall(
                NR_CLONE3,
                &mut args as *mut CloneArgs,
                std::mem::size_of::<CloneArgs>(),
            )
        };
        match pid {
            0 => run_child(&keep, &fds, components, stall),
            pid if pid < 0 => Err(BoxliteError::Storage(format!(
                "clone the attach child: {}",
                io::Error::last_os_error()
            ))),
            // SAFETY: CLONE_PIDFD stored a new descriptor that only we own.
            _ => Ok(Self {
                pidfd: unsafe { OwnedFd::from_raw_fd(pidfd) },
                reports,
                go,
            }),
        }
    }

    /// The child's next report, or `None` once `deadline` passes without one.
    fn report_within(&self, deadline: Duration) -> Option<Report> {
        wait_readable(&self.reports, deadline).then(|| Report::read(&self.reports))
    }

    /// Tell a ready child to mount, then wait for its result.
    fn go(self) -> Report {
        // SAFETY: a one-byte write to an owned pipe.
        let sent = unsafe { libc::write(self.go.as_raw_fd(), [1u8].as_ptr().cast(), 1) } == 1;
        let report = if sent {
            Report::read(&self.reports)
        } else {
            Report::missing()
        };
        self.reap();
        report
    }

    /// Stop a child that missed the deadline. Returns its pidfd when it has
    /// not exited within [`KILL_GRACE`].
    fn kill(self) -> Option<OwnedFd> {
        // A child that reads go after this sees end-of-file and never mounts.
        drop(self.go);
        // SAFETY: sends a signal through an owned pidfd.
        unsafe {
            libc::syscall(
                NR_PIDFD_SEND_SIGNAL,
                self.pidfd.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            );
        }
        if wait_readable(&self.pidfd, KILL_GRACE) {
            reap(&self.pidfd);
            None
        } else {
            Some(self.pidfd)
        }
    }

    fn reap(self) {
        reap(&self.pidfd);
    }
}

/// Whether `fd` turns readable within `wait`: a pipe with data or end-of-file,
/// or a pidfd whose process has exited.
fn wait_readable(fd: &OwnedFd, wait: Duration) -> bool {
    let end = Instant::now() + wait;
    loop {
        let left = end.saturating_duration_since(Instant::now());
        let millis = i32::try_from(left.as_nanos().div_ceil(1_000_000)).unwrap_or(i32::MAX);
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one pollfd on the stack.
        match unsafe { libc::poll(&mut poll, 1, millis) } {
            0 => return false,
            n if n > 0 => return true,
            _ if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => {}
            _ => return true,
        }
    }
}

/// Wait for our own child through its pidfd. `__WCLONE` is what lets a wait
/// see a child without an exit signal.
fn reap(pidfd: &OwnedFd) {
    loop {
        // SAFETY: an all-zero siginfo_t is valid; waitid fills it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: waits for this process's own child through an owned pidfd.
        let result = unsafe {
            libc::waitid(
                P_PIDFD,
                pidfd.as_raw_fd() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::__WCLONE,
            )
        };
        if result == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return;
        }
    }
}

/// Runs in the cloned child and never returns.
fn run_child(keep: &[RawFd; 4], fds: &ChildFds, components: &[CString], stall: Stall) -> ! {
    if let Some(report) = attach_in_child(keep, fds, components, stall) {
        report.send(fds.reports);
    }
    // SAFETY: leave without destructors or exit handlers.
    unsafe { libc::_exit(0) }
}

/// Close every other descriptor, join the namespace, open the mount point,
/// check it is empty, report ready, wait for go, attach. System calls only.
/// The mount goes onto the directory fd that was checked, so a container
/// process cannot swap in another directory between the check and the mount.
/// Returns `None` when the agent gave up before go.
fn attach_in_child(
    keep: &[RawFd; 4],
    fds: &ChildFds,
    components: &[CString],
    stall: Stall,
) -> Option<Report> {
    let errno = || io::Error::last_os_error().raw_os_error().unwrap_or(0);
    // SAFETY: system calls on descriptors and buffers prepared before the clone.
    unsafe {
        if close_others(keep) != 0 {
            return Some(Report::new(Stage::CloseDescriptors, errno()));
        }
        #[cfg(test)]
        if stall == Stall::BeforeReady {
            libc::pause();
        }
        let _ = stall;
        if libc::setns(fds.namespace, libc::CLONE_NEWNS) != 0 {
            return Some(Report::new(Stage::JoinNamespace, errno()));
        }
        let directory = match open_mount_point(components) {
            Ok(directory) => directory,
            Err(report) => return Some(report),
        };
        match has_entries(directory) {
            Err(code) => return Some(Report::new(Stage::ListMountPoint, code)),
            Ok(true) => return Some(Report::new(Stage::HasEntries, 0)),
            Ok(false) => {}
        }
        Report::new(Stage::Ready, 0).send(fds.reports);
        let mut byte = 0u8;
        if libc::read(fds.go, (&mut byte as *mut u8).cast(), 1) != 1 {
            return None;
        }
        Some(
            match sys::move_mount(
                fds.tree,
                c"",
                directory,
                c"",
                sys::MOVE_MOUNT_F_EMPTY_PATH | sys::MOVE_MOUNT_T_EMPTY_PATH,
            ) {
                Ok(()) => Report::new(Stage::Attached, 0),
                Err(error) => Report::new(Stage::Attach, error.raw_os_error().unwrap_or(0)),
            },
        )
    }
}

/// Close every descriptor except `keep`, which is sorted. System calls only.
unsafe fn close_others(keep: &[RawFd; 4]) -> libc::c_long {
    let mut first: libc::c_uint = 0;
    for &fd in keep {
        let fd = fd as libc::c_uint;
        if fd > first && libc::syscall(NR_CLOSE_RANGE, first, fd - 1, 0) != 0 {
            return -1;
        }
        first = fd + 1;
    }
    libc::syscall(NR_CLOSE_RANGE, first, libc::c_uint::MAX, 0)
}

/// Open the mount point from the container's root, creating each missing
/// directory and following no link. With `O_DIRECTORY | O_NOFOLLOW` a link
/// fails with `ENOTDIR` (`ELOOP` without `O_DIRECTORY`). System calls only.
unsafe fn open_mount_point(components: &[CString]) -> Result<RawFd, Report> {
    let errno = || io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut directory = libc::open(c"/".as_ptr(), flags);
    if directory < 0 {
        return Err(Report::new(Stage::OpenMountPoint, errno()));
    }
    for name in components {
        if libc::mkdirat(directory, name.as_ptr(), 0o755) != 0 {
            let code = errno();
            if code != libc::EEXIST {
                libc::close(directory);
                return Err(Report::new(Stage::CreateMountPoint, code));
            }
        }
        let next = libc::openat(directory, name.as_ptr(), flags);
        let code = errno();
        libc::close(directory);
        if next < 0 {
            let stage = if code == libc::ENOTDIR || code == libc::ELOOP {
                Stage::NotDirectory
            } else {
                Stage::OpenMountPoint
            };
            return Err(Report::new(stage, code));
        }
        directory = next;
    }
    Ok(directory)
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
    Ready = 7,
    NotDirectory = 8,
    CloseDescriptors = 9,
}

const STAGES: [Stage; 10] = [
    Stage::Attached,
    Stage::JoinNamespace,
    Stage::CreateMountPoint,
    Stage::HasEntries,
    Stage::OpenMountPoint,
    Stage::ListMountPoint,
    Stage::Attach,
    Stage::Ready,
    Stage::NotDirectory,
    Stage::CloseDescriptors,
];

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

    fn missing() -> Self {
        Self {
            stage: None,
            errno: 0,
        }
    }

    /// Write the report to `pipe`. System calls only.
    fn send(&self, pipe: RawFd) {
        let [a, b, c, d] = self.errno.to_le_bytes();
        let bytes = [self.stage.map_or(u8::MAX, |stage| stage as u8), a, b, c, d];
        // SAFETY: a plain write of a stack buffer to an owned pipe.
        unsafe { libc::write(pipe, bytes.as_ptr().cast(), bytes.len()) };
    }

    fn read(pipe: &OwnedFd) -> Self {
        let mut bytes = [0u8; 5];
        let complete = matches!(nix::unistd::read(pipe.as_raw_fd(), &mut bytes), Ok(5));
        Self {
            stage: STAGES
                .into_iter()
                .find(|stage| complete && *stage as u8 == bytes[0]),
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
            Some(Stage::NotDirectory) => Err(BoxliteError::InvalidState(format!(
                "{place} goes through a link or a file in the container; refusing to follow it"
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
            Some(Stage::CloseDescriptors) => Err(BoxliteError::Internal(format!(
                "the attach child could not close its descriptors: {errno}"
            ))),
            Some(Stage::Ready) | None => Err(BoxliteError::Internal(format!(
                "the attach child for {target} exited without a result"
            ))),
        }
    }
}

/// Whether the open directory `directory` has any entry besides `.` and `..`,
/// read with `getdents64` into a stack buffer. System calls only.
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
    use nix::errno::Errno;
    use nix::sys::wait::{waitpid, WaitPidFlag};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn destination_must_be_absolute_normal_and_shorter_than_path_max() {
        let too_long = format!("/{}", "a".repeat(libc::PATH_MAX as usize));
        for bad in [
            "opt/boxlite/agents",
            "/opt/../etc",
            "/",
            "",
            too_long.as_str(),
        ] {
            let error = validate_destination(Path::new(bad)).expect_err(bad);
            assert!(
                matches!(error, BoxliteError::InvalidArgument(_)),
                "{bad:?}: {error}"
            );
        }
        let longest = format!("/{}", "a".repeat(libc::PATH_MAX as usize - 2));
        validate_destination(Path::new(&longest)).unwrap();
        validate_destination(Path::new("/opt/boxlite/agents")).unwrap();
    }

    /// A child stalled before it joins any namespace, standing in for one stuck
    /// on a container path. The namespace and tree are never used, so this
    /// needs no privileges.
    fn stalled_child() -> Child {
        let namespace = File::open("/proc/self/ns/mnt").unwrap();
        let tree = OwnedFd::from(File::open("/").unwrap());
        Child::spawn(&namespace, &tree, &[], Stall::BeforeReady).unwrap()
    }

    fn child_pid(pidfd: &OwnedFd) -> Pid {
        let info = fs::read_to_string(format!("/proc/self/fdinfo/{}", pidfd.as_raw_fd())).unwrap();
        let pid = info
            .lines()
            .find_map(|line| line.strip_prefix("Pid:"))
            .unwrap();
        Pid::from_raw(pid.trim().parse().unwrap())
    }

    #[test]
    fn a_child_not_ready_by_the_deadline_is_killed_and_reaped() {
        let child = stalled_child();
        let pid = child_pid(&child.pidfd);

        assert!(child.report_within(Duration::from_millis(100)).is_none());
        assert!(
            child.kill().is_none(),
            "a child in a killable wait exits within the grace"
        );
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "the killed child was reaped, not left a zombie"
        );
    }

    #[test]
    fn waits_without_wclone_never_see_the_child() {
        let child = stalled_child();
        let pid = child_pid(&child.pidfd);

        // The reaper's sweep is `waitpid(-1, WNOHANG)`; without `__WCLONE`, a
        // wait for this very pid finds no child it may take.
        assert_eq!(waitpid(pid, Some(WaitPidFlag::WNOHANG)), Err(Errno::ECHILD));
        assert!(child.kill().is_none());
    }

    #[test]
    fn an_attach_is_refused_while_an_earlier_child_still_runs() {
        let child = stalled_child();
        let mut attacher = Attacher {
            straggler: Some(child.pidfd),
        };

        let error = attacher.reap_straggler().unwrap_err();
        assert!(matches!(error, BoxliteError::InvalidState(_)), "{error}");

        // Once it has exited, the next attach reaps it and goes ahead.
        let pidfd = attacher.straggler.as_ref().unwrap();
        // SAFETY: sends a signal through an owned pidfd.
        unsafe {
            libc::syscall(
                NR_PIDFD_SEND_SIGNAL,
                pidfd.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            );
        }
        assert!(wait_readable(pidfd, Duration::from_secs(5)));
        attacher.reap_straggler().unwrap();
        assert!(attacher.straggler.is_none());
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
            let _ = waitpid(self.pid, None);
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

        Attacher::default()
            .attach_read_only(
                source.path(),
                &Target::open(holder.pid).unwrap(),
                &destination,
            )
            .unwrap();

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

        let error = Attacher::default()
            .attach_read_only(
                source.path(),
                &Target::open(holder.pid).unwrap(),
                destination.path(),
            )
            .unwrap_err();

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
    fn privileged_destination_through_a_link_is_refused() {
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("agent"), b"agent-bytes").unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(root.path().join("elsewhere"), root.path().join("opt")).unwrap();
        let holder = NamespaceHolder::spawn();

        let error = Attacher::default()
            .attach_read_only(
                source.path(),
                &Target::open(holder.pid).unwrap(),
                &root.path().join("opt/agents"),
            )
            .unwrap_err();

        assert!(matches!(error, BoxliteError::InvalidState(_)), "{error}");
        assert!(
            !root.path().join("elsewhere/agents").exists(),
            "nothing was created through the link"
        );
    }

    #[test]
    #[ignore = "needs root in a private mount namespace: make test:guest-perms"]
    fn privileged_child_stopped_before_go_mounts_nothing_and_holds_no_exec_stdin() {
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("agent"), b"agent-bytes").unwrap();
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("agents");
        let holder = NamespaceHolder::spawn();
        // Stands in for the stdin write end the agent holds for an exec.
        let (stdin_read, stdin_write) = nix::unistd::pipe2(OFlag::O_CLOEXEC).unwrap();
        let target = Target::open(holder.pid).unwrap();
        let tree = clone_read_only(source.path()).unwrap();
        let components = components(&destination).unwrap();

        let child = Child::spawn(&target.namespace, &tree, &components, Stall::No).unwrap();
        let ready = child.report_within(Duration::from_secs(10)).unwrap();
        assert_eq!(ready.stage, Some(Stage::Ready));

        // The ready child waits for go, holding none of the agent's other
        // descriptors: the exec sees end-of-file as soon as the agent closes.
        drop(stdin_write);
        assert!(wait_readable(&stdin_read, Duration::from_secs(1)));
        let mut byte = [0u8; 1];
        assert_eq!(nix::unistd::read(stdin_read.as_raw_fd(), &mut byte), Ok(0));

        assert!(child.kill().is_none());
        assert_eq!(fs::read_dir(holder.view(&destination)).unwrap().count(), 0);
    }

    #[test]
    fn a_target_that_is_gone_is_not_found() {
        let mut exited = std::process::Command::new("true").spawn().unwrap();
        let pid = Pid::from_raw(i32::try_from(exited.id()).unwrap());
        exited.wait().unwrap();

        let Err(error) = Target::open(pid) else {
            panic!("opened the namespace of a process that has exited");
        };
        assert!(matches!(error, BoxliteError::NotFound(_)), "{error}");
    }
}
