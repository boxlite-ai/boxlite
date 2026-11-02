// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The block device's image backend.
//!
//! The first slice serves a raw image through imago's native synchronous
//! interface. The device is serialized by its caller, so the backend adds no
//! lock of its own; `discard` needs `&mut self` because imago invalidates
//! existing data mappings when a range is discarded.

use std::{io, path::Path};

use imago::{FormatAccess, Storage, StorageOpenOptions, file::File, raw::Raw};

use super::{SECTOR_SHIFT, SECTOR_SIZE};

/// A raw image and the geometry the device reports for it.
pub(crate) struct BlkBackend {
    image: FormatAccess<File>,
    capacity_sectors: u64,
    read_only: bool,
    discard_sector_alignment: u32,
}

impl BlkBackend {
    /// Opens `path` as a raw image.
    pub(crate) fn open(path: &Path, read_only: bool) -> io::Result<Self> {
        let options = StorageOpenOptions::new().write(!read_only).filename(path);
        let file = File::open(options)?;
        let discard_alignment = file.discard_align() as u64 / SECTOR_SIZE;
        let raw = Raw::<File>::open_image(file, !read_only)?;
        let image = FormatAccess::new(raw);
        let capacity_sectors = image.size() >> SECTOR_SHIFT;
        Ok(Self {
            image,
            capacity_sectors,
            read_only,
            discard_sector_alignment: discard_alignment.clamp(1, u32::MAX as u64) as u32,
        })
    }

    /// The image size in 512-byte sectors.
    pub(crate) fn capacity_sectors(&self) -> u64 {
        self.capacity_sectors
    }

    /// Whether the image was opened read-only.
    pub(crate) fn read_only(&self) -> bool {
        self.read_only
    }

    /// The discard alignment in sectors, at least one.
    pub(crate) fn discard_sector_alignment(&self) -> u32 {
        self.discard_sector_alignment
    }

    /// Reads `buf.len()` bytes at `offset`.
    pub(crate) fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        self.image.read(buf, offset)
    }

    /// Writes `buf` at `offset`.
    pub(crate) fn write_at(&self, offset: u64, buf: &[u8]) -> io::Result<()> {
        self.image.write(buf, offset)
    }

    /// Flushes and syncs the image.
    pub(crate) fn flush(&self) -> io::Result<()> {
        self.image.flush()?;
        self.image.sync()
    }

    /// Discards `len` bytes at `offset`, leaving zeroes on read-back.
    pub(crate) fn discard(&mut self, offset: u64, len: u64) -> io::Result<()> {
        self.image.discard_to_zero(offset, len)
    }

    /// Ensures `len` bytes at `offset` read back as zeroes.
    pub(crate) fn write_zeroes(&mut self, offset: u64, len: u64, unmap: bool) -> io::Result<()> {
        if unmap {
            self.image.discard_to_zero(offset, len)
        } else {
            self.image.write_zeroes(offset, len)
        }
    }
}
