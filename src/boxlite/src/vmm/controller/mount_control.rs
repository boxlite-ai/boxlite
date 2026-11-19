//! Descriptor delivery and authoritative records for one VM incarnation.
//!
//! Registration publishes `Preparing` before replying; a lost reply must be
//! reconciled through `list`. Retirement requires `Detaching`; the caller owns
//! guest acknowledgment and recovery. Transport errors poison the connection.

use boxlite_shared::constants::mount_tags::MOUNT_CONTROL_PREFACE;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
mod server;
mod transport;
#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
pub use server::serve;
#[cfg(test)]
mod tests;

const MAX_FRAME: usize = 64 * 1024;
const ACK: &[u8] = b"OK\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MountState {
    Preparing,
    Mounted,
    Detaching,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlMount {
    pub export: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
    pub state: MountState,
}

#[derive(Debug, Serialize, Deserialize)]
enum Request {
    Register {
        source: String,
        target: String,
        read_only: bool,
    },
    List,
    SetState {
        export: String,
        state: MountState,
    },
    Remove {
        export: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
enum Response {
    Registered(ControlMount),
    List(Vec<ControlMount>),
    Ok,
    Error { errno: i32, context: String },
}

/// Blocking Unix client. Move into `spawn_blocking` when called from async code.
/// A failed exchange closes the stream; requests are never retried implicitly.
pub struct MountControlClient {
    stream: Option<UnixStream>,
}

impl MountControlClient {
    /// Connect and negotiate within one five-second budget, including a full
    /// listener backlog. This method blocks the calling thread.
    pub fn connect_at(path: impl AsRef<Path>) -> io::Result<Self> {
        // Connection establishment and protocol negotiation share one budget.
        let deadline = transport::deadline();
        let stream = transport::connect(path.as_ref(), deadline)?;
        transport::configure(&stream)?;
        transport::send_bytes(&stream, MOUNT_CONTROL_PREFACE, None, deadline)?;
        let mut ack = [0; 3];
        let mut descriptors = Vec::new();
        transport::receive_exact(&stream, &mut ack, &mut descriptors, deadline)?;
        if ack != ACK || !descriptors.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "mount control acknowledgment",
            ));
        }
        Ok(Self {
            stream: Some(stream),
        })
    }

    fn exchange(&mut self, request: Request, file: Option<&File>) -> io::Result<Response> {
        let result = (|| {
            let stream = self.stream.as_ref().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotConnected,
                    "mount control connection poisoned",
                )
            })?;
            let payload = serde_json::to_vec(&request)?;
            let deadline = transport::deadline();
            transport::send_frame(stream, &payload, file.map(AsRawFd::as_raw_fd), deadline)?;
            let (payload, descriptors) = transport::receive_frame(stream, deadline)?;
            if !descriptors.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "descriptor in mount control response",
                ));
            }
            serde_json::from_slice(&payload).map_err(io::Error::from)
        })();
        if result.is_err() {
            self.stream.take();
        }
        match result? {
            Response::Error { errno, context } => {
                tracing::debug!(errno, context, "mount control request rejected");
                Err(io::Error::from_raw_os_error(errno))
            }
            response => Ok(response),
        }
    }

    fn unexpected(&mut self) -> io::Error {
        self.stream.take();
        io::Error::new(
            io::ErrorKind::InvalidData,
            "unexpected mount control response",
        )
    }

    pub fn register(
        &mut self,
        source: String,
        target: String,
        file: File,
        read_only: bool,
    ) -> io::Result<ControlMount> {
        match self.exchange(
            Request::Register {
                source,
                target,
                read_only,
            },
            Some(&file),
        )? {
            Response::Registered(mount) => Ok(mount),
            _ => Err(self.unexpected()),
        }
    }

    pub fn list(&mut self) -> io::Result<Vec<ControlMount>> {
        match self.exchange(Request::List, None)? {
            Response::List(mounts) => Ok(mounts),
            _ => Err(self.unexpected()),
        }
    }

    pub fn set_state(&mut self, export: &str, state: MountState) -> io::Result<()> {
        match self.exchange(
            Request::SetState {
                export: export.into(),
                state,
            },
            None,
        )? {
            Response::Ok => Ok(()),
            _ => Err(self.unexpected()),
        }
    }

    pub fn remove(&mut self, export: &str) -> io::Result<()> {
        match self.exchange(
            Request::Remove {
                export: export.into(),
            },
            None,
        )? {
            Response::Ok => Ok(()),
            _ => Err(self.unexpected()),
        }
    }
}
