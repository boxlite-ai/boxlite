// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The vCPU contract, and the handle other threads use to kick a vCPU.

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
use std::io;

use crate::{Result, VcpuExit};

/// A vCPU, bound to the thread that created it.
///
/// Backend vCPU types are `!Send`: HVF accepts vCPU calls only from the
/// creating thread, and KVM performs best that way.
pub trait Vcpu {
    /// The handle other threads use to kick this vCPU.
    type Handle: VcpuHandle;

    /// Enters the guest and returns at its next exit.
    fn run(&mut self) -> Result<VcpuExit<'_>>;

    /// Completes a handled MMIO or port access without executing another
    /// guest instruction, before stopping the vCPU or saving its state.
    ///
    /// Supply any read response and release the exit's borrowed buffer before
    /// calling. `Ok(Some(exit))` reports another exit from the same instruction,
    /// such as a split MMIO fragment, a read-modify-write phase, or a terminal
    /// exit. Handle it, release its borrow, and call again until `Ok(None)`.
    /// `Ok(None)` means no I/O remains and repeat calls are no-ops.
    fn complete_pending_io(&mut self) -> Result<Option<VcpuExit<'_>>>;

    /// Notifies the guest that its clock was interrupted, while stopped on
    /// the owning thread. An unused guest clock is a successful no-op; backends
    /// without this capability report Unsupported (with placeholder CPU id 0).
    ///
    /// On a KVM destination, call this on each vCPU's owning thread after
    /// `X86Vcpu::restore_state` installs its pvclock MSRs and before its first
    /// [`Vcpu::run`].
    fn notify_guest_stopped(&mut self) -> Result<()> {
        Err(crate::Error::ConfigureVcpu {
            id: 0,
            operation: "notify guest stopped (unsupported backend)",
            source: std::io::Error::from(std::io::ErrorKind::Unsupported),
        })
    }

    /// Returns a handle other threads use to kick this vCPU.
    fn handle(&self) -> Self::Handle;
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
#[derive(Debug, Default)]
pub(crate) struct PendingIo(pub(crate) bool);

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IoCompletion {
    Done,
    Exit,
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
impl PendingIo {
    pub(crate) fn complete(
        &mut self,
        enter: impl FnOnce() -> io::Result<()>,
    ) -> io::Result<IoCompletion> {
        if !self.0 {
            return Ok(IoCompletion::Done);
        }
        match enter() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                self.0 = false;
                Ok(IoCompletion::Done)
            }
            Err(error) => Err(error),
            Ok(()) => Ok(IoCompletion::Exit),
        }
    }
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
pub(crate) fn kvmclock_ctrl_result(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        // KVM's kvm_set_guest_paused returns EINVAL when pv_time is inactive.
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
        result => result,
    }
}

/// Forces one vCPU out of the guest, from any thread.
pub trait VcpuHandle: Clone + Send + Sync {
    /// Makes the vCPU's [`Vcpu::run`] return [`VcpuExit::Interrupted`].
    ///
    /// If the vCPU is outside the guest, its next `run` returns at once.
    /// Kicking a dropped vCPU does nothing.
    fn kick(&self) -> Result<()>;
}

#[cfg(test)]
#[path = "../tests/vcpu/mod.rs"]
mod pending_io_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kvmclock_inactive_pvclock_is_a_noop() {
        assert!(kvmclock_ctrl_result(Err(io::Error::from(io::ErrorKind::InvalidInput))).is_ok());
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert!(kvmclock_ctrl_result(Err(io::Error::from_raw_os_error(libc::EINVAL))).is_ok());
        assert!(kvmclock_ctrl_result(Ok(())).is_ok());
    }

    #[test]
    fn notify_guest_stopped_defaults_to_unsupported() {
        #[derive(Clone)]
        struct Cpu;

        impl VcpuHandle for Cpu {
            fn kick(&self) -> Result<()> {
                unreachable!()
            }
        }

        impl Vcpu for Cpu {
            type Handle = Self;

            fn run(&mut self) -> Result<VcpuExit<'_>> {
                unreachable!()
            }

            fn complete_pending_io(&mut self) -> Result<Option<VcpuExit<'_>>> {
                unreachable!()
            }

            fn handle(&self) -> Self::Handle {
                Self
            }
        }

        assert!(matches!(
            Cpu.notify_guest_stopped(),
            Err(crate::Error::ConfigureVcpu {
                id: 0,
                operation: "notify guest stopped (unsupported backend)",
                source,
            }) if source.kind() == io::ErrorKind::Unsupported
        ));
    }

    #[test]
    fn kvmclock_ioctl_failures_are_preserved() {
        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::Unsupported] {
            assert_eq!(
                kvmclock_ctrl_result(Err(io::Error::from(kind)))
                    .unwrap_err()
                    .kind(),
                kind
            );
        }
    }
}
