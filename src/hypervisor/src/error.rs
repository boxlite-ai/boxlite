// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hypervisor errors that keep the failed operation and its host cause.

use std::{error, fmt, io};

/// Result of a host hypervisor operation.
pub type Result<T> = std::result::Result<T, Error>;

/// A failed host hypervisor operation.
///
/// Each variant names the operation and the resource it acted on. The host
/// cause is an `io::Error`: `errno` on KVM, the `hv_return_t` on HVF, and the
/// `HRESULT` on WHP.
/// Backends report a host that cannot run VMs as
/// [`io::ErrorKind::Unsupported`], and missing access to the hypervisor as
/// [`io::ErrorKind::PermissionDenied`].
#[derive(Debug)]
pub enum Error {
    /// Creating the VM or its interrupt controller failed.
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
    /// Completing a handled device access without running the guest failed.
    CompletePendingIo { id: u32, source: io::Error },
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
            Self::CompletePendingIo { id, .. } => {
                write!(f, "failed to complete pending I/O for vCPU {id}")
            }
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
            | Self::CompletePendingIo { source, .. }
            | Self::KickVcpu { source, .. }
            | Self::SetIrqLine { source, .. } => Some(source),
            Self::UnhandledExit { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{error::Error as _, io};

    use super::Error;

    #[test]
    fn host_errors_identify_the_operation_and_preserve_the_cause() {
        let denied = || io::Error::new(io::ErrorKind::PermissionDenied, "hypervisor access denied");
        let cases = [
            (Error::CreateVm(denied()), "failed to create the VM"),
            (
                Error::MapMemory {
                    guest_addr: 0x8000_1000,
                    size: 4096,
                    source: denied(),
                },
                "failed to map 4096 bytes at guest address 0x80001000",
            ),
            (
                Error::UnmapMemory {
                    guest_addr: 0x9000_2000,
                    size: 8192,
                    source: denied(),
                },
                "failed to unmap 8192 bytes at guest address 0x90002000",
            ),
            (
                Error::CreateVcpu {
                    id: 3,
                    source: denied(),
                },
                "failed to create vCPU 3",
            ),
            (
                Error::RunVcpu {
                    id: 5,
                    source: denied(),
                },
                "failed to run vCPU 5",
            ),
            (
                Error::CompletePendingIo {
                    id: 6,
                    source: denied(),
                },
                "failed to complete pending I/O for vCPU 6",
            ),
            (
                Error::KickVcpu {
                    id: 7,
                    source: denied(),
                },
                "failed to kick vCPU 7",
            ),
            (
                Error::SetIrqLine {
                    line: 34,
                    source: denied(),
                },
                "failed to set interrupt line 34",
            ),
        ];

        for (error, message) in cases {
            assert_eq!(error.to_string(), message);
            let cause = error
                .source()
                .and_then(|source| source.downcast_ref::<io::Error>())
                .expect("original host error");
            assert_eq!(cause.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(cause.to_string(), "hypervisor access denied");
        }
    }

    #[test]
    fn unhandled_exit_identifies_the_vcpu_and_reason_without_a_host_cause() {
        let error = Error::UnhandledExit {
            id: 9,
            reason: "unrecognized exception syndrome 0x96000000".into(),
        };

        assert_eq!(
            error.to_string(),
            "vCPU 9 exited for an unhandled reason: unrecognized exception syndrome 0x96000000"
        );
        assert!(error.source().is_none());
    }
}
