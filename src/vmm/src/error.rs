// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! VMM errors.

use std::{error, fmt, io, path::PathBuf};

/// Result of a VMM operation.
pub type Result<T> = std::result::Result<T, Error>;

/// Why a VM control operation was refused or failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlReason {
    /// The operation is unavailable in the current lifecycle state.
    InvalidState,
    /// The operation requires a device-less configuration.
    UnsupportedDevice,
    /// The operation did not complete before its deadline.
    DeadlineTimeout,
    /// A terminal event interrupted the operation.
    TerminalOutcome,
}

impl fmt::Display for ControlReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidState => "invalid state",
            Self::UnsupportedDevice => "operation requires a device-less VM",
            Self::DeadlineTimeout => "vCPU acknowledgements are still incomplete",
            Self::TerminalOutcome => "the VM is stopping",
        })
    }
}

/// A VMM construction, execution, or control failure.
///
/// The cause chain stays intact through [`error::Error::source`], so callers
/// can tell a host that cannot run VMs from other failures.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// A control operation was refused or failed.
    Control {
        operation: &'static str,
        reason: ControlReason,
    },
    /// The vCPU count is outside `1..=config::MAX_VCPUS`.
    InvalidVcpuCount(u8),
    /// Opening or configuring filesystem exports failed.
    Filesystem(io::Error),
    /// Binding or configuring the host bridges failed.
    Vsock(io::Error),
    /// An invalid RAM size was requested.
    InvalidMemorySize(u32),
    /// A guest RAM range extends beyond a host or boot address limit.
    GuestMemoryAddressLimit {
        memory_mib: u32,
        end: u64,
        limit_end: u64,
        limit: &'static str,
    },
    /// The host's guest-memory capabilities are invalid or insufficient.
    HostMemoryCapability(io::Error),
    /// A hotplug capacity or target in MiB is not a multiple of 128 MiB, or
    /// does not fit the configured capacity.
    InvalidHotplugSize(u32),
    /// The requested hotplug window does not fit the guest or KVM layout.
    PlanHotplugMemory {
        capacity_mib: u32,
        source: io::Error,
    },
    /// Allocating the guest RAM failed.
    AllocateMemory { bytes: u64, source: io::Error },
    /// A host hypervisor operation failed.
    Hypervisor(boxlite_hypervisor::Error),
    /// The kernel command line is too long or not printable ASCII.
    InvalidCommandLine(&'static str),
    /// More disks than `config::MAX_DISKS`.
    InvalidDiskCount(usize),
    /// A disk control ID is empty or duplicated.
    InvalidDiskId(String),
    /// Opening a disk image failed.
    OpenDisk { path: PathBuf, source: io::Error },
    /// Creating the channel that grows a disk failed.
    DiskControl(io::Error),
    /// The VM already has a memory control endpoint.
    RegisterMemoryControl(io::Error),
    /// Every virtio-mmio window and interrupt line is taken.
    VirtioSlotsExhausted,
    /// Devices claimed resources the chipset cannot give them.
    ChipsetConflicts(Vec<crate::chipset::Conflict>),
    /// A device constructor raised interrupt `line` before the chipset was
    /// built.
    LineNotArmed(u32),
    /// A virtio device, its transport or its worker slot cannot continue.
    VirtioDevice {
        /// The device's short name.
        device: &'static str,
        /// Why the device stopped.
        reason: &'static str,
    },
    /// The virtio workers could not start, their poller or thread failed, or
    /// they did not stop in time (`TimedOut`).
    VirtioWorker(io::Error),
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
    /// Creating the reporting balloon failed.
    CreateBalloon(io::Error),
    /// Starting the thread that writes the guest console failed.
    SpawnConsole(io::Error),
    /// Starting the thread that raises the CMOS RTC alarm failed.
    SpawnRtcAlarm(io::Error),
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
            Self::Control { operation, reason } => write!(f, "{operation}: {reason}"),
            Self::Vsock(_) => f.write_str("failed to configure vsock bridges"),
            Self::Filesystem(_) => f.write_str("failed to configure virtio-fs exports"),
            Self::InvalidVcpuCount(count) => write!(f, "invalid vCPU count: {count}"),
            Self::InvalidMemorySize(mib) => write!(f, "invalid memory size: {mib} MiB"),
            Self::GuestMemoryAddressLimit {
                memory_mib,
                end,
                limit_end,
                limit,
            } => write!(
                f,
                "guest RAM request of {memory_mib} MiB ends at GPA {end:#x}, beyond {limit} exclusive limit {limit_end:#x}"
            ),
            Self::HostMemoryCapability(source) => {
                write!(f, "guest memory capability check failed: {source}")
            }
            Self::InvalidHotplugSize(mib) => write!(f, "invalid hotplug memory size: {mib} MiB"),
            Self::PlanHotplugMemory {
                capacity_mib,
                source,
            } => {
                write!(
                    f,
                    "cannot plan {capacity_mib} MiB of hotplug memory: {source}"
                )
            }
            Self::AllocateMemory { bytes, .. } => {
                write!(f, "failed to allocate {bytes} bytes of guest RAM")
            }
            Self::Hypervisor(_) => f.write_str("hypervisor operation failed"),
            Self::InvalidCommandLine(reason) => {
                write!(f, "invalid kernel command line: {reason}")
            }
            Self::InvalidDiskCount(count) => write!(f, "too many disks: {count}"),
            Self::InvalidDiskId(id) => write!(f, "empty or duplicate disk ID: {id:?}"),
            Self::DiskControl(_) => f.write_str("failed to create a disk grow channel"),
            Self::RegisterMemoryControl(_) => f.write_str("failed to register memory control"),
            Self::OpenDisk { path, .. } => {
                write!(f, "failed to open the disk image {}", path.display())
            }
            Self::VirtioSlotsExhausted => f.write_str("no virtio-mmio slot is free"),
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
            Self::VirtioDevice { device, reason } => {
                write!(f, "virtio device {device}: {reason}")
            }
            Self::VirtioWorker(_) => f.write_str("the virtio workers failed"),
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
            Self::CreateBalloon(_) => f.write_str("failed to create the reporting balloon"),
            Self::SpawnConsole(_) => f.write_str("failed to start the console thread"),
            Self::SpawnRtcAlarm(_) => f.write_str("failed to start the RTC alarm thread"),
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
            Self::Control { .. }
            | Self::InvalidVcpuCount(_)
            | Self::InvalidMemorySize(_)
            | Self::GuestMemoryAddressLimit { .. }
            | Self::InvalidHotplugSize(_)
            | Self::InvalidCommandLine(_)
            | Self::InvalidDiskCount(_)
            | Self::InvalidDiskId(_)
            | Self::VirtioSlotsExhausted
            | Self::ChipsetConflicts(_)
            | Self::LineNotArmed(_)
            | Self::VirtioDevice { .. }
            | Self::UnexpectedExit { .. }
            | Self::VcpuPanicked { .. }
            | Self::AlreadyRan => None,
            Self::Vsock(source)
            | Self::Filesystem(source)
            | Self::HostMemoryCapability(source)
            | Self::PlanHotplugMemory { source, .. }
            | Self::AllocateMemory { source, .. }
            | Self::OpenDisk { source, .. }
            | Self::DiskControl(source)
            | Self::RegisterMemoryControl(source)
            | Self::LoadKernel { source, .. }
            | Self::LoadInitramfs { source, .. }
            | Self::WriteBootData { source, .. }
            | Self::SpawnVcpu { source, .. }
            | Self::EventLoop(source)
            | Self::CreateBalloon(source)
            | Self::SpawnRtcAlarm(source)
            | Self::SpawnConsole(source)
            | Self::VirtioWorker(source) => Some(source),
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

    #[test]
    fn a_virtio_device_error_names_the_device_and_reason() {
        let error = Error::VirtioDevice {
            device: "rng",
            reason: "queue failed",
        };
        assert_eq!(error.to_string(), "virtio device rng: queue failed");
        assert!(error.source().is_none());
    }
}
