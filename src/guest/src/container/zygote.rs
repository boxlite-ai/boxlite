//! Zygote process for safe clone3() in single-threaded context.
//!
//! When libcontainer's `build()` calls `clone3()` from inside a multi-threaded
//! tokio process, the forked child can inherit a locked copy of musl's
//! `__malloc_lock` from another thread, causing a permanent deadlock.
//!
//! The zygote is forked **before** tokio starts any threads. It stays
//! single-threaded and handles all `build()` calls via IPC, making clone3()
//! safe. This is the same pattern as runwasi's Zygote (PR #775) and
//! runc's nsexec.
//!
//! See `docs/investigations/concurrent-exec-deadlock.md` for full analysis.

use super::capabilities::capability_names;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use libcontainer::container::builder::ContainerBuilder;
use libcontainer::syscall::syscall::SyscallType;
use nix::sys::socket::{
    recvmsg, sendmsg, socketpair, AddressFamily, ControlMessage, ControlMessageOwned, MsgFlags,
    SockFlag, SockType,
};
use nix::unistd::{fork, ForkResult, Pid};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{IoSlice, IoSliceMut};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Global zygote instance. Initialized once in main() before tokio starts.
pub(crate) static ZYGOTE: OnceLock<Zygote> = OnceLock::new();

/// Handle to the zygote process, held by the parent (tokio) process.
///
/// The zygote is a single-threaded child process that handles all
/// `ContainerBuilder::build()` calls. Access is serialized by the mutex
/// on the socket — one build at a time.
pub(crate) struct Zygote {
    /// SEQPACKET socket to the zygote child process.
    /// Mutex serializes concurrent build() calls (one IPC round-trip at a time).
    sock: Mutex<OwnedFd>,
}

impl std::fmt::Debug for Zygote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Zygote").field("sock", &"<fd>").finish()
    }
}

/// What to build. Serialized over IPC to the zygote.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct BuildSpec {
    pub container_id: String,
    pub state_root: PathBuf,
    pub console_socket: Option<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub args: Vec<String>,
    pub uid: u32,
    pub gid: u32,
}

/// Build outcome. Invalid states are unrepresentable.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(crate) enum BuildResult {
    Spawned { pid: i32 },
    Failed { error: String },
}

/// Process exit outcome from waitpid, serialized over IPC.
///
/// The zygote is the only process that can call waitpid on container
/// processes (it's their parent via clone3). This enum carries the exit
/// status back to the main process over the SEQPACKET socket.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(crate) enum WaitResult {
    /// Process called exit(code). Code 0 = success.
    Exited { code: i32 },
    /// Process was killed by signal (e.g., SIGKILL=9).
    Signaled { signal: i32 },
    /// Process is still running (WNOHANG returned StillAlive).
    /// The caller should retry after a short delay.
    StillAlive,
    /// waitpid failed or returned unexpected status.
    Failed { error: String },
}

/// Tagged IPC request from parent to zygote.
///
/// Allows multiplexing build and wait operations on a single SEQPACKET socket.
/// The parent's Mutex ensures only one request is in-flight at a time.
#[derive(Serialize, Deserialize, Debug, Clone)]
enum ZygoteRequest {
    /// Build a new container process. May include SCM_RIGHTS fds for stdio pipes.
    Build(BuildSpec),
    /// Wait for a container process to exit and return its exit status.
    /// The zygote must handle this because it's the parent of all container
    /// processes (they were created by clone3() inside the zygote).
    Wait { pid: i32 },
}

/// Tagged IPC response from zygote to parent, matched 1:1 with requests.
///
/// The protocol is strictly request-response (no unsolicited messages),
/// serialized by the parent's Mutex.
#[derive(Serialize, Deserialize, Debug, Clone)]
enum ZygoteResponse {
    Build(BuildResult),
    Wait(WaitResult),
}

impl Zygote {
    /// Start the zygote process. **MUST** be called before any threads exist.
    ///
    /// Forks a child process that stays single-threaded forever. The child
    /// runs `serve()` which receives build requests over the SEQPACKET socket.
    pub fn start() -> BoxliteResult<Self> {
        let (parent_sock, child_sock) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .map_err(|e| BoxliteError::Internal(format!("zygote socketpair: {e}")))?;

        // SAFETY: Called before any threads exist (precondition).
        // The child process inherits a clean, single-threaded address space.
        match unsafe { fork() } {
            Ok(ForkResult::Child) => {
                // Child: close parent's end, enter serve loop (never returns)
                drop(parent_sock);
                serve(child_sock);
            }
            Ok(ForkResult::Parent { child }) => {
                // Parent: close child's end, return handle
                drop(child_sock);
                tracing::info!(zygote_pid = child.as_raw(), "zygote started");
                Ok(Self {
                    sock: Mutex::new(parent_sock),
                })
            }
            Err(e) => Err(BoxliteError::Internal(format!("zygote fork: {e}"))),
        }
    }

    /// Build a container tenant process via the zygote. Returns the spawned PID.
    ///
    /// Wraps BuildSpec in ZygoteRequest::Build and expects ZygoteResponse::Build back.
    /// SCM_RIGHTS fd passing is unchanged — fds are only attached for Build requests.
    /// Blocks until the build completes (use from `spawn_blocking`).
    pub fn build(&self, spec: BuildSpec, fds: Option<[RawFd; 3]>) -> BoxliteResult<Pid> {
        let sock = self.sock.lock().unwrap();
        let fd = sock.as_raw_fd();
        send_request(fd, &ZygoteRequest::Build(spec), fds)?;
        match recv_response(fd)? {
            ZygoteResponse::Build(BuildResult::Spawned { pid }) => Ok(Pid::from_raw(pid)),
            ZygoteResponse::Build(BuildResult::Failed { error }) => {
                Err(BoxliteError::Internal(error))
            }
            other => Err(BoxliteError::Internal(format!(
                "expected Build response, got: {other:?}"
            ))),
        }
    }

    /// Wait for a container process to exit. Returns exit status.
    ///
    /// Container processes are direct children of the zygote (created by
    /// clone3 inside build()). Only the zygote can waitpid on them — the
    /// main process gets ECHILD because it's not the parent.
    ///
    /// This sends a Wait request over IPC to the zygote, which calls
    /// waitpid(pid, 0) and returns the result.
    ///
    /// Blocks until the process exits. Call from spawn_blocking to avoid
    /// blocking the tokio runtime.
    pub fn wait(&self, pid: Pid) -> BoxliteResult<WaitResult> {
        let sock = self.sock.lock().unwrap();
        let fd = sock.as_raw_fd();
        send_request(fd, &ZygoteRequest::Wait { pid: pid.as_raw() }, None)?;
        match recv_response(fd)? {
            ZygoteResponse::Wait(result) => Ok(result),
            other => Err(BoxliteError::Internal(format!(
                "expected Wait response, got: {other:?}"
            ))),
        }
    }
}

// ============================================================================
// Zygote child process
// ============================================================================

/// Zygote main loop. Runs in the forked child, single-threaded, never returns.
///
/// Handles two types of requests:
/// - Build: create a container process via ContainerBuilder::build()
/// - Wait: call waitpid on a container process and return its exit status
///
/// Both are serialized — one request at a time. This is safe because:
/// - Build requests are fast (~ms, just clone3 + setup)
/// - Wait requests return immediately for already-exited processes (zombies)
fn serve(sock: OwnedFd) -> ! {
    let fd = sock.as_raw_fd();
    std::mem::forget(sock); // Keep fd alive for the process lifetime

    loop {
        match recv_request(fd) {
            Ok((ZygoteRequest::Build(spec), fds)) => {
                let result = do_build(spec, fds);
                if let Err(e) = send_response(fd, &ZygoteResponse::Build(result)) {
                    eprintln!("[zygote] send_response failed: {e}");
                    std::process::exit(1);
                }
            }
            Ok((ZygoteRequest::Wait { pid }, _)) => {
                let result = do_wait(pid);
                if let Err(e) = send_response(fd, &ZygoteResponse::Wait(result)) {
                    eprintln!("[zygote] send_response failed: {e}");
                    std::process::exit(1);
                }
            }
            Err(e) => {
                // Parent closed socket or IPC error — exit cleanly.
                // This happens during normal guest agent shutdown.
                eprintln!("[zygote] recv_request ended: {e}");
                std::process::exit(0);
            }
        }
    }
}

/// Execute a container tenant build. Called inside the zygote (single-threaded).
///
/// This is the same ContainerBuilder chain that was in `command.rs build_and_spawn()`,
/// moved here to run in the zygote's single-threaded context where clone3() is safe.
fn do_build(spec: BuildSpec, fds: Option<[RawFd; 3]>) -> BuildResult {
    let build_fn = || -> Result<Pid, String> {
        let mut builder = ContainerBuilder::new(spec.container_id.clone(), SyscallType::default())
            .with_root_path(spec.state_root.clone())
            .map_err(|e| format!("Failed to set container root path: {e}"))?
            .with_console_socket(spec.console_socket.clone())
            .validate_id()
            .map_err(|e| format!("Invalid container ID: {e}"))?;

        if let Some(raw_fds) = fds {
            // SAFETY: fds were received via SCM_RIGHTS, we own them exclusively.
            let stdin = unsafe { OwnedFd::from_raw_fd(raw_fds[0]) };
            let stdout = unsafe { OwnedFd::from_raw_fd(raw_fds[1]) };
            let stderr = unsafe { OwnedFd::from_raw_fd(raw_fds[2]) };
            builder = builder
                .with_stdin(stdin)
                .with_stdout(stdout)
                .with_stderr(stderr);
        }

        let pid = builder
            .as_tenant()
            .with_capabilities(capability_names())
            .with_no_new_privs(false)
            .with_detach(false)
            .with_cwd(Some(spec.cwd))
            .with_env(spec.env)
            .with_container_args(spec.args)
            .with_user(Some(spec.uid))
            .with_group(Some(spec.gid))
            .build()
            .map_err(|e| format!("build failed: {e}"))?;

        Ok(pid)
    };

    match build_fn() {
        Ok(pid) => BuildResult::Spawned { pid: pid.as_raw() },
        Err(error) => BuildResult::Failed { error },
    }
}

/// Check if a container process has exited (non-blocking).
///
/// Called inside the zygote process (single-threaded). Uses WNOHANG so it
/// returns immediately even if the process is still running. This prevents
/// the zygote's Mutex from being held for the entire lifetime of long-running
/// processes, which would block all other concurrent waits and builds.
///
/// Returns `StillAlive` if the process hasn't exited yet. The caller (main
/// process) retries in a loop with short async sleeps between attempts.
fn do_wait(pid: i32) -> WaitResult {
    use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
    match waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG)) {
        Ok(WaitStatus::StillAlive) => WaitResult::StillAlive,
        Ok(WaitStatus::Exited(_, code)) => WaitResult::Exited { code },
        Ok(WaitStatus::Signaled(_, sig, _)) => WaitResult::Signaled { signal: sig as i32 },
        Ok(other) => WaitResult::Failed {
            error: format!("unexpected wait status: {other:?}"),
        },
        Err(e) => WaitResult::Failed {
            error: format!("waitpid failed: {e}"),
        },
    }
}

// ============================================================================
// IPC: SEQPACKET + SCM_RIGHTS
// ============================================================================

/// Maximum IPC message size. Typical BuildSpec is < 5 KiB; 1 MiB provides
/// ample headroom for extreme cases (e.g., 1000+ environment variables).
/// SEQPACKET delivers messages atomically — no framing needed.
const MAX_MSG_SIZE: usize = 1_048_576;

/// Send a ZygoteRequest to the zygote, optionally with pipe fds via SCM_RIGHTS.
///
/// Fds are only attached for Build requests (stdio pipes). Wait requests
/// pass None for fds since no file descriptors need to cross the IPC boundary.
fn send_request(
    sock: RawFd,
    request: &ZygoteRequest,
    fds: Option<[RawFd; 3]>,
) -> BoxliteResult<()> {
    let json = serde_json::to_vec(request)
        .map_err(|e| BoxliteError::Internal(format!("serialize ZygoteRequest: {e}")))?;

    if json.len() > MAX_MSG_SIZE {
        return Err(BoxliteError::Internal(format!(
            "ZygoteRequest too large: {} bytes (max {})",
            json.len(),
            MAX_MSG_SIZE
        )));
    }

    let iov = [IoSlice::new(&json)];

    if let Some(ref fds) = fds {
        let cmsg = [ControlMessage::ScmRights(fds)];
        sendmsg::<()>(sock, &iov, &cmsg, MsgFlags::empty(), None)
            .map_err(|e| BoxliteError::Internal(format!("sendmsg with fds: {e}")))?;
    } else {
        sendmsg::<()>(sock, &iov, &[], MsgFlags::empty(), None)
            .map_err(|e| BoxliteError::Internal(format!("sendmsg: {e}")))?;
    }
    Ok(())
}

/// Receive a ZygoteRequest from the parent, with optional pipe fds via SCM_RIGHTS.
///
/// Returns the deserialized request and any SCM_RIGHTS fds that were attached.
/// Build requests may include stdio pipe fds; Wait requests never have fds.
fn recv_request(sock: RawFd) -> BoxliteResult<(ZygoteRequest, Option<[RawFd; 3]>)> {
    let mut buf = vec![0u8; MAX_MSG_SIZE];
    let mut cmsg_buf = nix::cmsg_space!([RawFd; 3]);

    let mut iov = [IoSliceMut::new(&mut buf)];
    let msg = recvmsg::<()>(sock, &mut iov, Some(&mut cmsg_buf), MsgFlags::empty())
        .map_err(|e| BoxliteError::Internal(format!("recvmsg request: {e}")))?;

    let bytes = msg.bytes;
    if bytes == 0 {
        return Err(BoxliteError::Internal("zygote: peer closed".to_string()));
    }

    // Extract SCM_RIGHTS fds before dropping msg (which borrows iov → buf)
    let mut received_fds = None;
    for cmsg in msg.cmsgs().into_iter().flatten() {
        if let ControlMessageOwned::ScmRights(fds) = cmsg {
            if fds.len() == 3 {
                received_fds = Some([fds[0], fds[1], fds[2]]);
            }
        }
    }
    let _ = msg;
    let _ = iov;

    let request: ZygoteRequest = serde_json::from_slice(&buf[..bytes])
        .map_err(|e| BoxliteError::Internal(format!("deserialize ZygoteRequest: {e}")))?;

    Ok((request, received_fds))
}

/// Send a ZygoteResponse back to the parent.
fn send_response(sock: RawFd, response: &ZygoteResponse) -> BoxliteResult<()> {
    let json = serde_json::to_vec(response)
        .map_err(|e| BoxliteError::Internal(format!("serialize ZygoteResponse: {e}")))?;

    if json.len() > MAX_MSG_SIZE {
        return Err(BoxliteError::Internal(format!(
            "ZygoteResponse too large: {} bytes (max {})",
            json.len(),
            MAX_MSG_SIZE
        )));
    }

    let iov = [IoSlice::new(&json)];

    sendmsg::<()>(sock, &iov, &[], MsgFlags::empty(), None)
        .map_err(|e| BoxliteError::Internal(format!("sendmsg response: {e}")))?;
    Ok(())
}

/// Receive a ZygoteResponse from the zygote.
fn recv_response(sock: RawFd) -> BoxliteResult<ZygoteResponse> {
    let mut buf = vec![0u8; MAX_MSG_SIZE];

    let mut iov = [IoSliceMut::new(&mut buf)];
    let msg = recvmsg::<()>(sock, &mut iov, None, MsgFlags::empty())
        .map_err(|e| BoxliteError::Internal(format!("recvmsg response: {e}")))?;

    let bytes = msg.bytes;
    let _ = msg;
    let _ = iov;

    if bytes == 0 {
        return Err(BoxliteError::Internal(
            "zygote process exited unexpectedly".to_string(),
        ));
    }

    serde_json::from_slice(&buf[..bytes])
        .map_err(|e| BoxliteError::Internal(format!("deserialize ZygoteResponse: {e}")))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Serialization tests (pure logic, no fork needed)
    // ========================================================================

    fn sample_spec() -> BuildSpec {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        env.insert("HOME".to_string(), "/root".to_string());

        BuildSpec {
            container_id: "test-container-123".to_string(),
            state_root: PathBuf::from("/run/youki"),
            console_socket: Some("/tmp/console.sock".to_string()),
            cwd: PathBuf::from("/workspace"),
            env,
            args: vec![
                "sh".to_string(),
                "-c".to_string(),
                "echo hello world".to_string(),
            ],
            uid: 1000,
            gid: 1000,
        }
    }

    #[test]
    fn build_spec_serde_roundtrip() {
        let spec = sample_spec();
        let json = serde_json::to_vec(&spec).unwrap();
        let decoded: BuildSpec = serde_json::from_slice(&json).unwrap();
        assert_eq!(spec, decoded);
    }

    #[test]
    fn build_result_spawned_serde_roundtrip() {
        let result = BuildResult::Spawned { pid: 42 };
        let json = serde_json::to_vec(&result).unwrap();
        let decoded: BuildResult = serde_json::from_slice(&json).unwrap();
        assert_eq!(result, decoded);
    }

    #[test]
    fn build_result_failed_serde_roundtrip() {
        let result = BuildResult::Failed {
            error: "build failed: container not found".to_string(),
        };
        let json = serde_json::to_vec(&result).unwrap();
        let decoded: BuildResult = serde_json::from_slice(&json).unwrap();
        assert_eq!(result, decoded);
    }

    // --- WaitResult serde tests ---
    // WaitResult crosses the IPC boundary; verify it survives JSON serialization.

    #[test]
    fn wait_result_exited_serde_roundtrip() {
        let result = WaitResult::Exited { code: 42 };
        let json = serde_json::to_vec(&result).unwrap();
        let decoded: WaitResult = serde_json::from_slice(&json).unwrap();
        assert_eq!(result, decoded);
    }

    #[test]
    fn wait_result_signaled_serde_roundtrip() {
        let result = WaitResult::Signaled { signal: 9 };
        let json = serde_json::to_vec(&result).unwrap();
        let decoded: WaitResult = serde_json::from_slice(&json).unwrap();
        assert_eq!(result, decoded);
    }

    #[test]
    fn wait_result_failed_serde_roundtrip() {
        let result = WaitResult::Failed {
            error: "waitpid failed: ECHILD".to_string(),
        };
        let json = serde_json::to_vec(&result).unwrap();
        let decoded: WaitResult = serde_json::from_slice(&json).unwrap();
        assert_eq!(result, decoded);
    }

    // --- ZygoteRequest/ZygoteResponse tagged enum serde tests ---
    // Verify the enum discriminant survives JSON serialization.

    #[test]
    fn zygote_request_build_serde_roundtrip() {
        let request = ZygoteRequest::Build(sample_spec());
        let json = serde_json::to_vec(&request).unwrap();
        let decoded: ZygoteRequest = serde_json::from_slice(&json).unwrap();
        // Verify it decoded as Build variant with matching spec
        match decoded {
            ZygoteRequest::Build(spec) => assert_eq!(spec, sample_spec()),
            other => panic!("expected Build, got: {other:?}"),
        }
    }

    #[test]
    fn zygote_request_wait_serde_roundtrip() {
        let request = ZygoteRequest::Wait { pid: 12345 };
        let json = serde_json::to_vec(&request).unwrap();
        let decoded: ZygoteRequest = serde_json::from_slice(&json).unwrap();
        match decoded {
            ZygoteRequest::Wait { pid } => assert_eq!(pid, 12345),
            other => panic!("expected Wait, got: {other:?}"),
        }
    }

    #[test]
    fn build_spec_empty_optionals() {
        let spec = BuildSpec {
            container_id: "minimal".to_string(),
            state_root: PathBuf::from("/run"),
            console_socket: None,
            cwd: PathBuf::from("/"),
            env: HashMap::new(),
            args: vec![],
            uid: 0,
            gid: 0,
        };
        let json = serde_json::to_vec(&spec).unwrap();
        let decoded: BuildSpec = serde_json::from_slice(&json).unwrap();
        assert_eq!(spec, decoded);
        assert!(decoded.console_socket.is_none());
        assert!(decoded.env.is_empty());
        assert!(decoded.args.is_empty());
    }

    // ========================================================================
    // IPC protocol tests (need socketpair — Linux only)
    // ========================================================================

    #[test]
    fn ipc_send_recv_build_request_without_fds() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        let spec = sample_spec();
        send_request(fd_a, &ZygoteRequest::Build(spec.clone()), None).unwrap();

        let (received, fds) = recv_request(fd_b).unwrap();
        match received {
            ZygoteRequest::Build(recv_spec) => assert_eq!(spec, recv_spec),
            other => panic!("expected Build request, got: {other:?}"),
        }
        assert!(fds.is_none());
    }

    #[test]
    fn ipc_send_recv_build_request_with_fds() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        // Create 3 pipes to pass via SCM_RIGHTS
        let (r0, w0) = nix::unistd::pipe().unwrap();
        let (r1, w1) = nix::unistd::pipe().unwrap();
        let (_r2, w2) = nix::unistd::pipe().unwrap();

        let spec = sample_spec();
        let send_fds = [r0.as_raw_fd(), w1.as_raw_fd(), w2.as_raw_fd()];
        send_request(fd_a, &ZygoteRequest::Build(spec.clone()), Some(send_fds)).unwrap();

        let (received, recv_fds) = recv_request(fd_b).unwrap();
        match received {
            ZygoteRequest::Build(recv_spec) => assert_eq!(spec, recv_spec),
            other => panic!("expected Build request, got: {other:?}"),
        }
        let recv_fds = recv_fds.expect("should have received fds");

        // Verify fd passing: write through original, read through received
        use nix::unistd::{read, write};
        use std::os::fd::BorrowedFd;
        // Test pipe 0: write to w0, read from received r0
        write(&w0, b"test0").unwrap();
        let mut buf = [0u8; 5];
        let n = read(recv_fds[0], &mut buf).unwrap();
        assert_eq!(&buf[..n], b"test0");

        // Test pipe 1: write to received w1, read from r1
        // SAFETY: recv_fds[1] is a valid fd received via SCM_RIGHTS
        let recv_w1 = unsafe { BorrowedFd::borrow_raw(recv_fds[1]) };
        write(recv_w1, b"test1").unwrap();
        let n = read(r1.as_raw_fd(), &mut buf).unwrap();
        assert_eq!(&buf[..n], b"test1");
    }

    #[test]
    fn ipc_send_recv_wait_request() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        send_request(fd_a, &ZygoteRequest::Wait { pid: 12345 }, None).unwrap();

        let (received, fds) = recv_request(fd_b).unwrap();
        match received {
            ZygoteRequest::Wait { pid } => assert_eq!(pid, 12345),
            other => panic!("expected Wait request, got: {other:?}"),
        }
        assert!(fds.is_none());
    }

    #[test]
    fn ipc_send_recv_build_response_spawned() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        let response = ZygoteResponse::Build(BuildResult::Spawned { pid: 12345 });
        send_response(fd_a, &response).unwrap();

        let received = recv_response(fd_b).unwrap();
        match received {
            ZygoteResponse::Build(BuildResult::Spawned { pid }) => assert_eq!(pid, 12345),
            other => panic!("expected Build(Spawned) response, got: {other:?}"),
        }
    }

    #[test]
    fn ipc_send_recv_build_response_failed() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        let response = ZygoteResponse::Build(BuildResult::Failed {
            error: "container not found".to_string(),
        });
        send_response(fd_a, &response).unwrap();

        let received = recv_response(fd_b).unwrap();
        match received {
            ZygoteResponse::Build(BuildResult::Failed { error }) => {
                assert_eq!(error, "container not found");
            }
            other => panic!("expected Build(Failed) response, got: {other:?}"),
        }
    }

    #[test]
    fn ipc_send_recv_wait_response_exited() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        let response = ZygoteResponse::Wait(WaitResult::Exited { code: 42 });
        send_response(fd_a, &response).unwrap();

        let received = recv_response(fd_b).unwrap();
        match received {
            ZygoteResponse::Wait(WaitResult::Exited { code }) => assert_eq!(code, 42),
            other => panic!("expected Wait(Exited) response, got: {other:?}"),
        }
    }

    #[test]
    fn ipc_send_recv_wait_response_signaled() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        let response = ZygoteResponse::Wait(WaitResult::Signaled { signal: 9 });
        send_response(fd_a, &response).unwrap();

        let received = recv_response(fd_b).unwrap();
        match received {
            ZygoteResponse::Wait(WaitResult::Signaled { signal }) => assert_eq!(signal, 9),
            other => panic!("expected Wait(Signaled) response, got: {other:?}"),
        }
    }

    #[test]
    fn ipc_large_build_request() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        let fd_b = b.as_raw_fd();

        // Build a large spec with many env vars and args
        let mut env = HashMap::new();
        for i in 0..100 {
            env.insert(format!("VAR_{i}"), format!("value_{i}_with_some_padding"));
        }
        let args: Vec<String> = (0..50).map(|i| format!("arg-{i}-padding")).collect();

        let spec = BuildSpec {
            container_id: "large-spec-test".to_string(),
            state_root: PathBuf::from("/a/very/long/path/to/the/state/root/directory"),
            console_socket: Some("/tmp/a/deep/nested/console/socket/path.sock".to_string()),
            cwd: PathBuf::from("/workspace/project/subdir"),
            env,
            args,
            uid: 65534,
            gid: 65534,
        };

        send_request(fd_a, &ZygoteRequest::Build(spec.clone()), None).unwrap();
        let (received, fds) = recv_request(fd_b).unwrap();
        match received {
            ZygoteRequest::Build(recv_spec) => assert_eq!(spec, recv_spec),
            other => panic!("expected Build request, got: {other:?}"),
        }
        assert!(fds.is_none());
    }

    #[test]
    fn ipc_oversized_request_rejected() {
        // Build a spec that exceeds MAX_MSG_SIZE (1 MiB)
        let mut env = HashMap::new();
        // Each env entry ~30 bytes; 50_000 entries ≈ 1.5 MiB
        for i in 0..50_000 {
            env.insert(format!("VAR_{i}"), format!("value_{i}"));
        }

        let spec = BuildSpec {
            container_id: "oversized".to_string(),
            state_root: PathBuf::from("/run"),
            console_socket: None,
            cwd: PathBuf::from("/"),
            env,
            args: vec![],
            uid: 0,
            gid: 0,
        };

        let (a, _b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();

        let result = send_request(a.as_raw_fd(), &ZygoteRequest::Build(spec), None);
        assert!(result.is_err(), "oversized request should be rejected");
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("too large"),
            "error should mention 'too large', got: {err}"
        );
    }

    #[test]
    fn ipc_oversized_response_rejected() {
        let response = ZygoteResponse::Build(BuildResult::Failed {
            error: "x".repeat(2 * 1024 * 1024), // 2 MiB error string
        });

        let (a, _b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();

        let result = send_response(a.as_raw_fd(), &response);
        assert!(result.is_err(), "oversized response should be rejected");
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("too large"),
            "error should mention 'too large', got: {err}"
        );
    }

    // ========================================================================
    // Zygote lifecycle tests (need fork — Linux only)
    // ========================================================================

    #[test]
    fn zygote_start_creates_child_process() {
        let zygote = Zygote::start().expect("zygote should start");

        // Zygote is alive — socket fd is valid
        let sock = zygote.sock.lock().unwrap();
        assert!(sock.as_raw_fd() >= 0, "socket fd should be non-negative");

        // Drop releases the OwnedFd, closing the socket.
        // The zygote child will exit on recv error.
    }

    #[test]
    fn zygote_recv_error_on_closed_socket() {
        // Create a socketpair, close one end, verify recv fails
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_b = b.as_raw_fd();
        drop(a); // Close sender

        let result = recv_response(fd_b);
        assert!(result.is_err(), "recv on closed socket should fail");
    }

    #[test]
    fn zygote_send_error_on_closed_socket() {
        // Create a socketpair, close receiver, verify send fails
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let fd_a = a.as_raw_fd();
        drop(b); // Close receiver

        let response = ZygoteResponse::Build(BuildResult::Spawned { pid: 1 });
        let send_err = send_response(fd_a, &response);
        assert!(send_err.is_err(), "send on closed socket should fail");
    }

    // ========================================================================
    // Concurrency test (needs threads — Linux only)
    // ========================================================================

    #[test]
    fn zygote_concurrent_ipc_serialized() {
        // Verify that the mutex serializes concurrent IPC access.
        // We test the mutex behavior without a real zygote child by using
        // a socketpair where we manually respond on the other end.
        use std::sync::Arc;
        use std::thread;

        let (parent_sock, child_sock) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();

        let child_fd = child_sock.as_raw_fd();
        std::mem::forget(child_sock); // Responder thread manages this fd's lifetime

        let zygote = Arc::new(Zygote {
            sock: Mutex::new(parent_sock),
        });

        // Spawn a "fake zygote" thread that responds to each request with a Spawned result
        let responder = thread::spawn(move || {
            for i in 0..4 {
                let (request, _fds) = recv_request(child_fd).unwrap();
                match request {
                    ZygoteRequest::Build(spec) => {
                        assert!(spec.container_id.starts_with("concurrent-"));
                        let response =
                            ZygoteResponse::Build(BuildResult::Spawned { pid: 1000 + i });
                        send_response(child_fd, &response).unwrap();
                    }
                    other => panic!("expected Build request, got: {other:?}"),
                }
            }
            // SAFETY: We own this fd via mem::forget above
            unsafe { nix::libc::close(child_fd) };
        });

        // Spawn 4 threads that call build() concurrently
        let mut handles = Vec::new();
        for i in 0..4 {
            let z = zygote.clone();
            handles.push(thread::spawn(move || {
                let spec = BuildSpec {
                    container_id: format!("concurrent-{i}"),
                    state_root: PathBuf::from("/run"),
                    console_socket: None,
                    cwd: PathBuf::from("/"),
                    env: HashMap::new(),
                    args: vec!["echo".to_string()],
                    uid: 0,
                    gid: 0,
                };
                z.build(spec, None).unwrap()
            }));
        }

        // All must complete (no deadlock)
        let pids: Vec<Pid> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(pids.len(), 4);

        responder.join().unwrap();
        // parent_sock (OwnedFd inside zygote.sock) is cleaned up when zygote drops
    }
}
