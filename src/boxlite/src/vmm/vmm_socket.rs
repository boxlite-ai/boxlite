//! The host's control channel to a running shim.
//!
//! The shim serves one Unix socket, `vmm.sock` in the box's socket
//! directory, for runtime operations on the VMM it hosts. The socket is
//! host-only (mode 0600, never bridged into guest vsock) and at a fixed path,
//! so a runtime that restarts can still reach a running box. Each connection
//! carries one HTTP/1.1 request and one final response. Resize uses
//! `POST /v1/resize-disk` with JSON bodies bounded by [`MAX_BODY`].

use std::convert::Infallible;
use std::io;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::Incoming;
use hyper::header::{ALLOW, CONNECTION, CONTENT_TYPE, HOST, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use tokio::runtime::Runtime;
use tokio::time::{Instant, timeout, timeout_at};

const RESIZE_PATH: &str = "/v1/resize-disk";
const MAX_BODY: usize = 4096;
const HTTP_BUFFER: usize = 8192;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
// Allow the request read, ten-second device reply wait, and reply write.
const SERVER_TIMEOUT: Duration = Duration::from_secs(14);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(15);
const ACCEPT_RETRY_INITIAL: Duration = Duration::from_millis(5);
const ACCEPT_RETRY_MAX: Duration = Duration::from_millis(50);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResizeDiskRequest {
    block_id: String,
    bytes: u64,
}

/// The operations a shim may serve.
#[derive(Debug)]
pub(crate) enum ControlOp {
    /// Grows the disk with the configured `block_id` to `bytes`.
    ResizeDisk { block_id: String, bytes: u64 },
}

/// The shim's answer.
pub(crate) type ControlResponse = Result<ControlReply, ControlError>;

/// What a successful operation reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ControlReply {
    /// The disk's size in bytes after the operation.
    DiskSize(u64),
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
}

/// Binds `path` (replacing a stale socket), makes it owner-only, and serves
/// each connection on a `vmm-control` thread with `handle`.
pub(crate) fn serve(
    path: &Path,
    handle: impl Fn(ControlOp) -> ControlResponse + Send + 'static,
) -> io::Result<()> {
    if std::fs::symlink_metadata(path).is_ok() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    restrict_to_owner(path)?;
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
                    serve_connections(&runtime, listener.incoming(), handle, std::thread::sleep);
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
            }
        })?;
    started.recv().map_err(io::Error::other)?
}

fn serve_connections(
    runtime: &Runtime,
    incoming: impl Iterator<Item = io::Result<UnixStream>>,
    handle: impl Fn(ControlOp) -> ControlResponse,
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
        if let Err(error) = answer(runtime, stream, &handle) {
            tracing::debug!(%error, "control connection ended");
        }
    }
}

fn answer(
    runtime: &Runtime,
    stream: UnixStream,
    handle: &impl Fn(ControlOp) -> ControlResponse,
) -> io::Result<()> {
    runtime.block_on(async {
        stream.set_nonblocking(true)?;
        let stream = tokio::net::UnixStream::from_std(stream)?;
        let read_deadline = Instant::now() + READ_TIMEOUT;
        let connection = hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .half_close(true)
            .max_buf_size(HTTP_BUFFER)
            .timer(TokioTimer::new())
            .header_read_timeout(READ_TIMEOUT)
            .serve_connection(
                TokioIo::new(stream),
                hyper::service::service_fn(|request| async move {
                    Ok::<_, Infallible>(handle_http(request, read_deadline, handle).await)
                }),
            );
        timeout(SERVER_TIMEOUT, connection)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "control connection timed out"))?
            .map_err(io::Error::other)
    })
}

async fn handle_http(
    request: Request<Incoming>,
    read_deadline: Instant,
    handle: &impl Fn(ControlOp) -> ControlResponse,
) -> Response<Full<Bytes>> {
    if request.uri().path() != RESIZE_PATH {
        return invalid_request(StatusCode::NOT_FOUND, "unknown control path");
    }
    if request.method() != Method::POST {
        let mut response = invalid_request(StatusCode::METHOD_NOT_ALLOWED, "resize requires POST");
        response
            .headers_mut()
            .insert(ALLOW, HeaderValue::from_static("POST"));
        return response;
    }

    let body = Limited::new(request.into_body(), MAX_BODY);
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
    let request = match serde_json::from_slice::<ResizeDiskRequest>(&body) {
        Ok(request) => request,
        Err(error) => return invalid_request(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let reply = handle(ControlOp::ResizeDisk {
        block_id: request.block_id,
        bytes: request.bytes,
    });
    json_reply(reply_status(&reply), &reply)
}

fn invalid_request(status: StatusCode, message: impl Into<String>) -> Response<Full<Bytes>> {
    json_reply(status, &Err(ControlError::InvalidInput(message.into())))
}

fn reply_status(reply: &ControlResponse) -> StatusCode {
    match reply {
        Ok(_) => StatusCode::OK,
        Err(ControlError::InvalidInput(_)) => StatusCode::BAD_REQUEST,
        Err(ControlError::Unsupported(_)) => StatusCode::NOT_IMPLEMENTED,
        Err(ControlError::Failed(_)) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn json_reply(status: StatusCode, reply: &ControlResponse) -> Response<Full<Bytes>> {
    let (status, body) = match serde_json::to_vec(reply) {
        Ok(body) if body.len() <= MAX_BODY => (status, Bytes::from(body)),
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
    if body.len() > MAX_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "control request too large",
        ));
    }
    let stream = tokio::net::UnixStream::connect(path).await?;
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(HTTP_BUFFER)
        .handshake(TokioIo::new(stream))
        .await
        .map_err(io::Error::other)?;
    let request = Request::post(RESIZE_PATH)
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
        let body = Limited::new(response.into_body(), MAX_BODY)
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
    tokio::select! {
        biased;
        reply = &mut exchange => reply,
        result = connection => {
            result.map_err(io::Error::other)?;
            exchange.await
        }
    }
}

/// Request an absolute disk capacity through the native shim's host-only channel.
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
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
                "disk resize reply timed out; allocation may have changed; retry the target".into(),
            )
        })?
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
                BoxliteError::Unsupported(
                    "shim has no disk control channel; restart with the current runtime".into(),
                )
            }
            _ => BoxliteError::Engine(format!(
                "disk control exchange failed: {error}. Disk allocation may have changed. \
                 If the shim is older than the runtime, restart the box with matching versions."
            )),
        })?;
    match response {
        Ok(ControlReply::DiskSize(actual)) if actual == bytes => Ok(()),
        Ok(ControlReply::DiskSize(actual)) => Err(BoxliteError::Engine(format!(
            "shim reported {actual} disk bytes, requested {bytes}"
        ))),
        Err(ControlError::Unsupported(message)) => Err(BoxliteError::Unsupported(message)),
        Err(ControlError::InvalidInput(message)) => Err(BoxliteError::InvalidArgument(message)),
        Err(ControlError::Failed(message)) => Err(BoxliteError::Engine(format!(
            "disk resize completion is unknown: {message}; query allocation or retry the target"
        ))),
    }
}

/// `fchmodat`, which the shim's seccomp profile allows, rather than `chmod`.
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
