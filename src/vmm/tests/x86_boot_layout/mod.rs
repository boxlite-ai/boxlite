// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, io};

use vm_memory::GuestAddress;

use super::{PageSize, TablePlan, e820_ram_ranges, initramfs_slot, plan};
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

const KIB4: u64 = 4096;
const MIB2: u64 = 2 * 1024 * 1024;
const GIB: u64 = 1024 * 1024 * 1024;
const WINDOW: (u64, u64) = (0x9000, 0x9000 + GIB);

fn tables(plan: &TablePlan) -> BTreeMap<u64, [u64; 512]> {
    plan.pages
        .iter()
        .map(|page| (page.addr, page.entries))
        .collect()
}

/// Walk the architectural radix-512 digits of an address, returning the
/// physical address and leaf size. Missing entries must be zero, not flags.
fn translate(tables: &BTreeMap<u64, [u64; 512]>, root: u64, va: u64) -> Option<(u64, u64)> {
    let mut table = root;
    for shift in [39, 30, 21, 12] {
        let entry = tables[&table][((va >> shift) & 0x1ff) as usize];
        if entry == 0 {
            return None;
        }
        let flags = entry & !0x000f_ffff_ffff_f000;
        let large = flags & 0x80 != 0;
        assert_eq!(flags, if large { 0x83 } else { 0x03 });
        let base = entry - flags;
        if large || shift == 12 {
            assert!(!large || matches!(shift, 30 | 21));
            let size = 1 << shift;
            let offset_mask = size - 1;
            assert_eq!(base & offset_mask, 0);
            return Some((base | (va & offset_mask), size));
        }
        table = base;
    }
    unreachable!()
}

#[test]
fn six_gib_maps_both_ram_bands_and_leaves_the_mmio_hole_absent() {
    let ranges = X86_LAYOUT.ranges(6 * GIB).unwrap();
    for (leaf, size) in [
        (PageSize::Gib, GIB),
        (PageSize::Mib, MIB2),
        (PageSize::Kib, KIB4),
    ] {
        let plan = plan(&ranges, WINDOW, leaf).unwrap();
        let tables = tables(&plan);
        for gpa in [0, 0xbfff_ffff, 0x1_0000_0000, 0x1_bfff_ffff] {
            assert_eq!(
                translate(&tables, plan.pml4, gpa),
                Some((gpa, size)),
                "{leaf:?}"
            );
        }
        for gpa in [0xc000_0000, 0xfec0_0000, 0xffff_ffff, 0x1_c000_0000] {
            assert_eq!(
                translate(&tables, plan.pml4, gpa),
                None,
                "{leaf:?}, {gpa:#x}"
            );
        }
    }
}

#[test]
fn checked_gib_leaves_map_both_ram_bands_with_smaller_leaves_at_the_tail() {
    let ranges = X86_LAYOUT.ranges(3075 << 20).unwrap();
    let leaf = PageSize::Gib.checked(true).unwrap();
    let plan =
        super::plan_boot_tables(&ranges, (0x10_0000, 0x10_3080), None, leaf.page_size()).unwrap();
    let tables = tables(&plan);
    for (gpa, size) in [
        (0x4000_0000, GIB),
        (0x7fff_ffff, GIB),
        (0x1_0000_0000, MIB2),
        (0x1_002f_ffff, KIB4),
    ] {
        assert_eq!(translate(&tables, plan.pml4, gpa), Some((gpa, size)));
    }
    for gpa in [0xc000_0000, 0xfec0_0000, 0xffff_ffff, 0x1_0030_0000] {
        assert_eq!(translate(&tables, plan.pml4, gpa), None, "{gpa:#x}");
    }
}

#[test]
fn mib_leaves_use_four_kib_for_the_high_ram_tail() {
    let ranges = X86_LAYOUT.ranges(3073 << 20).unwrap();
    let plan = plan(&ranges, WINDOW, PageSize::Mib).unwrap();
    let tables = tables(&plan);
    for gpa in [0x1_0000_0000, 0x1_000f_ffff] {
        assert_eq!(translate(&tables, plan.pml4, gpa), Some((gpa, KIB4)));
    }
    assert_eq!(translate(&tables, plan.pml4, 0x1_0010_0000), None);
}

#[test]
fn refuses_a_window_that_only_fits_the_root() {
    let ranges = X86_LAYOUT.ranges(6 * GIB).unwrap();
    let error = plan(&ranges, (0x9000, 0xa000), PageSize::Kib)
        .err()
        .unwrap();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        error.to_string(),
        "boot page tables need 3080 pages, but only 1 are available"
    );
}

#[test]
fn sparse_512_gib_uses_multiple_pdpts_and_enforces_the_table_cap() {
    let ranges = X86_LAYOUT.ranges(512 * GIB).unwrap();
    let gib = plan(&ranges, WINDOW, PageSize::Gib).unwrap();
    assert_eq!(gib.pages.len(), 3, "one root and two PDPTs");
    assert_eq!(gib.tables(), (WINDOW.0, WINDOW.0 + 3 * KIB4));
    assert!(gib.reserved(true).is_empty());
    assert_eq!(gib.reserved(false), vec![gib.tables()]);
    let tables = tables(&gib);
    for gpa in [512 * GIB - 1, 512 * GIB, 513 * GIB - 1] {
        assert_eq!(translate(&tables, gib.pml4, gpa), Some((gpa, GIB)));
    }
    assert_eq!(translate(&tables, gib.pml4, 513 * GIB), None);

    // Give the window one more page than the independent table-page cap.
    let cap_window = (WINDOW.0, WINDOW.1 + KIB4);
    let error = plan(&ranges, cap_window, PageSize::Kib).err().unwrap();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        error.to_string(),
        "boot page tables need 262659 pages, but only 262144 are available"
    );
}

#[test]
fn mixed_leaves_map_adjacent_ranges_as_one_and_leave_small_gaps_absent() {
    let ranges = [
        (GuestAddress(GIB), KIB4 as usize),
        (GuestAddress(MIB2 / 2), (MIB2 / 2) as usize),
        (GuestAddress(GIB + 2 * KIB4), KIB4 as usize),
        (GuestAddress(0), (MIB2 / 2) as usize),
    ];
    let plan = plan(&ranges, WINDOW, PageSize::Gib).unwrap();
    let tables = tables(&plan);
    assert_eq!(
        translate(&tables, plan.pml4, MIB2 - 1),
        Some((MIB2 - 1, MIB2))
    );
    assert_eq!(translate(&tables, plan.pml4, GIB), Some((GIB, KIB4)));
    assert_eq!(translate(&tables, plan.pml4, GIB + KIB4), None);
    assert_eq!(
        translate(&tables, plan.pml4, GIB + 2 * KIB4),
        Some((GIB + 2 * KIB4, KIB4))
    );
}

mod windows {
    use super::*;
    use crate::x86_boot_layout::{TABLES_BASE, TABLES_FAST_END, plan_boot_tables};

    #[test]
    fn small_ram_uses_the_fast_window() {
        let ranges = X86_LAYOUT.ranges(16 << 20).unwrap();
        let plan = plan_boot_tables(&ranges, (0x10_0000, 0x10_3080), None, PageSize::Mib).unwrap();
        assert_eq!(plan.tables(), (0x9000, 0xc000));
    }

    #[test]
    fn fast_window_is_kept_when_the_kernel_sits_below_it() {
        let ranges = X86_LAYOUT.ranges(1 << 20).unwrap();
        let plan = plan_boot_tables(&ranges, (0x3000, 0x4000), None, PageSize::Mib).unwrap();
        // One root, one PDPT, one PD, and one PT for the partial 2 MiB block.
        assert_eq!(plan.pages.len(), 4);
        assert_eq!(plan.tables(), (0x9000, 0xd000));
    }

    #[test]
    fn fast_window_is_kept_when_the_kernel_touches_either_end() {
        let ranges = X86_LAYOUT.ranges(1 << 20).unwrap();
        for kernel in [(0x8000, 0x9000), (0xd000, 0xe000)] {
            let plan = plan_boot_tables(&ranges, kernel, None, PageSize::Mib).unwrap();
            assert_eq!(plan.tables(), (0x9000, 0xd000), "{kernel:#x?}");
        }
    }

    #[test]
    fn large_ram_places_the_tables_after_elf_bss_and_before_the_initramfs() {
        let ranges = X86_LAYOUT.ranges(24 * GIB).unwrap();
        let kernel = (0x10_0000, 0x10_3080);
        let archive = initramfs_slot(&ranges, 5000).unwrap();
        let with_archive =
            plan_boot_tables(&ranges, kernel, Some((archive, 5000)), PageSize::Mib).unwrap();
        assert_eq!(with_archive.tables().0, 0x10_4000);
        assert_eq!(archive.0, 0xbfff_e000);
        assert!(with_archive.tables().1 <= archive.0);

        let without_archive = plan_boot_tables(&ranges, kernel, None, PageSize::Mib).unwrap();
        assert_eq!(without_archive.tables().0, 0x10_4000);
        assert!(without_archive.tables().1 <= 0xc000_0000);
    }

    #[test]
    fn fast_window_is_rejected_when_it_would_cover_the_kernel() {
        let ranges = X86_LAYOUT.ranges(3071 << 20).unwrap();
        let leaf = PageSize::default();
        let fast = (TABLES_BASE, TABLES_FAST_END);
        assert_eq!(
            plan(&ranges, fast, leaf).unwrap().tables(),
            (0x9000, 0xf000)
        );

        // The sixth page starts at 0xe000, where the old five-page layout ended.
        for kernel in [(0xe000, 0x10_0000), (0x8000, 0x10_0000)] {
            let plan = plan_boot_tables(&ranges, kernel, None, leaf).unwrap();
            assert_ne!(plan.tables().0, TABLES_BASE);
            assert!(plan.tables().0 >= kernel.1);
        }
        // Adjacency is safe even if the unused part of the window overlaps.
        let adjacent = plan_boot_tables(&ranges, (0xf000, 0x10_0000), None, leaf).unwrap();
        assert_eq!(adjacent.tables(), (0x9000, 0xf000));
    }

    #[test]
    fn fast_window_is_rejected_when_it_would_cover_the_initramfs() {
        let ranges = X86_LAYOUT.ranges(6144 << 20).unwrap();
        let kernel = (0x1_0000_0000, 0x1_1000_0000);
        let initramfs = Some((GuestAddress(0x1_0000), 0x1000));
        let error = plan_boot_tables(&ranges, kernel, initramfs, PageSize::default())
            .err()
            .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn fast_window_is_kept_when_the_initramfs_starts_right_after_the_tables() {
        let ranges = X86_LAYOUT.ranges(6144 << 20).unwrap();
        let kernel = (0x1_0000_0000, 0x1_1000_0000);
        let initramfs = Some((GuestAddress(0x1_1000), 0x1000));
        let plan = plan_boot_tables(&ranges, kernel, initramfs, PageSize::default()).unwrap();
        assert_eq!(plan.tables(), (0x9000, 0x11000));
    }

    #[test]
    fn slow_window_must_not_cover_the_kernel() {
        let ranges = X86_LAYOUT.ranges(16 << 20).unwrap();
        let kernel = (0, 0x1_0000_0000);
        let error = plan_boot_tables(&ranges, kernel, None, PageSize::Mib)
            .err()
            .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn large_ram_rejects_an_empty_window_above_the_kernel() {
        let ranges = X86_LAYOUT.ranges(24 * GIB).unwrap();
        let archive = (GuestAddress(0x10_4000), 5000);
        let kernel = (0x10_0000, 0x10_3080);
        let error = plan_boot_tables(&ranges, kernel, Some(archive), PageSize::Mib)
            .err()
            .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
