// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Architectural values supplied by the machine's boot loader on arm64, the
//! backend operations that install them, and the VMM's answer to a guest's
//! PSCI `CPU_ON`.

use crate::{Result, Vcpu};

/// The registers a vCPU enters the kernel with
/// (`Documentation/arch/arm64/booting.rst`).
///
/// The boot vCPU starts at the kernel's entry with X0 at the device tree; a
/// secondary starts at the entry its `CPU_ON` named, with X0 at the context
/// ID. Other general-purpose registers keep their reset value, zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Arm64BootRegisters {
    pub pc: u64,
    pub x0: u64,
    /// PSTATE; Linux expects EL1h with D, A, I and F masked (`0x3c5`).
    pub pstate: u64,
}

/// The arm64 state a vCPU needs before its first guest entry.
pub trait Arm64Vcpu: Vcpu {
    /// Sets MPIDR_EL1, the affinity the GIC routes by and the device tree
    /// names the vCPU with. Call it before the first entry.
    fn set_mpidr(&mut self, mpidr: u64) -> Result<()>;

    /// Installs the entry registers. Call it before the first entry.
    fn set_boot_registers(&mut self, regs: &Arm64BootRegisters) -> Result<()>;
}

/// The VMM's answer to a guest's PSCI `CPU_ON`, which the guest reads as the
/// call's return value (`include/uapi/linux/psci.h`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CpuOnResult {
    /// The target starts at the requested entry.
    Success,
    /// The target names no vCPU, or the entry is not a valid address.
    InvalidParameters,
    /// The target has already started.
    AlreadyOn,
    /// The VMM could not start the target, or never answered.
    InternalFailure,
}
