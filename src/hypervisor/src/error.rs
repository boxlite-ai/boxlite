// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hypervisor errors that keep the failed operation and its host cause.

use std::{error, fmt, io};

/// Result of a host hypervisor operation.
pub type Result<T> = std::result::Result<T, Error>;

/// A failed host hypervisor operation.
///
/// Each variant names the operation and the resource it acted on. The host
/// cause is an `io::Error`: `errno` on KVM, and the `hv_return_t` on HVF.
/// Backends report a host that cannot run VMs as
/// [`io::ErrorKind::Unsupported`], and missing access to the hypervisor as
/// [`io::ErrorKind::PermissionDenied`].
#[derive(Debug)]
pub enum Error {
    /// Creating the VM or its in-kernel interrupt controller failed.
    CreateVm(io::Error),
    /// Mapping host memory into the guest failed.
    MapMemory {
        guest_addr: u64,
        size: usize,
        source: io::Error,
    },
    /// Removing a guest memory mapping failed.
    UnmapMemory {
        guest_addr: u64,
        size: usize,
        source: io::Error,
    },
    /// Creating a vCPU failed.
    CreateVcpu { id: u32, source: io::Error },
    /// Entering the guest failed.
    RunVcpu { id: u32, source: io::Error },
    /// Forcing a vCPU out of the guest failed.
    KickVcpu { id: u32, source: io::Error },
    /// Setting an interrupt line failed.
    SetIrqLine { line: u32, source: io::Error },
    /// The guest exited for a reason the backend does not handle.
    UnhandledExit {
        id: u32,
        /// The backend's description of the exit, for diagnostics only. Raw
        /// exit reasons and ARM exception syndromes stay inside the backend.
        reason: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CreateVm(_) => f.write_str("failed to create the VM"),
            Self::MapMemory {
                guest_addr, size, ..
            } => write!(
                f,
                "failed to map {size} bytes at guest address {guest_addr:#x}"
            ),
            Self::UnmapMemory {
                guest_addr, size, ..
            } => write!(
                f,
                "failed to unmap {size} bytes at guest address {guest_addr:#x}"
            ),
            Self::CreateVcpu { id, .. } => write!(f, "failed to create vCPU {id}"),
            Self::RunVcpu { id, .. } => write!(f, "failed to run vCPU {id}"),
            Self::KickVcpu { id, .. } => write!(f, "failed to kick vCPU {id}"),
            Self::SetIrqLine { line, .. } => write!(f, "failed to set interrupt line {line}"),
            Self::UnhandledExit { id, reason } => {
                write!(f, "vCPU {id} exited for an unhandled reason: {reason}")
            }
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::CreateVm(source)
            | Self::MapMemory { source, .. }
            | Self::UnmapMemory { source, .. }
            | Self::CreateVcpu { source, .. }
            | Self::RunVcpu { source, .. }
            | Self::KickVcpu { source, .. }
            | Self::SetIrqLine { source, .. } => Some(source),
            Self::UnhandledExit { .. } => None,
        }
    }
}
