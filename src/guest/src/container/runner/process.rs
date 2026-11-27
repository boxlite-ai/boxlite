//! Shared child setup, status channels, command resolution and PID identity.

use super::super::spec::ProcessSpec;
use super::super::zygote::{recv_packet, send_packet, CommandRejection};
use super::RunError;
use crate::service::exec::exec_handle::PtyConfig;
use nix::errno::Errno;
use nix::fcntl::{fcntl, open, AtFlags, FcntlArg, OFlag};
use nix::libc;
use nix::mount::{mount, MsFlags};
use nix::sys::signal::Signal;
use nix::sys::socket::{socketpair, AddressFamily, SockFlag, SockType};
use nix::sys::stat::Mode;
use nix::unistd::{self, Gid, Pid, Uid};
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub(super) fn pipe() -> io::Result<(File, File)> {
    let (read, write) = unistd::pipe2(OFlag::O_CLOEXEC)?;
    Ok((read.into(), write.into()))
}

pub(super) fn child_exit(error: RunError, mut report: File) -> ! {
    // Setup and command errors use a typed channel, not stderr or string
    // matching. The notifier closes automatically on a successful execve.
    use super::super::zygote::BuildResult;
    let verdict = BuildResult::from(error);
    let code = match &verdict {
        BuildResult::Rejected { exit_code, .. } => *exit_code,
        _ => 1,
    };
    if let Ok(json) = serde_json::to_vec(&verdict) {
        let _ = report.write_all(&json);
    }
    unsafe { libc::_exit(code) }
}

pub(super) fn read_report(mut read: File, must_be_ready: bool) -> Result<(), RunError> {
    let mut bytes = Vec::new();
    read.read_to_end(&mut bytes)?;
    match bytes.as_slice() {
        [] if !must_be_ready => Ok(()), // execve or trusted in-process workload
        [1] if must_be_ready => Ok(()),
        [] => Err(RunError::Failed(
            "init exited before reporting ready".into(),
        )),
        _ => match serde_json::from_slice(&bytes) {
            Ok(super::super::zygote::BuildResult::Rejected { message, exit_code }) => {
                Err(RunError::Rejected(CommandRejection { message, exit_code }))
            }
            Ok(super::super::zygote::BuildResult::Failed { error }) => Err(RunError::Failed(error)),
            _ => Err(RunError::Failed("invalid child status message".into())),
        },
    }
}

pub(super) struct Stdio {
    fds: Vec<OwnedFd>,
    config: Option<PtyConfig>,
    terminal: Option<(OwnedFd, OwnedFd)>,
}

impl Stdio {
    pub(super) fn new(fds: Vec<OwnedFd>, config: Option<PtyConfig>) -> io::Result<Self> {
        let terminal = match (fds.len(), &config) {
            (3, None) => None,
            (0, Some(_)) => Some(socketpair(
                AddressFamily::Unix,
                SockType::SeqPacket,
                None,
                SockFlag::SOCK_CLOEXEC,
            )?),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "expected three stdio fds or a PTY configuration",
                ));
            }
        };
        Ok(Self {
            fds,
            config,
            terminal,
        })
    }

    pub(super) fn keep_fds(&self, keep: &mut Vec<RawFd>) {
        keep.extend(self.fds.iter().map(AsRawFd::as_raw_fd));
        if let Some((_, child)) = &self.terminal {
            keep.push(child.as_raw_fd());
        }
    }

    pub(super) fn setup(
        &self,
        (uid, gid): (u32, u32),
        bind_init_console: bool,
    ) -> Result<(), RunError> {
        unistd::setsid().map_err(io::Error::from)?;
        if let Some((_, child)) = &self.terminal {
            let master = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open("/dev/pts/ptmx")?;
            let unlock = 0i32;
            if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSPTLCK, &unlock) } < 0 {
                return Err(io::Error::last_os_error().into());
            }
            // TIOCGPTPEER opens this master’s replica, independent of any
            // symlink or path replacement in the container's /dev.
            let fd = unsafe {
                libc::ioctl(
                    master.as_raw_fd(),
                    libc::TIOCGPTPEER,
                    libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error().into());
            }
            let slave = unsafe { OwnedFd::from_raw_fd(fd) };
            if (uid, gid) != (0, 0) {
                unistd::fchown(
                    slave.as_raw_fd(),
                    Some(Uid::from_raw(uid)),
                    Some(Gid::from_raw(gid)),
                )
                .map_err(io::Error::from)?;
            }
            if bind_init_console {
                bind_console(&slave)?;
            }
            if unsafe { libc::ioctl(slave.as_raw_fd(), libc::TIOCSCTTY, 0) } < 0 {
                return Err(io::Error::last_os_error().into());
            }
            super::super::pty::initialize(&slave, self.config.as_ref().unwrap())
                .map_err(|e| RunError::Failed(e.to_string()))?;
            for index in 0..3 {
                dup(slave.as_raw_fd(), index)?;
            }
            send_packet(child.as_raw_fd(), &(), &[master.as_raw_fd()])
                .map_err(|e| RunError::Failed(e.to_string()))?;
        } else {
            // Save any source that dup2 could overwrite before all sources
            // have been copied, including a source already at its target.
            let mut moved = [None, None, None];
            for (slot, fd) in moved.iter_mut().zip(&self.fds) {
                if fd.as_raw_fd() < 3 {
                    let raw = fcntl(fd.as_raw_fd(), FcntlArg::F_DUPFD_CLOEXEC(3))
                        .map_err(io::Error::from)?;
                    *slot = Some(unsafe { OwnedFd::from_raw_fd(raw) });
                }
            }
            for (index, (fd, moved)) in self.fds.iter().zip(&moved).enumerate() {
                dup(moved.as_ref().unwrap_or(fd).as_raw_fd(), index as RawFd)?;
            }
        }
        Ok(())
    }

    pub(super) fn receive(self) -> Result<Option<OwnedFd>, RunError> {
        let Some((parent, child)) = self.terminal else {
            return Ok(None);
        };
        drop(child);
        let ((), mut fds) =
            recv_packet(parent.as_raw_fd(), 1).map_err(|e| RunError::Failed(e.to_string()))?;
        fds.pop()
            .map(Some)
            .ok_or_else(|| RunError::Failed("child did not return a PTY".into()))
    }
}

fn bind_console(slave: &OwnedFd) -> io::Result<()> {
    let path = "/dev/console";
    let console = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            // A configured console device may already exist. Pin it without
            // opening the device or following a replacement symlink.
            let fd = open(
                path,
                OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )?;
            let file = unsafe { File::from_raw_fd(fd) };
            let kind = file.metadata()?.file_type();
            if !kind.is_file() && !kind.is_char_device() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid /dev/console mount target",
                ));
            }
            file
        }
        Err(error) => return Err(error),
    };
    let source = format!("/proc/self/fd/{}", slave.as_raw_fd());
    let target = format!("/proc/self/fd/{}", console.as_raw_fd());
    mount(
        Some(source.as_str()),
        target.as_str(),
        None::<&str>,
        MsFlags::MS_BIND,
        None::<&str>,
    )
    .map_err(|error| io::Error::other(format!("bind PTY to {path}: {error}")))
}

fn dup(from: RawFd, to: RawFd) -> io::Result<()> {
    unistd::dup2(from, to)?;
    Ok(())
}

/// Real close, not just CLOEXEC: a typed Rust workload may never execve.
/// Called only in a new child. Keep the caller's named setup descriptors.
pub(super) fn close_inherited(keep: &[RawFd]) -> io::Result<()> {
    let fds: Vec<_> = fs::read_dir("/proc/self/fd")?
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<RawFd>().ok())
        .collect();
    for fd in fds {
        if fd >= 3 && !keep.contains(&fd) {
            let _ = unistd::close(fd);
        }
    }
    Ok(())
}

pub(super) fn credentials(spec: &ProcessSpec) -> io::Result<()> {
    spec.capabilities.apply(spec.uid, spec.gid)?;
    let cwd = if spec.cwd.as_os_str().is_empty() {
        Path::new("/")
    } else {
        &spec.cwd
    };
    unistd::chdir(cwd)
        .map_err(|error| io::Error::other(format!("chdir {}: {error}", cwd.display())))?;
    Ok(())
}

pub(super) struct Command {
    args: Vec<CString>,
    env: Vec<CString>,
    path: PathBuf,
}

fn rejected(program: &str, exit_code: i32) -> RunError {
    let reason = if exit_code == 127 {
        "not found in $PATH"
    } else {
        "does not have correct permissions"
    };
    RunError::Rejected(CommandRejection {
        message: format!("executable '{program}' {reason}"),
        exit_code,
    })
}

impl Command {
    pub(super) fn prepare(spec: &ProcessSpec) -> Result<Self, RunError> {
        let args = spec
            .args
            .iter()
            .map(|s| CString::new(s.as_bytes()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::from)?;
        let env = spec
            .env
            .iter()
            .map(|(k, v)| {
                if k.is_empty() || k.contains('=') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "invalid environment variable name",
                    ));
                }
                Ok(CString::new(format!("{k}={v}"))?)
            })
            .collect::<io::Result<Vec<_>>>()?;
        let program = spec.args.first().map(String::as_str).unwrap_or("");
        if program.is_empty() {
            return Err(rejected(program, 127));
        }
        let search_path = if program.contains('/') {
            "" // Try a pathname directly, without a PATH prefix.
        } else {
            spec.env.get("PATH").map_or("/bin:/usr/bin", String::as_str)
        };
        let mut denied = false;
        for dir in search_path.split(':') {
            let path = Path::new(dir).join(program);
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => {
                    match unistd::faccessat(
                        None,
                        &path,
                        unistd::AccessFlags::X_OK,
                        AtFlags::AT_EACCESS,
                    ) {
                        Ok(()) => return Ok(Self { args, env, path }),
                        Err(Errno::EACCES | Errno::EPERM) => denied = true,
                        Err(Errno::ENOENT | Errno::ENOTDIR) => {}
                        Err(error) => return Err(io::Error::from(error).into()),
                    }
                }
                Ok(_) => denied = true,
                Err(e) if matches!(e.raw_os_error(), Some(libc::EACCES | libc::EPERM)) => {
                    denied = true
                }
                Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Err(rejected(program, if denied { 126 } else { 127 }))
    }

    pub(super) fn exec(self) -> RunError {
        let program = self.args[0].to_string_lossy();
        let executable = match CString::new(self.path.as_os_str().as_bytes()) {
            Ok(path) => path,
            Err(error) => return io::Error::from(error).into(),
        };
        match unistd::execve(&executable, &self.args, &self.env) {
            Err(Errno::EACCES | Errno::EPERM | Errno::ENOEXEC | Errno::EISDIR) => {
                rejected(&program, 126)
            }
            Err(Errno::ENOENT | Errno::ENOTDIR) => rejected(&program, 127),
            Err(error) => io::Error::from(error).into(),
            Ok(never) => match never {},
        }
    }
}

pub(super) struct Identity {
    pub pid: Pid,
    pidfd: Option<OwnedFd>,
    proc: File,
}

impl Identity {
    pub(super) fn open(pid: Pid, pidfd: Option<OwnedFd>) -> io::Result<Self> {
        let proc = File::open(format!("/proc/{pid}"))?;
        let pidfd = pidfd.or_else(|| {
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid.as_raw(), 0u32) };
            (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
        });
        let identity = Self { pid, pidfd, proc };
        if !identity.is_alive() {
            return Err(io::Error::from_raw_os_error(libc::ESRCH));
        }
        Ok(identity)
    }

    pub(super) fn proc_path(&self, path: &str) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}/{path}", self.proc.as_raw_fd()))
    }

    pub(super) fn is_alive(&self) -> bool {
        if let Some(pidfd) = &self.pidfd {
            let mut poll = libc::pollfd {
                fd: pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            loop {
                match unsafe { libc::poll(&mut poll, 1, 0) } {
                    0 => return true,
                    n if n < 0 && Errno::last() == Errno::EINTR => continue,
                    _ => return false,
                }
            }
        }
        fs::read(self.proc_path("stat"))
            .ok()
            .and_then(|raw| {
                crate::service::exec::process_instance::stat_fields(&raw)?
                    .next()
                    .map(|state| !matches!(state, "Z" | "X" | "x"))
            })
            .unwrap_or(false)
    }

    pub(super) fn signal(&self, signal: Signal) -> io::Result<()> {
        if let Some(pidfd) = &self.pidfd {
            let result = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    pidfd.as_raw_fd(),
                    signal as i32,
                    std::ptr::null::<libc::siginfo_t>(),
                    0u32,
                )
            };
            if result == 0 || Errno::last() == Errno::ESRCH {
                return Ok(());
            }
            if Errno::last() != Errno::ENOSYS {
                return Err(io::Error::last_os_error());
            }
        }
        if !self.is_alive() {
            return Ok(());
        }
        match nix::sys::signal::kill(self.pid, signal) {
            Ok(()) | Err(Errno::ESRCH) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::container::spec::resolve_user;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn reserved_uid_and_gid_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let etc = root.path().join("etc");
        fs::create_dir(&etc).unwrap();
        fs::write(
            etc.join("passwd"),
            "baduid:x:4294967295:1000::/:/bin/sh\nbadgid:x:1000:4294967295::/:/bin/sh\n",
        )
        .unwrap();
        fs::write(etc.join("group"), "badgroup:x:4294967295:\n").unwrap();
        let root = root.path().to_str().unwrap();
        let accepted: Vec<_> = [
            "4294967295",
            "0:4294967295",
            "baduid",
            "badgid",
            "1000",
            "0:badgroup",
        ]
        .into_iter()
        .filter_map(|user| resolve_user(root, user).ok().map(|ids| (user, ids)))
        .collect();
        assert!(accepted.is_empty(), "accepted reserved IDs: {accepted:?}");
        assert_eq!(
            resolve_user(root, "4294967294:4294967294").unwrap(),
            (u32::MAX - 1, u32::MAX - 1)
        );
    }

    #[test]
    fn path_reports_rejections_and_stops_at_first_executable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        let candidate = path.join("workload");
        let mut spec = ProcessSpec {
            args: vec!["workload".into()],
            env: [("PATH".into(), path.display().to_string())].into(),
            cwd: path.into(),
            uid: 0,
            gid: 0,
            capabilities: Default::default(),
        };
        let rejection = |spec: &ProcessSpec| match Command::prepare(spec) {
            Err(RunError::Rejected(rejection)) => rejection.exit_code,
            _ => panic!("expected a command rejection"),
        };
        assert_eq!(rejection(&spec), 127);
        fs::write(&candidate, "").unwrap();
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(rejection(&spec), 126);

        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755)).unwrap();
        let looping = path.join("loop");
        symlink("loop", &looping).unwrap();
        spec.env.insert(
            "PATH".into(),
            format!("{}:{}", path.display(), looping.display()),
        );
        assert!(
            Command::prepare(&spec).is_ok(),
            "later ELOOP must not override a PATH hit"
        );
    }
}
