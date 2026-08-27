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
mod output;
pub(crate) mod process_instance;
pub(in crate::service) mod registry;
pub(in crate::service) mod state;
mod timeout;
pub(crate) mod tty;

// Re-export trait so container module can implement it
pub(crate) use state::InitHealthCheck;

use crate::service::exec::error::ExecutionError;
use crate::service::exec::executor::{ContainerExecutor, GuestExecutor};
use crate::service::exec::registry::ExecutionLookup;
use crate::service::exec::state::ExecutionExit;
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
    async fn execution_lookup(&self, exec_id: &str) -> Result<ExecutionLookup, ExecutionError> {
        self.registry
            .lookup(exec_id)
            .await
            .ok_or_else(|| ExecutionError::NotFound(exec_id.to_string()))
    }

    /// Stream a running execution's stdout/stderr. One attach per execution.
    pub(crate) async fn attach_execution(
        &self,
        exec_id: &str,
    ) -> Result<mpsc::Receiver<Result<ExecOutput, Status>>, ExecutionError> {
        info!(execution_id = %exec_id, "attach request");
        match self.execution_lookup(exec_id).await? {
            ExecutionLookup::Live(state) => match state.attach(exec_id).await {
                Ok(output) => Ok(output),
                Err(ExecutionError::AlreadyAttached) => state.attach_retained(exec_id).await,
                Err(error @ ExecutionError::HandleUnavailable) => state
                    .sealed_terminal_output_summary()
                    .await
                    .map(terminal_output_receiver)
                    .ok_or(error),
                Err(error) => Err(error),
            },
            ExecutionLookup::Retained { state, snapshot } => {
                match state.attach_retained(exec_id).await {
                    Ok(output) => Ok(output),
                    Err(ExecutionError::HandleUnavailable) => {
                        Ok(terminal_output_receiver(snapshot.output))
                    }
                    Err(error) => Err(error),
                }
            }
            ExecutionLookup::Tombstone(snapshot) => Ok(terminal_output_receiver(snapshot.output)),
        }
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
        match self.execution_lookup(&exec_id).await? {
            ExecutionLookup::Live(state) => state.send_input(first, stream).await,
            ExecutionLookup::Retained { .. } | ExecutionLookup::Tombstone(_) => {
                Err(ExecutionError::HandleUnavailable)
            }
        }
    }

    /// Wait for exit, already classified — see [`ExecutionState::wait_exit`].
    pub(crate) async fn wait_execution(
        &self,
        exec_id: &str,
    ) -> Result<ExecutionExit, ExecutionError> {
        debug!(execution_id = %exec_id, "wait request");
        match self.execution_lookup(exec_id).await? {
            ExecutionLookup::Live(state) => Ok(state.wait_exit(exec_id).await),
            ExecutionLookup::Retained { snapshot, .. } | ExecutionLookup::Tombstone(snapshot) => {
                Ok(snapshot.exit)
            }
        }
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
        let state = self.execution_lookup(exec_id).await?;
        let parsed = nix::sys::signal::Signal::try_from(signal)
            .map_err(|_| ExecutionError::InvalidArgument(format!("signal number {signal}")))?;
        let sent = match state {
            ExecutionLookup::Live(state) => state.kill(parsed, process_group).await,
            ExecutionLookup::Retained { .. } | ExecutionLookup::Tombstone(_) => false,
        };
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
        let outcome = match self.execution_lookup(exec_id).await? {
            ExecutionLookup::Live(state) => state.resize_pty(rows, cols, x_pixels, y_pixels).await,
            ExecutionLookup::Retained { .. } | ExecutionLookup::Tombstone(_) => {
                Err(ExecutionError::HandleUnavailable)
            }
        };
        Ok(match outcome {
            Ok(()) => {
                info!(execution_id = %exec_id, rows, cols, "tty resized");
                TtyResize::Resized
            }
            Err(error) => {
                info!(execution_id = %exec_id, %error, "failed to resize tty");
                TtyResize::Rejected(error)
            }
        })
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

fn terminal_output_receiver(
    summary: output::OutputTerminalSummary,
) -> mpsc::Receiver<Result<ExecOutput, Status>> {
    let (tx, rx) = mpsc::channel(2);
    if let Some(failure) = summary.reader_failure {
        tx.try_send(Err(Status::internal(failure)))
            .expect("terminal attach receiver must be live");
    } else {
        for event in output::terminal_events(&summary) {
            tx.try_send(Ok(event))
                .expect("terminal attach receiver must be live");
        }
    }
    rx
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
    let execution_id =
        match execution_id_for_request(req.execution_id.as_deref(), ssh_workload.is_some()) {
            Ok(id) => id,
            Err(detail) => {
                return error_response(
                    req.execution_id.clone().unwrap_or_default(),
                    "invalid_argument",
                    detail,
                );
            }
        };

    let reservation = if ssh_workload.is_some() {
        if server.registry.exists(&execution_id).await {
            return error_response(execution_id, "execution_exists", "Execution already exists");
        }
        None
    } else {
        match server.registry.reserve(execution_id.clone()).await {
            Some(reservation) => Some(reservation),
            None => {
                return error_response(
                    execution_id,
                    "execution_exists",
                    "Execution already exists",
                );
            }
        }
    };

    match spawn_execution(
        server,
        execution_id,
        req,
        ssh_workload,
        reservation.as_ref(),
    )
    .await
    {
        Ok(response) => response,
        Err(response) => {
            if let Some(reservation) = reservation {
                server.registry.release_reservation(&reservation).await;
            }
            response
        }
    }
}

fn execution_id_for_request(requested: Option<&str>, is_ssh: bool) -> Result<String, &'static str> {
    match (requested, is_ssh) {
        (Some(_), false) => Err("execution_id is assigned by the guest"),
        (Some(id), true) => Ok(id.to_owned()),
        (None, _) => Ok(uuid::Uuid::new_v4().to_string()),
    }
}

/// Spawn execution (orchestrates full lifecycle).
async fn spawn_execution(
    server: &GuestServer,
    execution_id: String,
    req: ExecRequest,
    ssh_workload: Option<crate::service::ssh::SshWorkload>,
    reservation: Option<&registry::ExecutionReservation>,
) -> Result<ExecResponse, ExecResponse> {
    let started_at_ms = now_ms();

    let spawned_at = std::time::Instant::now();

    // Step 1: Spawn process using executor selected by BOXLITE_EXECUTOR env var
    let (child, container_ref) =
        spawn_with_executor(server, &req, &execution_id, ssh_workload).await?;

    let leader_pid = child.pid();
    let pid = leader_pid.as_raw() as u32;
    let process = process_instance::ProcessInstance::capture(leader_pid);
    if process.is_none() {
        warn!(
            execution_id = %execution_id,
            pid = leader_pid.as_raw(),
            "failed to capture process identity; signals will be skipped"
        );
    }

    // Register this pid's exit slot at the spawn, not at the wait: a detached
    // exec sends no Wait until its caller chooses to, and in between the exit
    // would age out as an ownerless stray.
    let reaper = crate::reaper::REAPER
        .get()
        .expect("reaper installed at startup");
    let exit = reaper.register(leader_pid, spawned_at).await;

    // Step 2: Create execution state and register
    // If running inside a container, pass the init health checker for death detection
    let state = match container_ref {
        Some(container) => {
            let health: std::sync::Arc<tokio::sync::Mutex<dyn InitHealthCheck>> = container;
            state::ExecutionState::new_with_init_health(child, health, exit, process)
        }
        None => state::ExecutionState::new(child, exit, process),
    };
    if let Some(reservation) = reservation {
        if !server.registry.publish(reservation, state.clone()).await {
            state.abort_unpublished().await;
            return Err(error_response(
                execution_id,
                "execution_cancelled",
                "Execution reservation was released before spawn completed",
            ));
        }
    } else if !server
        .registry
        .register(execution_id.clone(), state.clone())
        .await
    {
        state.abort_unpublished().await;
        return Err(error_response(
            execution_id,
            "execution_cancelled",
            "Execution registry is shutting down",
        ));
    }

    // Step 3: Start timeout watcher (if requested)
    if req.timeout_ms > 0 {
        let timeout_task = timeout::start_timeout_watcher(
            timeout::TimeoutTarget::new(process),
            execution_id.clone(),
            std::time::Duration::from_millis(req.timeout_ms),
        );
        state.set_timeout_task(timeout_task).await;
    }

    if reservation.is_some() {
        server
            .registry
            .observe_terminal(execution_id.clone(), state.clone());
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
            let spawn = match ssh_workload.as_ref() {
                Some(workload) => executor.spawn_ssh_workload(req, workload.clone()).await,
                None => executor.spawn(req).await,
            };
            let handle = match spawn {
                Ok(h) => h,
                Err(e) => {
                    // Zombie revival: run -d's Container.Start handoff can be
                    // lost when the creating CLI process exits before the RPC
                    // leaves the machine — the container sits in Created while
                    // the host has already marked the box Running. Re-issue the
                    // start here: run_init is idempotent, and a start still in
                    // flight holds the per-container lock, so this call queues
                    // behind it and then no-ops. On success, retry the spawn
                    // once (the lock must be dropped first — spawn takes it).
                    // Revive when the container is already running (a start in
                    // flight completed between the first spawn failure and this
                    // check) or when run_init starts it (the zombie case) —
                    // either way the first failure was most likely just the
                    // Created window, and one retry is warranted. A Stopped
                    // container fails run_init and falls through to the
                    // original diagnostic without a retry.
                    let revive = {
                        let container = container_ref.lock().await;
                        container.is_running() || container.run_init().is_ok()
                    };
                    let retry = if revive {
                        match ssh_workload {
                            Some(workload) => executor.spawn_ssh_workload(req, workload).await,
                            None => executor.spawn(req).await,
                        }
                    } else {
                        Err(e)
                    };
                    match retry {
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
                    }
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
    use super::{execution_id_for_request, is_single_path_component, GuestServer, TtyResize};
    use crate::layout::GuestLayout;
    use crate::reaper::ExitSlot;
    use crate::service::exec::error::ExecutionError;
    use crate::service::exec::exec_handle::{ExecHandle, ExitStatus};
    use crate::service::exec::output::{OutputStreamSummary, OutputTerminalSummary};
    use crate::service::exec::state::{ExecutionExit, ExecutionState, TerminalSnapshot};
    use boxlite_shared::{exec_output, ExecStdin};
    use nix::unistd::{pipe, write, Pid};

    #[test]
    fn rejects_ids_that_would_escape_the_containers_dir() {
        for bad in ["../../etc", "/etc/passwd", "a/b", "..", ".", ""] {
            assert!(!is_single_path_component(bad), "must reject {bad:?}");
        }
        assert!(is_single_path_component(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
    }

    #[test]
    fn public_exec_rejects_a_caller_supplied_execution_id() {
        assert!(execution_id_for_request(Some("caller-id"), false).is_err());
        assert_eq!(
            execution_id_for_request(Some("ssh-id"), true).unwrap(),
            "ssh-id"
        );
    }

    #[tokio::test]
    async fn tombstone_routes_terminal_rpcs_without_reopening_the_process() {
        let server = GuestServer::new(GuestLayout::new());
        server
            .registry
            .store_tombstone(
                "terminal-exec".into(),
                TerminalSnapshot {
                    exit: ExecutionExit {
                        exit_code: 9,
                        signal: 0,
                        error_message: String::new(),
                    },
                    output: OutputTerminalSummary {
                        stdout: OutputStreamSummary {
                            enabled: true,
                            total_bytes: 4,
                        },
                        stderr: OutputStreamSummary {
                            enabled: false,
                            total_bytes: 0,
                        },
                        reader_failure: None,
                    },
                },
            )
            .await;

        assert_eq!(
            server
                .wait_execution("terminal-exec")
                .await
                .unwrap()
                .exit_code,
            9
        );
        assert_eq!(
            server
                .wait_execution("terminal-exec")
                .await
                .unwrap()
                .exit_code,
            9
        );

        let mut output = server.attach_execution("terminal-exec").await.unwrap();
        let event = output.recv().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(stdout)) = event.event else {
            panic!("tombstone attach must return stdout terminal event");
        };
        assert!(stdout.data.is_empty());
        assert_eq!(stdout.offset, Some(4));
        assert_eq!(stdout.total_bytes, Some(4));

        let input = ExecStdin {
            execution_id: "terminal-exec".into(),
            data: Vec::new(),
            close: true,
        };
        assert!(matches!(
            server
                .send_execution_input(
                    input,
                    futures::stream::empty::<Result<ExecStdin, ExecutionError>>()
                )
                .await,
            Err(ExecutionError::HandleUnavailable)
        ));
        assert!(!server
            .kill_execution("terminal-exec", 15, false)
            .await
            .unwrap());
        assert!(matches!(
            server
                .resize_execution_tty("terminal-exec", 24, 80, 0, 0)
                .await,
            Ok(TtyResize::Rejected(ExecutionError::HandleUnavailable))
        ));
    }

    #[tokio::test]
    async fn reader_failure_tombstone_attach_returns_the_stored_internal_error() {
        let server = GuestServer::new(GuestLayout::new());
        server
            .registry
            .store_tombstone(
                "reader-failure".into(),
                TerminalSnapshot {
                    exit: ExecutionExit {
                        exit_code: 0,
                        signal: 0,
                        error_message: String::new(),
                    },
                    output: OutputTerminalSummary {
                        stdout: OutputStreamSummary {
                            enabled: true,
                            total_bytes: 7,
                        },
                        stderr: OutputStreamSummary {
                            enabled: false,
                            total_bytes: 0,
                        },
                        reader_failure: Some("stdout reader failed".into()),
                    },
                },
            )
            .await;

        let mut output = server.attach_execution("reader-failure").await.unwrap();
        let error = output.recv().await.unwrap().unwrap_err();
        assert_eq!(error.code(), tonic::Code::Internal);
        assert_eq!(error.message(), "stdout reader failed");
        assert!(output.recv().await.is_none());
    }

    #[tokio::test]
    async fn retained_attach_returns_terminal_output_after_the_ring_is_sealed() {
        let server = GuestServer::new(GuestLayout::new());
        let (_stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        drop(stdout_peer);
        drop(stderr_peer);
        let handle = ExecHandle::new(Pid::from_raw(13_001), stdin, stdout, Some(stderr))
            .expect("test pipes must register with Tokio");
        let state =
            ExecutionState::new_for_test(handle, ExitSlot::settled_for_test(ExitStatus::Code(0)));
        let snapshot = state.wait_terminal_snapshot("retained-exec").await;
        server
            .registry
            .register("retained-exec".into(), state)
            .await;
        assert!(server.registry.retain("retained-exec", snapshot, 0).await);

        let mut output = server.attach_execution("retained-exec").await.unwrap();
        let event = output.recv().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(stdout)) = event.event else {
            panic!("retained attach must return stdout terminal event");
        };
        assert!(stdout.data.is_empty());
        assert_eq!(stdout.offset, Some(0));
        assert_eq!(stdout.total_bytes, Some(0));
    }

    #[tokio::test]
    async fn retained_attach_replays_buffered_output_before_its_terminal_event() {
        let server = GuestServer::new(GuestLayout::new());
        let (_stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        write(&stdout_peer, b"snapshot-data").unwrap();
        drop(stdout_peer);
        drop(stderr_peer);
        let handle = ExecHandle::new(Pid::from_raw(13_004), stdin, stdout, Some(stderr))
            .expect("test pipes must register with Tokio");
        let state =
            ExecutionState::new_for_test(handle, ExitSlot::settled_for_test(ExitStatus::Code(0)));
        let snapshot = state.wait_terminal_snapshot("retained-output-exec").await;
        server
            .registry
            .register("retained-output-exec".into(), state)
            .await;
        assert!(
            server
                .registry
                .retain("retained-output-exec", snapshot, b"snapshot-data".len())
                .await
        );

        let mut output = server
            .attach_execution("retained-output-exec")
            .await
            .unwrap();
        let mut saw_data = false;
        while let Some(event) = output.recv().await {
            let Some(exec_output::Event::Stdout(stdout)) = event.unwrap().event else {
                continue;
            };
            if !saw_data {
                assert_eq!(stdout.data, b"snapshot-data");
                assert_eq!(stdout.offset, Some(0));
                assert_eq!(stdout.total_bytes, None);
                saw_data = true;
                continue;
            }
            assert!(stdout.data.is_empty());
            assert_eq!(stdout.offset, Some(b"snapshot-data".len() as u64));
            assert_eq!(stdout.total_bytes, Some(b"snapshot-data".len() as u64));
            return;
        }
        panic!("retained attach must replay stdout before its terminal event");
    }

    #[tokio::test]
    async fn sealed_live_attach_returns_terminal_output_while_retention_is_pending() {
        let server = GuestServer::new(GuestLayout::new());
        let (_stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        drop(stdout_peer);
        drop(stderr_peer);
        let handle = ExecHandle::new(Pid::from_raw(13_002), stdin, stdout, Some(stderr))
            .expect("test pipes must register with Tokio");
        let state =
            ExecutionState::new_for_test(handle, ExitSlot::settled_for_test(ExitStatus::Code(0)));
        state.wait_terminal_output_summary().await;
        server
            .registry
            .register("sealed-live-exec".into(), state)
            .await;

        let mut output = server.attach_execution("sealed-live-exec").await.unwrap();
        let event = output.recv().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(stdout)) = event.event else {
            panic!("sealed live attach must return stdout terminal event");
        };
        assert!(stdout.data.is_empty());
        assert_eq!(stdout.total_bytes, Some(0));
    }

    #[tokio::test]
    async fn sealed_live_attach_returns_terminal_output_after_resource_release() {
        let server = GuestServer::new(GuestLayout::new());
        let (_stdin_peer, stdin) = pipe().unwrap();
        let (stdout, stdout_peer) = pipe().unwrap();
        let (stderr, stderr_peer) = pipe().unwrap();
        drop(stdout_peer);
        drop(stderr_peer);
        let handle = ExecHandle::new(Pid::from_raw(13_003), stdin, stdout, Some(stderr))
            .expect("test pipes must register with Tokio");
        let state =
            ExecutionState::new_for_test(handle, ExitSlot::settled_for_test(ExitStatus::Code(0)));
        state.wait_terminal_output_summary().await;
        server
            .registry
            .register("released-sealed-live-exec".into(), state.clone())
            .await;
        assert!(state.release_resources().await);

        let mut output = server
            .attach_execution("released-sealed-live-exec")
            .await
            .expect("sealed live state must retain its terminal output");
        let event = output.recv().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(stdout)) = event.event else {
            panic!("released sealed live attach must return stdout terminal event");
        };
        assert!(stdout.data.is_empty());
        assert_eq!(stdout.total_bytes, Some(0));
    }
}
