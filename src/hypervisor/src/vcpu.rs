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

    /// Returns a handle other threads use to kick this vCPU.
    fn handle(&self) -> Self::Handle;
}

/// Forces one vCPU out of the guest, from any thread.
pub trait VcpuHandle: Clone + Send + Sync {
    /// Makes the vCPU's [`Vcpu::run`] return [`VcpuExit::Interrupted`].
    ///
    /// If the vCPU is outside the guest, its next `run` returns at once.
    /// Kicking a dropped vCPU does nothing.
    fn kick(&self) -> Result<()>;
}
