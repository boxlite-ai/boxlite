// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! VMM errors.

use std::{error, fmt, io, path::PathBuf};

/// Result of a VMM operation.
pub(crate) type Result<T> = std::result::Result<T, Error>;

/// A failure that ends the VM.
///
/// The cause chain stays intact through [`error::Error::source`], so callers
/// can tell a host that cannot run VMs from other failures.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Only the unwired Vm::new and boot::prepare build these."
    )
)]
pub(crate) enum Error {
    /// The vCPU count is outside `1..=config::MAX_VCPUS`.
    InvalidVcpuCount(u8),
    /// The RAM size is outside `1..=memory::MAX_MEMORY_MIB`.
    InvalidMemorySize(u32),
    /// Allocating the guest RAM failed.
    AllocateMemory { bytes: u64, source: io::Error },
    /// A host hypervisor operation failed.
    Hypervisor(boxlite_hypervisor::Error),
    /// The kernel command line is too long or not printable ASCII.
    InvalidCommandLine(&'static str),
    /// Opening or loading the kernel image failed.
    #[cfg_attr(
        all(test, not(all(target_os = "linux", target_arch = "x86_64"))),
        expect(dead_code, reason = "Only the Linux x86_64 boot module builds it.")
    )]
    LoadKernel { path: PathBuf, source: io::Error },
    /// Opening or loading the initramfs failed.
    #[cfg_attr(
        all(test, not(all(target_os = "linux", target_arch = "x86_64"))),
        expect(dead_code, reason = "Only the Linux x86_64 boot module builds it.")
    )]
    LoadInitramfs { path: PathBuf, source: io::Error },
    /// Writing boot data into guest RAM failed.
    #[cfg_attr(
        all(test, not(all(target_os = "linux", target_arch = "x86_64"))),
        expect(dead_code, reason = "Only the Linux x86_64 boot module builds it.")
    )]
    WriteBootData {
        what: &'static str,
        source: io::Error,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVcpuCount(count) => write!(f, "invalid vCPU count: {count}"),
            Self::InvalidMemorySize(mib) => write!(f, "invalid memory size: {mib} MiB"),
            Self::AllocateMemory { bytes, .. } => {
                write!(f, "failed to allocate {bytes} bytes of guest RAM")
            }
            Self::Hypervisor(_) => f.write_str("hypervisor operation failed"),
            Self::InvalidCommandLine(reason) => {
                write!(f, "invalid kernel command line: {reason}")
            }
            Self::LoadKernel { path, .. } => {
                write!(f, "failed to load the kernel {}", path.display())
            }
            Self::LoadInitramfs { path, .. } => {
                write!(f, "failed to load the initramfs {}", path.display())
            }
            Self::WriteBootData { what, .. } => {
                write!(f, "failed to write the {what} into guest RAM")
            }
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::InvalidVcpuCount(_)
            | Self::InvalidMemorySize(_)
            | Self::InvalidCommandLine(_) => None,
            Self::AllocateMemory { source, .. }
            | Self::LoadKernel { source, .. }
            | Self::LoadInitramfs { source, .. }
            | Self::WriteBootData { source, .. } => Some(source),
            Self::Hypervisor(source) => Some(source),
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
