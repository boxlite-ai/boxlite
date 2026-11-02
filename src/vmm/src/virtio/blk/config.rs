// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-blk configuration space.
//!
//! The layout follows virtio 1.2 section 5.2.4. The fields for features this
//! device does not offer stay zero but remain at their specified offsets, so a
//! driver sees the same layout it would from any other modern device.

use super::SEG_MAX;

/// The configuration space length, rounded up to four bytes.
pub(crate) const LEN: usize = 60;

/// The virtio-blk configuration space, encoded up front.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BlkConfig {
    bytes: [u8; LEN],
}

impl BlkConfig {
    /// Encodes the configuration for `capacity_sectors` and a discard
    /// alignment in bytes.
    pub(crate) fn new(capacity_sectors: u64, discard_alignment: u32) -> Self {
        let mut bytes = [0u8; LEN];
        put_u64(&mut bytes, 0, capacity_sectors);
        put_u32(&mut bytes, 8, 0); // size_max
        put_u32(&mut bytes, 12, SEG_MAX);
        put_u32(&mut bytes, 20, 0); // blk_size
        put_u32(&mut bytes, 36, u32::MAX); // max_discard_sectors
        put_u32(&mut bytes, 40, 1); // max_discard_seg
        put_u32(&mut bytes, 44, discard_alignment.max(1));
        put_u32(&mut bytes, 48, u32::MAX); // max_write_zeroes_sectors
        put_u32(&mut bytes, 52, 1); // max_write_zeroes_seg
        bytes[56] = 1; // write_zeroes_may_unmap
        Self { bytes }
    }

    /// Copies the configuration space at `offset` into `data`, zero-filling
    /// bytes past the end so a probing driver cannot fault the device.
    pub(crate) fn read(&self, offset: u64, data: &mut [u8]) {
        let offset = usize::try_from(offset).unwrap_or(usize::MAX);
        for (index, byte) in data.iter_mut().enumerate() {
            *byte = offset
                .checked_add(index)
                .and_then(|index| self.bytes.get(index).copied())
                .unwrap_or(0);
        }
    }
}

fn put_u32(bytes: &mut [u8; LEN], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8; LEN], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
