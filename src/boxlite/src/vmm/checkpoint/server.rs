//! Shim side of the checkpoint control socket.
//!
//! The server answers from its own threads, so it keeps working while the
//! guest is paused and while a long export runs. Every reply is built after
//! the owner returned, so the host never learns of a state change that did
//! not happen.

use super::protocol::{
    ControlFailure, ControlReply, ControlRequest, FailureKind, Operation, VmRunState, write_line,
};
use super::{
    descriptors,
    protocol::{DescriptorReply, DescriptorRequest},
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long a connected client may take to send its request line.
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Connections served at once. Only the box's own user can reach the socket;
/// the cap bounds threads if that user's client misbehaves.
const MAX_CONNECTIONS: usize = 16;

/// An owner operation that did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerError {
    pub kind: FailureKind,
    pub message: String,
}

impl OwnerError {
    pub fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// The snapshot VM owner as the control server drives it.
///
/// Each call blocks until the owner finished. `state` must not wait for a
/// mutation in progress, and `stop` must work while paused and during an
/// export.
pub trait CheckpointOwner: Send + Sync {
    fn descriptors(
        &self,
        _request: DescriptorRequest,
        _files: Vec<OwnedFd>,
    ) -> Result<(serde_json::Value, Vec<OwnedFd>), OwnerError> {
        Err(OwnerError::new(
            FailureKind::Rejected,
            "checkpoint protocol requires an explicit box restart",
        ))
    }
    fn state(&self) -> VmRunState;
    fn pause(&self, host_writers_stopped: bool) -> Result<(), OwnerError>;
    fn resume(&self) -> Result<(), OwnerError>;
    fn stop(&self) -> Result<(), OwnerError>;
}

struct Shared {
    owner: Arc<dyn CheckpointOwner>,
    /// Held for the whole of a mutation, so one mutation excludes another.
    mutation: Mutex<()>,
    /// Readable without waiting for a mutation in progress.
    mutations: Mutex<Mutations>,
    connections: AtomicUsize,
}

#[derive(Default)]
struct Mutations {
    /// The mutation holding `Shared::mutation`.
    in_flight: Option<Operation>,
    started: u64,
}

/// The bound control socket.
///
/// Binding and serving are separate steps: the shim binds before it installs
/// its seccomp filter (the filter has no `chmod`), and serves once the engine
/// produced the owner. The accept thread then lives as long as the process:
/// the shim exits when the VM ends.
#[derive(Debug)]
pub struct ControlServer {
    path: PathBuf,
    listener: UnixListener,
}

impl ControlServer {
    /// Bind the box-private control socket with owner-only permissions.
    pub fn bind(socket_path: &Path) -> BoxliteResult<Self> {
        match std::fs::remove_file(socket_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(BoxliteError::Engine(format!(
                    "failed to remove stale control socket {}: {e}",
                    socket_path.display()
                )));
            }
        }
        let listener = UnixListener::bind(socket_path).map_err(|e| {
            BoxliteError::Engine(format!(
                "failed to bind control socket {}: {e}",
                socket_path.display()
            ))
        })?;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600)).map_err(
            |e| {
                BoxliteError::Engine(format!(
                    "failed to restrict control socket {}: {e}",
                    socket_path.display()
                ))
            },
        )?;

        Ok(Self {
            path: socket_path.to_path_buf(),
            listener,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Bind imported resources after sandbox installation, before enter can
    /// create or release vCPUs. Only inspection/capability/import is accepted.
    pub fn bind_import(&self, owner: &dyn CheckpointOwner) -> BoxliteResult<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(BoxliteError::Engine(
                    "checkpoint import bindings timed out".into(),
                ));
            }
            let mut poll = libc::pollfd {
                fd: self.listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: poll references one live listener, with a bounded timeout.
            if unsafe { libc::poll(&mut poll, 1, remaining.as_millis() as i32) } <= 0 {
                return Err(BoxliteError::Engine(
                    "checkpoint import binding connection unavailable".into(),
                ));
            }
            let (stream, _) = self
                .listener
                .accept()
                .map_err(|e| BoxliteError::Engine(e.to_string()))?;
            let result = (|| -> std::io::Result<bool> {
                stream.set_read_timeout(Some(REQUEST_READ_TIMEOUT))?;
                stream.set_write_timeout(Some(REQUEST_READ_TIMEOUT))?;
                let request = descriptors::read_control(&stream)?;
                let ControlRequest::Session { operation } = request else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "checkpoint import requires protocol generation 2",
                    ));
                };
                let (request, files) =
                    descriptors::receive::<DescriptorRequest>(&stream, operation)?;
                let imported = matches!(request, DescriptorRequest::Import { .. });
                if !matches!(
                    request,
                    DescriptorRequest::Import { .. }
                        | DescriptorRequest::Capabilities
                        | DescriptorRequest::Inspect
                ) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "resources must be bound before lifecycle operations",
                    ));
                }
                let result = owner.descriptors(request, files);
                let succeeded = result.is_ok();
                let (metadata, files, error) = match result {
                    Ok((metadata, files)) => (metadata, files, None),
                    Err(error) => (
                        serde_json::Value::Null,
                        Vec::new(),
                        Some(ControlFailure {
                            kind: error.kind,
                            message: error.message,
                        }),
                    ),
                };
                descriptors::send(
                    &stream,
                    operation,
                    &DescriptorReply {
                        state: owner.state(),
                        metadata,
                        error,
                    },
                    &files,
                )?;
                if imported && !succeeded {
                    return Err(std::io::Error::other("checkpoint binding rejected"));
                }
                Ok(imported)
            })();
            match result {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => {
                    return Err(BoxliteError::Engine(format!(
                        "checkpoint import bindings: {error}"
                    )));
                }
            }
        }
    }

    /// Answer requests for `owner` on background threads.
    pub fn serve(self, owner: Arc<dyn CheckpointOwner>) -> BoxliteResult<()> {
        let shared = Arc::new(Shared {
            owner,
            mutation: Mutex::new(()),
            mutations: Mutex::default(),
            connections: AtomicUsize::new(0),
        });
        let listener = self.listener;
        std::thread::Builder::new()
            .name("checkpoint-control".into())
            .spawn(move || accept_loop(listener, shared))
            .map_err(|e| BoxliteError::Engine(format!("failed to start control thread: {e}")))?;
        Ok(())
    }
}

fn accept_loop(listener: UnixListener, shared: Arc<Shared>) {
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(e) => {
                tracing::warn!(error = %e, "Control socket accept failed");
                continue;
            }
        };
        if shared.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
            tracing::warn!("Control socket connection refused: too many connections");
            continue;
        }
        let spawned = std::thread::Builder::new()
            .name("checkpoint-request".into())
            .spawn({
                let shared = Arc::clone(&shared);
                move || {
                    serve(stream, &shared);
                    shared.connections.fetch_sub(1, Ordering::SeqCst);
                }
            });
        if let Err(e) = spawned {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
            tracing::warn!(error = %e, "Control request thread failed to start");
        }
    }
}

fn serve(stream: UnixStream, shared: &Shared) {
    if let Err(e) = stream.set_read_timeout(Some(REQUEST_READ_TIMEOUT)) {
        tracing::warn!(error = %e, "Control socket read timeout not set");
        return;
    }
    // Read no bytes past the newline: a Session switches to recvmsg framing.
    let request: ControlRequest = match descriptors::read_control(&stream) {
        Ok(request) => request,
        Err(e) => {
            tracing::warn!(error = %e, "Unreadable control request");
            let reply = failure(shared, FailureKind::Rejected, format!("bad request: {e}"));
            let _ = write_line(&mut &stream, &reply);
            return;
        }
    };
    if let ControlRequest::Session { operation } = request {
        let result = serve_descriptors(&stream, operation, shared);
        if let Err(error) = result {
            tracing::warn!(%error, "Checkpoint descriptor session ended without a reply");
        }
        return;
    }
    tracing::info!(request = ?request, "Checkpoint control request");
    let reply = handle(shared, request);
    // The owner already acted; a client that left learns the outcome from a
    // fresh state query.
    if let Err(e) = write_line(&mut &stream, &reply) {
        tracing::warn!(error = %e, state = %reply.state, "Control reply not delivered");
    }
}

fn handle(shared: &Shared, request: ControlRequest) -> ControlReply {
    match request {
        ControlRequest::Session { .. } => unreachable!("sessions use descriptor framing"),
        ControlRequest::State => reply(shared, None),
        // Not serialized with mutations: stopping is how the host ends an
        // operation it no longer trusts.
        ControlRequest::Stop => {
            let result = shared.owner.stop();
            reply(shared, result.err())
        }
        ControlRequest::RestoredShare { .. } | ControlRequest::ExportRaw { .. } => failure(
            shared,
            FailureKind::Rejected,
            "unsupported checkpoint protocol version; generation-2 descriptor binding required"
                .into(),
        ),
        ControlRequest::Pause {
            host_writers_stopped,
        } => mutate(shared, Operation::Pause, |owner| {
            owner.pause(host_writers_stopped)
        }),
        ControlRequest::Resume => mutate(shared, Operation::Resume, |owner| owner.resume()),
    }
}

fn serve_descriptors(
    stream: &UnixStream,
    operation: [u8; 16],
    shared: &Shared,
) -> std::io::Result<()> {
    let (request, files) = descriptors::receive::<DescriptorRequest>(stream, operation)?;
    let begin = matches!(request, DescriptorRequest::Begin { .. });
    let end = matches!(request, DescriptorRequest::End { .. });
    // Libkrun owns whole-capture exclusion, including clients that lost their
    // host lock. This lock also orders publication of query bookkeeping.
    let held = shared.mutation.try_lock();
    let result = if held.is_err() {
        Err(OwnerError::new(
            FailureKind::Busy,
            "another control operation is in progress",
        ))
    } else {
        if begin {
            lock(&shared.mutations).started += 1;
        }
        shared.owner.descriptors(request, files)
    };
    if result.is_ok() {
        let mut mutations = lock(&shared.mutations);
        if begin {
            mutations.in_flight = Some(Operation::Capture);
        }
        if end {
            mutations.in_flight = None;
        }
    }
    let (metadata, files, error) = match result {
        Ok((metadata, files)) => (metadata, files, None),
        Err(error) => (
            serde_json::Value::Null,
            Vec::new(),
            Some(ControlFailure {
                kind: error.kind,
                message: error.message,
            }),
        ),
    };
    descriptors::send(
        stream,
        operation,
        &DescriptorReply {
            state: shared.owner.state(),
            metadata,
            error,
        },
        &files,
    )
}

fn mutate(
    shared: &Shared,
    operation: Operation,
    run: impl FnOnce(&dyn CheckpointOwner) -> Result<(), OwnerError>,
) -> ControlReply {
    let held = match shared.mutation.try_lock() {
        Ok(held) => held,
        Err(std::sync::TryLockError::WouldBlock) => {
            let running = lock(&shared.mutations).in_flight;
            let message = match running {
                Some(running) => format!("{running} in progress"),
                None => "another operation in progress".to_string(),
            };
            return failure(shared, FailureKind::Busy, message);
        }
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };
    if lock(&shared.mutations).in_flight == Some(Operation::Capture) {
        return failure(shared, FailureKind::Busy, "capture in progress".into());
    }
    {
        let mut mutations = lock(&shared.mutations);
        mutations.in_flight = Some(operation);
        mutations.started += 1;
    }
    let result = run(shared.owner.as_ref());
    lock(&shared.mutations).in_flight = None;
    drop(held);
    reply(shared, result.err())
}

fn reply(shared: &Shared, error: Option<OwnerError>) -> ControlReply {
    // The state is read under the lock, so no mutation can start between it
    // and the in-flight operation it is reported with.
    let mutations = lock(&shared.mutations);
    ControlReply {
        state: shared.owner.state(),
        in_flight: mutations.in_flight,
        mutations: mutations.started,
        error: error.map(|e| ControlFailure {
            kind: e.kind,
            message: e.message,
        }),
        share: None,
    }
}

fn failure(shared: &Shared, kind: FailureKind, message: String) -> ControlReply {
    reply(shared, Some(OwnerError::new(kind, message)))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
