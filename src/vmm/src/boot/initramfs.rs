// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Places the initramfs in the highest page-aligned slot of RAM below an end
//! the boot path picks: the end of RAM on x86_64, as Firecracker and
//! cloud-hypervisor do, and the device tree on arm64, as Firecracker does.
//! Linux finds it through `boot_params` or the device tree.
//!
//! The slot is not checked against the kernel here. The arm64 boot path
//! refuses an initramfs that reaches into the `Image`; on x86_64 only tests
//! boot an initramfs, and the boot tests fail if one overwrites the kernel.

use std::io;

use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend, GuestMemoryRegion, ReadVolatile};

/// Linux frees the initramfs pages after unpacking them and warns about a
/// start that is not page aligned.
const PAGE_SIZE: u64 = 0x1000;

/// Reads `size` bytes of `image` into the highest page-aligned slot below
/// `end`, within the RAM region that holds the byte before `end`, and returns
/// its start.
///
/// Fails with `InvalidInput`, writing nothing, if `size` is zero or the slot
/// does not fit in that region.
pub(crate) fn load_initramfs<M, R>(
    ram: &M,
    image: &mut R,
    size: usize,
    end: GuestAddress,
) -> io::Result<GuestAddress>
where
    M: GuestMemoryBackend,
    R: ReadVolatile,
{
    let invalid = |reason: String| io::Error::new(io::ErrorKind::InvalidInput, reason);
    if size == 0 {
        return Err(invalid("the initramfs is empty".into()));
    }
    let region_start = end
        .0
        .checked_sub(1)
        .and_then(|last| ram.find_region(GuestAddress(last)))
        .map(|region| region.start_addr().0)
        .ok_or_else(|| invalid(format!("no RAM below {:#x}", end.0)))?;
    let start = end
        .0
        .checked_sub(size as u64)
        .map(|start| start & !(PAGE_SIZE - 1))
        .filter(|&start| start >= region_start)
        .ok_or_else(|| {
            invalid(format!(
                "an initramfs of {size} bytes does not fit in RAM from {region_start:#x} to {:#x}",
                end.0
            ))
        })?;
    ram.read_exact_volatile_from(GuestAddress(start), image, size)
        .map_err(io::Error::other)?;
    Ok(GuestAddress(start))
}

#[cfg(test)]
#[path = "../../tests/initramfs/mod.rs"]
mod tests;
