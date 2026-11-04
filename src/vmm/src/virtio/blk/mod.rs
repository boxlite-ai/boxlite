// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio block device.
//!
//! [`device::VirtioBlk`] implements the [`VirtioDevice`] contract over one
//! request queue; [`request`] parses chains; [`backend::DiskBackend`] is the
//! seam a disk engine implements, and [`imago::ImagoBackend`] is the
//! synchronous one. [`add_disks`] puts each configured disk behind a
//! virtio-mmio transport in its slot, run by the VM's workers.

use std::sync::{Arc, Mutex};

use self::{device::VirtioBlk, imago::ImagoBackend};
use super::{
    VirtioDevice, VirtioInterrupt,
    interrupt::MmioInterrupt,
    mmio::{MMIO_WINDOW_LEN, MmioResources, MmioTransport, Slot},
};
use crate::{
    chipset::ChipsetBuilder,
    config::{DiskConfig, MAX_DISKS},
    error::{Error, Result},
    vm::DeviceContext,
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
const NAMES: [&str; MAX_DISKS] = [
    "virtio-blk0",
    "virtio-blk1",
    "virtio-blk2",
    "virtio-blk3",
    "virtio-blk4",
    "virtio-blk5",
    "virtio-blk6",
    "virtio-blk7",
];

/// Adds disk `i` of `disks` as a virtio-blk device behind a virtio-mmio
/// transport in `slots[i]`, run by the VM's workers.
#[cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    expect(dead_code, reason = "Only the Linux x86_64 Vm::new adds disks yet.")
)]
pub(crate) fn add_disks(
    chipset: &mut ChipsetBuilder,
    ctx: DeviceContext<'_>,
    disks: &[DiskConfig],
    slots: &[Slot],
) -> Result<()> {
    for (index, (disk, slot)) in disks.iter().zip(slots).enumerate() {
        let name = NAMES
            .get(index)
            .ok_or(Error::InvalidDiskCount(disks.len()))?;
        let backend =
            ImagoBackend::open(&disk.path, disk.format, disk.read_only).map_err(|source| {
                Error::OpenDisk {
                    path: disk.path.clone(),
                    source,
                }
            })?;
        let device: Arc<Mutex<dyn VirtioDevice>> =
            Arc::new(Mutex::new(VirtioBlk::new(Box::new(backend))));
        chipset.add(name, |resources| {
            resources.mmio(slot.base, MMIO_WINDOW_LEN);
            let interrupt = Arc::new(MmioInterrupt::new(resources.line(slot.gsi)));
            let worker = ctx.workers.add(
                Arc::clone(&device),
                Arc::clone(&interrupt) as Arc<dyn VirtioInterrupt>,
            );
            MmioTransport::new(
                device,
                interrupt,
                MmioResources {
                    memory: Arc::clone(ctx.memory),
                    sender: resources.event_sender(),
                    worker,
                },
            )
        })?;
    }
    Ok(())
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
