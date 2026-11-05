// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio block device.
//!
//! [`device::VirtioBlk`] implements the [`VirtioDevice`] contract over one
//! request queue; [`request`] parses chains; [`backend::DiskBackend`] is the
//! seam a disk engine implements, and [`imago::ImagoBackend`] is the
//! synchronous one. [`add_disk`] puts one configured disk behind a
//! virtio-mmio transport in its slot, run by the VM's workers.

use std::sync::{Arc, Mutex};

use self::{device::VirtioBlk, imago::ImagoBackend};
use super::{
    DeviceContext, VirtioDevice,
    mmio::{self, Slot},
};
use crate::{
    chipset::ChipsetBuilder,
    config::{DiskConfig, MAX_DISKS},
    error::{Error, Result},
};

pub(crate) mod backend;
pub(crate) mod config;
pub(crate) mod device;
pub(crate) mod imago;
pub(crate) mod inflight;
pub(crate) mod request;

/// The chipset names of the disks, by index.
#[cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    expect(dead_code, reason = "Only the Linux x86_64 Vm::new adds disks yet.")
)]
const CHIPSET_NAMES: [&str; MAX_DISKS] = [
    "virtio-blk0",
    "virtio-blk1",
    "virtio-blk2",
    "virtio-blk3",
    "virtio-blk4",
    "virtio-blk5",
    "virtio-blk6",
    "virtio-blk7",
];

/// Adds `disk` as a virtio-blk device behind a virtio-mmio transport in
/// `slot`, run by the VM's workers. `index` selects the chipset name.
#[cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    expect(dead_code, reason = "Only the Linux x86_64 Vm::new adds disks yet.")
)]
pub(crate) fn add_disk(
    chipset: &mut ChipsetBuilder,
    ctx: &DeviceContext<'_>,
    disk: &DiskConfig,
    index: usize,
    slot: Slot,
) -> Result<()> {
    let name = CHIPSET_NAMES
        .get(index)
        .ok_or(Error::InvalidDiskCount(index + 1))?;
    let backend =
        ImagoBackend::open(&disk.path, disk.format, disk.read_only).map_err(|source| {
            Error::OpenDisk {
                path: disk.path.clone(),
                source,
            }
        })?;
    let device: Arc<Mutex<dyn VirtioDevice>> =
        Arc::new(Mutex::new(VirtioBlk::new(Box::new(backend))));
    mmio::add_device(chipset, ctx, name, slot, device)
}

/// The virtio device ID of a block device.
pub(crate) const DEVICE_ID: u32 = 2;
/// The request queue's maximum size.
pub(crate) const QUEUE_MAX: u16 = 256;
/// The queue maxima the `DeviceSpec` declares: one request queue.
pub(crate) const QUEUE_MAXIMUM: &[u16] = &[QUEUE_MAX];
/// The virtio block sector size and its shift.
pub(crate) const SECTOR_SIZE: u64 = 512;
pub(crate) const SECTOR_SHIFT: u32 = 9;
/// `seg_max` for one queue: the queue size minus the header and status.
pub(crate) const SEG_MAX: u32 = QUEUE_MAX as u32 - 2;
/// The request header length: type, reserved and sector.
pub(crate) const REQUEST_HEADER_LEN: usize = 16;
/// The largest data transfer one request may carry through the bounce
/// buffer.
pub(crate) const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// The largest range one discard request may cover: 128 MiB, as Firecracker
/// bounds it; a conforming guest splits a larger range.
pub(crate) const MAX_DISCARD_SECTORS: u32 = (128 << 20) / SECTOR_SIZE as u32;

/// `VIRTIO_BLK_F_SEG_MAX`: `seg_max` is valid.
pub(crate) const VIRTIO_BLK_F_SEG_MAX: u64 = 1 << 2;
/// `VIRTIO_BLK_F_RO`: the disk is read-only.
pub(crate) const VIRTIO_BLK_F_RO: u64 = 1 << 5;
/// `VIRTIO_BLK_F_FLUSH`: the device supports the flush command.
pub(crate) const VIRTIO_BLK_F_FLUSH: u64 = 1 << 9;
/// `VIRTIO_BLK_F_DISCARD`: the device supports the discard command.
pub(crate) const VIRTIO_BLK_F_DISCARD: u64 = 1 << 13;

/// The request types the device handles.
pub(crate) const VIRTIO_BLK_T_IN: u32 = 0;
pub(crate) const VIRTIO_BLK_T_OUT: u32 = 1;
pub(crate) const VIRTIO_BLK_T_FLUSH: u32 = 4;
pub(crate) const VIRTIO_BLK_T_DISCARD: u32 = 11;

/// The request status codes.
pub(crate) const VIRTIO_BLK_S_OK: u8 = 0;
pub(crate) const VIRTIO_BLK_S_IOERR: u8 = 1;
pub(crate) const VIRTIO_BLK_S_UNSUPP: u8 = 2;

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../../../tests/virtio/blk/mod.rs"]
mod tests;
