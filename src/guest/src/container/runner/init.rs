//! The init child alone sets up and pivots the root filesystem. It reports
//! readiness before start, then reports exec failure (or CLOEXEC EOF) to Start.

use super::super::zygote::InitBuildSpec;
use super::cgroup::Cgroup;
use super::process::{self, Command, Identity, Stdio};
use super::{Entry, Namespaces, Pending, RunError, RunnerRegistry, Spawned};
use nix::sched::{unshare, CloneFlags};
use nix::sys::resource::{setrlimit, Resource};
use nix::sys::signal::Signal;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};

impl RunnerRegistry {
    pub(super) fn create_init(
        &mut self,
        request: InitBuildSpec,
        fds: Vec<OwnedFd>,
    ) -> Result<Spawned, RunError> {
        let id = request.container_id;
        super::validate_id(&id)?;
        if self.entries.contains_key(&id) {
            return Err(RunError::Failed(format!("container {id} already exists")));
        }
        let spec = request.spec;
        let stdio = Stdio::new(fds, request.pty_config)?;
        let cgroup = Cgroup::create(&id, spec.cgroup.limits)
            .map_err(|e| io::Error::other(format!("create cgroup for {id}: {e}")))?;
        let private_cgroup = cgroup.as_ref().filter(|_| spec.cgroup.namespace);
        let (ready_pipe, mut ready) = process::pipe()?;
        let (mut gate, start_gate_pipe) = process::pipe()?;
        let (exec_notify_pipe, notify) = process::pipe()?;
        let (pid, pidfd) = self
            .clone_support
            .spawn(&self.root_pidns_fd, None, cgroup.as_ref(), || {
                let setup = || -> Result<Command, RunError> {
                    let mut keep = vec![ready.as_raw_fd(), gate.as_raw_fd(), notify.as_raw_fd()];
                    stdio.keep_fds(&mut keep);
                    process::close_inherited(&keep)?;
                    let cgroup_mount = if let Some(group) = private_cgroup {
                        unshare(CloneFlags::CLONE_NEWCGROUP).map_err(io::Error::from)?;
                        Some(group.open_for_mount()?)
                    } else {
                        None
                    };
                    nix::unistd::sethostname("boxlite").map_err(io::Error::from)?;
                    super::rootfs::prepare(&spec, cgroup_mount.as_ref())?;
                    drop(cgroup_mount);
                    stdio.setup((spec.process.uid, spec.process.gid), true)?;
                    process::close_inherited(&[
                        ready.as_raw_fd(),
                        gate.as_raw_fd(),
                        notify.as_raw_fd(),
                    ])?;
                    setrlimit(Resource::RLIMIT_NOFILE, 1_048_576, 1_048_576)
                        .map_err(io::Error::from)?;
                    process::credentials(&spec.process)?;
                    Command::prepare(&spec.process)
                };
                let command = match setup() {
                    Ok(command) => command,
                    Err(error) => process::child_exit(error, ready),
                };
                if ready.write_all(&[1]).is_err() {
                    unsafe { nix::libc::_exit(1) };
                }
                drop(ready);
                if gate.read_exact(&mut [0]).is_err() {
                    unsafe { nix::libc::_exit(1) };
                }
                drop(gate);
                process::child_exit(command.exec(), notify);
            })
            .map_err(|e| io::Error::other(format!("clone init: {e}")))?;
        let identity = Identity::open(pid, pidfd);
        process::read_report(ready_pipe, true)?;
        let identity = identity?;
        let result = (|| -> Result<_, RunError> {
            let ns = Namespaces::open(&identity, private_cgroup.is_some())?;
            let pty = stdio.receive()?;
            Ok((ns, pty))
        })();
        let (ns, pty) = match result {
            Ok(value) => value,
            Err(error) => {
                let _ = identity.signal(Signal::SIGKILL);
                return Err(error);
            }
        };
        self.entries.insert(
            id,
            Entry {
                identity,
                ns,
                cgroup,
                state: super::State::Created(Pending {
                    start_gate_pipe,
                    exec_notify_pipe,
                }),
            },
        );
        Ok(Spawned { pid, pty })
    }
}
