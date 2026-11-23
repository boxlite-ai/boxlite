//! The host's control channel to a running shim.
//!
//! The shim serves one Unix socket, `vmm.sock` in the box's socket
//! directory, for runtime operations on the VMM it hosts. The socket is
//! host-only (mode 0600, never bridged into guest vsock) and at a fixed path,
//! so a runtime that restarts can still reach a running box. Each connection
//! carries one request and one response: a 4-byte little-endian length, then
//! a JSON object of at most [`MAX_FRAME`] bytes. Native directory registration
//! carries one open directory via `SCM_RIGHTS`. Requests name [`VERSION`].

use std::fs::File;
use std::io;
#[cfg(test)]
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
use super::controller::mount_control::{ControlMount, MountState};
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
use std::time::Instant;

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
mod transport;

/// The protocol version a request names.
pub(crate) const VERSION: u32 = 1;
/// The largest frame either side accepts.
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub(crate) const MAX_FRAME: u32 = 64 * 1024;
#[cfg(not(all(feature = "native", target_os = "linux", target_arch = "x86_64")))]
const MAX_FRAME: u32 = 4096;
/// How long the shim waits for a request or a reply write.
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const ACCEPT_RETRY_INITIAL: Duration = Duration::from_millis(5);
const ACCEPT_RETRY_MAX: Duration = Duration::from_millis(50);

/// One versioned request. Its operation sits beside `version`, tagged by
/// `op`; an unknown operation fails to parse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ControlRequest {
    pub(crate) version: u32,
    #[serde(flatten)]
    pub(crate) op: ControlOp,
}

/// The operations a shim may serve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum ControlOp {
    /// Grows the disk with the configured `block_id` to `bytes`.
    ResizeDisk { block_id: String, bytes: u64 },
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
pub(crate) fn serve(
    path: &Path,
    handle: impl FnMut(ControlOp, Option<File>) -> ControlResponse + Send + 'static,
) -> io::Result<()> {
    if std::fs::symlink_metadata(path).is_ok() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    restrict_to_owner(path)?;
    std::thread::Builder::new()
        .name("vmm-control".into())
        .spawn(move || serve_connections(listener.incoming(), handle, std::thread::sleep))?;
    Ok(())
}

fn serve_connections(
    incoming: impl Iterator<Item = io::Result<UnixStream>>,
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
        if let Err(error) = answer(stream, &mut handle) {
            tracing::debug!(%error, "control connection ended");
        }
    }
}

fn answer(
    stream: UnixStream,
    handle: &mut impl FnMut(ControlOp, Option<File>) -> ControlResponse,
) -> io::Result<()> {
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    let (frame, file) = transport::receive_frame(&stream, Instant::now() + IO_TIMEOUT)?;
    #[cfg(not(all(feature = "native", target_os = "linux", target_arch = "x86_64")))]
    let (mut stream, frame, file) = {
        let mut stream = stream;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let frame = read_frame(&mut stream)?;
        (stream, frame, None)
    };
    let response = match serde_json::from_slice::<ControlRequest>(&frame) {
        Ok(request) if request.version == VERSION => {
            #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
            let checked = check_request(&stream, &request.op, file.is_some());
            #[cfg(not(all(feature = "native", target_os = "linux", target_arch = "x86_64")))]
            let checked = Ok(());
            checked.and_then(|()| handle(request.op, file))
        }
        Ok(request) => Err(ControlError::Unsupported(format!(
            "protocol version {}",
            request.version
        ))),
        Err(error) => Err(ControlError::InvalidInput(error.to_string())),
    };
    let reply = serde_json::to_vec(&response)?;
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    return transport::send_frame(&stream, &reply, None, Instant::now() + IO_TIMEOUT);
    #[cfg(not(all(feature = "native", target_os = "linux", target_arch = "x86_64")))]
    write_frame(&mut stream, &reply)
}

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
fn check_request(stream: &UnixStream, op: &ControlOp, has_fd: bool) -> Result<(), ControlError> {
    let register = matches!(op, ControlOp::RegisterMount { .. });
    if has_fd != register {
        return Err(ControlError::Mount(libc::EINVAL));
    }
    if !matches!(op, ControlOp::ResizeDisk { .. })
        && !transport::same_user(stream)
            .map_err(|error| ControlError::Mount(error.raw_os_error().unwrap_or(libc::EIO)))?
    {
        return Err(ControlError::Mount(libc::EPERM));
    }
    Ok(())
}

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn exchange(
    path: &Path,
    op: ControlOp,
    directory: Option<&File>,
    timeout: Duration,
) -> io::Result<ControlResponse> {
    use std::os::fd::AsRawFd;

    let deadline = Instant::now() + timeout;
    let stream = transport::connect(path, deadline)?;
    let request = ControlRequest {
        version: VERSION,
        op,
    };
    let frame = serde_json::to_vec(&request)?;
    transport::send_frame(&stream, &frame, directory.map(AsRawFd::as_raw_fd), deadline)?;
    let (reply, attached) = transport::receive_frame(&stream, deadline)?;
    if attached.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "descriptor in control reply",
        ));
    }
    Ok(serde_json::from_slice(&reply)?)
}

/// Sends `request` to the shim at `path` and waits up to `timeout` for the
/// answer, as the host side of one exchange.
#[cfg(test)]
pub(crate) fn request(
    path: &Path,
    request: &ControlRequest,
    timeout: Duration,
) -> io::Result<ControlResponse> {
    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    write_frame(&mut stream, &serde_json::to_vec(request)?)?;
    Ok(serde_json::from_slice(&read_frame(&mut stream)?)?)
}

#[cfg(test)]
fn read_frame(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length);
    if length > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("control frame of {length} bytes exceeds {MAX_FRAME}"),
        ));
    }
    let mut frame = vec![0u8; length as usize];
    stream.read_exact(&mut frame)?;
    Ok(frame)
}

#[cfg(test)]
fn write_frame(stream: &mut UnixStream, frame: &[u8]) -> io::Result<()> {
    let length = u32::try_from(frame.len())
        .ok()
        .filter(|length| *length <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "control frame too large"))?;
    stream.write_all(&length.to_le_bytes())?;
    stream.write_all(frame)
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
