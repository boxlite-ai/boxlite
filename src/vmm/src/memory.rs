// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Owned RAM prepared from an x86_64 ELF kernel, before vCPU creation.

mod elf;

use std::io::{self, Cursor};

use linux_loader::loader::{KernelLoader, elf::Elf};
use vm_memory::{GuestAddress, GuestMemoryMmap};

// Keep this initial contiguous layout below the x86 MMIO region.
const MAX_RAM_MIB: u32 = 3072;
const KERNEL_MIN_ADDR: u64 = 0x10_0000;

pub(crate) struct KernelMemory {
    pub(crate) ram: GuestMemoryMmap<()>,
    pub(crate) entry: u64,
    pub(crate) kernel_end: u64,
}

impl KernelMemory {
    /// Prepares fresh RAM; no hypervisor mapping or guest execution happens here.
    ///
    /// The owner must retain this allocation until the VM, all its vCPUs, and
    /// every host user have stopped accessing it. Mapping is a separate unsafe
    /// operation governed by `boxlite_hypervisor::Vm::map_memory`.
    pub(crate) fn load(image: &[u8], ram_mib: u32) -> io::Result<Self> {
        if !(1..=MAX_RAM_MIB).contains(&ram_mib) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("guest RAM must be 1..={MAX_RAM_MIB} MiB, got {ram_mib}"),
            ));
        }
        let ram_bytes = (ram_mib as usize) << 20;
        let layout = elf::validate(image, ram_bytes as u64)?;
        // Anonymous mmap is initially zero. Preflight rejects overlap, so
        // loading file-backed bytes cannot overwrite another segment's BSS.
        let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), ram_bytes)])
            .map_err(io::Error::other)?;
        Elf::load(
            &ram,
            // A zero offset preserves physical addresses and disables unused
            // PVH note parsing; this increment uses the ELF entry directly.
            Some(GuestAddress(0)),
            &mut Cursor::new(image),
            Some(GuestAddress(KERNEL_MIN_ADDR)),
        )
        .map_err(io::Error::other)?;
        Ok(Self {
            ram,
            entry: layout.entry,
            kernel_end: layout.end,
        })
    }
}

#[cfg(test)]
#[path = "../tests/memory/mod.rs"]
mod tests;
