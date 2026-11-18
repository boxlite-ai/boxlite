// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The boot GDT, page tables and entry registers, read back from guest RAM that
//! starts out filled with `0xff`, so every byte checked was written by
//! `long_mode_entry`.

use std::io;

use vm_memory::{Bytes, GuestAddress};

use super::long_mode_entry;
use crate::{
    memory::{GuestMemoryMmap, MMIO_HOLE_START},
    x86_boot_layout::{PageSize, TABLES_BASE, plan_boot_tables},
};

const ENTRY: u64 = 0x10_0000;
const LEAVES: [PageSize; 3] = [PageSize::Gib, PageSize::Mib, PageSize::Kib];
const BOOT_PARAMS: u64 = 0x7000;

fn ram(size: usize) -> GuestMemoryMmap {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), size)]).unwrap();
    ram.write_slice(&vec![0xff; size], GuestAddress(0)).unwrap();
    ram
}

/// Translates `virt` as the MMU does with 4-level paging, checking each entry
/// on the way; `None` if a level is not present.
fn translate(ram: &GuestMemoryMmap, cr3: u64, virt: u64) -> Option<u64> {
    const ADDRESS: u64 = 0x000f_ffff_ffff_f000;
    let mut table = cr3 & ADDRESS;
    for shift in [39, 30, 21, 12] {
        let index = (virt >> shift) & 0x1ff;
        let entry: u64 = ram.read_obj(GuestAddress(table + index * 8)).unwrap();
        if entry & 1 == 0 {
            return None;
        }
        assert_eq!(entry & ((1 << 63) | (1 << 1)), 1 << 1, "writable, not NX");
        table = entry & ADDRESS;
        if shift == 12 || (matches!(shift, 30 | 21) && entry & (1 << 7) != 0) {
            return Some(table | (virt & ((1 << shift) - 1)));
        }
    }
    unreachable!()
}

#[test]
fn writes_the_linux_boot_gdt_and_returns_64_bit_registers() {
    for leaf in LEAVES {
        let ram = ram(2 << 20);
        let plan = plan_boot_tables(
            &[(GuestAddress(0), 2 << 20)],
            (ENTRY, ENTRY + 1),
            None,
            leaf,
        )
        .unwrap();
        let regs = long_mode_entry(&ram, ENTRY, BOOT_PARAMS, &plan).unwrap();

        // boot.rst: flat __BOOT_CS (0x10) and __BOOT_DS (0x18).
        let gdt: [u64; 4] = ram.read_obj(GuestAddress(regs.gdt_base)).unwrap();
        assert_eq!(gdt, [0, 0, 0x00af_9b00_0000_ffff, 0x00cf_9300_0000_ffff]);
        assert_eq!((regs.gdt_base, regs.gdt_limit), (0x500, 31));
        let code = regs.code;
        assert_eq!(
            (code.selector, code.attributes, code.base, code.limit),
            (0x10, 0xa09b, 0, u32::MAX)
        );
        let data = regs.data;
        assert_eq!(
            (data.selector, data.attributes, data.base, data.limit),
            (0x18, 0xc093, 0, u32::MAX)
        );
        // PE, ET and PG; PAE; LME and LMA; IF clear; no IDT.
        assert_eq!((regs.cr0, regs.cr4, regs.efer), (0x8000_0011, 0x20, 0x500));
        assert_eq!(
            (regs.rip, regs.rsi, regs.rsp, regs.rflags),
            (ENTRY, BOOT_PARAMS, 0x8ff0, 2)
        );
        assert_eq!((regs.idt_base, regs.idt_limit), (0, 0));
    }
}

#[test]
fn writes_identity_mappings_only_for_ram() {
    let high_start = 1 << 32;
    let high_end = high_start + (1 << 30);
    let low_size = 6 << 20;
    let ranges = [
        (GuestAddress(0), low_size),
        (GuestAddress(high_start), 1 << 30),
    ];
    // The walker only reads the tables in low RAM, not the mapped high RAM.
    let tables_base = 0x20_0000;
    for leaf in LEAVES {
        let ram = ram(low_size);
        let plan = plan_boot_tables(&ranges, (TABLES_BASE, tables_base), None, leaf).unwrap();
        let regs = long_mode_entry(&ram, ENTRY, BOOT_PARAMS, &plan).unwrap();
        assert_eq!(regs.cr3, tables_base);

        for virt in [
            0,
            BOOT_PARAMS,
            0x2_0000,
            ENTRY,
            low_size as u64 - 1,
            high_start,
            high_end - 1,
        ] {
            assert_eq!(
                translate(&ram, regs.cr3, virt),
                Some(virt),
                "{leaf:?}, {virt:#x}"
            );
        }
        for virt in [
            low_size as u64,
            MMIO_HOLE_START,
            u64::from(u32::MAX),
            high_end,
            1 << 39,
        ] {
            assert_eq!(translate(&ram, regs.cr3, virt), None, "{leaf:?}, {virt:#x}");
        }
    }
}

#[test]
fn ram_without_room_for_the_tables_is_rejected_untouched() {
    for leaf in LEAVES {
        let plan = plan_boot_tables(
            &[(GuestAddress(0), 2 << 20)],
            (ENTRY, ENTRY + 1),
            None,
            leaf,
        )
        .unwrap();
        let size = plan.pages.last().unwrap().addr as usize;
        let ram = ram(size);

        let error = long_mode_entry(&ram, ENTRY, BOOT_PARAMS, &plan).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        let mut bytes = vec![0; size];
        ram.read_slice(&mut bytes, GuestAddress(0)).unwrap();
        assert!(
            bytes.iter().all(|&byte| byte == 0xff),
            "RAM was written for {leaf:?}"
        );
    }
}
