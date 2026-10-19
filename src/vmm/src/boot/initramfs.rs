// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Places the initramfs for the 64-bit boot protocol: at the top of the RAM
//! region at 0, page aligned and above the kernel, as Firecracker and
//! cloud-hypervisor do. Linux finds it through `boot_params`.

use std::io;

use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend, GuestMemoryRegion, ReadVolatile};

/// Linux frees the initramfs pages after unpacking them and warns about a
/// start that is not page aligned.
const PAGE_SIZE: u64 = 0x1000;

/// Reads `size` bytes of `image` into the top page-aligned slot of the RAM
/// region at 0 and returns its start.
///
/// Fails with `InvalidInput`, writing nothing, if `size` is zero or the slot
/// would begin below the page-aligned `kernel_end`.
pub(crate) fn load_initramfs<M, R>(
    ram: &M,
    image: &mut R,
    size: usize,
    kernel_end: u64,
) -> io::Result<GuestAddress>
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
    let ram_end = ram
        .find_region(GuestAddress(0))
        .map_or(0, |region| region.len());
    let floor = kernel_end.checked_next_multiple_of(PAGE_SIZE);
    let start = ram_end
        .checked_sub(size as u64)
        .map(|start| start & !(PAGE_SIZE - 1))
        .filter(|&start| floor.is_some_and(|floor| start >= floor))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "an initramfs of {size} bytes does not fit between the kernel end \
                     {kernel_end:#x} and the RAM end {ram_end:#x}"
                ),
            )
        })?;
    ram.read_exact_volatile_from(GuestAddress(start), image, size)
        .map_err(io::Error::other)?;
    Ok(GuestAddress(start))
}

#[cfg(test)]
#[path = "../../tests/initramfs/mod.rs"]
mod tests;
