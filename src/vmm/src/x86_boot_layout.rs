// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Pure x86_64 boot layout calculations, independent of linux-loader, KVM,
//! and guest memory allocation. The Linux x86_64 `boot` module and this
//! crate's tests share them. Boot page-table planning also belongs here.

use std::io;

use vm_memory::GuestAddress;

/// Usable low RAM ends where the MP table and the legacy BIOS areas begin.
pub(crate) const LOW_RAM_END: u64 = 0x9_fc00;
/// Usable RAM resumes here, above the legacy BIOS areas.
const HIGH_RAM_START: u64 = 0x10_0000;
/// Linux frees the initramfs pages after unpacking them and warns about a
/// start that is not page aligned.
const PAGE_SIZE: u64 = 0x1000;

/// Usable RAM intervals for `ranges`, without `[LOW_RAM_END, HIGH_RAM_START)`.
pub(crate) fn e820_ram_ranges(ranges: &[(GuestAddress, usize)]) -> Vec<(u64, u64)> {
    let mut usable = Vec::new();
    for &(start, size) in ranges {
        let (start, end) = (start.0, start.0 + size as u64);
        for (from, to) in [
            (start, end.min(LOW_RAM_END)),
            (start.max(HIGH_RAM_START), end),
        ] {
            if from < to {
                usable.push((from, to - from));
            }
        }
    }
    usable
}

/// The top page-aligned slot of the RAM range that holds guest address 0.
pub(crate) fn initramfs_slot(
    ranges: &[(GuestAddress, usize)],
    size: usize,
) -> io::Result<GuestAddress> {
    if size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the initramfs is empty",
        ));
    }
    let len = ranges
        .iter()
        .find_map(|&(start, len)| (start.0 == 0).then_some(len))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "no RAM range at guest address 0 for the initramfs",
            )
        })?;
    let start = len.checked_sub(size).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("an initramfs of {size} bytes does not fit in {len:#x} bytes of RAM"),
        )
    })?;
    Ok(GuestAddress(start as u64 & !(PAGE_SIZE - 1)))
}

#[cfg(test)]
#[path = "../tests/x86_boot_layout/mod.rs"]
mod tests;
