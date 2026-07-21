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

/// What init to build. Serialized over IPC to the zygote.
///
/// A separate type from `BuildSpec` because the inputs genuinely differ: an
/// init build is driven by the bundle's config.json (bundle/state paths),
/// not by a process spec (args/env/cwd/user).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct InitBuildSpec {
    pub container_id: String,
    pub state_root: PathBuf,
    pub bundle_path: PathBuf,
    /// PTY init (`run -t`): libcontainer allocates the PTY and relays the
    /// master over this socket. Mutually exclusive with SCM_RIGHTS stdio fds,
    /// exactly as in a tenant build.
    pub console_socket: Option<String>,
}

/// Build outcome. Invalid states are unrepresentable.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(crate) enum BuildResult {
    Spawned { pid: i32 },
    Failed { error: String },
}

/// Tagged IPC request from parent to zygote.
///
/// The parent's Mutex ensures only one request is in-flight at a time.
#[derive(Serialize, Deserialize, Debug, Clone)]
enum ZygoteRequest {
    /// Build a container tenant process. May include SCM_RIGHTS fds for stdio pipes.
    Build(BuildSpec),
    /// Build a container's init process. Same fd-passing contract as `Build`.
    BuildInit(InitBuildSpec),
}

/// Tagged IPC response from zygote to parent, matched 1:1 with requests.
///
/// The protocol is strictly request-response (no unsolicited messages),
/// serialized by the parent's Mutex. Each request kind gets its own response
/// tag so a mismatched reply is a detectable protocol violation, not a
/// silently misattributed pid.
#[derive(Serialize, Deserialize, Debug, Clone)]
enum ZygoteResponse {
    Build(BuildResult),
    BuildInit(BuildResult),
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
                "zygote protocol violation: Build answered with {other:?}"
            ))),
        }
    }

    /// Build a container's init process via the zygote. Returns init's pid.
    ///
    /// Same transport as `build`: one request-response under the socket mutex,
    /// stdio pipe fds (if any) ride via SCM_RIGHTS. Blocks until the build
    /// completes — callers on an async runtime decide whether that needs
    /// `spawn_blocking`.
    pub fn build_init(&self, spec: InitBuildSpec, fds: Option<[RawFd; 3]>) -> BoxliteResult<Pid> {
        let sock = self.sock.lock().unwrap();
        let fd = sock.as_raw_fd();
        send_request(fd, &ZygoteRequest::BuildInit(spec), fds)?;
        match recv_response(fd)? {
            ZygoteResponse::BuildInit(BuildResult::Spawned { pid }) => Ok(Pid::from_raw(pid)),
            ZygoteResponse::BuildInit(BuildResult::Failed { error }) => {
                Err(BoxliteError::Internal(error))
            }
            other => Err(BoxliteError::Internal(format!(
                "zygote protocol violation: BuildInit answered with {other:?}"
            ))),
        }
    }
}

// ============================================================================
// Zygote child process
// ============================================================================

/// Zygote main loop. Runs in the forked child, single-threaded, never returns.
///
/// Handles Build requests: create a container process via
/// `ContainerBuilder::build()`. Requests are serialized — one at a time —
/// which is safe because a build is fast (~ms: clone3 + setup). The zygote
/// never waits on container processes: tenants are cloned `CLONE_PARENT`
/// (`as_sibling`), so they reparent to guest main, which reaps them via its
/// own SIGCHLD loop (see the `reaper` module).
fn serve(sock: OwnedFd) -> ! {
    let fd = sock.as_raw_fd();
    std::mem::forget(sock); // Keep fd alive for the process lifetime

    loop {
        match recv_request(fd) {
            Ok((request, fds)) => {
                let response = match request {
                    ZygoteRequest::Build(spec) => ZygoteResponse::Build(do_build(spec, fds)),
                    ZygoteRequest::BuildInit(spec) => {
                        ZygoteResponse::BuildInit(do_build_init(spec, fds))
                    }
                };
                if let Err(e) = send_response(fd, &response) {
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
        // Own the received fds before any fallible step: they arrived via
        // SCM_RIGHTS and this process must close them on every path, or each
        // failed build leaks three fds into the long-lived zygote.
        // SAFETY: fds were received via SCM_RIGHTS, we own them exclusively.
        let owned_fds = fds.map(|raw| unsafe {
            (
                OwnedFd::from_raw_fd(raw[0]),
                OwnedFd::from_raw_fd(raw[1]),
                OwnedFd::from_raw_fd(raw[2]),
            )
        });

        let mut builder = ContainerBuilder::new(spec.container_id.clone(), SyscallType::default())
            .with_root_path(spec.state_root.clone())
            .map_err(|e| format!("Failed to set container root path: {e}"))?
            .with_console_socket(spec.console_socket.clone())
            .validate_id()
            .map_err(|e| format!("Invalid container ID: {e}"))?;

        if let Some((stdin, stdout, stderr)) = owned_fds {
            builder = builder
                .with_stdin(stdin)
                .with_stdout(stdout)
                .with_stderr(stderr);
        }

        // libcontainer 0.6's check_terminal requires a console socket iff
        // (detached && terminal). The tenant builder has no per-exec terminal
        // setter, so the two exec shapes diverge here.
        let pid = if spec.console_socket.is_some() {
            // TTY exec: hand youki a process.json with terminal=true (via
            // with_process) and detach=true, so it allocates the PTY, relays
            // the master fd over the console socket (received by ConsoleSocket),
            // and returns the pid (guest main reaps it — see as_sibling below).
            // The PTY path passes no stdio fds — youki wires the PTY slave instead.
            let env_vec: Vec<String> = spec.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
            let cwd = spec.cwd.to_str().unwrap_or("/");
            let process =
                super::spec::build_tty_exec_process(&spec.args, &env_vec, cwd, spec.uid, spec.gid)
                    .map_err(|e| format!("build tty exec process: {e}"))?;
            let process_json = serde_json::to_vec(&process)
                .map_err(|e| format!("serialize tty process.json: {e}"))?;
            let process_path = spec
                .state_root
                .join(format!("exec-process-{}.json", spec.container_id));
            std::fs::write(&process_path, process_json)
                .map_err(|e| format!("write tty process.json: {e}"))?;
            let result = builder
                .as_tenant()
                .as_sibling(true) // reparent to guest main; see the non-TTY arm
                .with_detach(true)
                .with_process(Some(process_path.clone()))
                .build()
                .map_err(|e| format!("build failed: {e}"));
            let _ = std::fs::remove_file(&process_path);
            result?
        } else {
            // Non-TTY exec: stdio via the passed pipe fds, no console socket,
            // terminal=false, non-detached.
            builder
                .as_tenant()
                // CLONE_PARENT so the tenant reparents to guest main (not the
                // zygote); guest main's reaper owns its exit. The zygote never waits.
                .as_sibling(true)
                .with_capabilities(capability_names())
                .with_no_new_privs(false)
                .with_detach(false)
                .with_cwd(Some(spec.cwd))
                .with_env(spec.env)
                .with_container_args(spec.args)
                .with_user(Some(spec.uid))
                .with_group(Some(spec.gid))
                .build()
                .map_err(|e| format!("build failed: {e}"))?
        };

        Ok(pid)
    };

    build_with_default_sigpipe(build_fn)
}

/// Execute a container init build. Called inside the zygote (single-threaded).
///
/// Body of the guest's old in-place init build (`start.rs`), moved here so
/// libcontainer's clone3 dance — main → intermediate → init — runs fork-safe.
///
/// `as_sibling(true)` below is load-bearing, not hygiene: libcontainer clones
/// init `CLONE_PARENT` off the intermediate, so init's parent is whoever the
/// intermediate's parent is — plain, that is the process calling `build()`.
/// In-guest that made init the guest's child by accident of location; built
/// here it would make init the *zygote's* child, whose exit nobody reaps
/// (the zygote never waits on container processes), starving the guest
/// reaper's `Wait` and losing the box's exit code. With `as_sibling` the
/// intermediate itself is cloned `CLONE_PARENT` too, so the whole chain
/// parents to guest main — the same topology as before the move, and the same
/// contract tenants already use. The intermediate then dies as a guest-main
/// stray (reaped by the sweep, aged out; see `reaper` docs), and
/// libcontainer's own `waitpid(intermediate)` sees ECHILD, which it tolerates
/// by design (readiness travels over its pipes, not the exit code).
fn do_build_init(spec: InitBuildSpec, fds: Option<[RawFd; 3]>) -> BuildResult {
    let build_fn = || -> Result<Pid, String> {
        // Own the received fds before any fallible step — see `do_build`.
        // SAFETY: fds were received via SCM_RIGHTS, we own them exclusively.
        let owned_fds = fds.map(|raw| unsafe {
            (
                OwnedFd::from_raw_fd(raw[0]),
                OwnedFd::from_raw_fd(raw[1]),
                OwnedFd::from_raw_fd(raw[2]),
            )
        });

        let builder = ContainerBuilder::new(spec.container_id.clone(), SyscallType::default())
            .with_root_path(spec.state_root.clone())
            .map_err(|e| format!("Failed to set container root path: {e}"))?
            .validate_id()
            .map_err(|e| format!("Invalid container ID: {e}"))?;

        // Init's stdio is exactly one of pipes or a PTY console socket —
        // validate the wire input here at the boundary rather than letting
        // libcontainer fail later with a less pointed error.
        let builder = match (owned_fds, spec.console_socket) {
            (Some((stdin, stdout, stderr)), None) => builder
                .with_stdin(stdin)
                .with_stdout(stdout)
                .with_stderr(stderr),
            (None, Some(socket)) => builder.with_console_socket(Some(socket)),
            (Some(_), Some(_)) => {
                return Err("init build: got both stdio fds and a console socket".to_string())
            }
            (None, None) => {
                return Err("init build: needs stdio fds or a console socket".to_string())
            }
        };

        let container = builder
            .as_init(&spec.bundle_path)
            // Parent init to guest main, not the zygote — see the fn doc.
            .as_sibling(true)
            .with_systemd(false)
            .with_detach(true)
            .build()
            .map_err(|e| format!("build failed: {e}"))?;

        container
            .pid()
            .ok_or_else(|| "built container state has no init pid".to_string())
    };

    let result = build_with_default_sigpipe(build_fn);

    // Greppable from the guest console: proves init creation actually routed
    // through the zygote rather than silently reverting to an in-guest build.
    match &result {
        BuildResult::Spawned { pid } => eprintln!(
            "[zygote] init build: container_id={} pid={}",
            spec.container_id, pid
        ),
        BuildResult::Failed { error } => eprintln!(
            "[zygote] init build failed: container_id={} error={}",
            spec.container_id, error
        ),
    }
    result
}

/// Run a build with the default SIGPIPE disposition, restoring the agent's
/// afterwards.
///
/// The Rust runtime installs SIG_IGN for SIGPIPE at startup; that disposition
/// is inherited by the zygote and by every container process youki forks here.
/// With SIGPIPE ignored, a process that writes to a pipe whose reader has
/// exited (e.g. the producer in `yes | head`, or `while :; do echo; done |
/// head`) gets EPIPE instead of being killed by SIGPIPE. A producer that loops
/// without checking write errors then never terminates: it spins, the pipeline
/// never completes, the exec never exits, and Wait hangs forever while a vCPU
/// stays pegged.
///
/// youki's init does not reset SIGPIPE, so set SIG_DFL just for the fork and
/// restore SIG_IGN immediately after — the long-lived single-threaded zygote
/// keeps the agent's EPIPE-as-error behavior on its own IPC socket, while the
/// forked child (and everything it execs) starts with the standard default.
fn build_with_default_sigpipe(build_fn: impl FnOnce() -> Result<Pid, String>) -> BuildResult {
    use nix::sys::signal::{signal, SigHandler, Signal};
    let prev_sigpipe = unsafe { signal(Signal::SIGPIPE, SigHandler::SigDfl) };

    let result = build_fn();

    if let Ok(prev) = prev_sigpipe {
        // SAFETY: restoring the disposition we just read; single-threaded zygote.
        unsafe {
            let _ = signal(Signal::SIGPIPE, prev);
        }
    }

    match result {
        Ok(pid) => BuildResult::Spawned { pid: pid.as_raw() },
        Err(error) => BuildResult::Failed { error },
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
/// Fds (stdio pipes) ride along with a non-TTY build; None otherwise — a TTY
/// build passes its PTY over the console socket, not via SCM_RIGHTS.
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
/// A non-TTY build carries stdio pipe fds; other builds have none.
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

    // --- ZygoteRequest/ZygoteResponse tagged enum serde tests ---
    // Verify the enum discriminant survives JSON serialization.

    #[test]
    fn zygote_request_build_serde_roundtrip() {
        let request = ZygoteRequest::Build(sample_spec());
        let json = serde_json::to_vec(&request).unwrap();
        let decoded: ZygoteRequest = serde_json::from_slice(&json).unwrap();
        // Verify it decoded as Build variant with matching spec
        let ZygoteRequest::Build(spec) = decoded else {
            panic!("expected Build variant");
        };
        assert_eq!(spec, sample_spec());
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
        let ZygoteRequest::Build(recv_spec) = received else {
            panic!("expected Build variant");
        };
        assert_eq!(spec, recv_spec);
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
        let ZygoteRequest::Build(recv_spec) = received else {
            panic!("expected Build variant");
        };
        assert_eq!(spec, recv_spec);
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
        let ZygoteRequest::Build(recv_spec) = received else {
            panic!("expected Build variant");
        };
        assert_eq!(spec, recv_spec);
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
                let ZygoteRequest::Build(spec) = request else {
                    panic!("expected Build variant");
                };
                assert!(spec.container_id.starts_with("concurrent-"));
                let response = ZygoteResponse::Build(BuildResult::Spawned { pid: 1000 + i });
                send_response(child_fd, &response).unwrap();
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

    // ========================================================================
    // Init build: protocol + fd-ownership tests
    // ========================================================================

    fn init_spec_named(container_id: &str) -> InitBuildSpec {
        InitBuildSpec {
            container_id: container_id.to_string(),
            state_root: PathBuf::from("/run/boxlite/c1/state"),
            bundle_path: PathBuf::from("/run/boxlite/c1"),
            console_socket: None,
        }
    }

    fn sample_init_spec() -> InitBuildSpec {
        init_spec_named("init-container-1")
    }

    fn tenant_spec_named(container_id: &str) -> BuildSpec {
        BuildSpec {
            container_id: container_id.to_string(),
            state_root: PathBuf::from("/run"),
            console_socket: None,
            cwd: PathBuf::from("/"),
            env: HashMap::new(),
            args: vec!["true".to_string()],
            uid: 0,
            gid: 0,
        }
    }

    #[test]
    fn init_build_spec_serde_roundtrip() {
        let spec = sample_init_spec();
        let json = serde_json::to_vec(&spec).unwrap();
        let decoded: InitBuildSpec = serde_json::from_slice(&json).unwrap();
        assert_eq!(spec, decoded);
    }

    #[test]
    fn zygote_request_build_init_serde_roundtrip() {
        let request = ZygoteRequest::BuildInit(sample_init_spec());
        let json = serde_json::to_vec(&request).unwrap();
        let decoded: ZygoteRequest = serde_json::from_slice(&json).unwrap();
        let ZygoteRequest::BuildInit(spec) = decoded else {
            panic!("expected BuildInit variant");
        };
        assert_eq!(spec, sample_init_spec());
    }

    #[test]
    fn zygote_response_build_init_serde_roundtrip() {
        let response = ZygoteResponse::BuildInit(BuildResult::Spawned { pid: 7 });
        let json = serde_json::to_vec(&response).unwrap();
        let decoded: ZygoteResponse = serde_json::from_slice(&json).unwrap();
        let ZygoteResponse::BuildInit(BuildResult::Spawned { pid }) = decoded else {
            panic!("expected BuildInit(Spawned) variant");
        };
        assert_eq!(pid, 7);
    }

    /// The stdio pipe fds ride SCM_RIGHTS on a BuildInit exactly as on a Build.
    #[test]
    fn ipc_send_recv_build_init_request_with_fds() {
        let (a, b) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();

        let (r0, _w0) = nix::unistd::pipe().unwrap();
        let (_r1, w1) = nix::unistd::pipe().unwrap();
        let (_r2, w2) = nix::unistd::pipe().unwrap();

        let spec = sample_init_spec();
        let send_fds = [r0.as_raw_fd(), w1.as_raw_fd(), w2.as_raw_fd()];
        send_request(
            a.as_raw_fd(),
            &ZygoteRequest::BuildInit(spec.clone()),
            Some(send_fds),
        )
        .unwrap();

        let (received, recv_fds) = recv_request(b.as_raw_fd()).unwrap();
        let ZygoteRequest::BuildInit(recv_spec) = received else {
            panic!("expected BuildInit variant");
        };
        assert_eq!(spec, recv_spec);
        assert!(recv_fds.is_some(), "stdio fds must ride the BuildInit");
    }

    /// RACE: tenant builds and init builds interleaving from many threads must
    /// each get their own response. The socket mutex serializes one
    /// request-response pair at a time and the per-kind response tags make any
    /// cross-pairing loud; the responder answers in arrival order with a pid
    /// derived from the request's own container id, so a swapped or
    /// cross-tagged reply fails the caller's assertion instead of handing a
    /// container someone else's pid.
    #[test]
    fn mixed_concurrent_builds_and_init_builds_stay_paired() {
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

        let responder = thread::spawn(move || {
            for _ in 0..8 {
                let (request, _fds) = recv_request(child_fd).unwrap();
                let response = match request {
                    ZygoteRequest::Build(spec) => {
                        let i: i32 = spec
                            .container_id
                            .trim_start_matches("mix-b-")
                            .parse()
                            .expect("tenant id carries its index");
                        ZygoteResponse::Build(BuildResult::Spawned { pid: 2000 + i })
                    }
                    ZygoteRequest::BuildInit(spec) => {
                        let i: i32 = spec
                            .container_id
                            .trim_start_matches("mix-i-")
                            .parse()
                            .expect("init id carries its index");
                        ZygoteResponse::BuildInit(BuildResult::Spawned { pid: 3000 + i })
                    }
                };
                send_response(child_fd, &response).unwrap();
            }
            // SAFETY: We own this fd via mem::forget above
            unsafe { nix::libc::close(child_fd) };
        });

        let zygote = Arc::new(Zygote {
            sock: Mutex::new(parent_sock),
        });
        let mut handles = Vec::new();
        for i in 0..4i32 {
            let z = Arc::clone(&zygote);
            handles.push(thread::spawn(move || {
                let pid = z
                    .build(tenant_spec_named(&format!("mix-b-{i}")), None)
                    .unwrap();
                assert_eq!(
                    pid.as_raw(),
                    2000 + i,
                    "tenant build {i} got another request's response"
                );
            }));
            let z = Arc::clone(&zygote);
            handles.push(thread::spawn(move || {
                let pid = z
                    .build_init(init_spec_named(&format!("mix-i-{i}")), None)
                    .unwrap();
                assert_eq!(
                    pid.as_raw(),
                    3000 + i,
                    "init build {i} got another request's response"
                );
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        responder.join().unwrap();
    }

    /// FAILURE: a Failed init build's error text must reach the caller intact —
    /// the box-start error the user sees is built from it.
    #[test]
    fn build_init_failure_error_reaches_the_caller() {
        use std::thread;

        let (parent_sock, child_sock) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let child_fd = child_sock.as_raw_fd();

        let responder = thread::spawn(move || {
            let (request, _fds) = recv_request(child_fd).unwrap();
            let ZygoteRequest::BuildInit(_) = request else {
                panic!("expected BuildInit request");
            };
            let response = ZygoteResponse::BuildInit(BuildResult::Failed {
                error: "bundle exploded: no config.json".to_string(),
            });
            send_response(child_fd, &response).unwrap();
            drop(child_sock);
        });

        let zygote = Zygote {
            sock: Mutex::new(parent_sock),
        };
        let err = zygote
            .build_init(sample_init_spec(), None)
            .expect_err("a Failed build must surface as an error");
        assert!(
            err.to_string().contains("bundle exploded"),
            "the zygote's error text must not be swallowed, got: {err}"
        );
        responder.join().unwrap();
    }

    /// FAILURE: the zygote dying between request and response must be a clean
    /// error at the caller, not a hang — a crashed zygote during box start has
    /// to fail the start.
    #[test]
    fn build_init_errors_cleanly_when_the_zygote_dies_mid_request() {
        use std::thread;

        let (parent_sock, child_sock) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let child_fd = child_sock.as_raw_fd();

        let responder = thread::spawn(move || {
            let (request, _fds) = recv_request(child_fd).unwrap();
            let ZygoteRequest::BuildInit(_) = request else {
                panic!("expected BuildInit request");
            };
            drop(child_sock); // die without replying
        });

        let zygote = Zygote {
            sock: Mutex::new(parent_sock),
        };
        let err = zygote
            .build_init(sample_init_spec(), None)
            .expect_err("a dead zygote must fail the build, not hang it");
        assert!(
            err.to_string()
                .contains("zygote process exited unexpectedly"),
            "unexpected error: {err}"
        );
        responder.join().unwrap();
    }

    /// The client refuses a response whose tag does not match its request —
    /// a mismatched reply must be a loud protocol error, never a
    /// misattributed pid.
    #[test]
    fn build_init_mismatched_response_is_protocol_error() {
        use std::thread;

        let (parent_sock, child_sock) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let child_fd = child_sock.as_raw_fd();

        let responder = thread::spawn(move || {
            let (request, _fds) = recv_request(child_fd).unwrap();
            let ZygoteRequest::BuildInit(_) = request else {
                panic!("expected BuildInit request");
            };
            // Deliberately answer with the wrong tag.
            let response = ZygoteResponse::Build(BuildResult::Spawned { pid: 1 });
            send_response(child_fd, &response).unwrap();
            drop(child_sock);
        });

        let zygote = Zygote {
            sock: Mutex::new(parent_sock),
        };
        let err = zygote
            .build_init(sample_init_spec(), None)
            .expect_err("a Build reply to a BuildInit must not pass as a pid");
        assert!(
            err.to_string().contains("protocol violation"),
            "unexpected error: {err}"
        );
        responder.join().unwrap();
    }

    /// Serializes tests that run a build: `build_with_default_sigpipe` flips
    /// the process-wide SIGPIPE disposition around the build, and two builds
    /// interleaving their save/restore pairs can strand it at SIG_DFL for the
    /// whole multi-threaded test harness.
    static SIGPIPE_DANCE: Mutex<()> = Mutex::new(());

    /// A failed build must close the fds it received via SCM_RIGHTS.
    ///
    /// The zygote is long-lived; if an early builder error returns before the
    /// raw fds are wrapped, each failed build leaks three fds forever. Checked
    /// through pipe object identity, not fd numbers (immune to fd reuse by
    /// parallel tests): once the build closed its read end, the held write end
    /// polls POLLERR; once it closed its write ends, reading the held read
    /// ends returns EOF. The stdin probe is poll, deliberately not a write —
    /// a write to a readerless pipe raises SIGPIPE, which is fatal whenever
    /// some concurrent build has the disposition at SIG_DFL.
    fn assert_build_failure_closes_fds(build: impl FnOnce([RawFd; 3]) -> BuildResult) {
        use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
        use nix::unistd::{pipe, read};
        use std::os::fd::{AsFd, IntoRawFd};

        let _serialize = SIGPIPE_DANCE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let (r0, w0) = pipe().unwrap();
        let (r1, w1) = pipe().unwrap();
        let (r2, w2) = pipe().unwrap();

        // Transfer ownership of one end of each pipe to the build, as
        // recv_request's SCM_RIGHTS does.
        let sent = [r0.into_raw_fd(), w1.into_raw_fd(), w2.into_raw_fd()];
        let result = build(sent);
        assert!(
            matches!(result, BuildResult::Failed { .. }),
            "the build was meant to fail, got: {result:?}"
        );

        // stdin read end closed → the held write end polls POLLERR.
        let mut probe = [PollFd::new(w0.as_fd(), PollFlags::POLLOUT)];
        poll(&mut probe, PollTimeout::ZERO).expect("poll stdin probe");
        assert!(
            probe[0]
                .revents()
                .expect("stdin probe revents")
                .contains(PollFlags::POLLERR),
            "failed build left its stdin fd open"
        );
        // stdout/stderr write ends closed → read ends see EOF.
        let mut buf = [0u8; 1];
        assert_eq!(
            read(r1.as_raw_fd(), &mut buf).expect("read stdout probe"),
            0,
            "failed build left its stdout fd open"
        );
        assert_eq!(
            read(r2.as_raw_fd(), &mut buf).expect("read stderr probe"),
            0,
            "failed build left its stderr fd open"
        );
    }

    #[test]
    fn failed_tenant_build_closes_received_fds() {
        let state_root = tempfile::TempDir::new().unwrap();
        assert_build_failure_closes_fds(|fds| {
            let spec = BuildSpec {
                // '/' fails validate_id before any clone happens.
                container_id: "../invalid".to_string(),
                state_root: state_root.path().to_path_buf(),
                console_socket: None,
                cwd: PathBuf::from("/"),
                env: HashMap::new(),
                args: vec!["true".to_string()],
                uid: 0,
                gid: 0,
            };
            do_build(spec, Some(fds))
        });
    }

    #[test]
    fn failed_init_build_closes_received_fds() {
        let state_root = tempfile::TempDir::new().unwrap();
        assert_build_failure_closes_fds(|fds| {
            let spec = InitBuildSpec {
                container_id: "../invalid".to_string(),
                state_root: state_root.path().to_path_buf(),
                bundle_path: state_root.path().to_path_buf(),
                console_socket: None,
            };
            do_build_init(spec, Some(fds))
        });
    }

    /// Both-or-neither stdio is rejected at the boundary; the fds still close.
    #[test]
    fn init_build_rejects_conflicting_stdio() {
        let state_root = tempfile::TempDir::new().unwrap();
        assert_build_failure_closes_fds(|fds| {
            let spec = InitBuildSpec {
                container_id: "valid-id".to_string(),
                state_root: state_root.path().to_path_buf(),
                bundle_path: state_root.path().to_path_buf(),
                console_socket: Some("/tmp/console.sock".to_string()),
            };
            do_build_init(spec, Some(fds))
        });

        let _serialize = SIGPIPE_DANCE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = do_build_init(
            InitBuildSpec {
                container_id: "valid-id".to_string(),
                state_root: state_root.path().to_path_buf(),
                bundle_path: state_root.path().to_path_buf(),
                console_socket: None,
            },
            None,
        );
        let BuildResult::Failed { error } = result else {
            panic!("an init build without any stdio must fail, got: {result:?}");
        };
        assert!(error.contains("stdio"), "unexpected error: {error}");
    }
}
