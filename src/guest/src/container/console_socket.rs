//! Console socket for PTY handling.
//!
//! Implements OCI-compliant console socket mechanism for receiving PTY master file descriptors
//! from libcontainer.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::sys::socket::{recvmsg, ControlMessageOwned, MsgFlags, UnixAddr};
use std::io::IoSliceMut;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixListener;
use std::time::Duration;

/// Timeout for the PTY console-socket handshake.
///
/// If libcontainer doesn't connect and send the PTY master fd within this
/// window, the handshake fails instead of blocking forever.
const PTY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Console socket for receiving PTY master FD from libcontainer.
///
/// Manages the lifecycle of a Unix domain socket that libcontainer connects to
/// for sending the PTY master file descriptor.
pub(super) struct ConsoleSocket {
    listener: UnixListener,
    socket_path: String,
}

impl ConsoleSocket {
    /// Create new console socket.
    ///
    /// Creates a Unix domain socket that libcontainer will connect to.
    ///
    /// # Arguments
    /// * `exec_id` - Unique execution ID for socket naming
    pub fn new(exec_id: &str) -> BoxliteResult<Self> {
        let socket_path = format!("/tmp/boxlite-console-{}.sock", exec_id);

        // Remove stale socket if exists
        let _ = std::fs::remove_file(&socket_path);

        let listener = UnixListener::bind(&socket_path).map_err(|e| {
            BoxliteError::Internal(format!("Failed to create console socket: {}", e))
        })?;

        tracing::debug!(socket_path = %socket_path, "Created console socket");

        Ok(Self {
            listener,
            socket_path,
        })
    }

    /// Get socket path for libcontainer.
    pub fn path(&self) -> &str {
        &self.socket_path
    }

    /// Receive PTY master FD from libcontainer.
    ///
    /// Waits for libcontainer to connect and send the PTY master file descriptor
    /// via SCM_RIGHTS ancillary message. Times out after [`PTY_HANDSHAKE_TIMEOUT`]
    /// to prevent indefinite blocking if libcontainer crashes or hangs.
    pub fn receive_pty_master(self) -> BoxliteResult<OwnedFd> {
        tracing::debug!("Waiting for console socket connection");

        // Set SO_RCVTIMEO on the listener so accept() doesn't block forever.
        Self::set_socket_timeout(self.listener.as_raw_fd(), PTY_HANDSHAKE_TIMEOUT);

        // Accept connection (bounded by timeout)
        let (stream, _) = self.listener.accept().map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut
            {
                BoxliteError::Internal(format!(
                    "Console socket accept timed out after {}s: \
                     libcontainer did not complete PTY handshake",
                    PTY_HANDSHAKE_TIMEOUT.as_secs()
                ))
            } else {
                BoxliteError::Internal(format!("Console socket accept failed: {}", e))
            }
        })?;

        tracing::debug!("Connection accepted, receiving PTY master FD");

        // Set timeout on the connected stream too
        Self::set_socket_timeout(stream.as_raw_fd(), PTY_HANDSHAKE_TIMEOUT);

        // Receive PTY master FD via SCM_RIGHTS
        let mut buf = [0u8; 1024];
        let mut iov = [IoSliceMut::new(&mut buf)];
        let mut cmsg_space = nix::cmsg_space!([RawFd; 1]);

        let msg = recvmsg::<UnixAddr>(
            stream.as_raw_fd(),
            &mut iov,
            Some(&mut cmsg_space),
            MsgFlags::empty(),
        )
        .map_err(|e| BoxliteError::Internal(format!("Failed to receive PTY master FD: {}", e)))?;

        // Extract FD from control messages
        for cmsg in msg.cmsgs().into_iter().flatten() {
            if let ControlMessageOwned::ScmRights(fds) = cmsg {
                if let Some(&fd) = fds.first() {
                    tracing::debug!(fd = fd, "Received PTY master FD");
                    return Ok(unsafe { OwnedFd::from_raw_fd(fd) });
                }
            }
        }

        Err(BoxliteError::Internal(
            "No PTY master FD received".to_string(),
        ))
    }

    /// Set `SO_RCVTIMEO` on a socket fd to bound blocking operations.
    fn set_socket_timeout(fd: RawFd, timeout: Duration) {
        let tv = nix::libc::timeval {
            tv_sec: timeout.as_secs() as _,
            tv_usec: 0,
        };
        // Best-effort: if setsockopt fails, the call proceeds without timeout
        // (existing behavior). This is non-fatal because the timeout is a safety
        // net, not a correctness requirement.
        unsafe {
            nix::libc::setsockopt(
                fd,
                nix::libc::SOL_SOCKET,
                nix::libc::SO_RCVTIMEO,
                &tv as *const _ as *const nix::libc::c_void,
                std::mem::size_of::<nix::libc::timeval>() as nix::libc::socklen_t,
            );
        }
    }
}

impl Drop for ConsoleSocket {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.socket_path) {
            tracing::warn!(
                socket_path = %self.socket_path,
                error = %e,
                "Failed to cleanup console socket"
            );
        } else {
            tracing::debug!(socket_path = %self.socket_path, "Cleaned up console socket");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_console_socket_lifecycle() {
        let exec_id = "test-exec-123";
        let socket = ConsoleSocket::new(exec_id).unwrap();

        assert!(socket.path().contains(exec_id));
        assert!(std::path::Path::new(socket.path()).exists());

        let path = socket.path().to_string();
        drop(socket);

        // Verify cleanup on drop
        assert!(!std::path::Path::new(&path).exists());
    }
}
