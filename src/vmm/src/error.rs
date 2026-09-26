// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! VMM errors.

use std::{error, fmt};

/// Result of a VMM operation.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A failure that ends the VM.
///
/// The cause chain stays intact through [`error::Error::source`], so callers
/// can tell a host that cannot run VMs from other failures.
#[derive(Debug)]
pub enum Error {
    /// A host hypervisor operation failed.
    Hypervisor(boxlite_hypervisor::Error),
    /// A device window was registered over an existing one.
    Overlap {
        /// Base address of the rejected window.
        base: u64,
        /// Size of the rejected window.
        size: u64,
    },
    /// A device window that is not addressable: its range ends outside the
    /// address space, so dispatch could never cover it soundly.
    InvalidWindow {
        /// Base address or port of the rejected window.
        base: u64,
        /// Size of the rejected window.
        size: u64,
    },
    /// A guest access hit an address with no device behind it.
    Unmapped {
        /// Faulting guest physical address.
        addr: u64,
    },
    /// An x86_64 port window was registered over an existing one.
    IoOverlap {
        /// Base port of the rejected window.
        port: u16,
        /// Size of the rejected window.
        size: u16,
    },
    /// A guest port access hit a port with no device behind it.
    IoUnmapped {
        /// Faulting port.
        port: u16,
    },
    /// A device's lock was poisoned by a panicking thread.
    DevicePoisoned {
        /// Address of the access that met the poisoned lock.
        addr: u64,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hypervisor(_) => f.write_str("hypervisor operation failed"),
            Self::Overlap { base, size } => {
                write!(f, "device at {base:#x}+{size} overlaps an existing device")
            }
            Self::InvalidWindow { base, size } => {
                write!(
                    f,
                    "device window {base:#x}+{size} does not fit the address space"
                )
            }
            Self::Unmapped { addr } => write!(f, "no device at guest address {addr:#x}"),
            Self::IoOverlap { port, size } => write!(
                f,
                "device at port {port:#04x}+{size} overlaps an existing device"
            ),
            Self::IoUnmapped { port } => write!(f, "no device at port {port:#04x}"),
            Self::DevicePoisoned { addr } => write!(f, "device at {addr:#x} is poisoned"),
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::Hypervisor(source) => Some(source),
            // The bus variants name their resource in Display and carry no
            // host cause.
            Self::Overlap { .. }
            | Self::InvalidWindow { .. }
            | Self::Unmapped { .. }
            | Self::IoOverlap { .. }
            | Self::IoUnmapped { .. }
            | Self::DevicePoisoned { .. } => None,
        }
    }
}

impl From<boxlite_hypervisor::Error> for Error {
    fn from(source: boxlite_hypervisor::Error) -> Self {
        Self::Hypervisor(source)
    }
}

#[cfg(test)]
mod tests {
    use std::{error::Error as _, io};

    use super::Error;

    #[test]
    fn keeps_the_host_cause_through_the_hypervisor_error() {
        for kind in [io::ErrorKind::Unsupported, io::ErrorKind::PermissionDenied] {
            let host = io::Error::from(kind);
            let error = Error::from(boxlite_hypervisor::Error::CreateVm(host));

            assert_eq!(error.to_string(), "hypervisor operation failed");
            let hypervisor = error.source().expect("hypervisor error");
            assert_eq!(hypervisor.to_string(), "failed to create the VM");
            let cause = hypervisor
                .source()
                .and_then(|cause| cause.downcast_ref::<io::Error>())
                .expect("host cause");
            assert_eq!(cause.kind(), kind);
        }
    }
}
