//! Host side of the checkpoint control socket.

use super::protocol::{ControlReply, ControlRequest, MAX_MESSAGE_BYTES, parse_line};
use super::{
    descriptors,
    protocol::{DescriptorReply, DescriptorRequest, write_line},
};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// Deadline for state, pause, resume and stop replies.
///
/// Pausing quiesces devices and resuming restarts them; both finish in well
/// under a second on a healthy owner. Thirty seconds leaves room for a loaded
/// host without letting a stuck owner hold the caller indefinitely.
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

/// Deadline for reaching the socket at all.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a request produced no reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlError {
    /// The request was never delivered whole, so the owner did nothing.
    Unavailable(String),
    /// The request was delivered but no complete reply came back (timeout,
    /// disconnect, garbage). The owner may or may not have acted.
    Uncertain(String),
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(m) => write!(f, "checkpoint control unavailable: {m}"),
            Self::Uncertain(m) => write!(f, "checkpoint control outcome unknown: {m}"),
        }
    }
}

/// Talks to one box's control socket.
#[derive(Debug, Clone)]
pub struct ControlClient {
    socket: PathBuf,
}

impl ControlClient {
    /// One descriptor request; no retry after delivery or uncertain reply.
    pub async fn descriptors(
        &self,
        request: DescriptorRequest,
        files: Vec<OwnedFd>,
    ) -> Result<(DescriptorReply, Vec<OwnedFd>), ControlError> {
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(&self.socket))
            .await
            .map_err(|_| ControlError::Unavailable("descriptor connect timed out".into()))?
            .map_err(|e| ControlError::Unavailable(e.to_string()))?
            .into_std()
            .map_err(|e| ControlError::Unavailable(e.to_string()))?;
        stream
            .set_nonblocking(false)
            .map_err(|e| ControlError::Unavailable(e.to_string()))?;
        tokio::task::spawn_blocking(move || {
            stream
                .set_write_timeout(Some(CONTROL_TIMEOUT))
                .map_err(|e| ControlError::Unavailable(e.to_string()))?;
            stream
                .set_read_timeout(Some(CONTROL_TIMEOUT))
                .map_err(|e| ControlError::Unavailable(e.to_string()))?;
            let operation = *uuid::Uuid::new_v4().as_bytes();
            write_line(&mut &stream, &ControlRequest::Session { operation })
                .map_err(|e| ControlError::Uncertain(e.to_string()))?;
            descriptors::send(&stream, operation, &request, &files).map_err(|e| {
                ControlError::Uncertain(format!(
                    "generation-2 control (restart an older shim): {e}"
                ))
            })?;
            if matches!(request, DescriptorRequest::Export { .. }) {
                stream
                    .set_read_timeout(None)
                    .map_err(|e| ControlError::Uncertain(e.to_string()))?;
            }
            descriptors::receive(&stream, operation)
                .map_err(|e| ControlError::Uncertain(e.to_string()))
        })
        .await
        .map_err(|e| ControlError::Uncertain(e.to_string()))?
    }

    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Send `request` with its standard deadline.
    pub async fn send(&self, request: &ControlRequest) -> Result<ControlReply, ControlError> {
        self.send_with_deadline(request, Some(CONTROL_TIMEOUT))
            .await
    }

    /// Send `request` on a fresh connection and wait up to `deadline` for the
    /// reply. Never retries: retrying an export could write it twice.
    pub async fn send_with_deadline(
        &self,
        request: &ControlRequest,
        deadline: Option<Duration>,
    ) -> Result<ControlReply, ControlError> {
        let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(&self.socket))
            .await
            .map_err(|_| ControlError::Unavailable("connect timed out".into()))?
            .map_err(|e| {
                ControlError::Unavailable(format!("connect {}: {e}", self.socket.display()))
            })?;

        let mut line = serde_json::to_vec(request)
            .map_err(|e| ControlError::Unavailable(format!("encode request: {e}")))?;
        line.push(b'\n');
        // The newline goes last, so a failed write never delivered a request
        // the shim would act on.
        tokio::time::timeout(CONNECT_TIMEOUT, stream.write_all(&line))
            .await
            .map_err(|_| ControlError::Unavailable("request write timed out".into()))?
            .map_err(|e| ControlError::Unavailable(format!("request write: {e}")))?;

        let read = async {
            let mut reply = Vec::new();
            BufReader::new(stream)
                .take(MAX_MESSAGE_BYTES as u64)
                .read_until(b'\n', &mut reply)
                .await
                .map_err(|e| ControlError::Uncertain(format!("reply read: {e}")))?;
            parse_line::<ControlReply>(&reply)
                .map_err(|e| ControlError::Uncertain(format!("reply: {e}")))
        };
        match deadline {
            Some(deadline) => tokio::time::timeout(deadline, read).await.map_err(|_| {
                ControlError::Uncertain(format!("no reply within {}s", deadline.as_secs()))
            })?,
            None => read.await,
        }
    }
}
