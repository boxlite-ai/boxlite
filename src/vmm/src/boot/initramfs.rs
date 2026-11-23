// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Places the initramfs in a page-aligned slot at the top of the low RAM
//! range containing guest address 0, even when RAM exists above 4 GiB.
//! The 64-bit boot protocol's `ramdisk_image` and `ramdisk_size` fields in
//! `boot_params` are 32 bits wide.
//!
//! Nothing checks that the slot stays clear of the kernel: only tests boot an
//! initramfs, and the KVM boot test fails if one overwrites the kernel.

use std::io;

use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend, ReadVolatile};

/// Reads `size` bytes of `image` into the top page-aligned slot of the RAM
/// region at 0 and returns its start.
///
/// Fails with `InvalidInput`, writing nothing, if that region is missing or
/// if `size` is zero or larger than the region.
pub(crate) fn load_initramfs<M, R>(
    ram: &M,
    ranges: &[(GuestAddress, usize)],
    image: &mut R,
    size: usize,
) -> io::Result<GuestAddress>
where
    M: GuestMemoryBackend,
    R: ReadVolatile,
{
    let start = crate::x86_boot_layout::initramfs_slot(ranges, size)?;
    ram.read_exact_volatile_from(start, image, size)
        .map_err(io::Error::other)?;
    Ok(start)
}

#[cfg(test)]
#[path = "../../tests/initramfs/mod.rs"]
mod tests;
