#![cfg(target_os = "linux")]
//! Execution service implementation.
//!
//! Provides gRPC service for executing commands in containers with
//! streaming I/O, process control, and state management.
//!
//! ## Architecture
//!
//! This module follows a clean layered design:
//!
//! - **Protocol Layer** (mod.rs): gRPC service implementation
//! - **Executor Layer** (executor.rs): Process spawning abstraction
//! - **Lifecycle Layer** (timeout.rs): Process management
//! - **State Layer** (registry.rs, state.rs): Execution state
//! - **Types** (types.rs): Shared types
//!
//! Each file has a single, clear responsibility.

pub(in crate::service) mod error;
#[cfg(target_os = "linux")]
pub mod exec_handle;
pub(in crate::service) mod executor;
pub(crate) mod identity;
mod output;
pub(in crate::service) mod registry;
pub(in crate::service) mod state;
mod timeout;
pub(crate) mod tty;

// Re-export trait so container module can implement it
pub(crate) use state::InitHealthCheck;

use crate::service::exec::error::ExecutionError;
use crate::service::exec::executor::{ContainerExecutor, GuestExecutor};
use crate::service::exec::state::{ExecutionExit, ExecutionState};
use crate::service::server::GuestServer;
use boxlite_shared::{
    constants::executor as executor_const, AttachRequest, ExecError, ExecOutput, ExecRequest,
    ExecResponse, ExecStdin, Execution, KillRequest, KillResponse, ResizeTtyRequest,
    ResizeTtyResponse, SendInputAck, WaitRequest, WaitResponse,
};
use futures::stream::{Stream, StreamExt as _};
use std::pin::Pin;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{debug, info, warn};

/// The execution core, addressed in native types.
///
/// This is the whole contract for driving a running execution, and it is
/// transport-free on purpose: `impl Execution for GuestServer` below is one
/// adapter over it, and the in-process SSH server is another. Neither is
/// privileged, and neither can drift from the other, because the behaviour
/// lives here rather than in either adapter.
impl GuestServer {
    async fn execution(&self, exec_id: &str) -> Result<ExecutionState, ExecutionError> {
        self.registry
            .get(exec_id)
            .await
            .ok_or_else(|| ExecutionError::NotFound(exec_id.to_string()))
    }

    /// Stream a running execution's stdout/stderr. One attach per execution.
    pub(crate) async fn attach_execution(
        &self,
        exec_id: &str,
    ) -> Result<mpsc::Receiver<Result<ExecOutput, Status>>, ExecutionError> {
        info!(execution_id = %exec_id, "attach request");
        self.execution(exec_id).await?.attach(exec_id).await
    }

    /// Forward `first` and then everything `stream` yields to the execution's
    /// stdin. The returned task completes when the stream ends or stdin closes.
    pub(crate) async fn send_execution_input(
        &self,
        first: ExecStdin,
        stream: impl Stream<Item = Result<ExecStdin, ExecutionError>> + Send + Unpin + 'static,
    ) -> Result<JoinHandle<Result<(), ExecutionError>>, ExecutionError> {
        if first.execution_id.is_empty() {
            return Err(ExecutionError::InvalidArgument(
                "execution_id is required".into(),
            ));
        }
        let exec_id = first.execution_id.clone();
        self.execution(&exec_id)
            .await?
            .send_input(first, stream)
            .await
    }

    /// Wait for exit, already classified — see [`ExecutionState::wait_exit`].
    pub(crate) async fn wait_execution(
        &self,
        exec_id: &str,
    ) -> Result<ExecutionExit, ExecutionError> {
        debug!(execution_id = %exec_id, "wait request");
        Ok(self.execution(exec_id).await?.wait_exit(exec_id).await)
    }

    /// Signal the execution. `false` means the process had already exited.
    pub(crate) async fn kill_execution(
        &self,
        exec_id: &str,
        signal: i32,
        process_group: bool,
    ) -> Result<bool, ExecutionError> {
        info!(execution_id = %exec_id, signal, process_group, "kill request");
        // Resolve before parsing: signal 0 is the conventional liveness probe and
        // is not a `Signal`, so parsing first would report an unknown execution
        // as an invalid argument.
        let state = self.execution(exec_id).await?;
        let parsed = nix::sys::signal::Signal::try_from(signal)
            .map_err(|_| ExecutionError::InvalidArgument(format!("signal number {signal}")))?;
        let sent = state.kill(parsed, process_group).await;
        if sent {
            info!(execution_id = %exec_id, signal, "signal sent");
        } else {
            info!(execution_id = %exec_id, "failed to send signal");
        }
        Ok(sent)
    }

    /// Resize the execution's PTY.
    ///
    /// A device-level refusal — no handle, no PTY, failed ioctl — is an outcome
    /// rather than an error, because that is what the wire contract reports
    /// (`success: false` on an otherwise successful call). `Err` is reserved for
    /// a caller mistake: an out-of-range dimension or an unknown execution.
    pub(crate) async fn resize_execution_tty(
        &self,
        exec_id: &str,
        rows: u32,
        cols: u32,
        x_pixels: u32,
        y_pixels: u32,
    ) -> Result<TtyResize, ExecutionError> {
        // Unwrap the inner detail rather than the rendered `BoxliteError`: both
        // types render an "invalid argument: " prefix, and nesting them stutters.
        let dimension = |name, value| {
            tty::dimension(name, value).map_err(|error| match error {
                boxlite_shared::errors::BoxliteError::InvalidArgument(detail) => {
                    ExecutionError::InvalidArgument(detail)
                }
                other => ExecutionError::InvalidArgument(other.to_string()),
            })
        };
        let rows = dimension("rows", rows)?;
        let cols = dimension("cols", cols)?;
        let x_pixels = dimension("x_pixels", x_pixels)?;
        let y_pixels = dimension("y_pixels", y_pixels)?;

        info!(execution_id = %exec_id, rows, cols, "resize_tty request");
        Ok(
            match self
                .execution(exec_id)
                .await?
                .resize_pty(rows, cols, x_pixels, y_pixels)
                .await
            {
                Ok(()) => {
                    info!(execution_id = %exec_id, rows, cols, "tty resized");
                    TtyResize::Resized
                }
                Err(error) => {
                    info!(execution_id = %exec_id, %error, "failed to resize tty");
                    TtyResize::Rejected(error)
                }
            },
        )
    }
}

/// What a resize did, for callers that must distinguish "the terminal refused"
/// from "you asked for something impossible".
#[derive(Debug)]
pub(crate) enum TtyResize {
    Resized,
    Rejected(ExecutionError),
}

#[tonic::async_trait]
impl Execution for GuestServer {
    async fn exec(&self, request: Request<ExecRequest>) -> Result<Response<ExecResponse>, Status> {
        let req = request.into_inner();
        Ok(Response::new(start_execution(self, req, None).await))
    }

    type AttachStream = Pin<Box<dyn Stream<Item = Result<ExecOutput, Status>> + Send + 'static>>;

    async fn attach(
        &self,
        request: Request<AttachRequest>,
    ) -> Result<Response<Self::AttachStream>, Status> {
        let rx = self
            .attach_execution(&request.into_inner().execution_id)
            .await?;
        let stream = ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream) as Self::AttachStream))
    }

    async fn send_input(
        &self,
        request: Request<Streaming<ExecStdin>>,
    ) -> Result<Response<SendInputAck>, Status> {
        let mut stream = request.into_inner();

        // First message must carry execution_id.
        let first = stream
            .message()
            .await?
            .ok_or_else(|| Status::invalid_argument("Empty stdin stream"))?;

        let rest = stream.map(|msg| msg.map_err(|status| ExecutionError::Input(Box::new(status))));
        let task = self.send_execution_input(first, Box::pin(rest)).await?;

        match task.await {
            Ok(Ok(())) => Ok(Response::new(SendInputAck {})),
            Ok(Err(error)) => Err(error.into()),
            Err(error) => Err(Status::internal(format!("Stdin task panicked: {error}"))),
        }
    }

    async fn wait(&self, request: Request<WaitRequest>) -> Result<Response<WaitResponse>, Status> {
        let exit = self
            .wait_execution(&request.into_inner().execution_id)
            .await?;
        Ok(Response::new(WaitResponse {
            exit_code: exit.exit_code,
            signal: exit.signal,
            timed_out: false,
            duration_ms: 0,
            error_message: exit.error_message,
        }))
    }

    async fn kill(&self, request: Request<KillRequest>) -> Result<Response<KillResponse>, Status> {
        let req = request.into_inner();
        let sent = self
            .kill_execution(&req.execution_id, req.signal, req.process_group)
            .await?;
        Ok(Response::new(KillResponse {
            success: sent,
            error: (!sent).then(|| "Failed to send signal".to_string()),
        }))
    }

    async fn resize_tty(
        &self,
        request: Request<ResizeTtyRequest>,
    ) -> Result<Response<ResizeTtyResponse>, Status> {
        let req = request.into_inner();
        let outcome = self
            .resize_execution_tty(
                &req.execution_id,
                req.rows,
                req.cols,
                req.x_pixels,
                req.y_pixels,
            )
            .await?;
        Ok(Response::new(match outcome {
            TtyResize::Resized => ResizeTtyResponse {
                success: true,
                error: None,
            },
            TtyResize::Rejected(reason) => ResizeTtyResponse {
                success: false,
                error: Some(reason.to_string()),
            },
        }))
    }
}

/// Start a typed workload selected by the in-process SSH server. This entry
/// point is intentionally outside the public Execution RPC contract.
pub(crate) async fn start_ssh_execution(
    server: &GuestServer,
    req: ExecRequest,
    workload: crate::service::ssh::SshWorkload,
) -> ExecResponse {
    start_execution(server, req, Some(workload)).await
}

async fn start_execution(
    server: &GuestServer,
    req: ExecRequest,
    ssh_workload: Option<crate::service::ssh::SshWorkload>,
) -> ExecResponse {
    let execution_id = req
        .execution_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    if server.registry.exists(&execution_id).await {
        return error_response(execution_id, "execution_exists", "Execution already exists");
    }

    match spawn_execution(server, execution_id, req, ssh_workload).await {
        Ok(response) | Err(response) => response,
    }
}

/// Spawn execution (orchestrates full lifecycle).
async fn spawn_execution(
    server: &GuestServer,
    execution_id: String,
    req: ExecRequest,
    ssh_workload: Option<crate::service::ssh::SshWorkload>,
) -> Result<ExecResponse, ExecResponse> {
    let started_at_ms = now_ms();

    let spawned_at = std::time::Instant::now();

    // Step 1: Spawn process using executor selected by BOXLITE_EXECUTOR env var
    let (child, container_ref) =
        spawn_with_executor(server, &req, &execution_id, ssh_workload).await?;

    let leader_pid = child.pid();
    let pid = leader_pid.as_raw() as u32;
    let identity = identity::ProcessIdentity::capture(leader_pid);
    if identity.is_none() {
        warn!(
            execution_id = %execution_id,
            pid = leader_pid.as_raw(),
            "failed to capture process identity; signals will be skipped"
        );
    }

    let reaper = crate::reaper::REAPER
        .get()
        .expect("reaper installed at startup");
    let exit = reaper.register(leader_pid, spawned_at).await;

    // Step 2: Create execution state and register
    // If running inside a container, pass the init health checker for death detection
    let state = match container_ref {
        Some(container) => {
            let health: std::sync::Arc<tokio::sync::Mutex<dyn InitHealthCheck>> = container;
            state::ExecutionState::new_with_init_health(child, health, exit, identity)
        }
        None => state::ExecutionState::new(child, exit, identity),
    };
    server
        .registry
        .register(execution_id.clone(), state.clone())
        .await;

    // Step 3: Start timeout watcher (if requested)
    if req.timeout_ms > 0 {
        timeout::start_timeout_watcher(
            timeout::TimeoutTarget::new(identity),
            execution_id.clone(),
            std::time::Duration::from_millis(req.timeout_ms),
        );
    }

    Ok(ExecResponse {
        execution_id,
        pid,
        started_at_ms,
        error: None,
    })
}

fn error_response(id: String, reason: &str, detail: &str) -> ExecResponse {
    ExecResponse {
        execution_id: id,
        pid: 0,
        started_at_ms: 0,
        error: Some(ExecError {
            reason: reason.to_string(),
            detail: detail.to_string(),
        }),
    }
}

fn spawn_error(exec_id: &str, err: String) -> ExecResponse {
    ExecResponse {
        execution_id: exec_id.to_string(),
        pid: 0,
        started_at_ms: 0,
        error: Some(ExecError {
            reason: "spawn_failed".to_string(),
            detail: err,
        }),
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Spawn process with executor selected by BOXLITE_EXECUTOR env var.
///
/// Returns (ExecHandle, Option<container_ref>) — the container ref is provided
/// when running inside a container, enabling init-death detection.
///
/// Syntax:
/// - No env var or empty: use guest executor
/// - "guest": run directly on guest VM
/// - "container=<id>": run in container with specified ID
async fn spawn_with_executor(
    server: &GuestServer,
    req: &ExecRequest,
    execution_id: &str,
    ssh_workload: Option<crate::service::ssh::SshWorkload>,
) -> Result<
    (
        exec_handle::ExecHandle,
        Option<std::sync::Arc<tokio::sync::Mutex<crate::container::Container>>>,
    ),
    ExecResponse,
> {
    use executor::Executor;

    let executor_value = req.env.get(executor_const::ENV_VAR).map(|s| s.as_str());

    match executor_value {
        Some(executor_const::GUEST) | None | Some("") => {
            if ssh_workload.is_some() {
                return Err(spawn_error(
                    execution_id,
                    "internal SSH workloads require a container executor".into(),
                ));
            }
            // Guest executor (explicit or default)
            debug!(execution_id = %execution_id, "Using GuestExecutor");
            let handle = GuestExecutor
                .spawn(req)
                .await
                .map_err(|e| spawn_error(execution_id, e.to_string()))?;
            Ok((handle, None))
        }
        Some(s) if s.starts_with(executor_const::CONTAINER_KEY) => {
            // Container executor: parse "container=<id>"
            let container_id = s
                .strip_prefix(executor_const::CONTAINER_KEY)
                .and_then(|rest| rest.strip_prefix('='))
                .unwrap_or("");
            if container_id.is_empty() {
                return Err(spawn_error(
                    execution_id,
                    format!("Invalid {}: missing container_id", executor_const::ENV_VAR),
                ));
            }
            // Caller-controllable (a client can override BOXLITE_EXECUTOR in its
            // exec env) and joined into a filesystem path below, so require a
            // single normal component — `..`/`/…` must not escape containers/.
            if !is_single_path_component(container_id) {
                return Err(spawn_error(
                    execution_id,
                    format!(
                        "Invalid {}: container_id must be a single path component",
                        executor_const::ENV_VAR
                    ),
                ));
            }
            debug!(
                execution_id = %execution_id,
                container_id = %container_id,
                "Using ContainerExecutor"
            );
            // Refuse cleanly when the container's init has already exited
            // (docker semantics: no exec in a stopped container). Without
            // this, the tenant build reaches libcontainer against a dead
            // init and surfaces an opaque procfs internal error.
            //
            // Presence is the signal, not parseability: a torn record still
            // means init is gone, and letting a bad parse fall through here
            // would hand the exec straight back to the panic.
            let exit_file = server.layout.shared().container(container_id).exit_file();
            if exit_file.exists() {
                let how = boxlite_shared::layout::ExitRecord::read(&exit_file).map_or_else(
                    || "init exited".to_string(),
                    |record| format!("init exited with code {}", record.exit_code),
                );
                return Err(spawn_error(
                    execution_id,
                    format!("container is not running: {how}"),
                ));
            }

            // Look up container from registry
            let container_arc = {
                let containers_guard = server.containers.lock().await;
                containers_guard.get(container_id).cloned().ok_or_else(|| {
                    spawn_error(
                        execution_id,
                        format!("Container not found: {}", container_id),
                    )
                })?
            };
            let executor = ContainerExecutor::new(container_arc);
            let container_ref = executor.container_ref();
            let spawn = match ssh_workload {
                Some(workload) => executor.spawn_ssh_workload(req, workload).await,
                None => executor.spawn(req).await,
            };
            let handle = match spawn {
                Ok(h) => h,
                Err(e) => {
                    // Check if container init died — provide actionable diagnostics
                    let mut container = container_ref.lock().await;
                    if !container.is_running() {
                        let (init_stdout, init_stderr) = container.drain_init_output();
                        let mut msg = format!(
                            "Container init process exited — cannot exec. Original error: {}",
                            e
                        );
                        if !init_stdout.is_empty() {
                            msg.push_str(&format!(". Init stdout: {}", init_stdout.trim()));
                        }
                        if !init_stderr.is_empty() {
                            msg.push_str(&format!(". Init stderr: {}", init_stderr.trim()));
                        }
                        return Err(spawn_error(execution_id, msg));
                    }
                    return Err(spawn_error(execution_id, e.to_string()));
                }
            };
            Ok((handle, Some(container_ref)))
        }
        Some(unknown) => {
            // Unknown executor value
            Err(spawn_error(
                execution_id,
                format!(
                    "Unknown {} value: '{}'. Expected 'guest' or 'container=<id>'",
                    executor_const::ENV_VAR,
                    unknown
                ),
            ))
        }
    }
}

/// True when `id` is a single normal path component (no `..`, `/`, or a prefix),
/// so joining it under `containers/` cannot escape that directory. Real container
/// ids are 64-char hex, so this never rejects a legitimate one.
fn is_single_path_component(id: &str) -> bool {
    let mut components = std::path::Path::new(id).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

#[cfg(test)]
mod container_id_path_tests {
    use super::is_single_path_component;

    #[test]
    fn rejects_ids_that_would_escape_the_containers_dir() {
        for bad in ["../../etc", "/etc/passwd", "a/b", "..", ".", ""] {
            assert!(!is_single_path_component(bad), "must reject {bad:?}");
        }
        assert!(is_single_path_component(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
    }
}
