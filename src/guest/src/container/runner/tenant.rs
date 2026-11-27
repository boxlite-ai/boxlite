//! Join the init child's existing view. The zygote only selects the next
//! child's PID namespace; all other namespace changes happen in the child.

use super::super::zygote::BuildSpec;
use super::process::{self, Command, Stdio};
use super::{RunError, RunnerRegistry, Spawned};
use crate::service::ssh::BoxliteWorkloadExecutor;
use nix::sched::{setns, CloneFlags};
use nix::unistd::{chdir, chroot, fchdir};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};

impl RunnerRegistry {
    pub(super) fn spawn_tenant(
        &mut self,
        request: BuildSpec,
        fds: Vec<OwnedFd>,
    ) -> Result<Spawned, RunError> {
        let id = &request.container_id;
        let entry = self
            .entries
            .get(id)
            .filter(|entry| {
                matches!(entry.state, super::State::Running) && entry.identity.is_alive()
            })
            .ok_or_else(|| RunError::Failed(format!("container {id} is not running")))?;
        let terminal = request.pty_config.is_some();
        let executor = request.ssh_workload.map(BoxliteWorkloadExecutor::new);
        if let Some(executor) = &executor {
            executor
                .validate(&request.process.args, terminal)
                .map_err(|e| RunError::Failed(e.to_string()))?;
        }
        let stdio = Stdio::new(fds, request.pty_config)?;
        let spec = request.process;
        let (exec_notify_pipe, notify) = process::pipe()?;
        let (pid, _) = self
            .clone_support
            .spawn(
                &self.root_pidns_fd,
                Some(&entry.ns.pid),
                entry.cgroup.as_ref(),
                || {
                    let setup = || -> Result<(), RunError> {
                        let ns = &entry.ns;
                        setns(&ns.ipc, CloneFlags::CLONE_NEWIPC).map_err(io::Error::from)?;
                        setns(&ns.uts, CloneFlags::CLONE_NEWUTS).map_err(io::Error::from)?;
                        if let Some(cgroup) = &ns.cgroup {
                            setns(cgroup, CloneFlags::CLONE_NEWCGROUP).map_err(io::Error::from)?;
                        }
                        setns(&ns.mnt, CloneFlags::CLONE_NEWNS).map_err(io::Error::from)?;
                        let mut keep = vec![notify.as_raw_fd(), ns.root.as_raw_fd()];
                        stdio.keep_fds(&mut keep);
                        process::close_inherited(&keep)?;
                        // setns(mnt) doesn't replace cwd/root; enter init's actual
                        // root without changing the shared mount table in any way.
                        fchdir(ns.root.as_raw_fd()).map_err(io::Error::from)?;
                        chroot(".").map_err(io::Error::from)?;
                        chdir("/").map_err(io::Error::from)?;
                        stdio.setup((spec.uid, spec.gid), false)?;
                        process::close_inherited(&[notify.as_raw_fd()])?;
                        process::credentials(&spec).map_err(RunError::from)
                    };
                    if let Err(error) = setup() {
                        process::child_exit(error, notify);
                    }
                    if let Some(executor) = executor {
                        let mut notify = Some(notify);
                        let result = executor.exec(&spec.env, || drop(notify.take()));
                        if let Some(notify) = notify {
                            process::child_exit(
                                RunError::Failed(result.err().map_or_else(
                                    || "SSH workload returned before execution".into(),
                                    |error| error.to_string(),
                                )),
                                notify,
                            );
                        }
                        unsafe { nix::libc::_exit(i32::from(result.is_err())) };
                    }
                    let error = match Command::prepare(&spec) {
                        Ok(command) => command.exec(),
                        Err(e) => e,
                    };
                    process::child_exit(error, notify);
                },
            )
            .map_err(|e| io::Error::other(format!("clone tenant: {e}")))?;
        process::read_report(exec_notify_pipe, false)?;
        let pty = stdio.receive()?;
        Ok(Spawned { pid, pty })
    }
}
