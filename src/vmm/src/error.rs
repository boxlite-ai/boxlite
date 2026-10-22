// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! VMM errors.

use std::{error, fmt, io, path::PathBuf};

/// Result of a VMM operation.
pub type Result<T> = std::result::Result<T, Error>;

/// A failure that ends the VM.
///
/// The cause chain stays intact through [`error::Error::source`], so callers
/// can tell a host that cannot run VMs from other failures.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
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
    /// Devices claimed resources the chipset cannot give them.
    ChipsetConflicts(Vec<crate::chipset::Conflict>),
    /// A device constructor raised interrupt `line` before the chipset was
    /// built.
    LineNotArmed(u32),
    /// Opening or loading the kernel image failed.
    LoadKernel { path: PathBuf, source: io::Error },
    /// Opening or loading the initramfs failed.
    LoadInitramfs { path: PathBuf, source: io::Error },
    /// Writing boot data into guest RAM failed.
    WriteBootData {
        what: &'static str,
        source: io::Error,
    },
    /// Creating the vCPU event loop failed, or waiting on it did.
    EventLoop(io::Error),
    /// Starting the thread of vCPU `vcpu` failed.
    SpawnVcpu { vcpu: u32, source: io::Error },
    /// vCPU `vcpu` exited in a way this host should never report, such as
    /// `Halted` with KVM's in-kernel interrupt controller.
    UnexpectedExit { vcpu: u32, exit: String },
    /// The thread of vCPU `vcpu` panicked; the VMM caught it and stopped the VM.
    VcpuPanicked { vcpu: u32 },
    /// `Vm::run` was called again; a VM runs once.
    AlreadyRan,
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
            Self::ChipsetConflicts(conflicts) => {
                write!(f, "{} chipset conflict(s):", conflicts.len())?;
                for conflict in conflicts {
                    write!(f, " {conflict};")?;
                }
                Ok(())
            }
            Self::LineNotArmed(line) => {
                write!(
                    f,
                    "interrupt line {line} raised before the chipset is built"
                )
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
            Self::EventLoop(_) => f.write_str("the VM event loop failed"),
            Self::SpawnVcpu { vcpu, .. } => write!(f, "failed to start vCPU {vcpu}"),
            Self::UnexpectedExit { vcpu, exit } => {
                write!(f, "vCPU {vcpu} exited unexpectedly: {exit}")
            }
            Self::VcpuPanicked { vcpu } => write!(f, "vCPU {vcpu} panicked"),
            Self::AlreadyRan => f.write_str("the VM has already run"),
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::InvalidVcpuCount(_)
            | Self::InvalidMemorySize(_)
            | Self::InvalidCommandLine(_)
            | Self::ChipsetConflicts(_)
            | Self::LineNotArmed(_)
            | Self::UnexpectedExit { .. }
            | Self::VcpuPanicked { .. }
            | Self::AlreadyRan => None,
            Self::AllocateMemory { source, .. }
            | Self::LoadKernel { source, .. }
            | Self::LoadInitramfs { source, .. }
            | Self::WriteBootData { source, .. }
            | Self::SpawnVcpu { source, .. }
            | Self::EventLoop(source) => Some(source),
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
