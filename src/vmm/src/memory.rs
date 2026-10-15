// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Backing-memory ownership and guest address layout.
//!
//! [`GuestRam`] allocates the RAM a VM uses. Host-side users of guest memory
//! hold clones of the shared [`Arc`] and go through vm-memory's volatile
//! access API, never plain references. Registering the RAM with the host
//! hypervisor, and the lifetime rules that come with it, follow in the next
//! slice.

use std::{io, ptr::NonNull, sync::Arc};

use boxlite_hypervisor::MemoryRegion;
use vm_memory::{GuestAddress, GuestMemoryBackend, GuestMemoryRegion};

use crate::error::{Error, Result};

/// The guest memory type every host-side user shares. Dirty-page tracking
/// (M8) changes this alias rather than every holder.
pub(crate) type GuestMemoryMmap = vm_memory::GuestMemoryMmap<()>;

/// Bytes per MiB.
const MIB: u64 = 1 << 20;

/// Guest physical address of the first RAM byte: 0 on x86_64, 2 GiB on arm64,
/// where the interrupt controller, UART, RTC and device windows sit below RAM.
#[cfg(target_arch = "x86_64")]
pub(crate) const RAM_START: u64 = 0;
#[cfg(target_arch = "aarch64")]
pub(crate) const RAM_START: u64 = 0x8000_0000;

/// Where the x86_64 32-bit MMIO hole begins: the VMM design and Firecracker
/// both reserve the gigabyte below 4 GiB for devices.
#[cfg(target_arch = "x86_64")]
pub(crate) const MMIO_HOLE_START: u64 = 0xC000_0000;

/// Largest `memory_mib` this layout places: the x86_64 RAM below the MMIO
/// hole. Every architecture keeps the same bound until a later change adds
/// the x86_64 region above 4 GiB and the arm64 address-space limit.
pub(crate) const MAX_MEMORY_MIB: u32 = 3072;

#[cfg(target_arch = "x86_64")]
const _: () = assert!(RAM_START + MAX_MEMORY_MIB as u64 * MIB <= MMIO_HOLE_START);

/// The guest RAM ranges for `memory_mib`: one region at [`RAM_START`].
pub(crate) fn ram_ranges(memory_mib: u32) -> Vec<(GuestAddress, usize)> {
    // A MiB count fits `usize` on the 64-bit hosts the hypervisor supports.
    let size = (u64::from(memory_mib) * MIB) as usize;
    vec![(GuestAddress(RAM_START), size)]
}

/// Guest RAM owned by the VMM.
#[derive(Debug)]
pub(crate) struct GuestRam {
    memory: Arc<GuestMemoryMmap>,
}

impl GuestRam {
    /// Allocates zero-filled anonymous memory for `ranges`, which must be
    /// ascending and non-overlapping.
    pub(crate) fn new(ranges: &[(GuestAddress, usize)]) -> Result<Self> {
        let bytes = ranges.iter().map(|(_, size)| *size as u64).sum();
        let memory =
            GuestMemoryMmap::from_ranges(ranges).map_err(|source| Error::AllocateMemory {
                bytes,
                source: io::Error::other(source),
            })?;
        Ok(Self {
            memory: Arc::new(memory),
        })
    }

    /// The shared guest memory every host-side user clones.
    pub(crate) fn memory(&self) -> &Arc<GuestMemoryMmap> {
        &self.memory
    }

    /// Each RAM range as the hypervisor registers it, in ascending guest order.
    pub(crate) fn regions(&self) -> impl Iterator<Item = MemoryRegion> + '_ {
        self.memory.iter().map(|region| MemoryRegion {
            guest_addr: region.start_addr().0,
            // vm-memory rejects a failed mmap, so a region pointer is never null.
            host_addr: NonNull::new(region.as_ptr()).expect("mmap returned a null mapping"),
            size: region.len() as usize,
        })
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../tests/memory/mod.rs"]
mod tests;
