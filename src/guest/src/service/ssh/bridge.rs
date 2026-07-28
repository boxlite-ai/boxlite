//! Bridge one SSH channel to the guest's existing execution lifecycle.

use crate::service::exec::error::ExecutionError;
use crate::service::exec::registry::ExecutionRegistry;
use crate::service::exec::TtyResize;
use crate::service::server::GuestServer;
use crate::service::ssh::auth::SSH_USER;
use crate::service::ssh::limits::{
    CONTROL_CALL_TIMEOUT, FORWARD_CONNECT_TIMEOUT, PROCESS_TERMINATION_GRACE, STDIN_QUEUE_DEPTH,
};
use crate::service::ssh::SshWorkload;
use boxlite_shared::{
    constants::executor as executor_const, ExecOutput, ExecRequest, ExecStdin, TtyConfig,
};
use futures::StreamExt as _;
use russh::server::Handle as SessionHandle;
use russh::{ChannelId, Sig};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

const GRACEFUL_TERMINATION_SIGNALS: [i32; 2] = [1, 15]; // SIGHUP, SIGTERM
const FORCED_TERMINATION_SIGNAL: i32 = 9; // SIGKILL

/// SSH-owned signals address the execution's whole process group, never just
/// its leader: a shell that has forked children must take them down with it.
/// Every SSH kill site passes this rather than a literal, so the policy has one
/// place to be read, changed, and asserted.
pub(super) const SIGNAL_TARGETS_PROCESS_GROUP: bool = true;

#[derive(Debug)]
pub(crate) enum BridgeError {
    Target(String),
    Exec(String),
    StdinClosed,
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Target(error) => write!(f, "SSH execution target unavailable: {error}"),
            Self::Exec(error) => write!(f, "SSH execution failed: {error}"),
            Self::StdinClosed => write!(f, "SSH execution stdin is closed"),
        }
    }
}

impl std::error::Error for BridgeError {}

impl From<ExecutionError> for BridgeError {
    fn from(error: ExecutionError) -> Self {
        Self::Exec(error.to_string())
    }
}

pub(crate) enum Command {
    Shell,
    Exec(String),
    Sftp,
    Streamlocal(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChannelCompletion {
    Session,
    Forwarding,
}

impl ChannelCompletion {
    fn sends_exit_notification(self) -> bool {
        matches!(self, Self::Session)
    }
}

#[derive(Clone)]
struct StdinForwarder {
    execution_id: String,
    sender: mpsc::Sender<ExecStdin>,
}

impl StdinForwarder {
    async fn data(&self, data: Vec<u8>) -> Result<(), BridgeError> {
        self.send(data, false).await
    }

    async fn eof(&self) -> Result<(), BridgeError> {
        self.send(Vec::new(), true).await
    }

    async fn send(&self, data: Vec<u8>, close: bool) -> Result<(), BridgeError> {
        self.sender
            .send(ExecStdin {
                execution_id: self.execution_id.clone(),
                data,
                close,
            })
            .await
            .map_err(|_| BridgeError::StdinClosed)
    }
}

pub(crate) struct ChannelBridge {
    server: Arc<GuestServer>,
    execution_id: String,
    stdin: StdinForwarder,
    output_activate: Option<oneshot::Sender<()>>,
    output_cancel: Option<oneshot::Sender<()>>,
}

impl ChannelBridge {
    pub(crate) async fn start(
        server: Arc<GuestServer>,
        command: Command,
        tty: Option<TtyConfig>,
        env: HashMap<String, String>,
        channel_id: ChannelId,
        session_handle: SessionHandle,
    ) -> Result<Self, BridgeError> {
        let (container_id, profile) = resolve_single_container_profile(&server).await?;
        let launch = execution_launch(command, tty, env, &container_id, &profile);
        let completion = launch.completion;

        let response = tokio::time::timeout(
            CONTROL_CALL_TIMEOUT,
            crate::service::exec::start_ssh_execution(
                &server,
                ExecRequest {
                    execution_id: None,
                    program: launch.program,
                    args: launch.args,
                    env: launch.env,
                    workdir: launch.workdir,
                    timeout_ms: 0,
                    tty: launch.tty,
                    user: launch.user,
                },
                launch.workload,
            ),
        )
        .await
        .map_err(|_| BridgeError::Exec("exec timed out".into()))?;

        if let Some(error) = response.error {
            return Err(BridgeError::Exec(format!(
                "{}: {}",
                error.reason, error.detail
            )));
        }
        let execution_id = response.execution_id;

        // The core takes the execution id from the first frame, so open the
        // stream with an empty one; an empty payload writes nothing.
        let (stdin_tx, stdin_rx) = mpsc::channel::<ExecStdin>(STDIN_QUEUE_DEPTH);
        let opening = ExecStdin {
            execution_id: execution_id.clone(),
            data: Vec::new(),
            close: false,
        };
        let input_task = match server
            .send_execution_input(
                opening,
                Box::pin(tokio_stream::wrappers::ReceiverStream::new(stdin_rx).map(Ok)),
            )
            .await
        {
            Ok(task) => task,
            // The execution is already registered and running, so this failure
            // path owes the same teardown every sibling below performs.
            Err(error) => {
                cleanup_failed_execution_start(server.clone(), execution_id);
                return Err(error.into());
            }
        };
        tokio::spawn(async move {
            if let Ok(Err(error)) = input_task.await {
                warn!(%error, "SSH stdin forwarding ended with an error");
            }
        });

        let (output_start, output_activate) = if completion == ChannelCompletion::Forwarding {
            let ready = match await_streamlocal_ready(&server, &execution_id).await {
                Ok(ready) => ready,
                Err(error) => {
                    cleanup_failed_execution_start(server.clone(), execution_id);
                    return Err(error);
                }
            };
            let (activate_tx, activate_rx) = oneshot::channel();
            (
                OutputPumpStart::AwaitActivation {
                    output: ready.output,
                    buffered_stdout: ready.buffered_stdout,
                    activate_rx,
                },
                Some(activate_tx),
            )
        } else {
            (OutputPumpStart::Attach, None)
        };

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let output_task = spawn_output_pump(
            server.clone(),
            execution_id.clone(),
            channel_id,
            session_handle,
            completion,
            output_start,
            cancel_rx,
        );
        spawn_execution_cleanup(server.registry.clone(), execution_id.clone(), output_task);

        Ok(Self {
            server,
            execution_id: execution_id.clone(),
            stdin: StdinForwarder {
                execution_id,
                sender: stdin_tx,
            },
            output_activate,
            output_cancel: Some(cancel_tx),
        })
    }

    /// Allow a prepared forwarding pump to emit buffered socket data only
    /// after the SSH channel-open confirmation has been queued.
    pub(crate) fn activate_output(&mut self) {
        if let Some(activate) = self.output_activate.take() {
            let _ = activate.send(());
        }
    }

    pub(crate) async fn stdin(&self, data: Vec<u8>) -> Result<(), BridgeError> {
        self.stdin.data(data).await
    }

    pub(crate) async fn stdin_eof(&self) -> Result<(), BridgeError> {
        self.stdin.eof().await
    }

    pub(crate) async fn resize(
        &self,
        rows: u32,
        cols: u32,
        x_pixels: u32,
        y_pixels: u32,
    ) -> Result<(), BridgeError> {
        let outcome = tokio::time::timeout(
            CONTROL_CALL_TIMEOUT,
            self.server
                .resize_execution_tty(&self.execution_id, rows, cols, x_pixels, y_pixels),
        )
        .await
        .map_err(|_| BridgeError::Exec("resize_tty timed out".into()))??;
        match outcome {
            TtyResize::Resized => Ok(()),
            TtyResize::Rejected(reason) => Err(reason.into()),
        }
    }

    pub(crate) async fn signal(&self, signal: i32) -> Result<(), BridgeError> {
        send_group_signal(&self.server, &self.execution_id, signal).await
    }

    pub(crate) fn terminate_running(&mut self) {
        let execution_id = self.execution_id.clone();
        let server = self.server.clone();
        tokio::spawn(terminate_process_group(server, execution_id));
        if let Some(cancel) = self.output_cancel.take() {
            let _ = cancel.send(());
        }
    }
}

async fn send_group_signal(
    server: &GuestServer,
    execution_id: &str,
    signal: i32,
) -> Result<(), BridgeError> {
    let sent = tokio::time::timeout(
        CONTROL_CALL_TIMEOUT,
        server.kill_execution(execution_id, signal, SIGNAL_TARGETS_PROCESS_GROUP),
    )
    .await
    .map_err(|_| BridgeError::Exec("kill timed out".into()))??;
    if sent {
        Ok(())
    } else {
        Err(BridgeError::Exec("kill rejected the signal".into()))
    }
}

async fn terminate_process_group(server: Arc<GuestServer>, execution_id: String) {
    // Give normal shell traps and cleanup handlers one fixed grace window.
    // `timeout_at` prevents a stuck control call from postponing SIGKILL past
    // the deadline.
    let deadline = tokio::time::Instant::now() + PROCESS_TERMINATION_GRACE;
    for signal in GRACEFUL_TERMINATION_SIGNALS {
        match tokio::time::timeout_at(deadline, send_group_signal(&server, &execution_id, signal))
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                debug!(%error, %execution_id, signal, "SSH graceful group signal was not delivered");
            }
            Err(_) => break,
        }
    }
    tokio::time::sleep_until(deadline).await;
    if let Err(error) = send_group_signal(&server, &execution_id, FORCED_TERMINATION_SIGNAL).await {
        debug!(%error, %execution_id, "SSH forced group signal was not delivered");
    }
}

impl Drop for ChannelBridge {
    fn drop(&mut self) {
        // Transport loss may drop the russh handler without delivering a
        // channel-close callback. Keep SSH-owned processes tied to the channel
        // in that path as well; terminate_running takes the cancel sender so a
        // normal channel-close does not start teardown twice.
        if self.output_cancel.is_some() {
            self.terminate_running();
        }
    }
}

pub(super) async fn resolve_single_container_profile(
    server: &GuestServer,
) -> Result<(String, crate::container::user_profile::RootSessionProfile), BridgeError> {
    let containers = server.containers.lock().await;
    let container_id = select_single_container_id(containers.keys())?;
    let container = containers
        .get(&container_id)
        .expect("selected container remains registered while map is locked")
        .clone();
    drop(containers);
    let profile = container.lock().await.root_session_profile();
    Ok((container_id, profile))
}

fn select_single_container_id<'a>(
    mut container_ids: impl Iterator<Item = &'a String>,
) -> Result<String, BridgeError> {
    let Some(container_id) = container_ids.next() else {
        return Err(BridgeError::Target(
            "no running container is registered".into(),
        ));
    };
    let Some(_second_container_id) = container_ids.next() else {
        return Ok(container_id.clone());
    };

    let count = 2 + container_ids.count();
    Err(BridgeError::Target(format!(
        "exactly one running container is required, found {count}"
    )))
}

fn container_exec_env(
    mut env: HashMap<String, String>,
    container_id: &str,
) -> HashMap<String, String> {
    // Insert this after caller-provided variables so an SSH client cannot
    // select the guest executor or a different container.
    env.insert(
        executor_const::ENV_VAR.to_string(),
        format!("{}={container_id}", executor_const::CONTAINER_KEY),
    );
    env
}

pub(super) fn session_exec_env(
    mut env: HashMap<String, String>,
    container_id: &str,
    profile: &crate::container::user_profile::RootSessionProfile,
) -> HashMap<String, String> {
    // Account identity is server-owned. Insert it after client-provided env so
    // AcceptEnv cannot move a root login away from its passwd profile.
    env.insert("HOME".into(), profile.home_dir.clone());
    env.insert("SHELL".into(), profile.login_shell.clone());
    env.insert("USER".into(), SSH_USER.into());
    env.insert("LOGNAME".into(), SSH_USER.into());
    container_exec_env(env, container_id)
}

struct ExecutionLaunch {
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    workdir: String,
    tty: Option<TtyConfig>,
    user: Option<String>,
    completion: ChannelCompletion,
    workload: SshWorkload,
}

fn execution_launch(
    command: Command,
    tty: Option<TtyConfig>,
    env: HashMap<String, String>,
    container_id: &str,
    profile: &crate::container::user_profile::RootSessionProfile,
) -> ExecutionLaunch {
    match command {
        Command::Shell => {
            let helper = session_launch(container_id, profile, env, SshWorkload::Shell);
            ExecutionLaunch {
                program: helper.program,
                args: helper.args,
                env: helper.env,
                workdir: profile.home_dir.clone(),
                tty,
                user: helper.user,
                completion: ChannelCompletion::Session,
                workload: helper.workload,
            }
        }
        Command::Exec(command) => {
            let helper = session_launch(container_id, profile, env, SshWorkload::Exec { command });
            ExecutionLaunch {
                program: helper.program,
                args: helper.args,
                env: helper.env,
                workdir: profile.home_dir.clone(),
                tty,
                user: helper.user,
                completion: ChannelCompletion::Session,
                workload: helper.workload,
            }
        }
        Command::Sftp => {
            let helper = sftp_launch(container_id, profile);
            ExecutionLaunch {
                program: helper.program,
                args: helper.args,
                env: helper.env,
                workdir: profile.home_dir.clone(),
                tty: None,
                user: helper.user,
                completion: ChannelCompletion::Session,
                workload: helper.workload,
            }
        }
        Command::Streamlocal(socket_path) => {
            let helper = streamlocal_launch(container_id, profile, socket_path);
            ExecutionLaunch {
                program: helper.program,
                args: helper.args,
                env: helper.env,
                workdir: String::new(),
                tty: None,
                user: helper.user,
                completion: ChannelCompletion::Forwarding,
                workload: helper.workload,
            }
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
struct InternalHelperLaunch {
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    user: Option<String>,
    workload: SshWorkload,
}

fn internal_helper_launch(
    container_id: &str,
    profile: &crate::container::user_profile::RootSessionProfile,
    workload: SshWorkload,
    env: HashMap<String, String>,
) -> InternalHelperLaunch {
    let (program, args) = workload.placeholder();
    InternalHelperLaunch {
        // The zygote installs BoxliteWorkloadExecutor for tenant builds. This
        // reserved argv[0] selects its narrow SSH workload surface without
        // requiring a helper executable in the container image.
        program,
        args,
        env: session_exec_env(env, container_id, profile),
        // Server-owned SSH work always runs as container root. A numeric
        // identity works in scratch images that deliberately omit passwd.
        user: Some("0:0".to_string()),
        workload,
    }
}

fn session_launch(
    container_id: &str,
    profile: &crate::container::user_profile::RootSessionProfile,
    env: HashMap<String, String>,
    workload: SshWorkload,
) -> InternalHelperLaunch {
    internal_helper_launch(container_id, profile, workload, env)
}

fn sftp_launch(
    container_id: &str,
    profile: &crate::container::user_profile::RootSessionProfile,
) -> InternalHelperLaunch {
    internal_helper_launch(container_id, profile, SshWorkload::Sftp, HashMap::new())
}

fn streamlocal_launch(
    container_id: &str,
    profile: &crate::container::user_profile::RootSessionProfile,
    socket_path: String,
) -> InternalHelperLaunch {
    internal_helper_launch(
        container_id,
        profile,
        SshWorkload::DirectStreamlocal { socket_path },
        HashMap::new(),
    )
}

struct PreparedStreamlocalOutput {
    output: mpsc::Receiver<ExecOutput>,
    buffered_stdout: Vec<u8>,
}

enum OutputPumpStart {
    Attach,
    AwaitActivation {
        output: mpsc::Receiver<ExecOutput>,
        buffered_stdout: Vec<u8>,
        activate_rx: oneshot::Receiver<()>,
    },
}

#[derive(Default)]
struct StreamlocalReadyParser {
    matched: usize,
}

impl StreamlocalReadyParser {
    fn push_stdout(&mut self, data: &[u8]) -> Result<Option<Vec<u8>>, BridgeError> {
        let magic = crate::service::ssh::streamlocal::STREAMLOCAL_READY_MAGIC;
        let prefix_bytes = (magic.len() - self.matched).min(data.len());
        if data[..prefix_bytes] != magic[self.matched..self.matched + prefix_bytes] {
            return Err(BridgeError::Exec(
                "streamlocal helper returned an invalid readiness prefix".into(),
            ));
        }
        self.matched += prefix_bytes;
        if self.matched == magic.len() {
            Ok(Some(data[prefix_bytes..].to_vec()))
        } else {
            Ok(None)
        }
    }
}

async fn await_streamlocal_ready(
    server: &GuestServer,
    execution_id: &str,
) -> Result<PreparedStreamlocalOutput, BridgeError> {
    tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, async {
        let mut output = server
            .attach_execution(execution_id)
            .await
            .map_err(|error| BridgeError::Exec(format!("streamlocal attach failed: {error}")))?;
        let mut parser = StreamlocalReadyParser::default();

        loop {
            let message = output.recv().await.ok_or_else(|| {
                BridgeError::Exec("streamlocal helper exited before readiness".into())
            })?;
            match message.event {
                Some(boxlite_shared::exec_output::Event::Stdout(stdout)) => {
                    if let Some(buffered_stdout) = parser.push_stdout(&stdout.data)? {
                        return Ok(PreparedStreamlocalOutput {
                            output,
                            buffered_stdout,
                        });
                    }
                }
                Some(boxlite_shared::exec_output::Event::Stderr(stderr)) => {
                    debug!(
                        bytes = stderr.data.len(),
                        %execution_id,
                        "streamlocal helper stderr before readiness"
                    );
                }
                None => {}
            }
        }
    })
    .await
    .map_err(|_| BridgeError::Exec("streamlocal readiness timed out".into()))?
}

const INDETERMINATE_EXIT_STATUS: u32 = 255;

#[derive(Debug, Eq, PartialEq)]
enum ExitNotification {
    Status(u32),
    Signal { number: i32, message: String },
}

fn spawn_output_pump(
    server: Arc<GuestServer>,
    execution_id: String,
    channel_id: ChannelId,
    session_handle: SessionHandle,
    completion: ChannelCompletion,
    output_start: OutputPumpStart,
    mut cancel_rx: oneshot::Receiver<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let (mut output, buffered_stdout) = match output_start {
            OutputPumpStart::Attach => {
                let attached = tokio::select! {
                    _ = &mut cancel_rx => return,
                    attached = tokio::time::timeout(
                        CONTROL_CALL_TIMEOUT,
                        server.attach_execution(&execution_id),
                    ) => attached,
                };
                // Flatten first so each outcome is one arm and the compiler,
                // not a panic, proves the match is exhaustive.
                let attached = match attached {
                    Ok(inner) => inner,
                    Err(_) => Err(ExecutionError::Io("attach timed out".into())),
                };
                match attached {
                    Ok(output) => (output, Vec::new()),
                    Err(error) => {
                        warn!(%error, %execution_id, "SSH attach failed");
                        terminate_process_group(server.clone(), execution_id.clone()).await;
                        finish_channel(
                            &session_handle,
                            channel_id,
                            completion,
                            ExitNotification::Status(INDETERMINATE_EXIT_STATUS),
                        )
                        .await;
                        return;
                    }
                }
            }
            OutputPumpStart::AwaitActivation {
                output,
                buffered_stdout,
                mut activate_rx,
            } => {
                let activated = tokio::select! {
                    _ = &mut cancel_rx => return,
                    activated = &mut activate_rx => activated,
                };
                if activated.is_err() {
                    return;
                }
                (output, buffered_stdout)
            }
        };

        if !buffered_stdout.is_empty() {
            let _ = session_handle.data(channel_id, buffered_stdout).await;
        }

        loop {
            tokio::select! {
                // A resolved oneshot receiver must not be polled again by the
                // wait select below. Cancellation means the channel lifecycle
                // owner is already terminating the process group, so the
                // output task can finish immediately.
                _ = &mut cancel_rx => return,
                message = output.recv() => {
                    match message {
                        Some(message) => match message.event {
                            Some(boxlite_shared::exec_output::Event::Stdout(stdout)) => {
                                let _ = session_handle.data(channel_id, stdout.data).await;
                            }
                            Some(boxlite_shared::exec_output::Event::Stderr(stderr)) => {
                                let _ = session_handle.extended_data(channel_id, 1, stderr.data).await;
                            }
                            None => {}
                        },
                        None => break,
                    }
                }
            }
        }

        // Output EOF and process exit are distinct. Programs may close stdout
        // and stderr while continuing useful work, so the wait remains
        // outstanding for their actual lifetime. Channel cancellation is the
        // bounded escape path and triggers process-group teardown through
        // ChannelBridge.
        let exit = tokio::select! {
            _ = &mut cancel_rx => return,
            exit = server.wait_execution(&execution_id) => exit,
        };

        let notification = match exit {
            Ok(exit) => exit_notification(exit.exit_code, exit.signal, exit.error_message),
            Err(error) => {
                warn!(%error, %execution_id, "SSH wait failed");
                terminate_process_group(server, execution_id.clone()).await;
                ExitNotification::Status(INDETERMINATE_EXIT_STATUS)
            }
        };

        finish_channel(&session_handle, channel_id, completion, notification).await;
    })
}

/// Keep one lifecycle owner for every SSH-created execution.
///
/// The output task may finish early because Attach failed or the SSH channel
/// was cancelled. The cleanup task still waits for a confirmed process exit.
/// Conversely, a process may exit before its buffered output is drained, so
/// release waits for both before closing descriptors and removing the registry
/// entry.
fn spawn_execution_cleanup(
    registry: ExecutionRegistry,
    execution_id: String,
    output_task: JoinHandle<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(state) = registry.get(&execution_id).await else {
            return;
        };

        state.wait_process().await;
        if let Err(error) = output_task.await {
            warn!(%error, %execution_id, "SSH output task ended unexpectedly");
        }

        if !registry.release_ephemeral(&execution_id).await {
            debug!(%execution_id, "SSH execution was already released");
        }
    })
}

fn cleanup_failed_execution_start(server: Arc<GuestServer>, execution_id: String) {
    let cleanup_execution_id = execution_id.clone();
    let output_task = tokio::spawn(async {});
    spawn_execution_cleanup(server.registry.clone(), cleanup_execution_id, output_task);
    tokio::spawn(terminate_process_group(server, execution_id));
}

fn exit_notification(exit_code: i32, signal: i32, error_message: String) -> ExitNotification {
    if signal == 0 {
        ExitNotification::Status(exit_code as u32)
    } else {
        ExitNotification::Signal {
            number: signal,
            message: error_message,
        }
    }
}

async fn finish_channel(
    handle: &SessionHandle,
    channel_id: ChannelId,
    completion: ChannelCompletion,
    notification: ExitNotification,
) {
    if completion.sends_exit_notification() {
        match notification {
            ExitNotification::Status(status) => {
                let _ = handle.exit_status_request(channel_id, status).await;
            }
            ExitNotification::Signal { number, message } => {
                let _ = handle
                    .exit_signal_request(
                        channel_id,
                        ssh_signal(number),
                        false,
                        message,
                        String::new(),
                    )
                    .await;
            }
        }
    }
    let _ = handle.eof(channel_id).await;
    let _ = handle.close(channel_id).await;
}

pub(crate) fn signal_number(signal: &Sig) -> Option<i32> {
    Some(match signal {
        Sig::ABRT => 6,
        Sig::ALRM => 14,
        Sig::FPE => 8,
        Sig::HUP => 1,
        Sig::ILL => 4,
        Sig::INT => 2,
        Sig::KILL => 9,
        Sig::PIPE => 13,
        Sig::QUIT => 3,
        Sig::SEGV => 11,
        Sig::TERM => 15,
        Sig::USR1 => 10,
        Sig::Custom(name) => custom_signal_number(name)?,
    })
}

fn custom_signal_number(name: &str) -> Option<i32> {
    let name = name.strip_prefix("SIG").unwrap_or(name);
    Some(match name {
        "HUP" => 1,
        "INT" => 2,
        "QUIT" => 3,
        "ILL" => 4,
        "TRAP" => 5,
        "ABRT" | "IOT" => 6,
        "BUS" => 7,
        "FPE" => 8,
        "KILL" => 9,
        "USR1" => 10,
        "SEGV" => 11,
        "USR2" => 12,
        "PIPE" => 13,
        "ALRM" => 14,
        "TERM" => 15,
        "STKFLT" => 16,
        "CHLD" | "CLD" => 17,
        "CONT" => 18,
        "STOP" => 19,
        "TSTP" => 20,
        "TTIN" => 21,
        "TTOU" => 22,
        "URG" => 23,
        "XCPU" => 24,
        "XFSZ" => 25,
        "VTALRM" => 26,
        "PROF" => 27,
        "WINCH" => 28,
        "IO" | "POLL" => 29,
        "PWR" => 30,
        "SYS" => 31,
        _ => return None,
    })
}

fn ssh_signal(signal: i32) -> Sig {
    match signal {
        1 => Sig::HUP,
        2 => Sig::INT,
        3 => Sig::QUIT,
        4 => Sig::ILL,
        6 => Sig::ABRT,
        8 => Sig::FPE,
        9 => Sig::KILL,
        10 => Sig::USR1,
        11 => Sig::SEGV,
        13 => Sig::PIPE,
        14 => Sig::ALRM,
        15 => Sig::TERM,
        16 => Sig::Custom("STKFLT".into()),
        5 => Sig::Custom("TRAP".into()),
        7 => Sig::Custom("BUS".into()),
        12 => Sig::Custom("USR2".into()),
        17 => Sig::Custom("CHLD".into()),
        18 => Sig::Custom("CONT".into()),
        19 => Sig::Custom("STOP".into()),
        20 => Sig::Custom("TSTP".into()),
        21 => Sig::Custom("TTIN".into()),
        22 => Sig::Custom("TTOU".into()),
        23 => Sig::Custom("URG".into()),
        24 => Sig::Custom("XCPU".into()),
        25 => Sig::Custom("XFSZ".into()),
        26 => Sig::Custom("VTALRM".into()),
        27 => Sig::Custom("PROF".into()),
        28 => Sig::Custom("WINCH".into()),
        29 => Sig::Custom("IO".into()),
        30 => Sig::Custom("PWR".into()),
        31 => Sig::Custom("SYS".into()),
        other => Sig::Custom(format!("SIGNAL-{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reaper::ExitSlot;
    use crate::service::exec::exec_handle::{ExecHandle, ExitStatus};
    use crate::service::exec::state::ExecutionState;
    use nix::unistd::{pipe, Pid};

    fn root_profile() -> crate::container::user_profile::RootSessionProfile {
        crate::container::user_profile::RootSessionProfile {
            home_dir: "/root".into(),
            login_shell: "/bin/bash".into(),
        }
    }

    async fn pending_execution(
        registry: &ExecutionRegistry,
        execution_id: &str,
        pid: i32,
    ) -> tokio::sync::watch::Sender<Option<ExitStatus>> {
        let (_stdin_peer, stdin) = pipe().unwrap();
        let (stdout, _stdout_peer) = pipe().unwrap();
        let (stderr, _stderr_peer) = pipe().unwrap();
        let handle = ExecHandle::new(Pid::from_raw(pid), stdin, stdout, Some(stderr));
        let (exit, exit_tx) = ExitSlot::pending_for_test();
        let state = ExecutionState::new_for_test(handle, exit);
        registry.register(execution_id.into(), state).await;
        exit_tx
    }

    #[test]
    fn execution_requires_exactly_one_container() {
        let none = Vec::<String>::new();
        assert!(matches!(
            select_single_container_id(none.iter()),
            Err(BridgeError::Target(_))
        ));

        let one = ["container-1".to_string()];
        assert_eq!(
            select_single_container_id(one.iter()).unwrap(),
            "container-1"
        );

        let many = ["container-1".to_string(), "container-2".to_string()];
        let error = select_single_container_id(many.iter()).unwrap_err();
        assert!(error.to_string().contains("found 2"));
    }

    #[test]
    fn caller_cannot_override_the_container_executor() {
        let mut env = HashMap::new();
        env.insert(executor_const::ENV_VAR.to_string(), "guest".to_string());

        let env = container_exec_env(env, "container-1");

        assert_eq!(
            env.get(executor_const::ENV_VAR).map(String::as_str),
            Some("container=container-1")
        );
    }

    #[test]
    fn shell_launch_uses_the_container_profile_and_protects_account_environment() {
        let profile = root_profile();
        let mut env = HashMap::from([
            ("HOME".to_string(), "/attacker".to_string()),
            ("SHELL".to_string(), "/tmp/shell".to_string()),
            ("USER".to_string(), "somebody".to_string()),
            ("LOGNAME".to_string(), "somebody".to_string()),
            ("TERM".to_string(), "xterm-256color".to_string()),
        ]);
        env.insert(executor_const::ENV_VAR.to_string(), "guest".into());

        let launch = execution_launch(Command::Shell, None, env, "container-1", &profile);

        assert_eq!(
            launch.program,
            crate::service::ssh::workload::INTERNAL_PROGRAM
        );
        assert_eq!(
            launch.args,
            [crate::service::ssh::session::INTERNAL_SESSION_ARG, "shell"]
        );
        assert_eq!(launch.workdir, "/root");
        assert_eq!(launch.env.get("HOME").map(String::as_str), Some("/root"));
        assert_eq!(
            launch.env.get("SHELL").map(String::as_str),
            Some("/bin/bash")
        );
        assert_eq!(launch.env.get("USER").map(String::as_str), Some("root"));
        assert_eq!(launch.env.get("LOGNAME").map(String::as_str), Some("root"));
        assert_eq!(
            launch.env.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        assert_eq!(
            launch.env.get(executor_const::ENV_VAR).map(String::as_str),
            Some("container=container-1")
        );
    }

    #[test]
    fn exec_launch_preserves_the_complete_command_as_one_argument() {
        let command = "printf '%s' 'spaces ; $(still shell data)'";
        let launch = execution_launch(
            Command::Exec(command.into()),
            None,
            HashMap::new(),
            "container-1",
            &root_profile(),
        );

        assert_eq!(
            launch.args,
            [
                crate::service::ssh::session::INTERNAL_SESSION_ARG,
                "exec",
                command
            ]
        );
        assert_eq!(launch.workdir, "/root");
    }

    #[test]
    fn sftp_launch_uses_root_home_without_a_tty_or_client_environment() {
        let mut env = HashMap::new();
        env.insert("LC_ALL".into(), "client-controlled".into());
        let launch = execution_launch(
            Command::Sftp,
            Some(TtyConfig::default()),
            env,
            "container-1",
            &root_profile(),
        );

        assert_eq!(launch.workdir, "/root");
        assert!(launch.tty.is_none());
        assert!(!launch.env.contains_key("LC_ALL"));
        assert_eq!(launch.env.get("HOME").map(String::as_str), Some("/root"));
    }

    #[test]
    fn sftp_uses_the_internal_container_workload() {
        let launch = sftp_launch("container-1", &root_profile());

        assert_eq!(
            launch.program,
            crate::service::ssh::workload::INTERNAL_PROGRAM
        );
        assert_eq!(launch.args, [crate::service::ssh::sftp::INTERNAL_SFTP_ARG]);
        assert_eq!(launch.user.as_deref(), Some("0:0"));
        assert_eq!(launch.env.len(), 5);
        assert_eq!(launch.env.get("HOME").map(String::as_str), Some("/root"));
        assert_eq!(
            launch.env.get(executor_const::ENV_VAR).map(String::as_str),
            Some("container=container-1")
        );
    }

    #[test]
    fn streamlocal_uses_the_internal_container_workload() {
        let launch = streamlocal_launch("container-1", &root_profile(), "/run/service.sock".into());

        assert_eq!(
            launch.program,
            crate::service::ssh::workload::INTERNAL_PROGRAM
        );
        assert_eq!(
            launch.args,
            [
                crate::service::ssh::streamlocal::INTERNAL_STREAMLOCAL_ARG,
                "/run/service.sock"
            ]
        );
        assert_eq!(launch.user.as_deref(), Some("0:0"));
        assert_eq!(launch.env.len(), 5);
        assert_eq!(launch.env.get("HOME").map(String::as_str), Some("/root"));
        assert_eq!(
            launch.env.get(executor_const::ENV_VAR).map(String::as_str),
            Some("container=container-1")
        );
    }

    #[test]
    fn forwarding_completion_is_distinct_from_session_exit_notification() {
        assert!(ChannelCompletion::Session.sends_exit_notification());
        assert!(!ChannelCompletion::Forwarding.sends_exit_notification());
    }

    #[test]
    fn streamlocal_readiness_prefix_can_be_fragmented() {
        let magic = crate::service::ssh::streamlocal::STREAMLOCAL_READY_MAGIC;
        let mut parser = StreamlocalReadyParser::default();

        assert_eq!(parser.push_stdout(&magic[..3]).unwrap(), None);
        assert_eq!(parser.push_stdout(&magic[3..11]).unwrap(), None);
        assert_eq!(parser.push_stdout(&magic[11..]).unwrap(), Some(Vec::new()));
    }

    #[test]
    fn streamlocal_readiness_preserves_coalesced_socket_payload() {
        let magic = crate::service::ssh::streamlocal::STREAMLOCAL_READY_MAGIC;
        let mut frame = magic.to_vec();
        frame.extend_from_slice(b"socket payload");

        let mut parser = StreamlocalReadyParser::default();
        assert_eq!(
            parser.push_stdout(&frame).unwrap(),
            Some(b"socket payload".to_vec())
        );
    }

    #[test]
    fn streamlocal_readiness_rejects_non_helper_output() {
        let mut parser = StreamlocalReadyParser::default();
        assert!(parser.push_stdout(b"not readiness").is_err());
    }

    #[test]
    fn ssh_teardown_escalates_hup_and_term_to_kill() {
        assert_eq!(GRACEFUL_TERMINATION_SIGNALS, [1, 15]);
        assert_eq!(FORCED_TERMINATION_SIGNAL, 9);
        assert!(!PROCESS_TERMINATION_GRACE.is_zero());
        // A shell that forked children must take them down with it, so the
        // final signal addresses the group rather than the leader.
        assert_eq!(
            (FORCED_TERMINATION_SIGNAL, SIGNAL_TARGETS_PROCESS_GROUP),
            (9, true)
        );
    }

    #[test]
    fn preserves_signal_termination_as_an_ssh_exit_signal() {
        assert_eq!(
            exit_notification(0, 15, "container init exited".into()),
            ExitNotification::Signal {
                number: 15,
                message: "container init exited".into()
            }
        );
        assert_eq!(
            exit_notification(23, 0, String::new()),
            ExitNotification::Status(23)
        );
        assert_eq!(signal_number(&Sig::TERM), Some(15));
        assert_eq!(signal_number(&Sig::Custom("USR2".into())), Some(12));
        assert_eq!(signal_number(&Sig::Custom("UNKNOWN".into())), None);
    }

    #[tokio::test]
    async fn stdin_backpressure_preserves_more_than_one_queue_of_frames() {
        let (sender, mut receiver) = mpsc::channel(STDIN_QUEUE_DEPTH);
        let forwarder = StdinForwarder {
            execution_id: "exec-1".into(),
            sender,
        };
        let expected: Vec<Vec<u8>> = (0..(STDIN_QUEUE_DEPTH * 3))
            .map(|index| vec![index as u8; 257])
            .collect();
        let sent = expected.clone();

        let producer = tokio::spawn(async move {
            for frame in sent {
                forwarder.data(frame).await.unwrap();
            }
            forwarder.eof().await.unwrap();
        });

        let mut observed = Vec::new();
        while let Some(message) = receiver.recv().await {
            assert_eq!(message.execution_id, "exec-1");
            if message.close {
                break;
            }
            observed.push(message.data);
        }
        producer.await.unwrap();

        assert_eq!(observed, expected);
    }

    #[tokio::test]
    async fn attach_failure_still_releases_after_terminal_exit() {
        let registry = ExecutionRegistry::new();
        let exit_tx = pending_execution(&registry, "attach-failed", 31_001).await;
        let output_task = tokio::spawn(async {});
        let cleanup =
            spawn_execution_cleanup(registry.clone(), "attach-failed".into(), output_task);

        tokio::task::yield_now().await;
        assert!(registry.exists("attach-failed").await);
        exit_tx.send(Some(ExitStatus::Code(255))).unwrap();
        tokio::time::timeout(CONTROL_CALL_TIMEOUT, cleanup)
            .await
            .expect("cleanup must finish after exit")
            .unwrap();

        assert!(!registry.exists("attach-failed").await);
    }

    #[tokio::test]
    async fn cancelled_output_waiter_survives_until_teardown_reaps_process() {
        let registry = ExecutionRegistry::new();
        let exit_tx = pending_execution(&registry, "cancelled", 31_002).await;
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let output_task = tokio::spawn(async move {
            let _ = cancel_rx.await;
        });
        let cleanup = spawn_execution_cleanup(registry.clone(), "cancelled".into(), output_task);

        cancel_tx.send(()).unwrap();
        tokio::task::yield_now().await;
        assert!(registry.exists("cancelled").await);

        exit_tx
            .send(Some(ExitStatus::Signal(nix::sys::signal::Signal::SIGKILL)))
            .unwrap();
        tokio::time::timeout(CONTROL_CALL_TIMEOUT, cleanup)
            .await
            .expect("cleanup must finish after teardown exit")
            .unwrap();
        assert!(!registry.exists("cancelled").await);
    }

    #[tokio::test]
    async fn terminal_execution_is_retained_until_output_is_drained() {
        let registry = ExecutionRegistry::new();
        let exit_tx = pending_execution(&registry, "draining", 31_003).await;
        let (drained_tx, drained_rx) = oneshot::channel::<()>();
        let output_task = tokio::spawn(async move {
            let _ = drained_rx.await;
        });
        let cleanup = spawn_execution_cleanup(registry.clone(), "draining".into(), output_task);

        exit_tx.send(Some(ExitStatus::Code(0))).unwrap();
        tokio::task::yield_now().await;
        assert!(registry.exists("draining").await);

        drained_tx.send(()).unwrap();
        tokio::time::timeout(CONTROL_CALL_TIMEOUT, cleanup)
            .await
            .expect("cleanup must finish after output drains")
            .unwrap();
        assert!(!registry.exists("draining").await);
    }
}
