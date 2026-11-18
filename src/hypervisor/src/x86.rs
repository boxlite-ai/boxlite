// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Architectural values supplied by the machine's boot loader, and the x86
//! backend operations that install them.

use crate::{Result, Vcpu, Vm};

/// One CPUID response; the VMM selects guest features and topology.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct X86CpuidEntry {
    pub leaf: u32,
    pub subleaf: u32,
    pub subleaf_required: bool,
    pub eax: u32,
    pub ebx: u32,
    pub ecx: u32,
    pub edx: u32,
}

/// One model-specific register write selected by the VMM.
#[derive(Clone, Copy, Debug)]
pub struct X86Msr {
    pub index: u32,
    pub value: u64,
}

/// A decoded x86 segment descriptor, independent of the host API.
#[derive(Clone, Copy, Debug, Default)]
pub struct X86Segment {
    pub base: u64,
    pub limit: u32,
    pub selector: u16,
    /// Access byte followed by the flags nibble in bits 12..15, as in a GDT.
    pub attributes: u16,
}

/// The registers needed to enter an x86 kernel directly.
///
/// The machine owns these values, including mode bits and all guest addresses.
/// Other general-purpose registers start at zero; x87/SSE start in reset state.
/// Secondary CPUs should retain their architectural reset state until INIT/SIPI.
#[derive(Clone, Copy, Debug, Default)]
pub struct X86BootRegisters {
    pub rip: u64,
    pub rsp: u64,
    pub rsi: u64,
    pub rflags: u64,
    pub cr0: u64,
    pub cr3: u64,
    pub cr4: u64,
    pub efer: u64,
    pub code: X86Segment,
    pub data: X86Segment,
    pub gdt_base: u64,
    pub gdt_limit: u16,
    pub idt_base: u64,
    pub idt_limit: u16,
}

/// The x86 operations a VM offers the machine's boot loader.
pub trait X86Vm: Vm<Vcpu: X86ParkVcpu> {
    /// Host-supported CPUID values, before the VMM applies guest topology and
    /// policy. They are a ceiling: a guest must not see features beyond them.
    fn supported_cpuid(&self) -> &[X86CpuidEntry];
}

/// The x86 state a vCPU needs before its first guest entry.
///
/// Both writes are not transactional: discard the vCPU after any error.
pub trait X86Vcpu: Vcpu {
    /// Installs the machine's CPUID and MSR policy. Call it before
    /// [`set_boot_registers`](Self::set_boot_registers).
    fn set_cpu_features(&mut self, cpuid: &[X86CpuidEntry], msrs: &[X86Msr]) -> Result<()>;

    /// Installs the entry registers. Only the boot vCPU needs them; the others
    /// keep their reset state until INIT/SIPI.
    fn set_boot_registers(&mut self, state: &X86BootRegisters) -> Result<()>;
}

/// An x86 vCPU the machine can take off its worker thread and later resume on
/// another one, so a vCPU the host has not granted has no thread at all.
pub trait X86ParkVcpu: X86Vcpu + Sized {
    /// This vCPU while no thread runs it.
    type Parked: X86ParkedVcpu<Vcpu = Self>;

    /// Completes any pending device access, then releases the calling
    /// thread's binding. Handles taken before parking become inert.
    fn park(self) -> Result<Self::Parked>;
}

/// A parked x86 vCPU: it runs no guest code until [`resume`](Self::resume).
///
/// The guest can still send it INIT and SIPI, which KVM latches; call
/// [`reset`](Self::reset) before resuming it.
pub trait X86ParkedVcpu: Send + Sized {
    /// The thread-bound vCPU that [`resume`](Self::resume) returns.
    type Vcpu;

    /// Whether the guest left the vCPU halted, as an offlined CPU does.
    fn is_halted(&self) -> Result<bool>;

    /// Drops any INIT and SIPI received while parked; the vCPU then waits for
    /// a fresh INIT, as a CPU that never ran does.
    fn reset(&mut self) -> Result<()>;

    /// Binds the vCPU to the calling thread.
    fn resume(self) -> Result<Self::Vcpu>;
}
