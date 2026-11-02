// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio block device.
//!
//! The device implements the synchronous [`VirtioDevice`](super::VirtioDevice)
//! contract and uses the shared split-virtqueue adapter in [`super::queue`].
//! Request parsing and the imago backend live in this module; the transport,
//! event worker and interrupt plumbing arrive with later slices.

pub(crate) mod backend;
pub(crate) mod config;
pub(crate) mod device;
pub(crate) mod request;

/// The virtio device ID for a block device.
pub(crate) const DEVICE_ID: u32 = 2;
/// The single request queue's maximum size.
pub(crate) const QUEUE_MAX: u16 = 256;
/// The queue maxima a `DeviceSpec` advertises.
pub(crate) const QUEUE_MAXIMUM: &[u16] = &[QUEUE_MAX];
/// The virtio block sector size and shift.
pub(crate) const SECTOR_SIZE: u64 = 512;
pub(crate) const SECTOR_SHIFT: u32 = 9;
/// `seg_max` for a one-queue device: the queue size minus header and status.
pub(crate) const SEG_MAX: u32 = QUEUE_MAX as u32 - 2;
/// The request header's fixed length.
pub(crate) const REQUEST_HEADER_LEN: usize = 16;
/// The largest guest data buffer copied through the bounce buffer.
pub(crate) const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// `VIRTIO_F_VERSION_1`.
pub(crate) const VIRTIO_F_VERSION_1: u64 = 1 << 32;
/// `VIRTIO_BLK_F_SEG_MAX`.
pub(crate) const VIRTIO_BLK_F_SEG_MAX: u64 = 1 << 2;
/// `VIRTIO_BLK_F_RO`.
pub(crate) const VIRTIO_BLK_F_RO: u64 = 1 << 5;
/// `VIRTIO_BLK_F_FLUSH`.
pub(crate) const VIRTIO_BLK_F_FLUSH: u64 = 1 << 9;
/// `VIRTIO_BLK_F_DISCARD`.
pub(crate) const VIRTIO_BLK_F_DISCARD: u64 = 1 << 13;
/// `VIRTIO_BLK_F_WRITE_ZEROES`.
pub(crate) const VIRTIO_BLK_F_WRITE_ZEROES: u64 = 1 << 14;
/// `VIRTIO_RING_F_EVENT_IDX`.
pub(crate) const VIRTIO_RING_F_EVENT_IDX: u64 = 1 << 29;

/// Request types.
pub(crate) const VIRTIO_BLK_T_IN: u32 = 0;
pub(crate) const VIRTIO_BLK_T_OUT: u32 = 1;
pub(crate) const VIRTIO_BLK_T_FLUSH: u32 = 4;
pub(crate) const VIRTIO_BLK_T_DISCARD: u32 = 11;
pub(crate) const VIRTIO_BLK_T_WRITE_ZEROES: u32 = 13;

/// Request status codes.
pub(crate) const VIRTIO_BLK_S_OK: u8 = 0;
pub(crate) const VIRTIO_BLK_S_IOERR: u8 = 1;
pub(crate) const VIRTIO_BLK_S_UNSUPP: u8 = 2;

/// `VIRTIO_BLK_WRITE_ZEROES_FLAG_UNMAP`.
pub(crate) const VIRTIO_BLK_WRITE_ZEROES_FLAG_UNMAP: u32 = 1;

#[cfg(test)]
#[path = "../../../tests/virtio/blk/mod.rs"]
mod tests;
