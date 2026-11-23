// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The boot vCPU state at the Linux 64-bit entry (`Documentation/arch/x86/boot.rst`,
//! "64-bit Boot Protocol"): long mode with paging, identity-mapped RAM, a GDT
//! with flat `__BOOT_CS` and `__BOOT_DS`, interrupts off, and RSI at
//! `boot_params`.

use std::io;

use boxlite_hypervisor::{X86BootRegisters, X86Segment};
use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend};

use crate::x86_boot_layout::TablePlan;

/// The boot GDT sits below the zero page at `0x7000`.
const GDT_START: u64 = 0x500;
/// Null, unused, `__BOOT_CS` and `__BOOT_DS`: flat 64-bit code and flat
/// read/write data, as Linux encodes `GDT_ENTRY_INIT(DESC_CODE64, 0, 0xfffff)`
/// and `GDT_ENTRY_INIT(DESC_DATA64, 0, 0xfffff)`.
const GDT: [u64; 4] = [0, 0, 0x00af_9b00_0000_ffff, 0x00cf_9300_0000_ffff];
const BOOT_CS: u16 = 0x10;
const BOOT_DS: u16 = 0x18;

/// Top of the boot stack, below the page tables; Firecracker uses the same.
const BOOT_STACK: u64 = 0x8ff0;
const PAGE_SIZE: u64 = 0x1000;

const CR0_PE: u64 = 1;
const CR0_ET: u64 = 1 << 4;
const CR0_PG: u64 = 1 << 31;
const CR4_PAE: u64 = 1 << 5;
const EFER_LME: u64 = 1 << 8;
const EFER_LMA: u64 = 1 << 10;
/// Bit 1 of RFLAGS is always set; IF stays clear.
const RFLAGS_FIXED: u64 = 1 << 1;

/// Writes the boot GDT and identity page tables into `ram` and returns the boot
/// vCPU registers that enter `entry` in 64-bit mode with RSI at `boot_params`.
/// Both addresses must be mapped by `plan`. If `ram` does not hold the GDT or
/// any table page, returns `InvalidInput` without writing anything.
pub(crate) fn long_mode_entry<M: GuestMemoryBackend>(
    ram: &M,
    entry: u64,
    boot_params: u64,
    plan: &TablePlan,
) -> io::Result<X86BootRegisters> {
    let check = |addr, len| {
        if ram.check_range(GuestAddress(addr), len) {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("guest RAM does not cover {len:#x} bytes of boot tables at {addr:#x}"),
            ))
        }
    };
    check(GDT_START, size_of_val(&GDT))?;
    for page in &plan.pages {
        check(page.addr, PAGE_SIZE as usize)?;
    }

    ram.write_obj(GDT, GuestAddress(GDT_START))
        .map_err(io::Error::other)?;
    let mut bytes = [0; PAGE_SIZE as usize];
    for page in &plan.pages {
        for (slot, entry) in bytes.as_chunks_mut::<8>().0.iter_mut().zip(&page.entries) {
            *slot = entry.to_le_bytes();
        }
        ram.write_slice(&bytes, GuestAddress(page.addr))
            .map_err(io::Error::other)?;
    }
    Ok(X86BootRegisters {
        rip: entry,
        rsp: BOOT_STACK,
        rsi: boot_params,
        rflags: RFLAGS_FIXED,
        cr0: CR0_PE | CR0_ET | CR0_PG,
        cr3: plan.pml4,
        cr4: CR4_PAE,
        efer: EFER_LME | EFER_LMA,
        code: segment(BOOT_CS),
        data: segment(BOOT_DS),
        gdt_base: GDT_START,
        gdt_limit: (size_of_val(&GDT) - 1) as u16,
        // No IDT: an exception before Linux installs its own triple-faults.
        idt_base: 0,
        idt_limit: 0,
    })
}

/// The hidden segment state for `selector`, decoded from its GDT entry so the
/// registers and the GDT in guest RAM cannot disagree.
fn segment(selector: u16) -> X86Segment {
    let descriptor = GDT[usize::from(selector >> 3)];
    let attributes = ((descriptor >> 40) & 0xf0ff) as u16;
    let limit = (((descriptor >> 32) & 0xf_0000) | (descriptor & 0xffff)) as u32;
    X86Segment {
        base: ((descriptor >> 16) & 0xff_ffff) | ((descriptor >> 32) & 0xff00_0000),
        // G (attribute bit 15) counts the limit in 4 KiB units.
        limit: if attributes & 0x8000 != 0 {
            (limit << 12) | 0xfff
        } else {
            limit
        },
        selector,
        attributes,
    }
}

// Unit tests live under `tests/`, like the crate's other test modules.
#[cfg(test)]
#[path = "../../tests/entry/mod.rs"]
mod tests;
