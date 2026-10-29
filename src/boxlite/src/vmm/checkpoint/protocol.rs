//! Wire format of the checkpoint control socket.
//!
//! One request per connection: the host writes one JSON line, the shim
//! answers with one JSON line and closes. A connection therefore never
//! carries state across requests, so a host that lost a reply reconnects and
//! asks [`ControlRequest::State`] instead of guessing.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};

/// Upper bound for one request or reply line, newline included.
///
/// Messages are a few hundred bytes; the cap only stops a peer from making
/// the other side buffer without limit.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// What the snapshot VM owner reports about the guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "exit_code")]
pub enum VmRunState {
    /// Checkpointing is set up but the VM was not started yet.
    Configured,
    /// The VM is booting or importing.
    Starting,
    Running,
    Paused,
    /// The guest ended on its own with this exit code.
    Exited(i32),
    /// A device or memory failure ended the VM.
    Failed,
    /// The owner was stopped (host request or teardown).
    Stopped,
}

impl VmRunState {
    /// Whether the VM is gone for good.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Exited(_) | Self::Failed | Self::Stopped)
    }
}

impl std::fmt::Display for VmRunState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configured => f.write_str("configured"),
            Self::Starting => f.write_str("starting"),
            Self::Running => f.write_str("running"),
            Self::Paused => f.write_str("paused"),
            Self::Exited(code) => write!(f, "exited({code})"),
            Self::Failed => f.write_str("failed"),
            Self::Stopped => f.write_str("stopped"),
        }
    }
}

/// A host request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "op")]
pub enum ControlRequest {
    /// Switch to generation-2 descriptor frames on this dedicated connection.
    Session {
        operation: [u8; 16],
    },
    /// Read the owner's state. Never waits for a mutation in progress.
    State,
    /// Stop the vCPUs and devices at a consistent cut.
    ///
    /// `host_writers_stopped` is the caller's assertion that nothing on the
    /// host writes external shared directories until the guest resumes.
    Pause {
        host_writers_stopped: bool,
    },
    Resume,
    /// Write the paused VM's raw image to `name` inside the shim's export
    /// directory. A single file name, never a path: the shim decides where.
    ExportRaw {
        name: String,
    },
    /// End the VM, paused or not, without a guest RPC.
    Stop,
    /// Where an imported VM keeps its copy of share `tag`. A read, never
    /// queued behind a mutation.
    RestoredShare {
        tag: String,
    },
}

/// A mutation the owner is carrying out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Capture,
    Pause,
    Resume,
    ExportRaw,
}

impl std::fmt::Display for Operation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Capture => "capture",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::ExportRaw => "export",
        })
    }
}

/// Generation-2 requests carry descriptors separately from bounded JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "op")]
pub enum DescriptorRequest {
    Capabilities,
    Begin {
        disk_only: bool,
    },
    Prepare {
        token: u64,
    },
    Export {
        token: u64,
        metadata: serde_json::Value,
    },
    End {
        token: u64,
        cancel: bool,
    },
    Import {
        bindings: serde_json::Value,
    },
    Inspect,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DescriptorReply {
    pub state: VmRunState,
    pub error: Option<ControlFailure>,
    pub metadata: serde_json::Value,
}

/// Why a request did not succeed. `ControlReply::state` tells where the VM
/// is now; these kinds only say what to tell the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// Another mutation is in progress; this one was not started.
    Busy,
    /// Not valid in the current state or with these arguments; nothing done.
    Rejected,
    /// Writing the export failed; the VM is still paused.
    Io,
    /// The owner failed the operation.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlFailure {
    pub kind: FailureKind,
    pub message: String,
}

/// The shim's answer, built only after the owner finished the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlReply {
    /// The owner's state after the request.
    pub state: VmRunState,
    /// The mutation still running when this reply was built, if any.
    #[serde(default)]
    pub in_flight: Option<Operation>,
    /// Mutations started so far. Two replies with the same count saw no
    /// pause, resume or export begin between them.
    #[serde(default)]
    pub mutations: u64,
    #[serde(default)]
    pub error: Option<ControlFailure>,
    /// The answer to [`ControlRequest::RestoredShare`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<std::path::PathBuf>,
}

/// Serialize `message` as one line.
pub fn write_line<T: Serialize>(writer: &mut impl Write, message: &T) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(message).map_err(std::io::Error::other)?;
    line.push(b'\n');
    if line.len() > MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "control message exceeds the size limit",
        ));
    }
    writer.write_all(&line)?;
    writer.flush()
}

/// Read one line of at most [`MAX_MESSAGE_BYTES`] and parse it.
///
/// A missing newline (peer closed early) or an oversized line is an error:
/// a half message must never be taken for a whole one.
pub fn read_line<T: for<'de> Deserialize<'de>>(reader: &mut impl BufRead) -> std::io::Result<T> {
    let mut line = Vec::new();
    std::io::Read::take(&mut *reader, MAX_MESSAGE_BYTES as u64).read_until(b'\n', &mut line)?;
    parse_line(&line)
}

/// Parse a complete line read by any transport.
pub fn parse_line<T: for<'de> Deserialize<'de>>(line: &[u8]) -> std::io::Result<T> {
    let Some(body) = line.strip_suffix(b"\n") else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "control message ended before its newline",
        ));
    };
    serde_json::from_slice(body)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_protocol_round_trips_and_refuses_partial_lines() {
        let request = ControlRequest::ExportRaw {
            name: "vm.img".into(),
        };
        let mut wire = Vec::new();
        write_line(&mut wire, &request).unwrap();
        assert_eq!(wire.last(), Some(&b'\n'));
        let back: ControlRequest = read_line(&mut wire.as_slice()).unwrap();
        assert_eq!(back, request);

        let reply = ControlReply {
            state: VmRunState::Exited(3),
            in_flight: None,
            mutations: 2,
            error: None,
            share: Some("/box/restored/fs/0".into()),
        };
        let mut wire = Vec::new();
        write_line(&mut wire, &reply).unwrap();
        let back: ControlReply = read_line(&mut wire.as_slice()).unwrap();
        assert_eq!(back, reply);

        // A peer that closed before the newline sent no message at all.
        let truncated = &wire[..wire.len() - 1];
        let err = read_line::<ControlReply>(&mut &truncated[..]).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);

        // An endless line stops at the cap instead of growing the buffer.
        let endless = vec![b'x'; MAX_MESSAGE_BYTES * 2];
        assert!(read_line::<ControlReply>(&mut endless.as_slice()).is_err());
    }
}
