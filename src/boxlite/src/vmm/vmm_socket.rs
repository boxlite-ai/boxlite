//! The host's control channel to a running shim.
//!
//! The shim serves one Unix socket, `vmm.sock` in the box's socket
//! directory, for runtime operations on the VMM it hosts. The socket is
//! host-only (mode 0600, never bridged into guest vsock) and at a fixed path,
//! so a runtime that restarts can still reach a running box with a matching
//! shim. Each connection carries one HTTP/1.1 JSON request and response.
//! Directory registration attaches one open directory via `SCM_RIGHTS`.

use std::io;
use std::path::Path;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{CONNECTION, CONTENT_TYPE, HOST};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;

#[cfg(any(test, feature = "native"))]
use {
    http_body_util::LengthLimitError,
    hyper::{
        Method, Response,
        body::Incoming,
        header::{ALLOW, HeaderValue},
    },
    hyper_util::rt::TokioTimer,
    std::{
        cell::RefCell,
        convert::Infallible,
        fs::File,
        os::unix::net::{UnixListener, UnixStream},
    },
    tokio::{
        runtime::Runtime,
        time::{Instant, timeout_at},
    },
};

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
use super::controller::mount_control::{ControlMount, MountState};
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
mod transport;

#[cfg(all(
    any(test, feature = "native"),
    target_os = "linux",
    target_arch = "x86_64"
))]
const MEMORY_PATH: &str = "/v1/memory";
const RESIZE_PATH: &str = "/v1/resize-disk";
const MAX_BODY: usize = 4096;
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
const MOUNT_PATH: &str = "/v1/mount-control";
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub(super) const MAX_MOUNT_BODY: usize = 64 * 1024;
const HTTP_BUFFER: usize = 8192;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CLIENT_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(test, feature = "native"))]
const READ_TIMEOUT: Duration = Duration::from_secs(2);
// Allow the request read, ten-second device reply wait, and reply write.
#[cfg(any(test, feature = "native"))]
const SERVER_TIMEOUT: Duration = Duration::from_secs(14);
#[cfg(any(test, feature = "native"))]
const ACCEPT_RETRY_INITIAL: Duration = Duration::from_millis(5);
#[cfg(any(test, feature = "native"))]
const ACCEPT_RETRY_MAX: Duration = Duration::from_millis(50);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResizeDiskRequest {
    block_id: String,
    bytes: u64,
}

#[cfg(all(
    any(test, feature = "native"),
    target_os = "linux",
    target_arch = "x86_64"
))]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryRequest {
    target_mib: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MemoryObservation {
    pub requested_mib: u32,
    pub plugged_mib: u32,
    pub mapped_mib: u32,
    pub retained_empty_mib: u32,
}

/// The operations a shim may serve.
#[cfg(any(test, feature = "native"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum ControlOp {
    /// Grows the disk with the configured `block_id` to `bytes`.
    ResizeDisk { block_id: String, bytes: u64 },
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    Memory { target_mib: Option<u32> },
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    RegisterMount {
        source: String,
        target: String,
        read_only: bool,
    },
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    ListMounts,
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    SetMountState { export: String, state: MountState },
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    RemoveMount { export: String },
}

/// The shim's answer.
pub(crate) type ControlResponse = Result<ControlReply, ControlError>;

/// What a successful operation reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ControlReply {
    /// The disk's size in bytes after the operation.
    DiskSize(u64),
    MemoryTargetPublished,
    Memory(MemoryObservation),
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    MountRegistered(ControlMount),
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    Mounts(Vec<ControlMount>),
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    MountUpdated,
}

/// Why an operation failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ControlError {
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("invalid request: {0}")]
    InvalidInput(String),
    #[error("{0}")]
    Failed(String),
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    #[error("mount control errno {0}")]
    Mount(i32),
}

/// Binds `path` (replacing a stale socket), makes it owner-only, and serves
/// each connection on a `vmm-control` thread with `handle`.
#[cfg(any(test, feature = "native"))]
pub(crate) fn serve(
    path: &Path,
    handle: impl FnMut(ControlOp, Option<File>) -> ControlResponse + Send + 'static,
) -> io::Result<()> {
    if std::fs::symlink_metadata(path).is_ok() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    restrict_to_owner(path)?;
    // SAFETY: `geteuid` has no preconditions.
    let owner = unsafe { libc::geteuid() };
    let (ready, started) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("vmm-control".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .enable_time()
                .build();
            match runtime {
                Ok(runtime) => {
                    let _ = ready.send(Ok(()));
                    serve_connections(
                        &runtime,
                        listener.incoming(),
                        owner,
                        handle,
                        std::thread::sleep,
                    );
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
            }
        })?;
    started.recv().map_err(io::Error::other)?
}

#[cfg(any(test, feature = "native"))]
fn serve_connections(
    runtime: &Runtime,
    incoming: impl Iterator<Item = io::Result<UnixStream>>,
    owner: libc::uid_t,
    mut handle: impl FnMut(ControlOp, Option<File>) -> ControlResponse,
    mut sleep: impl FnMut(Duration),
) {
    use io::ErrorKind::{ConnectionAborted, Interrupted};

    let mut retry_delay = ACCEPT_RETRY_INITIAL;
    for connection in incoming {
        let stream = match connection {
            Ok(stream) => {
                retry_delay = ACCEPT_RETRY_INITIAL;
                stream
            }
            Err(error) if matches!(error.kind(), Interrupted | ConnectionAborted) => continue,
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EBADF | libc::ENOTSOCK | libc::EINVAL)
                ) =>
            {
                tracing::error!(%error, "VMM control listener stopped");
                break;
            }
            Err(error) => {
                if retry_delay == ACCEPT_RETRY_INITIAL {
                    tracing::warn!(%error, "VMM control accept failed, retrying");
                }
                sleep(retry_delay);
                retry_delay = (retry_delay * 2).min(ACCEPT_RETRY_MAX);
                continue;
            }
        };
        if let Err(error) = answer(runtime, stream, owner, &mut handle) {
            tracing::debug!(%error, "control connection ended");
        }
    }
}

#[cfg(any(test, feature = "native"))]
fn answer(
    runtime: &Runtime,
    stream: UnixStream,
    owner: libc::uid_t,
    handle: &mut impl FnMut(ControlOp, Option<File>) -> ControlResponse,
) -> io::Result<()> {
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    let same_user = transport::same_user(&stream, owner)
        .map_err(|error| error.raw_os_error().unwrap_or(libc::EIO));
    #[cfg(not(all(feature = "native", target_os = "linux", target_arch = "x86_64")))]
    let _ = owner;

    runtime.block_on(async {
        stream.set_nonblocking(true)?;
        let stream = tokio::net::UnixStream::from_std(stream)?;
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        let (stream, received) = transport::AncillaryIo::new(stream, None);

        // One request per connection. The listener owns the mutable handler
        // and lends it to Hyper only for synchronous dispatch.
        let handle = RefCell::new(handle);
        let read_deadline = Instant::now() + READ_TIMEOUT;
        let connection = hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .half_close(true)
            .max_buf_size(HTTP_BUFFER)
            .timer(TokioTimer::new())
            .header_read_timeout(READ_TIMEOUT)
            .serve_connection(
                TokioIo::new(stream),
                hyper::service::service_fn(|request| async {
                    let reply = handle_http(request, read_deadline, |op| {
                        #[cfg(all(
                            feature = "native",
                            target_os = "linux",
                            target_arch = "x86_64"
                        ))]
                        let file = {
                            let file = received.take();
                            check_request(&op, file.is_some(), same_user)?;
                            file
                        };
                        #[cfg(not(all(
                            feature = "native",
                            target_os = "linux",
                            target_arch = "x86_64"
                        )))]
                        let file = None;
                        handle.borrow_mut()(op, file)
                    })
                    .await;
                    Ok::<_, Infallible>(reply)
                }),
            );
        timeout(SERVER_TIMEOUT, connection)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "control connection timed out"))?
            .map_err(io::Error::other)
    })
}

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
fn check_request(
    op: &ControlOp,
    has_fd: bool,
    same_user: Result<bool, i32>,
) -> Result<(), ControlError> {
    let register = matches!(op, ControlOp::RegisterMount { .. });
    if has_fd != register {
        return Err(ControlError::Mount(libc::EINVAL));
    }
    if !matches!(op, ControlOp::ResizeDisk { .. }) && !same_user.map_err(ControlError::Mount)? {
        return Err(ControlError::Mount(libc::EPERM));
    }
    Ok(())
}

#[cfg(any(test, feature = "native"))]
async fn handle_http(
    request: Request<Incoming>,
    read_deadline: Instant,
    handle: impl FnOnce(ControlOp) -> ControlResponse,
) -> Response<Full<Bytes>> {
    type ParseControlOp = fn(&[u8]) -> Result<ControlOp, ControlError>;
    let (parse, max_body): (ParseControlOp, _) = match request.uri().path() {
        RESIZE_PATH => (parse_resize, MAX_BODY),
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        MEMORY_PATH => (parse_memory, MAX_BODY),
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        MOUNT_PATH => (parse_mount, MAX_MOUNT_BODY),
        _ => return invalid_request(StatusCode::NOT_FOUND, "unknown control path"),
    };
    if request.method() != Method::POST {
        let mut response = invalid_request(StatusCode::METHOD_NOT_ALLOWED, "control requires POST");
        response
            .headers_mut()
            .insert(ALLOW, HeaderValue::from_static("POST"));
        return response;
    }

    let body = Limited::new(request.into_body(), max_body);
    let body = match timeout_at(read_deadline, body.collect()).await {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(error)) if error.is::<LengthLimitError>() => {
            return invalid_request(StatusCode::PAYLOAD_TOO_LARGE, "control request too large");
        }
        Ok(Err(_)) => {
            return invalid_request(StatusCode::BAD_REQUEST, "incomplete control request");
        }
        Err(_) => return invalid_request(StatusCode::REQUEST_TIMEOUT, "control request timed out"),
    };
    let reply = parse(&body).and_then(handle);
    json_reply(reply_status(&reply), &reply, max_body)
}

#[cfg(any(test, feature = "native"))]
fn parse_resize(body: &[u8]) -> Result<ControlOp, ControlError> {
    let request: ResizeDiskRequest = serde_json::from_slice(body)
        .map_err(|error| ControlError::InvalidInput(error.to_string()))?;
    Ok(ControlOp::ResizeDisk {
        block_id: request.block_id,
        bytes: request.bytes,
    })
}

#[cfg(all(
    any(test, feature = "native"),
    target_os = "linux",
    target_arch = "x86_64"
))]
fn parse_memory(body: &[u8]) -> Result<ControlOp, ControlError> {
    serde_json::from_slice::<MemoryRequest>(body)
        .map(|request| ControlOp::Memory {
            target_mib: request.target_mib,
        })
        .map_err(|error| ControlError::InvalidInput(error.to_string()))
}

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
fn parse_mount(body: &[u8]) -> Result<ControlOp, ControlError> {
    let op = serde_json::from_slice(body)
        .map_err(|error| ControlError::InvalidInput(error.to_string()))?;
    if matches!(op, ControlOp::ResizeDisk { .. } | ControlOp::Memory { .. }) {
        return Err(ControlError::InvalidInput(
            "expected a mount operation".into(),
        ));
    }
    Ok(op)
}

#[cfg(any(test, feature = "native"))]
fn invalid_request(status: StatusCode, message: impl Into<String>) -> Response<Full<Bytes>> {
    json_reply(
        status,
        &Err(ControlError::InvalidInput(message.into())),
        MAX_BODY,
    )
}

fn reply_status(reply: &ControlResponse) -> StatusCode {
    match reply {
        Ok(_) => StatusCode::OK,
        Err(ControlError::InvalidInput(_)) => StatusCode::BAD_REQUEST,
        Err(ControlError::Unsupported(_)) => StatusCode::NOT_IMPLEMENTED,
        Err(ControlError::Failed(_)) => StatusCode::INTERNAL_SERVER_ERROR,
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        Err(ControlError::Mount(errno)) => match *errno {
            libc::EINVAL | libc::ENOTDIR => StatusCode::BAD_REQUEST,
            libc::EPERM | libc::EACCES => StatusCode::FORBIDDEN,
            libc::ENOENT => StatusCode::NOT_FOUND,
            libc::EBUSY => StatusCode::CONFLICT,
            libc::ENOSPC => StatusCode::INSUFFICIENT_STORAGE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        },
    }
}

#[cfg(any(test, feature = "native"))]
fn json_reply(
    status: StatusCode,
    reply: &ControlResponse,
    max_body: usize,
) -> Response<Full<Bytes>> {
    let (status, body) = match serde_json::to_vec(reply) {
        Ok(body) if body.len() <= max_body => (status, Bytes::from(body)),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Bytes::from_static(br#"{"Err":{"failed":"control reply exceeds the size limit"}}"#),
        ),
    };
    let mut response = Response::new(Full::new(body));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

async fn request(path: &Path, block_id: &str, bytes: u64) -> io::Result<ControlResponse> {
    let body = serde_json::to_vec(&ResizeDiskRequest {
        block_id: block_id.into(),
        bytes,
    })?;
    let stream = tokio::net::UnixStream::connect(path).await?;
    exchange_http(TokioIo::new(stream), RESIZE_PATH, body, MAX_BODY).await
}

async fn exchange_http(
    stream: impl hyper::rt::Read + hyper::rt::Write + Unpin,
    route: &'static str,
    body: Vec<u8>,
    max_body: usize,
) -> io::Result<ControlResponse> {
    if body.len() > max_body {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "control request too large",
        ));
    }
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(HTTP_BUFFER)
        .handshake(stream)
        .await
        .map_err(io::Error::other)?;
    let request = Request::post(route)
        .header(HOST, "vmm")
        .header(CONTENT_TYPE, "application/json")
        .header(CONNECTION, "close")
        .body(Full::new(Bytes::from(body)))
        .map_err(io::Error::other)?;
    let exchange = async {
        let response = sender
            .send_request(request)
            .await
            .map_err(io::Error::other)?;
        let status = response.status();
        let body = Limited::new(response.into_body(), max_body)
            .collect()
            .await
            .map_err(io::Error::other)?;
        let reply: ControlResponse = serde_json::from_slice(&body.to_bytes())?;
        if status != reply_status(&reply) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected HTTP control status {status}"),
            ));
        }
        Ok(reply)
    };
    tokio::pin!(exchange);
    // Drive the connection within this exchange so canceling it closes the socket.
    // Drop the socket at completion because the peer may already have closed.
    tokio::select! {
        biased;
        reply = &mut exchange => reply,
        result = connection.without_shutdown() => {
            result.map_err(io::Error::other)?;
            exchange.await
        }
    }
}

/// A blocking exchange for the native mount client and shim tests.
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn exchange(
    path: &Path,
    op: ControlOp,
    directory: Option<&File>,
    timeout: Duration,
) -> io::Result<ControlResponse> {
    let deadline = std::time::Instant::now() + timeout;
    let (route, body, max_body) = match op {
        ControlOp::ResizeDisk { block_id, bytes } => (
            RESIZE_PATH,
            serde_json::to_vec(&ResizeDiskRequest { block_id, bytes })?,
            MAX_BODY,
        ),
        ControlOp::Memory { target_mib } => (
            MEMORY_PATH,
            serde_json::to_vec(&MemoryRequest { target_mib })?,
            MAX_BODY,
        ),
        op => (MOUNT_PATH, serde_json::to_vec(&op)?, MAX_MOUNT_BODY),
    };
    // A blocking Unix connect waits on a full listen backlog until the deadline.
    let stream = transport::connect(path, deadline)?;
    stream.set_nonblocking(true)?;
    let directory = directory.map(File::try_clone).transpose()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    runtime.block_on(async {
        let stream = tokio::net::UnixStream::from_std(stream)?;
        let (stream, received) = transport::AncillaryIo::new(stream, directory);
        let reply = timeout_at(
            Instant::from_std(deadline),
            exchange_http(TokioIo::new(stream), route, body, max_body),
        )
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "VMM control deadline"))??;
        if received.take().is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "descriptor in control reply",
            ));
        }
        Ok(reply)
    })
}

/// Request an absolute disk capacity through the native shim's host-only channel.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) async fn grow_disk(
    path: &Path,
    block_id: &str,
    bytes: u64,
) -> boxlite_shared::BoxliteResult<()> {
    use boxlite_shared::BoxliteError;

    // The worker waits up to ten seconds; allow the bounded exchange to outlast it.
    let response = timeout(CLIENT_TIMEOUT, request(path, block_id, bytes))
        .await
        .map_err(|_| {
            BoxliteError::Engine(
                "disk resize completion is unknown: reply timed out; retry the target".into(),
            )
        })?
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
                BoxliteError::Unsupported(
                    "shim has no disk control channel; restart with the current runtime".into(),
                )
            }
            _ => BoxliteError::Engine(format!(
                "disk resize completion is unknown: {error}; retry the target. \
                 If the shim is older than the runtime, restart the box with matching versions."
            )),
        })?;
    match response {
        Ok(ControlReply::DiskSize(actual)) if actual == bytes => Ok(()),
        Ok(ControlReply::DiskSize(actual)) => Err(BoxliteError::Engine(format!(
            "disk resize completion is unknown: shim reported {actual} disk bytes, requested {bytes}; retry the target"
        ))),
        Err(ControlError::Unsupported(message)) => Err(BoxliteError::Unsupported(message)),
        Err(ControlError::InvalidInput(message)) => Err(BoxliteError::InvalidArgument(message)),
        Err(ControlError::Failed(message)) => Err(BoxliteError::Engine(format!(
            "disk resize completion is unknown: {message}; query allocation or retry the target"
        ))),
        _ => Err(BoxliteError::Engine(
            "disk resize completion is unknown: unexpected shim reply; retry the target".into(),
        )),
    }
}

/// `fchmodat`, which the shim's seccomp profile allows, rather than `chmod`.
#[cfg(any(test, feature = "native"))]
fn restrict_to_owner(path: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: `path` is a valid NUL-terminated string for the call.
    if unsafe { libc::fchmodat(libc::AT_FDCWD, path.as_ptr(), 0o600, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/vmm_socket.rs"]
mod tests;
