//! Shim side of the checkpoint control socket.
//!
//! The server answers from its own threads, so it keeps working while the
//! guest is paused and while a long export runs. Every reply is built after
//! the owner returned, so the host never learns of a state change that did
//! not happen.

use super::protocol::{
    ControlFailure, ControlReply, ControlRequest, FailureKind, Operation, VmRunState, read_line,
    write_line,
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::io::BufReader;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Component, Path, PathBuf};
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
    fn state(&self) -> VmRunState;
    fn pause(&self, host_writers_stopped: bool) -> Result<(), OwnerError>;
    fn resume(&self) -> Result<(), OwnerError>;
    fn export_raw(&self, path: &Path) -> Result<(), OwnerError>;
    fn stop(&self) -> Result<(), OwnerError>;
    /// The root of an imported VM's copy of share `tag`.
    fn restored_share(&self, tag: &str) -> Result<PathBuf, OwnerError>;
}

struct Shared {
    owner: Arc<dyn CheckpointOwner>,
    export_dir: PathBuf,
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
    export_dir: PathBuf,
    listener: UnixListener,
}

impl ControlServer {
    /// Bind `socket_path` with owner-only permissions. Exports will be
    /// written inside `export_dir`.
    pub fn bind(socket_path: &Path, export_dir: &Path) -> BoxliteResult<Self> {
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
            export_dir: export_dir.to_path_buf(),
            listener,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Answer requests for `owner` on background threads.
    pub fn serve(self, owner: Arc<dyn CheckpointOwner>) -> BoxliteResult<()> {
        let shared = Arc::new(Shared {
            owner,
            export_dir: self.export_dir,
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
    let mut reader = BufReader::new(&stream);
    let request: ControlRequest = match read_line(&mut reader) {
        Ok(request) => request,
        Err(e) => {
            tracing::warn!(error = %e, "Unreadable control request");
            let reply = failure(shared, FailureKind::Rejected, format!("bad request: {e}"));
            let _ = write_line(&mut &stream, &reply);
            return;
        }
    };
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
        ControlRequest::State => reply(shared, None),
        // Not serialized with mutations: stopping is how the host ends an
        // operation it no longer trusts.
        ControlRequest::Stop => {
            let result = shared.owner.stop();
            reply(shared, result.err())
        }
        ControlRequest::RestoredShare { tag } => match shared.owner.restored_share(&tag) {
            Ok(path) => ControlReply {
                share: Some(path),
                ..reply(shared, None)
            },
            Err(error) => reply(shared, Some(error)),
        },
        ControlRequest::Pause {
            host_writers_stopped,
        } => mutate(shared, Operation::Pause, |owner| {
            owner.pause(host_writers_stopped)
        }),
        ControlRequest::Resume => mutate(shared, Operation::Resume, |owner| owner.resume()),
        ControlRequest::ExportRaw { name } => {
            let path = match export_path(&shared.export_dir, &name) {
                Ok(path) => path,
                Err(e) => return reply(shared, Some(e)),
            };
            mutate(shared, Operation::ExportRaw, |owner| {
                owner.export_raw(&path)
            })
        }
    }
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

/// Resolve an export name to a file directly inside `export_dir`.
fn export_path(export_dir: &Path, name: &str) -> Result<PathBuf, OwnerError> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(file)), None) => Ok(export_dir.join(file)),
        _ => Err(OwnerError::new(
            FailureKind::Rejected,
            format!("export name {name:?} must be a single file name"),
        )),
    }
}
