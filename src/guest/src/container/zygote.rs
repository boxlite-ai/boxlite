//! Single-threaded launch server, forked before Tokio starts. A child cloned
//! directly by the async guest could inherit allocator locks held by threads.

use super::runner::{RunnerRegistry, Spawned};
use super::spec::{InitSpec, ProcessSpec};
use super::SpawnFailure;
use crate::service::exec::exec_handle::PtyConfig;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::sys::socket::{
    recvmsg, sendmsg, socketpair, AddressFamily, ControlMessage, ControlMessageOwned, MsgFlags,
    SockFlag, SockType,
};
use nix::unistd::{fork, ForkResult, Pid};
use serde::{Deserialize, Serialize};
use std::io::{IoSlice, IoSliceMut};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::{Mutex, OnceLock};

pub(crate) static ZYGOTE: OnceLock<Zygote> = OnceLock::new();

#[derive(Debug)]
pub(crate) struct Zygote {
    sock: Mutex<OwnedFd>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(super) struct BuildSpec {
    pub container_id: String,
    pub process: ProcessSpec,
    pub ssh_workload: Option<crate::service::ssh::SshWorkload>,
    pub pty_config: Option<PtyConfig>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(super) struct InitBuildSpec {
    pub container_id: String,
    pub spec: InitSpec,
    pub pty_config: Option<PtyConfig>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(super) enum BuildResult {
    Spawned { pid: i32 },
    Failed { error: String },
    Rejected { message: String, exit_code: i32 },
}

/// A caller-supplied program was missing (127) or could not be executed (126).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CommandRejection {
    pub message: String,
    pub exit_code: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Status {
    Created,
    Running,
    Stopped,
}

#[derive(Serialize, Deserialize, Debug)]
enum Request {
    Build(BuildSpec),
    BuildInit(InitBuildSpec),
    Start(String),
    Status(String),
    Signal { id: String, force: bool },
    Remove(String),
}

#[derive(Serialize, Deserialize, Debug)]
enum Response {
    Build(BuildResult),
    BuildInit(BuildResult),
    Start(Result<(), BuildResult>),
    Status(Status),
    Signal(Result<(), String>),
    Remove(Result<(), String>),
}

impl Zygote {
    /// Must run before any async runtime threads exist.
    pub fn start() -> BoxliteResult<Self> {
        let (parent, child) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .map_err(internal)?;
        let registry = RunnerRegistry::new().map_err(internal)?;
        // SAFETY: caller is single-threaded. The child stays single-threaded.
        match unsafe { fork() }.map_err(internal)? {
            ForkResult::Child => {
                // Only the guest agent owns the reset policy. Never unwind
                // out of the zygote into its caller.
                std::panic::set_hook(Box::new(|_| unsafe { nix::libc::_exit(101) }));
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    drop(parent);
                    serve(child, registry);
                }));
                unsafe { nix::libc::_exit(if result.is_ok() { 0 } else { 101 }) };
            }
            ForkResult::Parent { child: pid } => {
                drop(child);
                tracing::debug!(zygote_pid = pid.as_raw(), "zygote started");
                Ok(Self {
                    sock: Mutex::new(parent),
                })
            }
        }
    }

    fn exchange(
        &self,
        request: Request,
        fds: &[RawFd],
        expect_fds: usize,
    ) -> BoxliteResult<(Response, Vec<OwnedFd>)> {
        let sock = self.sock.lock().unwrap();
        send_packet(sock.as_raw_fd(), &request, fds)?;
        recv_packet(sock.as_raw_fd(), expect_fds)
    }

    pub(super) fn build(&self, spec: BuildSpec, fds: &[RawFd]) -> Result<Spawned, SpawnFailure> {
        let pty = spec.pty_config.is_some();
        let (response, fds) = self.exchange(Request::Build(spec), fds, usize::from(pty))?;
        match response {
            Response::Build(result) => build_result(result, fds, pty),
            other => Err(protocol(other).into()),
        }
    }

    pub(super) fn build_init(&self, spec: InitBuildSpec, fds: &[RawFd]) -> BoxliteResult<Spawned> {
        let pty = spec.pty_config.is_some();
        let (response, fds) = self.exchange(Request::BuildInit(spec), fds, usize::from(pty))?;
        match response {
            Response::BuildInit(result) => build_result(result, fds, pty).map_err(init_failure),
            other => Err(protocol(other)),
        }
    }

    pub(super) fn run_init(&self, id: &str) -> BoxliteResult<()> {
        match self.exchange(Request::Start(id.into()), &[], 0)?.0 {
            Response::Start(result) => result.map_err(|result| init_failure(build_failure(result))),
            other => Err(protocol(other)),
        }
    }

    pub(super) fn status(&self, id: &str) -> BoxliteResult<Status> {
        match self.exchange(Request::Status(id.into()), &[], 0)?.0 {
            Response::Status(status) => Ok(status),
            other => Err(protocol(other)),
        }
    }

    pub(super) fn signal(&self, id: &str, force: bool) -> BoxliteResult<()> {
        match self
            .exchange(
                Request::Signal {
                    id: id.into(),
                    force,
                },
                &[],
                0,
            )?
            .0
        {
            Response::Signal(result) => result.map_err(BoxliteError::Internal),
            other => Err(protocol(other)),
        }
    }

    pub(super) fn remove(&self, id: &str) -> BoxliteResult<()> {
        match self.exchange(Request::Remove(id.into()), &[], 0)?.0 {
            Response::Remove(result) => result.map_err(BoxliteError::Internal),
            other => Err(protocol(other)),
        }
    }
}

fn internal(error: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Internal(format!("zygote: {error}"))
}
fn protocol(response: Response) -> BoxliteError {
    internal(format!("unexpected response {response:?}"))
}

fn build_failure(result: BuildResult) -> SpawnFailure {
    match result {
        BuildResult::Failed { error } => BoxliteError::Internal(error).into(),
        BuildResult::Rejected { message, exit_code } => {
            SpawnFailure::Rejected(CommandRejection { message, exit_code })
        }
        BuildResult::Spawned { .. } => internal("unexpected successful build").into(),
    }
}

// Init does not have an exec outcome to return to the caller. Preserve the
// invalid-argument contract for rejected commands, not for runner faults.
fn init_failure(failure: SpawnFailure) -> BoxliteError {
    match failure {
        SpawnFailure::Rejected(rejection) => BoxliteError::InvalidArgument(rejection.message),
        SpawnFailure::Failed(error) => error,
    }
}

fn build_result(
    result: BuildResult,
    mut fds: Vec<OwnedFd>,
    pty: bool,
) -> Result<Spawned, SpawnFailure> {
    match result {
        BuildResult::Spawned { pid } if fds.len() == usize::from(pty) => Ok(Spawned {
            pid: Pid::from_raw(pid),
            pty: fds.pop(),
        }),
        BuildResult::Spawned { .. } => Err(internal("incorrect PTY fd count").into()),
        other => Err(build_failure(other)),
    }
}

fn serve(sock: OwnedFd, mut registry: RunnerRegistry) {
    while let Ok((request, fds)) = recv_packet(sock.as_raw_fd(), 3) {
        let mut pty = None;
        let mut build = |result: Result<Spawned, super::runner::RunError>| match result {
            Ok(spawned) => {
                pty = spawned.pty;
                BuildResult::Spawned {
                    pid: spawned.pid.as_raw(),
                }
            }
            Err(error) => error.into(),
        };
        let response = match request {
            Request::Build(spec) => Response::Build(build(registry.build(spec, fds))),
            Request::BuildInit(spec) => Response::BuildInit(build(registry.build_init(spec, fds))),
            Request::Start(id) => Response::Start(registry.start(&id).map_err(Into::into)),
            Request::Status(id) => Response::Status(registry.status(&id)),
            Request::Signal { id, force } => {
                Response::Signal(registry.signal(&id, force).map_err(|e| e.to_string()))
            }
            Request::Remove(id) => {
                Response::Remove(registry.remove(&id).map_err(|e| e.to_string()))
            }
        };
        let raw = pty.as_ref().map(AsRawFd::as_raw_fd);
        if send_packet(sock.as_raw_fd(), &response, raw.as_slice()).is_err() {
            break;
        }
    }
}

const MAX_MSG_SIZE: usize = 1_048_576;

pub(super) fn send_packet<T: Serialize>(
    sock: RawFd,
    message: &T,
    fds: &[RawFd],
) -> BoxliteResult<()> {
    let json = serde_json::to_vec(message).map_err(internal)?;
    if json.len() > MAX_MSG_SIZE {
        return Err(internal("IPC message too large"));
    }
    let iov = [IoSlice::new(&json)];
    let rights = (!fds.is_empty()).then_some(ControlMessage::ScmRights(fds));
    sendmsg::<()>(sock, &iov, rights.as_slice(), MsgFlags::MSG_NOSIGNAL, None).map_err(internal)?;
    Ok(())
}

pub(super) fn recv_packet<T: for<'de> Deserialize<'de>>(
    sock: RawFd,
    max_fds: usize,
) -> BoxliteResult<(T, Vec<OwnedFd>)> {
    let mut buf = vec![0; MAX_MSG_SIZE];
    // Linux permits up to 253 descriptors in SCM_RIGHTS. Take ownership of
    // all received fds even when the packet or its descriptor count is invalid.
    let mut ancillary = nix::cmsg_space!([RawFd; 253]);
    let mut iov = [IoSliceMut::new(&mut buf)];
    let msg = recvmsg::<()>(
        sock,
        &mut iov,
        Some(&mut ancillary),
        MsgFlags::MSG_CMSG_CLOEXEC,
    )
    .map_err(internal)?;
    let mut fds = Vec::new();
    for cmsg in msg.cmsgs().map_err(internal)? {
        if let ControlMessageOwned::ScmRights(raw) = cmsg {
            fds.extend(
                raw.into_iter()
                    .map(|fd| unsafe { OwnedFd::from_raw_fd(fd) }),
            );
        }
    }
    let bytes = msg.bytes;
    if bytes == 0 {
        return Err(internal("IPC peer closed"));
    }
    if fds.len() > max_fds
        || msg
            .flags
            .intersects(MsgFlags::MSG_TRUNC | MsgFlags::MSG_CTRUNC)
    {
        return Err(internal("invalid IPC packet size or fd count"));
    }
    Ok((
        serde_json::from_slice(&buf[..bytes]).map_err(internal)?,
        fds,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::container::capabilities::CapabilitySet;
    use std::collections::HashMap;

    #[test]
    fn tenant_plan_round_trips_with_stdio() {
        let (send, recv) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let (read, _) = nix::unistd::pipe().unwrap();
        let spec = BuildSpec {
            container_id: "test".into(),
            process: ProcessSpec {
                env: HashMap::from([("PATH".into(), "/bin".into())]),
                cwd: "/work".into(),
                args: vec!["true".into()],
                uid: 123,
                gid: 456,
                capabilities: CapabilitySet::default(),
            },
            ssh_workload: Some(crate::service::ssh::SshWorkload::Shell),
            pty_config: None,
        };
        send_packet(
            send.as_raw_fd(),
            &Request::Build(spec.clone()),
            &[read.as_raw_fd(); 3],
        )
        .unwrap();
        let (Request::Build(received), fds) = recv_packet(recv.as_raw_fd(), 3).unwrap() else {
            panic!("wrong request")
        };
        assert_eq!(spec, received);
        assert_eq!(fds.len(), 3);
        for fd in fds {
            let flags = nix::fcntl::fcntl(fd.as_raw_fd(), nix::fcntl::FcntlArg::F_GETFD).unwrap();
            assert_ne!(flags & nix::libc::FD_CLOEXEC, 0);
        }
    }

    #[test]
    fn closed_zygote_returns_an_ipc_error() {
        let (send, recv) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        drop(recv);
        assert!(send_packet(send.as_raw_fd(), &Request::Status("test".into()), &[]).is_err());
        assert!(recv_packet::<Response>(send.as_raw_fd(), 0).is_err());
    }
}
