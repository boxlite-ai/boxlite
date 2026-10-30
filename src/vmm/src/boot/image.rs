// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Loads an arm64 `Image` through linux-loader at its text offset above the
//! 2 MiB-aligned RAM base (`Documentation/arch/arm64/booting.rst`).

use std::io::{self, Read, Seek};

use linux_loader::loader::{Error as LoaderError, KernelLoader, PE, pe};
use vm_memory::{Bytes, GuestAddress, GuestMemoryBackend, ReadVolatile};

use crate::memory::RAM_START;

/// Where the `Image` runs, and the first byte past what it claims.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LoadedImage {
    /// The load address, which is also the entry point.
    pub(crate) entry: GuestAddress,
    /// The end of the larger of the file and the header's `image_size`,
    /// which includes the kernel's BSS.
    pub(crate) end: GuestAddress,
}

/// Loads `image` at the RAM base plus its text offset. Fails with
/// `InvalidData` for a file that is not an arm64 `Image`.
pub(crate) fn load_image<M, F>(ram: &M, image: &mut F) -> io::Result<LoadedImage>
where
    M: GuestMemoryBackend,
    F: Read + Seek + ReadVolatile,
{
    let loaded =
        PE::load(ram, Some(GuestAddress(RAM_START)), image, None).map_err(|error| match error {
            LoaderError::Pe(pe::Error::InvalidImageMagicNumber) => {
                io::Error::new(io::ErrorKind::InvalidData, error)
            }
            error => io::Error::other(error),
        })?;
    let header: pe::arm64_image_header =
        ram.read_obj(loaded.kernel_load).map_err(io::Error::other)?;
    let claimed = loaded
        .kernel_load
        .0
        .checked_add(u64::from_le(header.image_size))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Image size overflows its address",
            )
        })?;
    let end = GuestAddress(loaded.kernel_end.max(claimed));
    // linux-loader checks only the file; the BSS past it must fit as well.
    if !ram.check_range(loaded.kernel_load, (end.0 - loaded.kernel_load.0) as usize) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("the Image claims memory up to {:#x}, outside RAM", end.0),
        ));
    }
    Ok(LoadedImage {
        entry: loaded.kernel_load,
        end,
    })
}

#[cfg(test)]
#[path = "../../tests/image/mod.rs"]
mod tests;
