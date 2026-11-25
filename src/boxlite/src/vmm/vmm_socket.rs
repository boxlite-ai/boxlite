//! The host's control channel to a running shim.
//!
//! The shim serves one Unix socket, `vmm.sock` in the box's socket
//! directory, for runtime operations on the VMM it hosts. The socket is
//! host-only (mode 0600, never bridged into guest vsock) and at a fixed path,
//! so a runtime that restarts can still reach a running box with a matching
//! shim. Each connection carries one HTTP/1.1 JSON request and response.
//! Directory registration attaches one open directory via `SCM_RIGHTS`.

#![allow(dead_code)]
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{CONNECTION, CONTENT_TYPE, HOST};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
use tokio::time::timeout;

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
use {
    http_body_util::LengthLimitError,
    hyper::{
        Method, Response,
        body::Incoming,
        header::{ALLOW, HeaderValue},
    },
    hyper_util::rt::TokioTimer,
    std::{
        cell::{Cell, RefCell},
        convert::Infallible,
        os::unix::net::{UnixListener, UnixStream},
    },
    tokio::{
        runtime::Runtime,
        sync::Notify,
        time::{Instant, sleep, timeout_at},
    },
};

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
use super::controller::mount_control::{ControlMount, MountState};
mod transport;

const RESIZE_PATH: &str = "/v1/resize-disk";
const CHECKPOINT_PATH: &str = "/v1/capture-checkpoint";
const CHECKPOINT_VERSION: u32 = 1;
const MAX_CHECKPOINT_BODY: usize = 64 * 1024;
const MAX_BODY: usize = 4096;
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
const MOUNT_PATH: &str = "/v1/mount-control";
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub(super) const MAX_MOUNT_BODY: usize = 64 * 1024;
const HTTP_BUFFER: usize = 8192;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CLIENT_TIMEOUT: Duration = Duration::from_secs(15);

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
const READ_TIMEOUT: Duration = Duration::from_secs(2);
// Allow the request read, ten-second device reply wait, and reply write.
#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
const SERVER_TIMEOUT: Duration = Duration::from_secs(14);
#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
const CHECKPOINT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
const ACCEPT_RETRY_INITIAL: Duration = Duration::from_millis(5);
#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
const ACCEPT_RETRY_MAX: Duration = Duration::from_millis(50);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResizeDiskRequest {
    block_id: String,
    bytes: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointRequest {
    version: u32,
    vm_state_path: PathBuf,
    disk_dst_path: PathBuf,
}

/// The operations a shim may serve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum ControlOp {
    /// Grows the disk with the configured `block_id` to `bytes`.
    ResizeDisk { block_id: String, bytes: u64 },
    /// Pauses the VM, saves VM state and the container disk, then resumes it.
    CaptureCheckpoint {
        vm_state_path: PathBuf,
        disk_dst_path: PathBuf,
    },
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
    /// Checkpoint state and flattened disk written; VM resumed.
    CheckpointCaptured {
        vm_state_bytes: u64,
        guest_rootfs_path: Option<PathBuf>,
    },
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
    /// Internal server signal; the wire response is `Failed`.
    #[serde(skip)]
    #[cfg(any(test, feature = "krun"))]
    #[cfg_attr(
        not(any(
            test,
            all(target_os = "linux", target_arch = "x86_64"),
            all(target_os = "macos", target_arch = "aarch64")
        )),
        allow(dead_code)
    )]
    #[error("{0}")]
    ShimShutdown(String),
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    #[error("mount control errno {0}")]
    Mount(i32),
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
/// Binds `path` (replacing a stale socket), makes it owner-only, and serves
/// each connection on a `vmm-control` thread with `handle`.
pub(crate) fn serve(
    path: &Path,
    handle: impl FnMut(ControlOp, Option<File>) -> ControlResponse + Send + 'static,
) -> io::Result<()> {
    if std::fs::symlink_metadata(path).is_ok() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    #[cfg(target_os = "macos")]
    transport::suppress_sigpipe(&listener)?;
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

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
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
        if let Err(error) = answer_with_shutdown(runtime, stream, owner, &mut handle, || {
            std::process::exit(1)
        }) {
            tracing::debug!(%error, "control connection ended");
        }
    }
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
fn answer_with_shutdown(
    runtime: &Runtime,
    stream: UnixStream,
    owner: libc::uid_t,
    handle: &mut impl FnMut(ControlOp, Option<File>) -> ControlResponse,
    shutdown: impl FnOnce(),
) -> io::Result<()> {
    let same_user = transport::same_user(&stream, owner);
    transport::prepare_stream(&stream)?;
    let terminate = Cell::new(false);
    let result = runtime.block_on(async {
        let stream = tokio::net::UnixStream::from_std(stream)?;
        let (stream, received) = transport::AncillaryIo::new(stream, None);

        // The listener lends its handler to Hyper only for synchronous dispatch.
        let handle = RefCell::new(handle);
        let checkpoint_finished = Notify::new();
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
                        let file = received.take();
                        check_request(&op, file.is_some(), same_user.as_ref().copied())?;
                        let checkpoint = matches!(op, ControlOp::CaptureCheckpoint { .. });
                        let response = handle.borrow_mut()(op, file);
                        if checkpoint {
                            checkpoint_finished.notify_one();
                        }
                        #[cfg(any(test, feature = "krun"))]
                        if let Err(ControlError::ShimShutdown(message)) = response {
                            terminate.set(true);
                            return Err(ControlError::Failed(message));
                        }
                        response
                    })
                    .await;
                    Ok::<_, Infallible>(reply)
                }),
            );
        tokio::pin!(connection);
        tokio::select! {
            biased;
            result = &mut connection => result.map_err(io::Error::other),
            // Capture can outlast the native connection deadline. Start a fresh
            // write deadline after saving, flattening, and resuming the VM.
            _ = checkpoint_finished.notified() => {
                tokio::time::timeout(CHECKPOINT_WRITE_TIMEOUT, connection)
                    .await
                    .map_err(|_| server_timeout())?
                    .map_err(io::Error::other)
            }
            _ = sleep(SERVER_TIMEOUT) => Err(server_timeout()),
        }
    });
    if terminate.get() {
        shutdown();
    }
    result
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
fn server_timeout() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "control connection timed out")
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
fn check_request(
    op: &ControlOp,
    has_fd: bool,
    same_user: Result<bool, &io::Error>,
) -> Result<(), ControlError> {
    match op {
        ControlOp::ResizeDisk { .. } if has_fd => {
            #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
            let error = ControlError::Mount(libc::EINVAL);
            #[cfg(not(all(feature = "native", target_os = "linux", target_arch = "x86_64")))]
            let error =
                ControlError::InvalidInput("unexpected file descriptor in resize request".into());
            Err(error)
        }
        ControlOp::ResizeDisk { .. } => Ok(()),
        ControlOp::CaptureCheckpoint { .. } => {
            if has_fd {
                return Err(ControlError::InvalidInput(
                    "unexpected file descriptor in checkpoint request".into(),
                ));
            }
            let same_user = same_user.map_err(|error| {
                ControlError::Failed(format!(
                    "failed to verify control peer credentials: {error}"
                ))
            })?;
            if !same_user {
                return Err(ControlError::Failed(
                    "control request rejected: peer uid does not match shim owner".into(),
                ));
            }
            Ok(())
        }
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        _ => {
            if has_fd != matches!(op, ControlOp::RegisterMount { .. }) {
                return Err(ControlError::Mount(libc::EINVAL));
            }
            if !same_user
                .map_err(|error| ControlError::Mount(error.raw_os_error().unwrap_or(libc::EIO)))?
            {
                return Err(ControlError::Mount(libc::EPERM));
            }
            Ok(())
        }
    }
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
async fn handle_http(
    request: Request<Incoming>,
    read_deadline: Instant,
    handle: impl FnOnce(ControlOp) -> ControlResponse,
) -> Response<Full<Bytes>> {
    type ParseControlOp = fn(&[u8]) -> Result<ControlOp, ControlError>;
    let (parse, max_body): (ParseControlOp, _) = match request.uri().path() {
        RESIZE_PATH => (parse_resize, MAX_BODY),
        CHECKPOINT_PATH => (parse_checkpoint, MAX_CHECKPOINT_BODY),
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
        Err(_) => {
            return invalid_request(StatusCode::REQUEST_TIMEOUT, "control request timed out");
        }
    };
    let reply = parse(&body).and_then(handle);
    json_reply(reply_status(&reply), &reply, max_body)
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
fn parse_resize(body: &[u8]) -> Result<ControlOp, ControlError> {
    let request: ResizeDiskRequest = serde_json::from_slice(body)
        .map_err(|error| ControlError::InvalidInput(error.to_string()))?;
    Ok(ControlOp::ResizeDisk {
        block_id: request.block_id,
        bytes: request.bytes,
    })
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
fn parse_checkpoint(body: &[u8]) -> Result<ControlOp, ControlError> {
    let request: CheckpointRequest = serde_json::from_slice(body)
        .map_err(|error| ControlError::InvalidInput(error.to_string()))?;
    if request.version != CHECKPOINT_VERSION {
        return Err(ControlError::Unsupported(format!(
            "protocol version {}",
            request.version
        )));
    }
    Ok(ControlOp::CaptureCheckpoint {
        vm_state_path: request.vm_state_path,
        disk_dst_path: request.disk_dst_path,
    })
}

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
fn parse_mount(body: &[u8]) -> Result<ControlOp, ControlError> {
    let op = serde_json::from_slice(body)
        .map_err(|error| ControlError::InvalidInput(error.to_string()))?;
    if matches!(
        op,
        ControlOp::ResizeDisk { .. } | ControlOp::CaptureCheckpoint { .. }
    ) {
        return Err(ControlError::InvalidInput(
            "expected a mount operation".into(),
        ));
    }
    Ok(op)
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
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
        #[cfg(any(test, feature = "krun"))]
        Err(ControlError::ShimShutdown(_)) => StatusCode::INTERNAL_SERVER_ERROR,
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

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
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

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
async fn request_resize(path: &Path, block_id: &str, bytes: u64) -> io::Result<ControlResponse> {
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

/// A blocking exchange for checkpoint capture and the native mount client.
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
        ControlOp::CaptureCheckpoint {
            vm_state_path,
            disk_dst_path,
        } => (
            CHECKPOINT_PATH,
            serde_json::to_vec(&CheckpointRequest {
                version: CHECKPOINT_VERSION,
                vm_state_path,
                disk_dst_path,
            })?,
            MAX_CHECKPOINT_BODY,
        ),
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        op => (MOUNT_PATH, serde_json::to_vec(&op)?, MAX_MOUNT_BODY),
    };
    exchange_blocking_http(path, route, body, max_body, directory, deadline)
}

fn exchange_blocking_http(
    path: &Path,
    route: &'static str,
    body: Vec<u8>,
    max_body: usize,
    directory: Option<&File>,
    deadline: std::time::Instant,
) -> io::Result<ControlResponse> {
    // Linux nonblocking connect fails immediately on a full listener backlog.
    #[cfg(target_os = "linux")]
    let stream = transport::connect(path, deadline)?;
    let directory = directory.map(File::try_clone).transpose()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    runtime.block_on(async {
        tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), async {
            #[cfg(not(target_os = "linux"))]
            let stream = tokio::net::UnixStream::connect(path).await?.into_std()?;
            #[cfg(target_os = "macos")]
            transport::suppress_sigpipe(&stream)?;
            transport::prepare_stream(&stream)?;
            let stream = tokio::net::UnixStream::from_std(stream)?;
            let (stream, received) = transport::AncillaryIo::new(stream, directory);
            let reply = exchange_http(TokioIo::new(stream), route, body, max_body).await?;
            if received.take().is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "descriptor in control reply",
                ));
            }
            Ok(reply)
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "VMM control deadline"))?
    })
}

/// Sends a control operation to the shim with a deadline covering the whole exchange.
pub(crate) fn request(
    path: &Path,
    op: ControlOp,
    timeout: Duration,
) -> BoxliteResult<ControlReply> {
    let response = exchange(path, op, None, timeout).map_err(|error| {
        BoxliteError::Engine(format!(
            "VMM control request to {} failed: {error}",
            path.display()
        ))
    })?;
    response.map_err(|error| match error {
        ControlError::Unsupported(message) => BoxliteError::Unsupported(message),
        ControlError::InvalidInput(message) => BoxliteError::InvalidArgument(message),
        ControlError::Failed(message) => BoxliteError::Engine(message),
        #[cfg(any(test, feature = "krun"))]
        ControlError::ShimShutdown(message) => BoxliteError::Engine(message),
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        ControlError::Mount(errno) => BoxliteError::Engine(format!("mount control errno {errno}")),
    })
}

/// Request an absolute disk capacity through the native shim's host-only channel.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) async fn grow_disk(
    path: &Path,
    block_id: &str,
    bytes: u64,
) -> boxlite_shared::BoxliteResult<()> {
    // The worker waits up to ten seconds; allow the bounded exchange to outlast it.
    let response = timeout(CLIENT_TIMEOUT, request_resize(path, block_id, bytes))
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
#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
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
