// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Architectural values supplied by the machine's boot loader.

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
