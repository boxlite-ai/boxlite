//! Host directory delivery to a single VM through its `vmm.sock`.
//!
//! The shim keeps exports, not state. Registration publishes an export before
//! replying; a client whose reply was lost finds it again by request ID.

use crate::vmm::vmm_socket::{self, ControlError, ControlOp, ControlReply};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

mod registry;
pub(crate) use registry::Registry;

// Include time queued behind an online disk resize in the exchange budget.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) type MountRequestId = [u8; 16];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlMount {
    pub export: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
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
        self.register_with_request_id(source, target, file, read_only, None)
    }

    pub(crate) fn register_with_request_id(
        &self,
        source: String,
        target: String,
        file: File,
        read_only: bool,
        request_id: Option<MountRequestId>,
    ) -> io::Result<ControlMount> {
        match self.exchange(
            ControlOp::RegisterMount {
                source,
                target,
                read_only,
                request_id,
            },
            Some(&file),
        )? {
            ControlReply::MountRegistered(mount) => Ok(mount),
            _ => Err(unexpected_reply()),
        }
    }

    /// The export registered under `request_id`, if any.
    pub(crate) fn find_registered(
        &self,
        request_id: MountRequestId,
    ) -> io::Result<Option<ControlMount>> {
        match self.exchange(ControlOp::FindRegisteredMount { request_id }, None)? {
            ControlReply::RegisteredMount(mount) => Ok(mount),
            _ => Err(unexpected_reply()),
        }
    }

    pub fn list(&self) -> io::Result<Vec<ControlMount>> {
        match self.exchange(ControlOp::ListMounts, None)? {
            ControlReply::Mounts(mounts) => Ok(mounts),
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
