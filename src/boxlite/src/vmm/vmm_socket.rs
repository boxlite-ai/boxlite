//! The host's control channel to a running shim.
//!
//! The shim serves one Unix socket, `vmm.sock` in the box's socket
//! directory, for runtime operations on the VMM it hosts. The socket is
//! host-only (mode 0600, never bridged into guest vsock) and at a fixed path,
//! so a runtime that restarts can still reach a running box. Each connection
//! carries one request and one response: a 4-byte little-endian length, then
//! a JSON object of at most [`MAX_FRAME`] bytes. Requests name [`VERSION`];
//! a shim answers any other version, or an operation its engine lacks, with
//! [`ControlError::Unsupported`].

use std::io;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(any(
    test,
    feature = "krun",
    all(feature = "native", target_os = "linux", target_arch = "x86_64")
))]
mod server;

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub(crate) use server::serve;

#[cfg(all(test, feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub(crate) use server::request;

#[cfg(feature = "krun")]
pub(crate) use server::{bind_owner, serve_bound};

/// The protocol version a request names.
pub(crate) const VERSION: u32 = 1;
/// The largest frame either side accepts.
const MAX_FRAME: u32 = 4096;
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
    ResizeDisk {
        block_id: String,
        bytes: u64,
    },
    DiskSnapshot(super::live_snapshot::Request),
}

/// The shim's answer.
pub(crate) type ControlResponse = Result<ControlReply, ControlError>;

/// What a successful operation reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ControlReply {
    /// The disk's size in bytes after the operation.
    DiskSize(u64),
    DiskSnapshot(super::live_snapshot::Phase),
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

pub(crate) async fn request_from_shim(
    path: &Path,
    request: &ControlRequest,
    identity: crate::util::PidRecord,
    timeout: Duration,
) -> io::Result<(ControlResponse, crate::util::PidRecord)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    tokio::time::timeout(timeout, async {
        let mut stream = tokio::net::UnixStream::connect(path).await?;
        let peer = stream
            .peer_cred()?
            .pid()
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|&pid| is_shim_peer(pid, identity))
            .and_then(|pid| {
                crate::util::process_start_time(pid).map(|start_time| crate::util::PidRecord {
                    pid,
                    start_time: Some(start_time),
                })
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "unexpected VMM socket peer",
                )
            })?;

        let frame = serde_json::to_vec(request)?;
        let size = checked_size(frame.len())?;
        stream.write_all(&size.to_le_bytes()).await?;
        stream.write_all(&frame).await?;

        let size = stream.read_u32_le().await?;
        if size > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "control frame too large",
            ));
        }
        let mut response = vec![0; size as usize];
        stream.read_exact(&mut response).await?;
        Ok((serde_json::from_slice(&response)?, peer))
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "VMM control request timed out"))?
}

#[cfg(target_os = "linux")]
fn is_shim_peer(mut peer: u32, identity: crate::util::PidRecord) -> bool {
    // Bubblewrap's bound socket belongs to the jailed descendant of the recorded process.
    for _ in 0..8 {
        if peer == identity.pid {
            return identity.start_time.is_some()
                && crate::util::process_start_time(peer) == identity.start_time;
        }
        let parent = std::fs::read_to_string(format!("/proc/{peer}/status"))
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix("PPid:"))
                    .and_then(|pid| pid.trim().parse::<u32>().ok())
            });
        let Some(parent) = parent.filter(|&pid| pid > 1 && pid != peer) else {
            return false;
        };
        peer = parent;
    }
    false
}

#[cfg(not(target_os = "linux"))]
fn is_shim_peer(peer: u32, identity: crate::util::PidRecord) -> bool {
    peer == identity.pid
        && identity.start_time.is_some()
        && crate::util::process_start_time(peer) == identity.start_time
}

fn checked_size(size: usize) -> io::Result<u32> {
    u32::try_from(size)
        .ok()
        .filter(|length| *length <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "control frame too large"))
}
