// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The x86_64 zero page and kernel command line for the 64-bit boot protocol
//! (`Documentation/arch/x86/boot.rst`, `zero-page.rst`).

use std::io;

use linux_loader::{
    cmdline::Cmdline,
    configurator::{BootConfigurator, BootParams, linux::LinuxBootConfigurator},
    loader::{
        bootparam::{boot_e820_entry, boot_params},
        load_cmdline,
    },
};
use vm_memory::{GuestAddress, GuestMemoryBackend};

use crate::config::MAX_CMDLINE_BYTES;

pub(super) use crate::x86_boot_layout::LOW_RAM_END;

/// `boot_params` (the zero page), as the design's x86_64 layout places it.
const ZERO_PAGE_START: u64 = 0x7000;
/// The NUL-terminated kernel command line, from the same layout.
const CMDLINE_START: u64 = 0x2_0000;

/// Setup header values, as Firecracker and libkrun write them: no assigned
/// loader ID, the boot flag and "HdrS" magic, and a 16 MiB alignment.
const LOADER_UNDEFINED: u8 = 0xff;
const BOOT_FLAG: u16 = 0xaa55;
const HEADER_MAGIC: u32 = u32::from_le_bytes(*b"HdrS");
const KERNEL_ALIGNMENT: u32 = 16 << 20;
/// `E820_TYPE_RAM`: usable RAM.
const E820_RAM: u32 = 1;
const E820_RESERVED: u32 = 2;

/// Writes the command line at 0x2_0000 and `boot_params` at 0x7000, then
/// returns the zero-page address the boot vCPU gets in RSI. Each of `ranges`
/// becomes usable E820 RAM outside [0x9_FC00, 1 MiB) and the half-open
/// `reserved` intervals. The start and size of `initramfs` go into the header.
///
/// Fails with `InvalidInput`, writing nothing, if `cmdline`, once trimmed, is
/// not printable ASCII under `MAX_CMDLINE_BYTES`, if the E820 map needs more
/// than 128 slots, or if `initramfs` does not fit the 32-bit fields.
pub(crate) fn write_boot_params<M: GuestMemoryBackend>(
    ram: &M,
    cmdline: &str,
    ranges: &[(GuestAddress, usize)],
    initramfs: Option<(GuestAddress, usize)>,
    reserved: &[(u64, u64)],
) -> io::Result<u64> {
    let mut line = Cmdline::new(MAX_CMDLINE_BYTES).map_err(io::Error::other)?;
    line.insert_str(cmdline)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let cmdline_size = line
        .as_cstring()
        .map_err(io::Error::other)?
        .as_bytes_with_nul()
        .len();

    let mut params = boot_params::default();
    params.hdr.type_of_loader = LOADER_UNDEFINED;
    params.hdr.boot_flag = BOOT_FLAG;
    params.hdr.header = HEADER_MAGIC;
    params.hdr.kernel_alignment = KERNEL_ALIGNMENT;
    params.hdr.cmd_line_ptr = CMDLINE_START as u32;
    params.hdr.cmdline_size = cmdline_size as u32;
    if let Some((start, size)) = initramfs {
        let field = |value: u64| {
            u32::try_from(value).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the initramfs does not fit the 32-bit setup header fields",
                )
            })
        };
        params.hdr.ramdisk_image = field(start.0)?;
        params.hdr.ramdisk_size = field(size as u64)?;
    }
    let entries = e820_entries(ranges, reserved);
    let slots = params.e820_table.len();
    if entries.len() > slots {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} E820 entries do not fit the {slots} zero-page slots",
                entries.len()
            ),
        ));
    }
    for (slot, entry) in entries.iter().enumerate() {
        params.e820_table[slot] = *entry;
    }
    params.e820_entries = entries.len() as u8;

    load_cmdline(ram, GuestAddress(CMDLINE_START), &line).map_err(io::Error::other)?;
    let zero_page = BootParams::new(&params, GuestAddress(ZERO_PAGE_START));
    LinuxBootConfigurator::write_bootparams(&zero_page, ram).map_err(io::Error::other)?;
    Ok(ZERO_PAGE_START)
}

fn e820_entries(ranges: &[(GuestAddress, usize)], reserved: &[(u64, u64)]) -> Vec<boot_e820_entry> {
    let mut reserved = reserved.to_vec();
    reserved.sort_unstable();
    let mut entries: Vec<_> = reserved
        .iter()
        .map(|&(start, end)| boot_e820_entry {
            addr: start,
            size: end - start,
            r#type: E820_RESERVED,
        })
        .collect();
    let mut usable = |addr, end| {
        if addr < end {
            entries.push(boot_e820_entry {
                addr,
                size: end - addr,
                r#type: E820_RAM,
            });
        }
    };
    for (start, size) in crate::x86_boot_layout::e820_ram_ranges(ranges) {
        let end = start + size;
        let mut cursor = start;
        for &(from, to) in reserved.iter().take_while(|&&(from, _)| from < end) {
            if cursor < to {
                usable(cursor, from);
                cursor = to;
            }
        }
        usable(cursor, end);
    }
    entries.sort_unstable_by_key(|entry| entry.addr);
    entries
}

#[cfg(test)]
#[path = "../../tests/params/mod.rs"]
mod tests;
