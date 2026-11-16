//! The host's control channel to a running shim.
//!
//! The shim serves one Unix socket, `control.sock` in the box's socket
//! directory, for runtime operations on the VMM it hosts. The socket is
//! host-only (mode 0600, never bridged into guest vsock) and at a fixed path,
//! so a runtime that restarts can still reach a running box. Each connection
//! carries one request and one response: a 4-byte little-endian length, then
//! a JSON object of at most [`MAX_FRAME`] bytes. Requests name [`VERSION`];
//! a shim answers any other version, or an operation its engine lacks, with
//! [`ControlError::Unsupported`].

use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The protocol version a request names.
pub(crate) const VERSION: u32 = 1;
/// The largest frame either side accepts.
const MAX_FRAME: u32 = 4096;
/// How long the shim waits for a request or a reply write.
const IO_TIMEOUT: Duration = Duration::from_secs(2);

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
    /// Grows disk `index` (attach order) to `bytes`.
    ResizeDisk { index: usize, bytes: u64 },
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
    std::thread::Builder::new()
        .name("vmm-control".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                if let Err(error) = answer(stream, &handle) {
                    tracing::debug!(%error, "control connection ended");
                }
            }
        })?;
    Ok(())
}

fn answer(
    mut stream: UnixStream,
    handle: &impl Fn(ControlOp) -> ControlResponse,
) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let response = match serde_json::from_slice::<ControlRequest>(&read_frame(&mut stream)?) {
        Ok(request) if request.version == VERSION => handle(request.op),
        Ok(request) => Err(ControlError::Unsupported(format!(
            "protocol version {}",
            request.version
        ))),
        Err(error) => Err(ControlError::InvalidInput(error.to_string())),
    };
    write_frame(&mut stream, &serde_json::to_vec(&response)?)
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
#[path = "tests/control.rs"]
mod tests;
