// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The MP table read back from guest RAM that starts out filled with `0xff`,
//! parsed the way Linux's `mpparse.c` walks it.

use vm_memory::{Bytes, GuestAddress};

use super::write_mptable;
use crate::{config::MAX_VCPUS, memory::GuestMemoryMmap};

const START: u64 = 0x9_fc00;

fn ram() -> GuestMemoryMmap {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 1 << 20)]).unwrap();
    ram.write_slice(&vec![0xff; 1 << 20], GuestAddress(0))
        .unwrap();
    ram
}

fn read(ram: &GuestMemoryMmap, address: u64, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    ram.read_slice(&mut bytes, GuestAddress(address)).unwrap();
    bytes
}

fn sums_to_zero(bytes: &[u8]) -> bool {
    bytes.iter().fold(0u8, |sum, byte| sum.wrapping_add(*byte)) == 0
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

/// Checks the floating pointer and header, then every entry in order, for
/// `count` vCPUs.
fn check(count: u8) {
    let ram = ram();
    write_mptable(&ram, count).unwrap();

    let pointer = read(&ram, START, 16);
    assert_eq!(&pointer[..4], b"_MP_");
    assert!(sums_to_zero(&pointer));
    let (table_start, length_units, revision) = (u32_at(&pointer, 4), pointer[8], pointer[9]);
    assert_eq!((table_start, length_units, revision), (0x9_fc10, 1, 4));
    assert_eq!(&pointer[11..], [0; 5], "no default configuration");

    let length = usize::from(u16_at(&read(&ram, START + 20, 2), 0));
    assert_eq!(16 + length, 284 + 20 * usize::from(count));
    assert!(START + 16 + length as u64 <= 0x10_0000);
    let table = read(&ram, u64::from(table_start), length);
    assert_eq!(&table[..4], b"PCMP");
    assert!(sums_to_zero(&table));
    assert_eq!(table[6], 4);
    assert_eq!(&table[8..28], b"BOXLITE VMM         ");
    let entry_count = u16_at(&table, 34);
    assert_eq!(entry_count, u16::from(count) + 28);
    assert_eq!(u32_at(&table, 36), 0xfee0_0000);

    let ioapic_id = count + 1;
    let mut entries = &table[44..];
    for apic_id in 0..count {
        let flags = if apic_id == 0 { 3 } else { 1 };
        assert_eq!(entries[..4], [0, apic_id, 0x14, flags], "CPU {apic_id}");
        assert_eq!(u32_at(entries, 8), 1 | 1 << 9, "FPU and APIC");
        entries = &entries[20..];
    }
    assert_eq!(entries[..8], *b"\x01\x00ISA   ");
    assert_eq!(entries[8..12], [2, ioapic_id, 0x11, 1]);
    assert_eq!(u32_at(entries, 12), 0xfec0_0000);
    entries = &entries[16..];
    for irq in 0..24 {
        assert_eq!(
            entries[..8],
            [3, 0, 0, 0, 0, irq, ioapic_id, irq],
            "IRQ {irq}"
        );
        entries = &entries[8..];
    }
    assert_eq!(entries, [4, 3, 0, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0xff, 1]);

    let after: u8 = ram
        .read_obj(GuestAddress(START + 16 + length as u64))
        .unwrap();
    assert_eq!(after, 0xff, "nothing written past the table");
}

#[test]
fn lists_one_vcpu() {
    check(1);
}

#[test]
fn lists_the_maximum_vcpus_inside_the_reserved_range() {
    check(MAX_VCPUS);
}

#[test]
fn fails_without_ram_at_the_table() {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x9_f000)]).unwrap();
    assert!(write_mptable(&ram, 1).is_err());
}
