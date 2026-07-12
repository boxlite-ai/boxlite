//! Tee an exec's stdout/stderr pipe (or PTY master) into a log file while
//! still forwarding the live bytes to whoever consumes the
//! [`crate::service::exec::exec_handle::ExecHandle`].
//!
//! Why: `boxlite run` runs the user's command as a tenant `exec` inside the
//! container, not as the container's PID 1. The exec's stdout fd is a pipe
//! that the gRPC `Attach` consumer drains. When the CLI detaches
//! (`boxlite run -d`) nobody attaches and the bytes pile up in the pipe
//! buffer until the user later attaches — or never appear at all if the
//! command exited without an attach.
//!
//! This module inserts a single always-on reader between the kernel pipe
//! and the consumer-facing fd: it forks the stream into the log file (an
//! append-only file on the `/run/boxlite/shared` virtio-fs share, host-
//! visible as `<box_dir>/shared/container.log`) and a new pipe whose
//! read-end takes the original's place in `ExecHandle`. Consumers see the
//! same bytes; the file gets a persistent copy.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::unistd::pipe;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::io::{AsRawFd, OwnedFd};
use std::path::PathBuf;

/// Single-file location the guest tees every exec's stream into. Path is
/// inside the virtio-fs share, so writes here surface to the host at
/// `<box_dir>/shared/container.log` (the host-visible path the CLI's
/// `boxlite logs` reads).
pub const CONTAINER_LOG_PATH: &str = "/run/boxlite/shared/container.log";

/// Wrap a child-process output fd so its bytes ALSO land in `log_path`.
///
/// Returns a new fd (the read-end of an internal relay pipe). The caller
/// hands this new fd to `ExecHandle::new` instead of `source_fd`; the gRPC
/// attach stream then reads from the relay pipe and is byte-for-byte
/// identical to what the original pipe carried.
///
/// `source_fd` must be readable (a pipe read-end or a PTY master). The
/// background thread closes its end on EOF / error and drops out cleanly.
/// If `log_path` can't be opened (e.g. running outside a real box where
/// the virtio-fs share doesn't exist), the function logs a warning and
/// returns the original fd unchanged — never blocks a working exec on
/// log-file plumbing.
pub(crate) fn wrap_with_tee(source_fd: OwnedFd, log_path: PathBuf) -> BoxliteResult<OwnedFd> {
    let log = match OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(f) => f,
        Err(e) => {
            // Best-effort: hand back the original fd so exec still works.
            tracing::warn!(
                path = %log_path.display(),
                error = %e,
                "exec tee disabled — could not open log file; output will not be captured for `boxlite logs`"
            );
            return Ok(source_fd);
        }
    };
    let (relay_read, relay_write) =
        pipe().map_err(|e| BoxliteError::Internal(format!("Failed to create relay pipe: {e}")))?;
    spawn_tee_thread(source_fd, relay_write, log, log_path);
    Ok(relay_read)
}

/// One OS thread per stream. Reads from `src`, writes to BOTH the relay pipe
/// `relay` (so the gRPC consumer sees the bytes) AND `log` (so `boxlite
/// logs` sees them later, even if no one ever attached). `fsync` after each
/// batch is the load-bearing call on virtio-fs: without it the host sees
/// the appended bytes only when the file is finally closed.
fn spawn_tee_thread(src: OwnedFd, relay: OwnedFd, mut log: std::fs::File, log_path: PathBuf) {
    std::thread::spawn(move || {
        let log_fd = log.as_raw_fd();
        let mut src = std::fs::File::from(src);
        let mut relay = std::fs::File::from(relay);
        let mut buf = [0u8; 4096];
        loop {
            match src.read(&mut buf) {
                Ok(0) => break, // EOF — child closed its write-end
                Ok(n) => {
                    // File first: it's local disk + virtio-fs, fast and
                    // unaffected by gRPC backpressure. The relay write
                    // can block if the gRPC consumer is slow; we accept
                    // that — backpressure is the existing behaviour, and
                    // the log captures the bytes regardless.
                    if let Err(e) = log.write_all(&buf[..n]) {
                        tracing::warn!(path = %log_path.display(), error = %e, "exec log write failed");
                    } else {
                        let _ = nix::unistd::fsync(log_fd);
                    }
                    if relay.write_all(&buf[..n]).is_err() {
                        // Consumer dropped (CLI detached, attach closed) —
                        // keep draining `src` into the file so the log
                        // stays complete even with no live consumer.
                        loop {
                            match src.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    if log.write_all(&buf[..n]).is_ok() {
                                        let _ = nix::unistd::fsync(log_fd);
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        break;
                    }
                }
                Err(_) => break, // EIO on closed PTY master, etc.
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::io::AsRawFd;

    /// File path that can't be opened (no such directory) → tee disables
    /// itself and returns the original fd; exec must keep working.
    #[test]
    fn wrap_with_tee_returns_source_when_log_unopenable() {
        use nix::unistd::pipe;
        let (rx, _tx) = pipe().unwrap();
        let raw_before = rx.as_raw_fd();
        let result = wrap_with_tee(rx, PathBuf::from("/nonexistent/dir/x.log")).unwrap();
        assert_eq!(
            result.as_raw_fd(),
            raw_before,
            "fallback must hand back the same fd, not a fresh pipe"
        );
    }

    /// End-to-end fanout: bytes written to the source-side write-end show
    /// up both on the relay read-end (what the gRPC consumer sees) and in
    /// the log file (what `boxlite logs` will read).
    #[test]
    fn wrap_with_tee_writes_to_both_relay_and_file() {
        use nix::unistd::pipe;
        use std::io::Read as _;
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("container.log");
        let (src_rx, src_tx) = pipe().unwrap();

        // Wrap the source: caller passes src_rx and gets back a relay read-end.
        let relay_rx = wrap_with_tee(src_rx, log_path.clone()).unwrap();

        // Simulate the child writing through src_tx.
        nix::unistd::write(&src_tx, b"TEE_PAYLOAD\n").unwrap();
        // Close the write-end so the tee thread exits on EOF and drops `log`,
        // flushing any buffered bytes.
        drop(src_tx);

        // Consumer side — reads from the relay (the new "stdout" fd).
        let mut consumer = std::fs::File::from(relay_rx);
        let mut got = String::new();
        consumer.read_to_string(&mut got).unwrap();
        assert!(
            got.contains("TEE_PAYLOAD"),
            "relay missing payload: {got:?}"
        );

        // File side — reads independently.
        // Brief poll: the tee thread is async; give it up to 2 s.
        for _ in 0..100 {
            let body = std::fs::read_to_string(&log_path).unwrap_or_default();
            if body.contains("TEE_PAYLOAD") {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!(
            "log file never received payload: {:?}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
    }
}
