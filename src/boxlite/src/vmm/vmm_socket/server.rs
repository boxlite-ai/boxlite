use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use super::{
    ControlError, ControlOp, ControlRequest, ControlResponse, MAX_FRAME, VERSION, checked_size,
};

/// How long the shim waits for a request or a reply write.
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const ACCEPT_RETRY_INITIAL: Duration = Duration::from_millis(5);
const ACCEPT_RETRY_MAX: Duration = Duration::from_millis(50);

/// Binds `path` (replacing a stale socket), makes it owner-only, and serves
/// each connection on a `vmm-control` thread with `handle`.
#[cfg(any(
    test,
    all(feature = "native", target_os = "linux", target_arch = "x86_64")
))]
pub(crate) fn serve(
    path: &Path,
    handle: impl Fn(ControlOp) -> ControlResponse + Send + 'static,
) -> io::Result<()> {
    serve_bound(bind_owner(path)?, handle)
}

pub(crate) fn bind_owner(path: &Path) -> io::Result<UnixListener> {
    if std::fs::symlink_metadata(path).is_ok() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    restrict_to_owner(path)?;
    Ok(listener)
}

pub(crate) fn serve_bound(
    listener: UnixListener,
    handle: impl Fn(ControlOp) -> ControlResponse + Send + 'static,
) -> io::Result<()> {
    std::thread::Builder::new()
        .name("vmm-control".into())
        .spawn(move || serve_connections(listener.incoming(), handle, std::thread::sleep))?;
    Ok(())
}

fn serve_connections(
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
        if let Err(error) = answer(stream, &handle) {
            tracing::debug!(%error, "control connection ended");
        }
    }
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
    let length = checked_size(frame.len())?;
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
#[path = "../tests/vmm_socket.rs"]
mod tests;
