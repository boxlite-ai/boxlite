// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-blk configuration space.
//!
//! The layout follows virtio 1.2 section 5.2.4. The fields of features this
//! device does not offer stay zero at their specified offsets, so a driver
//! sees the layout it expects from any modern device.

use super::{SEG_MAX, backend::DiskInfo};

/// The configuration space length, rounded up to four bytes.
pub(crate) const CONFIG_LEN: usize = 60;

/// The configuration space, encoded once from the disk information.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BlkConfig {
    bytes: [u8; CONFIG_LEN],
}

impl BlkConfig {
    /// Encodes the configuration of a disk with `info`.
    pub(crate) fn new(info: &DiskInfo) -> Self {
        let mut bytes = [0u8; CONFIG_LEN];
        put_u64(&mut bytes, 0, info.capacity_sectors);
        put_u32(&mut bytes, 12, SEG_MAX);
        put_u32(&mut bytes, 36, u32::MAX); // max_discard_sectors
        put_u32(&mut bytes, 40, 1); // max_discard_seg
        put_u32(&mut bytes, 44, info.discard_sector_alignment.max(1));
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

fn put_u32(bytes: &mut [u8; CONFIG_LEN], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8; CONFIG_LEN], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
