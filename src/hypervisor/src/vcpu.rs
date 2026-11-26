// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The vCPU contract, and the handle other threads use to kick a vCPU.

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
    /// The caller first supplies any read response and releases the exit's
    /// borrowed buffer. With no pending access this succeeds without entering
    /// the guest. Successful completion consumes the pending access, so a
    /// subsequent call does not complete it twice.
    fn complete_pending_io(&mut self) -> Result<()>;

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
mod tests {
    use super::*;
    use std::io;

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

            fn complete_pending_io(&mut self) -> Result<()> {
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
