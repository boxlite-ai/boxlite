//! Container-scoped OpenSSH reverse streamlocal forwarding.
//!
//! The SSH server cannot bind the requested pathname directly: it lives in the
//! guest mount namespace, while SSH sessions see the OCI container's mount
//! namespace. A small container-executed helper owns the Unix listener and
//! relays each accepted connection to a private guest-loopback ingress. The
//! parent authenticates those ingress connections before opening
//! `forwarded-streamlocal@openssh.com` channels.

use crate::service::exec::registry::ExecutionRegistry;
use crate::service::server::GuestServer;
use crate::service::ssh::limits::{
    CONTROL_CALL_TIMEOUT, FORWARD_CONNECT_TIMEOUT, MAX_FORWARD_CONNECTIONS,
    MAX_REMOTE_FORWARD_LISTENERS, PROCESS_TERMINATION_GRACE,
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::{exec_output, ExecOutput, ExecRequest, ExecStdin};
use futures::StreamExt as _;
use russh::server::{Handle as SessionHandle, Msg};
use russh::Channel;
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, warn};

pub(crate) const INTERNAL_REVERSE_STREAMLOCAL_ARG: &str = "--boxlite-internal-reverse-streamlocal";
pub(crate) const REVERSE_STREAMLOCAL_READY_MAGIC: &[u8] = b"\0boxlite-reverse-streamlocal-ready\0";
const REVERSE_STREAMLOCAL_STOPPED_MAGIC: &[u8] = b"\0boxlite-reverse-streamlocal-stopped\0";
const HELPER_RELAY_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const INGRESS_TOKEN_BYTES: usize = 36;
const HELPER_STDIN_QUEUE_DEPTH: usize = 2;

#[derive(Debug)]
pub(crate) struct InternalArgs {
    pub(crate) socket_path: String,
    pub(crate) ingress: SocketAddrV4,
}

pub(crate) fn run_internal(args: InternalArgs) -> BoxliteResult<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| BoxliteError::Internal(format!("reverse streamlocal runtime: {error}")))?;
    runtime.block_on(serve_reverse_streamlocal(
        args,
        tokio::io::stdin(),
        tokio::io::stdout(),
    ))
}

pub(crate) fn parse_internal_args(args: &[String]) -> BoxliteResult<InternalArgs> {
    let [socket_path, ingress] = args else {
        return Err(BoxliteError::Config(
            "internal reverse streamlocal workload requires socket path and ingress".into(),
        ));
    };
    let socket_path = socket_path.clone();
    if !super::streamlocal::is_valid_target(&socket_path) {
        return Err(BoxliteError::Config(
            "invalid internal reverse streamlocal socket path".into(),
        ));
    }

    let ingress = ingress
        .parse::<SocketAddr>()
        .map_err(|_| BoxliteError::Config("invalid reverse streamlocal ingress".into()))?;
    let SocketAddr::V4(ingress) = ingress else {
        return Err(BoxliteError::Config(
            "reverse streamlocal ingress must use IPv4 loopback".into(),
        ));
    };
    if *ingress.ip() != Ipv4Addr::LOCALHOST || ingress.port() == 0 {
        return Err(BoxliteError::Config(
            "reverse streamlocal ingress must use IPv4 loopback with a nonzero port".into(),
        ));
    }

    Ok(InternalArgs {
        socket_path,
        ingress,
    })
}

async fn serve_reverse_streamlocal<R, W>(
    args: InternalArgs,
    mut control: R,
    mut status: W,
) -> BoxliteResult<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // The per-listener bearer token uses stdin because execution argv/env are
    // diagnostic surfaces. Execution's stdin stream is binary and is never
    // included in process-launch logs.
    let token = read_ingress_token(&mut control).await?;

    // Deliberately do not pre-unlink. Existing filesystem entries belong to
    // the container and a forwarding request must not destroy them.
    let listener = UnixListener::bind(&args.socket_path).map_err(|error| {
        BoxliteError::Execution(format!("reverse streamlocal bind failed: {error}"))
    })?;
    let mut bound_socket = BoundSocket::capture(&args.socket_path).map_err(|error| {
        BoxliteError::Execution(format!(
            "reverse streamlocal socket identity failed: {error}"
        ))
    })?;
    std::fs::set_permissions(&args.socket_path, std::fs::Permissions::from_mode(0o600)).map_err(
        |error| {
            BoxliteError::Execution(format!(
                "reverse streamlocal socket permission update failed: {error}"
            ))
        },
    )?;

    // The parent consumes this marker before accepting the SSH global request.
    // At this point bind, identity capture, and permission hardening have all
    // succeeded inside the container mount namespace.
    status
        .write_all(REVERSE_STREAMLOCAL_READY_MAGIC)
        .await
        .map_err(|error| {
            BoxliteError::Execution(format!(
                "reverse streamlocal readiness write failed: {error}"
            ))
        })?;
    status.flush().await.map_err(|error| {
        BoxliteError::Execution(format!(
            "reverse streamlocal readiness flush failed: {error}"
        ))
    })?;

    let permits = Arc::new(Semaphore::new(MAX_FORWARD_CONNECTIONS));
    let mut relays = JoinSet::new();
    let mut stop = [0_u8; 16];
    let listener_result = loop {
        tokio::select! {
            biased;
            control_result = control.read(&mut stop) => {
                break control_result.map(|_| ());
            }
            completed = relays.join_next(), if !relays.is_empty() => {
                if let Some(Err(error)) = completed {
                    warn!(%error, "reverse streamlocal helper relay task failed");
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => break Err(error),
                };
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    debug!("reverse streamlocal helper connection limit reached");
                    continue;
                };
                let ingress = args.ingress;
                let token = token.clone();
                relays.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = relay_to_ingress(stream, ingress, token.as_bytes()).await {
                        debug!(%error, "reverse streamlocal helper relay ended");
                    }
                });
            }
        }
    };

    drop(listener);
    bound_socket.cleanup().map_err(|error| {
        BoxliteError::Execution(format!(
            "reverse streamlocal socket cleanup failed: {error}"
        ))
    })?;
    status
        .write_all(REVERSE_STREAMLOCAL_STOPPED_MAGIC)
        .await
        .map_err(|error| {
            BoxliteError::Execution(format!("reverse streamlocal stopped write failed: {error}"))
        })?;
    status.flush().await.map_err(|error| {
        BoxliteError::Execution(format!("reverse streamlocal stopped flush failed: {error}"))
    })?;

    // Established relays may drain after the listener pathname disappears, but
    // a peer cannot pin this internal execution forever.
    if tokio::time::timeout(HELPER_RELAY_DRAIN_TIMEOUT, drain_join_set(&mut relays))
        .await
        .is_err()
    {
        relays.abort_all();
        drain_join_set(&mut relays).await;
    }

    listener_result.map_err(|error| {
        BoxliteError::Execution(format!("reverse streamlocal accept failed: {error}"))
    })
}

async fn read_ingress_token<R>(control: &mut R) -> BoxliteResult<String>
where
    R: AsyncRead + Unpin,
{
    let mut token = [0_u8; INGRESS_TOKEN_BYTES];
    tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, control.read_exact(&mut token))
        .await
        .map_err(|_| BoxliteError::Execution("reverse streamlocal token read timed out".into()))?
        .map_err(|error| {
            BoxliteError::Execution(format!("reverse streamlocal token read failed: {error}"))
        })?;
    let token = std::str::from_utf8(&token)
        .map_err(|_| BoxliteError::Config("reverse streamlocal token is not UTF-8".into()))?;
    let parsed_token = uuid::Uuid::parse_str(token)
        .map_err(|_| BoxliteError::Config("invalid reverse streamlocal token".into()))?;
    if parsed_token.to_string() != token {
        return Err(BoxliteError::Config(
            "reverse streamlocal token must use canonical UUID syntax".into(),
        ));
    }
    Ok(token.to_string())
}

async fn relay_to_ingress(
    mut unix: UnixStream,
    ingress: SocketAddrV4,
    token: &[u8],
) -> std::io::Result<()> {
    let mut tcp = tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, TcpStream::connect(ingress))
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "ingress connect timed out")
        })??;
    tcp.write_all(token).await?;
    let _ = tokio::io::copy_bidirectional(&mut unix, &mut tcp).await?;
    let _ = unix.shutdown().await;
    let _ = tcp.shutdown().await;
    Ok(())
}

async fn drain_join_set<T: 'static>(tasks: &mut JoinSet<T>) {
    while let Some(completed) = tasks.join_next().await {
        if let Err(error) = completed {
            warn!(%error, "reverse streamlocal task failed");
        }
    }
}

struct BoundSocket {
    path: PathBuf,
    device: u64,
    inode: u64,
    cleaned: bool,
}

impl BoundSocket {
    fn capture(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref();
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.file_type().is_socket() {
            return Err(std::io::Error::other("bound pathname is not a Unix socket"));
        }
        Ok(Self {
            path: path.to_path_buf(),
            device: metadata.dev(),
            inode: metadata.ino(),
            cleaned: false,
        })
    }

    fn cleanup(&mut self) -> std::io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        self.cleaned = true;

        let metadata = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            std::fs::remove_file(&self.path)?;
        }
        Ok(())
    }
}

impl Drop for BoundSocket {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[derive(Clone, Default)]
struct ListenerRegistry {
    entries: Arc<Mutex<HashMap<String, ListenerEntry>>>,
}

struct ListenerEntry {
    identity: Arc<()>,
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<bool>,
}

impl ListenerRegistry {
    fn register(&self, socket_path: String, limit: usize) -> Option<ListenerRegistration> {
        let mut entries = self.lock();
        if entries.len() >= limit || entries.contains_key(&socket_path) {
            return None;
        }

        let identity = Arc::new(());
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        entries.insert(
            socket_path.clone(),
            ListenerEntry {
                identity: identity.clone(),
                cancel: cancel_tx,
                stopped: stopped_rx,
            },
        );
        Some(ListenerRegistration {
            registry: self.clone(),
            socket_path,
            identity,
            cancel: cancel_rx,
            stopped: Some(stopped_tx),
            stopped_cleanly: false,
        })
    }

    async fn cancel(&self, socket_path: &str) -> bool {
        let entry = self.lock().remove(socket_path);
        let Some(entry) = entry else {
            return false;
        };
        let _ = entry.cancel.send(());
        entry.stopped.await.unwrap_or(false)
    }

    fn cancel_all(&self) {
        let entries = self
            .lock()
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        for entry in entries {
            let _ = entry.cancel.send(());
        }
    }

    fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, ListenerEntry>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct ListenerRegistration {
    registry: ListenerRegistry,
    socket_path: String,
    identity: Arc<()>,
    cancel: oneshot::Receiver<()>,
    stopped: Option<oneshot::Sender<bool>>,
    stopped_cleanly: bool,
}

impl ListenerRegistration {
    async fn cancelled(&mut self) {
        let _ = (&mut self.cancel).await;
    }

    fn finish_cleanly(&mut self) {
        self.stopped_cleanly = true;
    }
}

impl Drop for ListenerRegistration {
    fn drop(&mut self) {
        let mut entries = self.registry.lock();
        let owns_entry = entries
            .get(&self.socket_path)
            .is_some_and(|entry| Arc::ptr_eq(&entry.identity, &self.identity));
        if owns_entry {
            entries.remove(&self.socket_path);
        }
        drop(entries);

        if let Some(stopped) = self.stopped.take() {
            let _ = stopped.send(self.stopped_cleanly);
        }
    }
}

/// Owns reverse streamlocal listeners created by one authenticated connection.
pub(crate) struct ReverseStreamlocalManager {
    listeners: ListenerRegistry,
    connection_permits: Arc<Semaphore>,
}

impl ReverseStreamlocalManager {
    pub(crate) fn new() -> Self {
        Self {
            listeners: ListenerRegistry::default(),
            connection_permits: Arc::new(Semaphore::new(MAX_FORWARD_CONNECTIONS)),
        }
    }

    pub(crate) async fn listen(
        &self,
        socket_path: &str,
        server: Arc<GuestServer>,
        session_handle: SessionHandle,
    ) -> bool {
        if !super::streamlocal::is_valid_target(socket_path)
            || self.listeners.len() >= MAX_REMOTE_FORWARD_LISTENERS
        {
            return false;
        }
        let Some(registration) = self
            .listeners
            .register(socket_path.to_string(), MAX_REMOTE_FORWARD_LISTENERS)
        else {
            return false;
        };

        let ingress = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await {
            Ok(ingress) => ingress,
            Err(error) => {
                debug!(%error, "reverse streamlocal loopback ingress bind failed");
                return false;
            }
        };
        let SocketAddr::V4(ingress_address) = ingress
            .local_addr()
            .ok()
            .unwrap_or_else(|| SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)))
        else {
            return false;
        };
        if *ingress_address.ip() != Ipv4Addr::LOCALHOST || ingress_address.port() == 0 {
            return false;
        }

        let token = uuid::Uuid::new_v4().to_string();
        let helper =
            match RunningHelper::start(server, socket_path, ingress_address, token.clone()).await {
                Ok(helper) => helper,
                Err(error) => {
                    debug!(%error, socket_path, "reverse streamlocal helper start failed");
                    return false;
                }
            };

        spawn_listener(
            ingress,
            socket_path.to_string(),
            token,
            session_handle,
            self.connection_permits.clone(),
            helper,
            registration,
        );
        true
    }

    pub(crate) async fn cancel(&self, socket_path: &str) -> bool {
        if !super::streamlocal::is_valid_target(socket_path) {
            return false;
        }
        self.listeners.cancel(socket_path).await
    }
}

impl Drop for ReverseStreamlocalManager {
    fn drop(&mut self) {
        self.listeners.cancel_all();
    }
}

struct RunningHelper {
    server: Arc<GuestServer>,
    registry: ExecutionRegistry,
    execution_id: String,
    stdin: mpsc::Sender<ExecStdin>,
    stdin_task: JoinHandle<()>,
    output: mpsc::Receiver<ExecOutput>,
    buffered_stdout: Vec<u8>,
}

impl RunningHelper {
    async fn start(
        server: Arc<GuestServer>,
        socket_path: &str,
        ingress: SocketAddrV4,
        token: String,
    ) -> Result<Self, String> {
        let (container_id, profile) = super::bridge::resolve_single_container_profile(&server)
            .await
            .map_err(|error| error.to_string())?;
        let launch = helper_execution_launch(&container_id, &profile, socket_path, ingress);
        let response = tokio::time::timeout(
            CONTROL_CALL_TIMEOUT,
            crate::service::exec::start_ssh_execution(&server, launch.request, launch.workload),
        )
        .await
        .map_err(|_| "reverse streamlocal exec RPC timed out".to_string())?;
        if let Some(error) = response.error {
            return Err(format!("{}: {}", error.reason, error.detail));
        }
        let execution_id = response.execution_id;
        let registry = server.registry.clone();

        let (stdin_tx, stdin_rx) = mpsc::channel::<ExecStdin>(HELPER_STDIN_QUEUE_DEPTH);
        let opening = ExecStdin {
            execution_id: execution_id.clone(),
            data: Vec::new(),
            close: false,
        };
        let input = match server
            .send_execution_input(opening, Box::pin(ReceiverStream::new(stdin_rx).map(Ok)))
            .await
        {
            Ok(task) => task,
            // Matches every sibling failure below: the execution is registered
            // and running, so it must be torn down rather than leaked.
            Err(error) => {
                spawn_failed_helper_cleanup(server.clone(), registry, execution_id, None, None);
                return Err(format!("reverse streamlocal stdin setup failed: {error}"));
            }
        };
        let stdin_task = tokio::spawn(async move {
            if let Ok(Err(error)) = input.await {
                debug!(%error, "reverse streamlocal helper stdin ended");
            }
        });
        if stdin_tx
            .send(ExecStdin {
                execution_id: execution_id.clone(),
                data: token.into_bytes(),
                close: false,
            })
            .await
            .is_err()
        {
            spawn_failed_helper_cleanup(
                server.clone(),
                registry,
                execution_id,
                None,
                Some(stdin_task),
            );
            return Err("reverse streamlocal stdin setup failed".into());
        }

        let attach =
            tokio::time::timeout(CONTROL_CALL_TIMEOUT, server.attach_execution(&execution_id))
                .await;
        let mut output = match attach {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                let _ = stdin_tx
                    .send(ExecStdin {
                        execution_id: execution_id.clone(),
                        data: Vec::new(),
                        close: true,
                    })
                    .await;
                drop(stdin_tx);
                spawn_failed_helper_cleanup(
                    server.clone(),
                    registry,
                    execution_id,
                    None,
                    Some(stdin_task),
                );
                return Err(format!("reverse streamlocal attach failed: {error}"));
            }
            Err(_) => {
                let _ = stdin_tx
                    .send(ExecStdin {
                        execution_id: execution_id.clone(),
                        data: Vec::new(),
                        close: true,
                    })
                    .await;
                drop(stdin_tx);
                spawn_failed_helper_cleanup(
                    server.clone(),
                    registry,
                    execution_id,
                    None,
                    Some(stdin_task),
                );
                return Err("reverse streamlocal attach timed out".into());
            }
        };

        let buffered_stdout = match read_marker(
            &mut output,
            REVERSE_STREAMLOCAL_READY_MAGIC,
            Vec::new(),
            REVERSE_STREAMLOCAL_STOPPED_MAGIC.len(),
        )
        .await
        {
            Ok(buffered) => buffered,
            Err(error) => {
                let _ = stdin_tx
                    .send(ExecStdin {
                        execution_id: execution_id.clone(),
                        data: Vec::new(),
                        close: true,
                    })
                    .await;
                drop(stdin_tx);
                spawn_failed_helper_cleanup(
                    server.clone(),
                    registry,
                    execution_id,
                    Some(output),
                    Some(stdin_task),
                );
                return Err(error);
            }
        };

        Ok(Self {
            server,
            registry,
            execution_id,
            stdin: stdin_tx,
            stdin_task,
            output,
            buffered_stdout,
        })
    }

    async fn request_stop(&mut self) -> bool {
        self.stdin
            .send(ExecStdin {
                execution_id: self.execution_id.clone(),
                data: Vec::new(),
                close: true,
            })
            .await
            .is_ok()
    }

    async fn wait_stopped(&mut self) -> bool {
        let buffered = std::mem::take(&mut self.buffered_stdout);
        match read_marker(
            &mut self.output,
            REVERSE_STREAMLOCAL_STOPPED_MAGIC,
            buffered,
            0,
        )
        .await
        {
            Ok(_) => true,
            Err(error) => {
                debug!(%error, "reverse streamlocal helper stop acknowledgement failed");
                false
            }
        }
    }

    fn spawn_cleanup(self, force_termination: bool) {
        spawn_execution_cleanup(
            self.server,
            self.registry,
            self.execution_id,
            Some(self.output),
            Some(self.stdin_task),
            force_termination,
        );
    }
}

struct HelperExecutionLaunch {
    request: ExecRequest,
    workload: super::SshWorkload,
}

fn helper_execution_launch(
    container_id: &str,
    profile: &crate::container::user_profile::RootSessionProfile,
    socket_path: &str,
    ingress: SocketAddrV4,
) -> HelperExecutionLaunch {
    let workload = super::SshWorkload::ReverseStreamlocal {
        socket_path: socket_path.into(),
        ingress,
    };
    let (program, args) = workload.placeholder();
    HelperExecutionLaunch {
        request: ExecRequest {
            execution_id: None,
            program,
            args,
            env: super::bridge::session_exec_env(HashMap::new(), container_id, profile),
            workdir: profile.home_dir.clone(),
            timeout_ms: 0,
            tty: None,
            user: Some("0:0".to_string()),
        },
        workload,
    }
}

fn spawn_listener(
    ingress: TcpListener,
    socket_path: String,
    token: String,
    session_handle: SessionHandle,
    permits: Arc<Semaphore>,
    mut helper: RunningHelper,
    mut registration: ListenerRegistration,
) {
    tokio::spawn(async move {
        enum End {
            Cancelled,
            HelperEnded,
            IngressFailed,
        }

        let mut pending_opens = JoinSet::new();
        let end = loop {
            tokio::select! {
                biased;
                _ = registration.cancelled() => break End::Cancelled,
                completed = pending_opens.join_next(), if !pending_opens.is_empty() => {
                    if let Some(Err(error)) = completed {
                        warn!(%error, "reverse streamlocal channel task failed");
                    }
                }
                output = helper.output.recv() => {
                    match output {
                        Some(ExecOutput { event: Some(exec_output::Event::Stderr(stderr)) }) => {
                            debug!(bytes = stderr.data.len(), "reverse streamlocal helper stderr");
                        }
                        Some(ExecOutput { event: Some(exec_output::Event::Stdout(stdout)) }) => {
                            if !append_stopped_marker_prefix(
                                &mut helper.buffered_stdout,
                                &stdout.data,
                            ) {
                                warn!("reverse streamlocal helper emitted invalid control output");
                                break End::HelperEnded;
                            }
                        }
                        Some(ExecOutput { event: None }) => {}
                        None => break End::HelperEnded,
                    }
                }
                accepted = ingress.accept() => {
                    let (stream, peer) = match accepted {
                        Ok(accepted) => accepted,
                        Err(error) => {
                            warn!(%error, "reverse streamlocal loopback ingress failed");
                            break End::IngressFailed;
                        }
                    };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let Ok(permit) = permits.clone().try_acquire_owned() else {
                        debug!("reverse streamlocal forwarding connection limit reached");
                        continue;
                    };
                    let handle = session_handle.clone();
                    let path = socket_path.clone();
                    let expected_token = token.clone();
                    pending_opens.spawn(async move {
                        let stream = match authenticate_ingress(stream, expected_token.as_bytes()).await {
                            Ok(stream) => stream,
                            Err(error) => {
                                debug!(%error, "reverse streamlocal ingress authentication failed");
                                return;
                            }
                        };
                        let channel = tokio::time::timeout(
                            FORWARD_CONNECT_TIMEOUT,
                            handle.channel_open_forwarded_streamlocal(path),
                        )
                        .await;
                        match channel {
                            Ok(Ok(channel)) => spawn_relay(channel, stream, permit),
                            Ok(Err(error)) => {
                                debug!(%error, "SSH client rejected reverse streamlocal channel")
                            }
                            Err(_) => debug!("reverse streamlocal channel request timed out"),
                        }
                    });
                }
            }
        };

        // Closing the ingress first prevents a post-cancel helper connection
        // from starting another SSH channel. Already-open relays own their TCP
        // streams independently and may continue draining.
        drop(ingress);
        let was_cancelled = matches!(end, End::Cancelled);
        let stop_acknowledged = if matches!(end, End::HelperEnded) {
            false
        } else {
            let requested = helper.request_stop().await;
            requested
                && tokio::time::timeout(CONTROL_CALL_TIMEOUT, helper.wait_stopped())
                    .await
                    .unwrap_or(false)
        };

        finish_pending_opens(&mut pending_opens).await;
        if was_cancelled && stop_acknowledged {
            registration.finish_cleanly();
        }
        drop(registration);
        helper.spawn_cleanup(!stop_acknowledged && !matches!(end, End::HelperEnded));
    });
}

async fn authenticate_ingress(
    mut stream: TcpStream,
    expected_token: &[u8],
) -> std::io::Result<TcpStream> {
    if expected_token.len() != INGRESS_TOKEN_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid expected ingress token length",
        ));
    }
    let mut received = [0_u8; INGRESS_TOKEN_BYTES];
    tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, stream.read_exact(&mut received))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "token read timed out"))??;
    if received != expected_token {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "ingress token mismatch",
        ));
    }
    Ok(stream)
}

fn spawn_relay(
    channel: Channel<Msg>,
    mut stream: TcpStream,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    tokio::spawn(async move {
        let mut channel = channel.into_stream();
        if let Err(error) = tokio::io::copy_bidirectional(&mut channel, &mut stream).await {
            debug!(%error, "SSH reverse streamlocal relay ended with an error");
        }
        let _ = channel.shutdown().await;
        let _ = stream.shutdown().await;
    });
}

async fn finish_pending_opens(pending_opens: &mut JoinSet<()>) {
    while let Some(completed) = pending_opens.join_next().await {
        if let Err(error) = completed {
            warn!(%error, "reverse streamlocal channel task failed");
        }
    }
}

#[derive(Default)]
struct MarkerParser {
    matched: usize,
}

impl MarkerParser {
    fn push(
        &mut self,
        marker: &[u8],
        chunk: &[u8],
        max_trailing_bytes: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        let needed = marker.len().saturating_sub(self.matched);
        let prefix_len = needed.min(chunk.len());
        if chunk[..prefix_len] != marker[self.matched..self.matched + prefix_len] {
            return Err("reverse streamlocal helper returned an invalid control marker".into());
        }
        self.matched += prefix_len;
        if self.matched == marker.len() {
            if chunk.len() - prefix_len > max_trailing_bytes {
                return Err("reverse streamlocal helper returned excess control output".into());
            }
            return Ok(Some(chunk[prefix_len..].to_vec()));
        }
        Ok(None)
    }
}

async fn read_marker(
    output: &mut mpsc::Receiver<ExecOutput>,
    marker: &[u8],
    initial_stdout: Vec<u8>,
    max_trailing_bytes: usize,
) -> Result<Vec<u8>, String> {
    tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, async {
        let mut parser = MarkerParser::default();
        if !initial_stdout.is_empty() {
            if let Some(buffered) = parser.push(marker, &initial_stdout, max_trailing_bytes)? {
                return Ok(buffered);
            }
        }
        loop {
            let message = output.recv().await.ok_or_else(|| {
                "reverse streamlocal helper exited before control marker".to_string()
            })?;
            match message.event {
                Some(exec_output::Event::Stdout(stdout)) => {
                    if let Some(buffered) = parser.push(marker, &stdout.data, max_trailing_bytes)? {
                        return Ok(buffered);
                    }
                }
                Some(exec_output::Event::Stderr(stderr)) => {
                    debug!(
                        bytes = stderr.data.len(),
                        "reverse streamlocal helper stderr before marker"
                    );
                }
                None => {}
            }
        }
    })
    .await
    .map_err(|_| "reverse streamlocal helper control marker timed out".to_string())?
}

fn append_stopped_marker_prefix(buffer: &mut Vec<u8>, chunk: &[u8]) -> bool {
    let Some(end) = buffer.len().checked_add(chunk.len()) else {
        return false;
    };
    if end > REVERSE_STREAMLOCAL_STOPPED_MAGIC.len()
        || chunk != &REVERSE_STREAMLOCAL_STOPPED_MAGIC[buffer.len()..end]
    {
        return false;
    }
    buffer.extend_from_slice(chunk);
    true
}

fn spawn_failed_helper_cleanup(
    server: Arc<GuestServer>,
    registry: ExecutionRegistry,
    execution_id: String,
    output: Option<mpsc::Receiver<ExecOutput>>,
    stdin_task: Option<JoinHandle<()>>,
) {
    spawn_execution_cleanup(server, registry, execution_id, output, stdin_task, true);
}

fn spawn_execution_cleanup(
    server: Arc<GuestServer>,
    registry: ExecutionRegistry,
    execution_id: String,
    output: Option<mpsc::Receiver<ExecOutput>>,
    stdin_task: Option<JoinHandle<()>>,
    force_termination: bool,
) {
    tokio::spawn(async move {
        let output_task = output.map(|mut output| {
            tokio::spawn(async move {
                while let Some(message) = output.recv().await {
                    if let Some(exec_output::Event::Stderr(stderr)) = message.event {
                        debug!(
                            bytes = stderr.data.len(),
                            "reverse streamlocal helper stderr"
                        );
                    }
                }
            })
        });

        let state = registry.get(&execution_id).await;
        if force_termination {
            // A failed start may still have a working stdin control stream.
            // Give that graceful stop a chance to unlink the socket before
            // escalating to signals that cannot run the helper's destructor.
            let exited_gracefully = if let Some(state) = &state {
                tokio::time::timeout(PROCESS_TERMINATION_GRACE, state.wait_process())
                    .await
                    .is_ok()
            } else {
                true
            };
            if !exited_gracefully {
                let _ = tokio::time::timeout(
                    CONTROL_CALL_TIMEOUT,
                    server.kill_execution(
                        &execution_id,
                        15,
                        super::bridge::SIGNAL_TARGETS_PROCESS_GROUP,
                    ),
                )
                .await;
                if let Some(state) = &state {
                    if tokio::time::timeout(PROCESS_TERMINATION_GRACE, state.wait_process())
                        .await
                        .is_err()
                    {
                        let _ = tokio::time::timeout(
                            CONTROL_CALL_TIMEOUT,
                            server.kill_execution(
                                &execution_id,
                                9,
                                super::bridge::SIGNAL_TARGETS_PROCESS_GROUP,
                            ),
                        )
                        .await;
                    }
                } else {
                    let _ = tokio::time::timeout(
                        CONTROL_CALL_TIMEOUT,
                        server.kill_execution(
                            &execution_id,
                            9,
                            super::bridge::SIGNAL_TARGETS_PROCESS_GROUP,
                        ),
                    )
                    .await;
                }
            }
        }
        if let Some(state) = state {
            state.wait_process().await;
        }
        if let Some(task) = output_task {
            let _ = task.await;
        }
        if let Some(task) = stdin_task {
            let _ = task.await;
        }
        if !registry.release_ephemeral(&execution_id).await {
            debug!(%execution_id, "reverse streamlocal helper was already released");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "9e3d4f4f-e9e5-4896-a42c-9fe5f53244af";

    struct RunningInternal {
        control: tokio::io::DuplexStream,
        status: tokio::io::DuplexStream,
        task: JoinHandle<BoxliteResult<()>>,
    }

    async fn start_internal(socket_path: &Path, ingress: SocketAddrV4) -> RunningInternal {
        let (mut control, workload_control) = tokio::io::duplex(64);
        let (workload_status, mut status) = tokio::io::duplex(128);
        let args = InternalArgs {
            socket_path: socket_path.to_string_lossy().into_owned(),
            ingress,
        };
        let task = tokio::spawn(serve_reverse_streamlocal(
            args,
            workload_control,
            workload_status,
        ));
        control.write_all(TOKEN.as_bytes()).await.unwrap();

        let mut ready = vec![0; REVERSE_STREAMLOCAL_READY_MAGIC.len()];
        tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, status.read_exact(&mut ready))
            .await
            .expect("reverse streamlocal readiness timed out")
            .expect("read reverse streamlocal readiness");
        assert_eq!(ready, REVERSE_STREAMLOCAL_READY_MAGIC);

        RunningInternal {
            control,
            status,
            task,
        }
    }

    async fn stop_internal(mut running: RunningInternal) {
        running.control.write_all(b"stop").await.unwrap();
        let mut stopped = vec![0; REVERSE_STREAMLOCAL_STOPPED_MAGIC.len()];
        tokio::time::timeout(
            FORWARD_CONNECT_TIMEOUT,
            running.status.read_exact(&mut stopped),
        )
        .await
        .expect("reverse streamlocal stop timed out")
        .expect("read reverse streamlocal stopped marker");
        assert_eq!(stopped, REVERSE_STREAMLOCAL_STOPPED_MAGIC);
        tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, running.task)
            .await
            .expect("reverse streamlocal workload did not exit")
            .expect("join reverse streamlocal workload")
            .expect("reverse streamlocal workload failed");
    }

    async fn assert_internal_round_trip(socket_path: &Path, ingress: &TcpListener, request: &[u8]) {
        let mut unix = UnixStream::connect(socket_path).await.unwrap();
        let (mut tcp, peer) = tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, ingress.accept())
            .await
            .expect("reverse streamlocal ingress accept timed out")
            .unwrap();
        assert!(peer.ip().is_loopback());

        let mut token = [0; INGRESS_TOKEN_BYTES];
        tcp.read_exact(&mut token).await.unwrap();
        assert_eq!(&token, TOKEN.as_bytes());

        unix.write_all(request).await.unwrap();
        let mut received = vec![0; request.len()];
        tcp.read_exact(&mut received).await.unwrap();
        assert_eq!(received, request);

        tcp.write_all(b"response").await.unwrap();
        let mut response = [0; 8];
        unix.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"response");
    }

    #[test]
    fn helper_arguments_require_a_safe_path_and_loopback_ingress() {
        let parsed =
            parse_internal_args(&["/run/service.sock".into(), "127.0.0.1:32000".into()]).unwrap();
        assert_eq!(parsed.socket_path, "/run/service.sock");
        assert_eq!(parsed.ingress.port(), 32_000);

        assert!(parse_internal_args(&["relative.sock".into(), "127.0.0.1:32000".into(),]).is_err());
        assert!(
            parse_internal_args(&["/run/service.sock".into(), "192.0.2.1:32000".into(),]).is_err()
        );
    }

    #[tokio::test]
    async fn ingress_token_is_read_only_from_the_binary_control_stream() {
        let (mut writer, mut reader) = tokio::io::duplex(64);
        writer.write_all(TOKEN.as_bytes()).await.unwrap();
        assert_eq!(read_ingress_token(&mut reader).await.unwrap(), TOKEN);

        let (mut writer, mut reader) = tokio::io::duplex(64);
        writer
            .write_all(b"00000000-0000-0000-0000-00000000000Z")
            .await
            .unwrap();
        assert!(read_ingress_token(&mut reader).await.is_err());
    }

    #[test]
    fn helper_launch_keeps_the_token_out_of_logged_argv_and_env() {
        let profile = crate::container::user_profile::RootSessionProfile {
            home_dir: "/root".into(),
            login_shell: "/bin/ash".into(),
        };
        let launch = helper_execution_launch(
            "container-1",
            &profile,
            "/run/service.sock",
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, 32_000),
        );
        let request = launch.request;

        assert_eq!(
            request.program,
            crate::service::ssh::workload::INTERNAL_PROGRAM
        );
        assert_eq!(
            request.args,
            [
                INTERNAL_REVERSE_STREAMLOCAL_ARG,
                "/run/service.sock",
                "127.0.0.1:32000",
            ]
        );
        assert!(request.args.iter().all(|value| !value.contains(TOKEN)));
        assert!(request.env.values().all(|value| !value.contains(TOKEN)));
        assert_eq!(request.env.get("HOME").map(String::as_str), Some("/root"));
        assert_eq!(
            request.env.get("SHELL").map(String::as_str),
            Some("/bin/ash")
        );
        assert_eq!(request.env.get("USER").map(String::as_str), Some("root"));
        assert_eq!(request.user.as_deref(), Some("0:0"));
        assert_eq!(request.workdir, "/root");
        assert!(matches!(
            launch.workload,
            crate::service::ssh::SshWorkload::ReverseStreamlocal { .. }
        ));
    }

    #[test]
    fn ready_and_stopped_markers_support_fragmented_and_coalesced_input() {
        for marker in [
            REVERSE_STREAMLOCAL_READY_MAGIC,
            REVERSE_STREAMLOCAL_STOPPED_MAGIC,
        ] {
            let split = marker.len() / 2;
            let mut parser = MarkerParser::default();
            assert_eq!(parser.push(marker, &marker[..split], 16).unwrap(), None);
            assert_eq!(
                parser
                    .push(marker, &[&marker[split..], b"after"].concat(), 16)
                    .unwrap(),
                Some(b"after".to_vec())
            );

            let mut parser = MarkerParser::default();
            assert_eq!(
                parser
                    .push(marker, &[marker, b"payload"].concat(), 16)
                    .unwrap(),
                Some(b"payload".to_vec())
            );
        }
    }

    #[test]
    fn helper_control_output_is_prefix_checked_and_bounded() {
        let mut buffered = Vec::new();
        let split = REVERSE_STREAMLOCAL_STOPPED_MAGIC.len() / 2;
        assert!(append_stopped_marker_prefix(
            &mut buffered,
            &REVERSE_STREAMLOCAL_STOPPED_MAGIC[..split]
        ));
        assert!(append_stopped_marker_prefix(
            &mut buffered,
            &REVERSE_STREAMLOCAL_STOPPED_MAGIC[split..]
        ));
        assert!(!append_stopped_marker_prefix(&mut buffered, b"extra"));

        let mut parser = MarkerParser::default();
        assert!(parser
            .push(
                REVERSE_STREAMLOCAL_READY_MAGIC,
                &[REVERSE_STREAMLOCAL_READY_MAGIC, b"too-long"].concat(),
                1,
            )
            .is_err());
    }

    #[test]
    fn duplicate_and_listener_limit_registrations_are_rejected() {
        let registry = ListenerRegistry::default();
        let first = registry.register("/run/one.sock".into(), 2).unwrap();
        assert!(registry.register("/run/one.sock".into(), 2).is_none());
        let second = registry.register("/run/two.sock".into(), 2).unwrap();
        assert!(registry.register("/run/three.sock".into(), 2).is_none());
        drop(first);
        assert!(registry.register("/run/three.sock".into(), 2).is_some());
        drop(second);
    }

    #[tokio::test]
    async fn cancel_waits_for_pending_channel_opens() {
        let registry = ListenerRegistry::default();
        let mut registration = registry.register("/run/one.sock".into(), 1).unwrap();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let mut pending = JoinSet::new();
        pending.spawn(async move {
            let _ = finish_rx.await;
        });

        let registry_for_cancel = registry.clone();
        let cancel = tokio::spawn(async move { registry_for_cancel.cancel("/run/one.sock").await });
        registration.cancelled().await;
        registration.finish_cleanly();
        let finish = tokio::spawn(async move {
            finish_pending_opens(&mut pending).await;
            drop(registration);
        });
        tokio::task::yield_now().await;
        assert!(!cancel.is_finished());

        finish_tx.send(()).unwrap();
        finish.await.unwrap();
        assert!(cancel.await.unwrap());
    }

    #[tokio::test]
    async fn wrong_ingress_token_is_rejected_without_consuming_payload() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut client = TcpStream::connect(address).await.unwrap();
            client
                .write_all(b"00000000-0000-0000-0000-000000000000payload")
                .await
                .unwrap();
        });
        let (server, _) = listener.accept().await.unwrap();
        let error = authenticate_ingress(server, TOKEN.as_bytes())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        client.await.unwrap();
    }

    #[tokio::test]
    async fn internal_listener_relays_multiple_connections_and_cleans_up() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("forward.sock");
        let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let ingress_address = match ingress.local_addr().unwrap() {
            SocketAddr::V4(address) => address,
            SocketAddr::V6(_) => unreachable!("IPv4 bind returned IPv6 address"),
        };
        let running = start_internal(&socket_path, ingress_address).await;

        assert_internal_round_trip(&socket_path, &ingress, b"first").await;
        assert_internal_round_trip(&socket_path, &ingress, b"second").await;
        stop_internal(running).await;
        assert!(!socket_path.exists());
    }

    #[tokio::test]
    async fn internal_listener_preserves_an_existing_path() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("occupied.sock");
        let existing = UnixListener::bind(&socket_path).unwrap();
        let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let ingress_address = match ingress.local_addr().unwrap() {
            SocketAddr::V4(address) => address,
            SocketAddr::V6(_) => unreachable!("IPv4 bind returned IPv6 address"),
        };
        let (mut control, workload_control) = tokio::io::duplex(64);
        let (workload_status, _status) = tokio::io::duplex(64);
        let task = tokio::spawn(serve_reverse_streamlocal(
            InternalArgs {
                socket_path: socket_path.to_string_lossy().into_owned(),
                ingress: ingress_address,
            },
            workload_control,
            workload_status,
        ));
        control.write_all(TOKEN.as_bytes()).await.unwrap();

        let result = tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, task)
            .await
            .expect("colliding reverse streamlocal workload did not exit")
            .unwrap();
        assert!(result.is_err());
        assert!(socket_path.exists());

        let connect = UnixStream::connect(&socket_path).await.unwrap();
        let (_accepted, _) = existing.accept().await.unwrap();
        drop(connect);
    }

    #[tokio::test]
    async fn internal_listener_does_not_unlink_a_replacement_socket() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("forward.sock");
        let displaced_path = directory.path().join("displaced.sock");
        let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let ingress_address = match ingress.local_addr().unwrap() {
            SocketAddr::V4(address) => address,
            SocketAddr::V6(_) => unreachable!("IPv4 bind returned IPv6 address"),
        };
        let running = start_internal(&socket_path, ingress_address).await;

        std::fs::rename(&socket_path, &displaced_path).unwrap();
        let replacement = UnixListener::bind(&socket_path).unwrap();
        stop_internal(running).await;

        assert!(socket_path.exists());
        let connect = UnixStream::connect(&socket_path).await.unwrap();
        let (_accepted, _) = replacement.accept().await.unwrap();
        drop(connect);
    }
}
