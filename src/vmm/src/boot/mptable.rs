// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The MP table (Intel MultiProcessor Specification 1.4) that lists the vCPUs
//! and the IOAPIC for a Linux booted without ACPI; without it Linux turns off
//! SMP and the IOAPIC. The contents follow Firecracker: every vCPU, an ISA bus,
//! the in-kernel IOAPIC with ISA IRQ k on pin k, ExtINT on the boot vCPU's
//! LINT0 and NMI on every LINT1.

use std::io;

use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend};

use super::params::LOW_RAM_END;
use crate::config::MAX_VCPUS;

/// The floating pointer goes where usable low RAM ends, in the last KiB below
/// 640 KiB that Linux scans, and the configuration table follows it. The whole
/// table takes 284 + 20 bytes per vCPU, 1564 at 64, inside the E820 hole
/// [0x9_FC00, 1 MiB).
const MPTABLE_START: u64 = LOW_RAM_END;
const FLOATING_POINTER_LEN: usize = 16;
const HEADER_LEN: usize = 44;
/// Byte offsets of the checksums in the floating pointer and in the header.
const FLOATING_POINTER_CHECKSUM: usize = 10;
const HEADER_CHECKSUM: usize = 7;
/// Specification revision 1.4.
const SPEC_REVISION: u8 = 4;

/// The architectural local APIC and IOAPIC addresses, both in KVM's kernel.
const LAPIC_ADDR: u32 = 0xfee0_0000;
const IOAPIC_ADDR: u32 = 0xfec0_0000;
/// Version registers of an xAPIC and of an 82093AA-style IOAPIC.
const APIC_VERSION: u8 = 0x14;
const IOAPIC_VERSION: u8 = 0x11;
/// Family 6 with FPU and APIC, as Firecracker reports; Linux reads CPUID.
const CPU_SIGNATURE: u32 = 0x600;
const CPU_FEATURES: u32 = 1 | 1 << 9;
/// IOAPIC pins; KVM routes GSI k to pin k, so ISA IRQ k uses pin k.
const IOAPIC_PINS: u8 = 24;

/// Entry types, CPU and IOAPIC flags, and interrupt types (section 4.3).
const PROCESSOR: u8 = 0;
const BUS: u8 = 1;
const IOAPIC: u8 = 2;
const IO_INTERRUPT: u8 = 3;
const LOCAL_INTERRUPT: u8 = 4;
const ENABLED: u8 = 1;
const BOOTSTRAP: u8 = 2;
const INT: u8 = 0;
const NMI: u8 = 1;
const EXTINT: u8 = 3;
/// A local interrupt entry for every local APIC.
const ALL_APICS: u8 = 0xff;

/// Writes the MP floating pointer and configuration table for `vcpu_count`
/// vCPUs, with APIC IDs `0..vcpu_count` as `vcpu_cpuid` assigns them and vCPU
/// 0 as the bootstrap processor.
pub(crate) fn write_mptable<M: GuestMemoryBackend>(ram: &M, vcpu_count: u8) -> io::Result<()> {
    debug_assert!((1..=MAX_VCPUS).contains(&vcpu_count));
    let ioapic_id = vcpu_count + 1;

    let mut entries = Vec::new();
    for apic_id in 0..vcpu_count {
        let flags = if apic_id == 0 {
            ENABLED | BOOTSTRAP
        } else {
            ENABLED
        };
        entries.extend([PROCESSOR, apic_id, APIC_VERSION, flags]);
        entries.extend(CPU_SIGNATURE.to_le_bytes());
        entries.extend(CPU_FEATURES.to_le_bytes());
        entries.extend([0; 8]);
    }
    entries.extend([BUS, 0]);
    entries.extend(*b"ISA   ");
    entries.extend([IOAPIC, ioapic_id, IOAPIC_VERSION, ENABLED]);
    entries.extend(IOAPIC_ADDR.to_le_bytes());
    for pin in 0..IOAPIC_PINS {
        // Type, vectored, conforming polarity and trigger, ISA bus 0, IRQ,
        // IOAPIC, pin.
        entries.extend([IO_INTERRUPT, INT, 0, 0, 0, pin, ioapic_id, pin]);
    }
    entries.extend([LOCAL_INTERRUPT, EXTINT, 0, 0, 0, 0, 0, 0]);
    entries.extend([LOCAL_INTERRUPT, NMI, 0, 0, 0, 0, ALL_APICS, 1]);
    let entry_count = u16::from(vcpu_count) + 2 + u16::from(IOAPIC_PINS) + 2;

    let mut table = Vec::with_capacity(FLOATING_POINTER_LEN + HEADER_LEN + entries.len());
    // Floating pointer: the table address, one 16-byte unit, the revision, and
    // zero feature bytes, which mean a configuration table is present.
    table.extend(*b"_MP_");
    table.extend(((MPTABLE_START as usize + FLOATING_POINTER_LEN) as u32).to_le_bytes());
    table.extend([1, SPEC_REVISION, 0, 0, 0, 0, 0, 0]);
    // Header: length, revision, IDs, no OEM or extended table.
    table.extend(*b"PCMP");
    table.extend(((HEADER_LEN + entries.len()) as u16).to_le_bytes());
    table.extend([SPEC_REVISION, 0]);
    table.extend(*b"BOXLITE ");
    table.extend(*b"VMM         ");
    table.extend([0; 6]);
    table.extend(entry_count.to_le_bytes());
    table.extend(LAPIC_ADDR.to_le_bytes());
    table.extend([0; 4]);
    table.extend(entries);
    table[FLOATING_POINTER_CHECKSUM] = checksum(&table[..FLOATING_POINTER_LEN]);
    table[FLOATING_POINTER_LEN + HEADER_CHECKSUM] = checksum(&table[FLOATING_POINTER_LEN..]);

    ram.write_slice(&table, GuestAddress(MPTABLE_START))
        .map_err(io::Error::other)
}

/// The byte that makes `bytes` sum to zero, given a zero checksum field.
fn checksum(bytes: &[u8]) -> u8 {
    bytes
        .iter()
        .fold(0, |sum: u8, byte| sum.wrapping_sub(*byte))
}

#[cfg(test)]
#[path = "../../tests/mptable/mod.rs"]
mod tests;
