//! Host directory delivery to a single VM through its `vmm.sock`.
//!
//! Registration publishes `Preparing` before replying. A lost reply can be
//! reconciled with `list`. The caller owns guest acknowledgment and recovery.

use crate::vmm::vmm_socket::{self, ControlError, ControlOp, ControlReply};
use boxlite_vmm::ExportPhase;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

mod registry;
pub(crate) use registry::Registry;

// Include time queued behind an online disk resize in the exchange budget.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MountState {
    Preparing,
    Mounted,
    Detaching,
}

impl From<MountState> for ExportPhase {
    fn from(state: MountState) -> Self {
        match state {
            MountState::Preparing => ExportPhase::Preparing,
            MountState::Mounted => ExportPhase::Mounted,
            MountState::Detaching => ExportPhase::Detaching,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlMount {
    pub export: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
    pub state: MountState,
}

/// Blocking client. Each operation opens a connection for one exchange.
/// Call from `spawn_blocking` when using an async executor.
pub struct MountControlClient {
    path: PathBuf,
}

impl MountControlClient {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn exchange(&self, op: ControlOp, directory: Option<&File>) -> io::Result<ControlReply> {
        match vmm_socket::exchange(&self.path, op, directory, CONTROL_TIMEOUT)? {
            Ok(reply) => Ok(reply),
            Err(ControlError::Mount(errno)) => Err(io::Error::from_raw_os_error(errno)),
            Err(ControlError::Unsupported(message)) => {
                Err(io::Error::new(io::ErrorKind::Unsupported, message))
            }
            Err(ControlError::InvalidInput(message)) => {
                Err(io::Error::new(io::ErrorKind::InvalidInput, message))
            }
            Err(error) => Err(io::Error::other(error)),
        }
    }

    pub fn register(
        &self,
        source: String,
        target: String,
        file: File,
        read_only: bool,
    ) -> io::Result<ControlMount> {
        match self.exchange(
            ControlOp::RegisterMount {
                source,
                target,
                read_only,
            },
            Some(&file),
        )? {
            ControlReply::MountRegistered(mount) => Ok(mount),
            _ => Err(unexpected_reply()),
        }
    }

    pub fn list(&self) -> io::Result<Vec<ControlMount>> {
        match self.exchange(ControlOp::ListMounts, None)? {
            ControlReply::Mounts(mounts) => Ok(mounts),
            _ => Err(unexpected_reply()),
        }
    }

    pub fn set_state(&self, export: &str, state: MountState) -> io::Result<()> {
        match self.exchange(
            ControlOp::SetMountState {
                export: export.into(),
                state,
            },
            None,
        )? {
            ControlReply::MountUpdated => Ok(()),
            _ => Err(unexpected_reply()),
        }
    }

    pub fn remove(&self, export: &str) -> io::Result<()> {
        match self.exchange(
            ControlOp::RemoveMount {
                export: export.into(),
            },
            None,
        )? {
            ControlReply::MountUpdated => Ok(()),
            _ => Err(unexpected_reply()),
        }
    }
}

fn unexpected_reply() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "unexpected mount control response",
    )
}
