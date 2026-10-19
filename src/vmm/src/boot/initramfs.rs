// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Loads an uncompressed newc cpio archive into the top of guest RAM for the
//! 64-bit Linux boot protocol.

use std::io::{self, Read, Seek, SeekFrom};

use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend};

/// 4 KiB page size for alignment.
const PAGE_SIZE: u64 = 4096;

/// What [`load_initramfs`] placed in guest RAM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LoadedInitramfs {
    /// Guest physical address where the archive was loaded.
    pub(crate) address: u64,
    /// Number of bytes in the archive.
    pub(crate) size: usize,
}

/// Aligns `addr` down to the nearest multiple of `align`, which must be a power of two.
fn align_down(addr: u64, align: u64) -> u64 {
    addr & !(align - 1)
}

/// Aligns `addr` up to the nearest multiple of `align`, which must be a power of two.
fn align_up(addr: u64, align: u64) -> u64 {
    (addr + align - 1) & !(align - 1)
}

/// Places `archive` at the top of guest RAM, aligned down to 4 KiB, and writes
/// its bytes into RAM.
///
/// Fails with `InvalidInput` before writing anything if the archive is empty,
/// does not fit in RAM, or would start below the page-aligned `kernel_end`.
pub(crate) fn load_initramfs<M, R>(
    ram: &M,
    archive: &mut R,
    kernel_end: u64,
    ram_end: u64,
) -> io::Result<LoadedInitramfs>
where
    M: GuestMemoryBackend,
    R: Read + Seek,
{
    let size = archive.seek(SeekFrom::End(0))?;
    archive.seek(SeekFrom::Start(0))?;
    if size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the initramfs archive is empty",
        ));
    }
    let Some(unaligned) = ram_end.checked_sub(size) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the initramfs archive does not fit in guest RAM",
        ));
    };
    let start = align_down(unaligned, PAGE_SIZE);
    let aligned_kernel_end = align_up(kernel_end, PAGE_SIZE);
    if start < aligned_kernel_end {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the initramfs archive overlaps with the kernel",
        ));
    }
    let mut buf = vec![0u8; size as usize];
    archive.read_exact(&mut buf)?;
    ram.write_slice(&buf, GuestAddress(start))
        .map_err(io::Error::other)?;
    Ok(LoadedInitramfs {
        address: start,
        size: size as usize,
    })
}

#[cfg(test)]
#[path = "../../tests/initramfs/mod.rs"]
pub(crate) mod tests;
