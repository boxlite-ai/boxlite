//! A guest-local OCI runner for BoxLite's resolved launch plans. All mutable
//! runtime state and cached namespace handles belong to the single-threaded zygote.

mod cgroup;
mod clone;
mod init;
mod process;
mod rootfs;
mod tenant;

use super::zygote::{BuildResult, CommandRejection};
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::OwnedFd;

pub(super) struct RunnerRegistry {
    entries: HashMap<String, Entry>,
    clone_support: clone::CloneSupport,
    root_pidns_fd: File,
}

struct Entry {
    identity: process::Identity,
    ns: Namespaces,
    cgroup: Option<cgroup::Cgroup>,
    state: State,
}

enum State {
    Created(Pending),
    Running,
    Stopped,
}

struct Pending {
    start_gate_pipe: File,
    exec_notify_pipe: File,
}

struct Namespaces {
    pid: File,
    ipc: File,
    uts: File,
    cgroup: Option<File>,
    mnt: File,
    root: File,
}

impl Namespaces {
    fn open(init: &process::Identity, private_cgroup: bool) -> io::Result<Self> {
        let open = |path| File::open(init.proc_path(path));
        Ok(Self {
            pid: open("ns/pid")?,
            ipc: open("ns/ipc")?,
            uts: open("ns/uts")?,
            cgroup: private_cgroup.then(|| open("ns/cgroup")).transpose()?,
            mnt: open("ns/mnt")?,
            root: open("root")?,
        })
    }
}

pub(super) struct Spawned {
    pub pid: Pid,
    pub pty: Option<OwnedFd>,
}

pub(super) enum RunError {
    Failed(String),
    Rejected(CommandRejection),
}

impl From<io::Error> for RunError {
    fn from(error: io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<RunError> for BuildResult {
    fn from(error: RunError) -> Self {
        match error {
            RunError::Failed(error) => Self::Failed { error },
            RunError::Rejected(CommandRejection { message, exit_code }) => {
                Self::Rejected { message, exit_code }
            }
        }
    }
}

pub(super) fn validate_id(id: &str) -> io::Result<()> {
    if id.is_empty()
        || id == "."
        || id == ".."
        || id.len() > 247
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid container ID: {id:?}"),
        ));
    }
    Ok(())
}

impl RunnerRegistry {
    pub(super) fn new() -> io::Result<Self> {
        Ok(Self {
            entries: HashMap::new(),
            clone_support: Default::default(),
            root_pidns_fd: File::open("/proc/self/ns/pid")?,
        })
    }

    pub(super) fn build_init(
        &mut self,
        spec: super::zygote::InitBuildSpec,
        fds: Vec<OwnedFd>,
    ) -> Result<Spawned, RunError> {
        let id = spec.container_id.clone();
        let result = self.create_init(spec, fds);
        match &result {
            // The guest console marker identifies the launch path even when
            // boot timing is disabled.
            Ok(Spawned { pid, .. }) => {
                eprintln!("[zygote] init build: container_id={id} pid={pid}")
            }
            Err(
                RunError::Failed(error)
                | RunError::Rejected(CommandRejection { message: error, .. }),
            ) if crate::boot_timing_enabled() => {
                eprintln!("[zygote] init build failed: container_id={id} error={error}");
            }
            Err(_) => {}
        }
        result
    }

    pub(super) fn build(
        &mut self,
        spec: super::zygote::BuildSpec,
        fds: Vec<OwnedFd>,
    ) -> Result<Spawned, RunError> {
        self.spawn_tenant(spec, fds)
    }

    pub(super) fn start(&mut self, id: &str) -> Result<(), RunError> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| RunError::Failed(format!("unknown container {id}")))?;
        if !entry.identity.is_alive() {
            entry.state = State::Stopped;
        }
        match std::mem::replace(&mut entry.state, State::Stopped) {
            State::Running => {
                entry.state = State::Running;
                Ok(())
            }
            State::Stopped => Err(RunError::Failed(format!("container {id} has stopped"))),
            State::Created(mut pending) => {
                pending.start_gate_pipe.write_all(&[1])?;
                drop(pending.start_gate_pipe);
                process::read_report(pending.exec_notify_pipe, false)?;
                entry.state = State::Running;
                Ok(())
            }
        }
    }

    pub(super) fn status(&mut self, id: &str) -> super::zygote::Status {
        use super::zygote::Status;
        let Some(entry) = self.entries.get_mut(id) else {
            return Status::Stopped;
        };
        if !entry.identity.is_alive() {
            entry.state = State::Stopped;
        }
        match entry.state {
            State::Created(_) => Status::Created,
            State::Running => Status::Running,
            State::Stopped => Status::Stopped,
        }
    }

    pub(super) fn signal(&self, id: &str, force: bool) -> io::Result<()> {
        let Some(entry) = self.entries.get(id) else {
            return Ok(());
        };
        if force {
            // Killing PID 1 also kills all remaining members of its PID
            // namespace, even if a privileged workload moved to another cgroup.
            let result = entry.identity.signal(Signal::SIGKILL);
            if let Some(cgroup) = &entry.cgroup {
                cgroup.kill()?;
            }
            result
        } else {
            entry.identity.signal(Signal::SIGTERM)
        }
    }

    pub(super) fn remove(&mut self, id: &str) -> io::Result<()> {
        let result = self.signal(id, true);
        self.entries.remove(id);
        result
    }
}

impl Drop for RunnerRegistry {
    fn drop(&mut self) {
        for id in self.entries.keys() {
            let _ = self.signal(id, true);
        }
    }
}
