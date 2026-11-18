// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;

use vm_memory::GuestAddress;

use super::{e820_ram_ranges, initramfs_slot};
use crate::memory::X86_LAYOUT;

#[test]
fn e820_reports_three_ranges_for_six_gib() {
    let ranges = X86_LAYOUT.ranges(6144 << 20).unwrap();
    let usable = e820_ram_ranges(&ranges);

    assert_eq!(
        usable,
        [
            (0, 0x9_fc00),
            (0x10_0000, 0xBFF0_0000),
            (0x1_0000_0000, 0xC000_0000),
        ]
    );
    assert_eq!(
        usable.iter().map(|&(_, size)| size).sum::<u64>(),
        (6144 << 20) - 0x60400
    );
    assert!(
        usable
            .iter()
            .all(|&(start, size)| start + size <= 0xC000_0000 || start >= 0x1_0000_0000)
    );
}

#[test]
fn e820_reports_two_ranges_below_the_mmio_hole() {
    let ranges = X86_LAYOUT.ranges(3072 << 20).unwrap();
    let usable = e820_ram_ranges(&ranges);

    assert_eq!(usable, [(0, 0x9_fc00), (0x10_0000, 0xBFF0_0000)]);
    assert_eq!(
        usable.iter().map(|&(_, size)| size).sum::<u64>(),
        (3072 << 20) - 0x60400
    );
}

#[test]
fn slots_the_archive_in_the_low_ram_band_when_high_ram_exists() {
    let ranges = X86_LAYOUT.ranges(6144 << 20).unwrap();
    let start = initramfs_slot(&ranges, 5000).unwrap();

    assert_eq!(start, GuestAddress(0xBFFF_E000));
    assert!(start.0 < 0x1_0000_0000);
}

#[test]
fn refuses_an_archive_larger_than_the_low_ram_band() {
    let ranges = X86_LAYOUT.ranges(6144 << 20).unwrap();

    assert_eq!(
        initramfs_slot(&ranges, 0xC000_0000 + 1).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        initramfs_slot(&[], 1).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    // The slot must be in the low band containing GPA 0, even if high RAM is large enough.
    assert_eq!(
        initramfs_slot(&ranges[1..], 1).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
}
