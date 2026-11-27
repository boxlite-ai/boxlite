//! Clone only from the single-threaded zygote. PID namespace selection affects
//! its next child, not the zygote itself; mount namespace selection never does.

use super::cgroup::Cgroup;
use nix::libc;
use nix::sched::{setns, unshare, CloneFlags};
use nix::unistd::{pipe2, Pid};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

const CLONE_INTO_CGROUP: u64 = 1 << 33;

#[derive(Default)]
pub(super) struct CloneSupport {
    no_into_cgroup: bool,
    no_pidfd: bool,
    no_clone3: bool,
}

struct PidNsGuard<'a>(&'a File);

impl<'a> PidNsGuard<'a> {
    fn enter(original: &'a File, next: Option<&File>) -> io::Result<Self> {
        match next {
            Some(target) => setns(target, CloneFlags::CLONE_NEWPID)?,
            None => unshare(CloneFlags::CLONE_NEWPID)?,
        }
        Ok(Self(original))
    }
}

impl Drop for PidNsGuard<'_> {
    fn drop(&mut self) {
        if let Err(error) = setns(self.0, CloneFlags::CLONE_NEWPID) {
            // Serving another request in the wrong PID namespace is unsafe.
            eprintln!("[zygote] cannot restore PID namespace: {error}");
            unsafe { libc::_exit(1) };
        }
    }
}

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
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

fn unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP)
    )
}

impl CloneSupport {
    fn raw_clone(
        &mut self,
        flags: u64,
        cgroup: Option<&Cgroup>,
        want_pidfd: bool,
    ) -> io::Result<(i32, Option<OwnedFd>)> {
        let mut with_pidfd = want_pidfd && !self.no_pidfd;
        let mut into_cgroup = cgroup.is_some() && !self.no_into_cgroup;
        loop {
            // Linux inherits the zygote's SIGCHLD disposition for reporting
            // child exit to its parent with CLONE_PARENT. clone3 requires the
            // supplied exit_signal field to be zero for this combination.
            if self.no_clone3 {
                let pid =
                    unsafe { libc::syscall(libc::SYS_clone, flags as libc::c_ulong, 0, 0, 0, 0) };
                if pid < 0 {
                    return Err(io::Error::last_os_error());
                }
                return Ok((pid as i32, None));
            }
            let mut pidfd = -1i32;
            let args = CloneArgs {
                flags: flags
                    | if into_cgroup { CLONE_INTO_CGROUP } else { 0 }
                    | if with_pidfd {
                        libc::CLONE_PIDFD as u64
                    } else {
                        0
                    },
                pidfd: if with_pidfd {
                    (&mut pidfd as *mut i32) as u64
                } else {
                    0
                },
                cgroup: if into_cgroup {
                    cgroup.unwrap().fd.as_raw_fd() as u64
                } else {
                    0
                },
                ..Default::default()
            };
            let pid =
                unsafe { libc::syscall(libc::SYS_clone3, &args, std::mem::size_of::<CloneArgs>()) };
            if pid >= 0 {
                if !into_cgroup && cgroup.is_some() {
                    self.no_into_cgroup = true;
                }
                if want_pidfd && !with_pidfd {
                    self.no_pidfd = true;
                }
                return Ok((
                    pid as i32,
                    (pidfd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(pidfd) }),
                ));
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOSYS) {
                self.no_clone3 = true;
                self.no_into_cgroup = true;
                self.no_pidfd = true;
            } else if unsupported(&error) && into_cgroup {
                into_cgroup = false;
            } else if unsupported(&error) && with_pidfd {
                with_pidfd = false;
            } else {
                return Err(error);
            }
        }
    }

    pub(super) fn spawn(
        &mut self,
        original: &File,
        next: Option<&File>,
        cgroup: Option<&Cgroup>,
        child: impl FnOnce(),
    ) -> io::Result<(Pid, Option<OwnedFd>)> {
        let flags = libc::CLONE_PARENT
            | if next.is_none() {
                libc::CLONE_NEWNS | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS
            } else {
                0
            };
        self.spawn_with(
            flags,
            cgroup,
            next.is_none(),
            || PidNsGuard::enter(original, next),
            child,
        )
    }

    fn spawn_with<G>(
        &mut self,
        flags: libc::c_int,
        cgroup: Option<&Cgroup>,
        want_pidfd: bool,
        enter: impl FnOnce() -> io::Result<G>,
        child: impl FnOnce(),
    ) -> io::Result<(Pid, Option<OwnedFd>)> {
        // Allocate the migration barrier only if needed (or on the first
        // probe with cgroups, when the kernel could reject atomic placement).
        let sync = cgroup
            .map(|_| pipe2(nix::fcntl::OFlag::O_CLOEXEC))
            .transpose()?;
        let guard = enter()?;
        let cloned = self.raw_clone(flags as u64, cgroup, want_pidfd);
        if matches!(cloned, Ok((0, _))) {
            // The child must not attempt to restore the zygote's PID namespace.
            std::mem::forget(guard);
            // A container PID 1 must never run the guest's reset hook or
            // unwind into the zygote's registry.
            std::panic::set_hook(Box::new(|_| unsafe { libc::_exit(101) }));
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                // The guest's Rust runtime ignores SIGPIPE; workload pipelines
                // expect the standard disposition instead.
                unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
                if let Some((read, write)) = sync {
                    drop(write);
                    if self.no_into_cgroup && File::from(read).read_exact(&mut [0]).is_err() {
                        unsafe { libc::_exit(1) };
                    }
                }
                child();
            }));
            unsafe { libc::_exit(if result.is_ok() { 1 } else { 101 }) };
        }
        drop(guard);
        let (pid, pidfd) = cloned?;
        let pid = Pid::from_raw(pid);
        if let (Some((read, write)), Some(cgroup)) = (sync, cgroup) {
            drop(read);
            if self.no_into_cgroup {
                // On error, closing the barrier makes the child exit without
                // running setup or workload code outside its target cgroup.
                cgroup.place(pid)?;
                File::from(write).write_all(&[1])?;
            }
        }
        Ok((pid, pidfd))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::sys::wait::{waitpid, WaitStatus};

    #[test]
    fn spawned_panic_exits_without_inherited_hook_or_unwind() {
        const PROBE: &str = "BOXLITE_CLONE_PANIC_PROBE";
        if std::env::var_os(PROBE).is_none() {
            // Isolate the inherited panic hook and run without other tests.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    concat!(
                        module_path!(),
                        "::spawned_panic_exits_without_inherited_hook_or_unwind"
                    )
                    .split_once("::")
                    .unwrap()
                    .1,
                    "--test-threads=1",
                ])
                .env(PROBE, "1")
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success() && stdout.contains("1 passed"),
                "{stdout}\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let mut support = CloneSupport {
            no_clone3: true,
            ..Default::default()
        };
        let saved = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| unsafe { libc::_exit(99) }));
        // Exercise spawn's actual clone/child branch without privileged
        // namespace setup; SIGCHLD makes the child waitable in this test.
        let result = support.spawn_with(
            libc::SIGCHLD,
            None,
            false,
            || Ok(()),
            || {
                panic!("child panic");
            },
        );
        std::panic::set_hook(saved);
        let (pid, _) = result.unwrap();
        assert_eq!(waitpid(pid, None).unwrap(), WaitStatus::Exited(pid, 101));
    }
}
