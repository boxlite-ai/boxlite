// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Places the initramfs for the 64-bit boot protocol: at the top of the RAM
//! region at 0, page aligned, as Firecracker and cloud-hypervisor do. Linux
//! finds it through `boot_params`.
//!
//! Nothing checks that the slot stays clear of the kernel: only tests boot an
//! initramfs, and the KVM boot test fails if one overwrites the kernel.

use std::io;

use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend, GuestMemoryRegion, ReadVolatile};

use crate::memory::RAM_START;

/// Linux frees the initramfs pages after unpacking them and warns about a
/// start that is not page aligned.
const PAGE_SIZE: u64 = 0x1000;

/// Reads `size` bytes of `image` into the top page-aligned slot of the RAM
/// region at [`RAM_START`] and returns its start.
///
/// Fails with `InvalidInput`, writing nothing, if `size` is zero or larger
/// than that region.
pub(crate) fn load_initramfs<M, R>(ram: &M, image: &mut R, size: usize) -> io::Result<GuestAddress>
where
    M: GuestMemoryBackend,
    R: ReadVolatile,
{
    if size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the initramfs is empty",
        ));
    }
    let region = ram.find_region(GuestAddress(RAM_START)).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("no guest RAM region found at {RAM_START:#x}"),
        )
    })?;
    let ram_end = region
        .start_addr()
        .0
        .checked_add(region.len())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "guest RAM address overflow"))?;
    let start = ram_end
        .checked_sub(size as u64)
        .map(|start| start & !(PAGE_SIZE - 1))
        .filter(|&start| start >= region.start_addr().0)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("an initramfs of {size} bytes does not fit in {ram_end:#x} bytes of RAM"),
            )
        })?;
    ram.read_exact_volatile_from(GuestAddress(start), image, size)
        .map_err(io::Error::other)?;
    Ok(GuestAddress(start))
}

#[cfg(test)]
#[path = "../../tests/initramfs/mod.rs"]
mod tests;
