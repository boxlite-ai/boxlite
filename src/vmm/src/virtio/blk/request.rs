// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! virtio-blk request parsing and completion.
//!
//! A chain carries a device-readable header, data in the direction the type
//! needs, and ends with one device-writable status byte (virtio 1.2 section
//! 5.2.6). [`parse`] turns a chain into a [`Request`] for the backend plus the
//! [`WriteTargets`] its results go to, or finishes a chain the backend must not
//! see. [`WriteTargets::finish`] writes the data and status back and returns the
//! used length, including the status byte.

use std::io::Read;

use virtio_queue::DescriptorChain;
use vm_memory::{Address, Bytes, GuestAddress};

use super::{
    MAX_REQUEST_BYTES, REQUEST_HEADER_LEN, SECTOR_SIZE, VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH,
    VIRTIO_BLK_S_IOERR, VIRTIO_BLK_S_UNSUPP, VIRTIO_BLK_T_DISCARD, VIRTIO_BLK_T_FLUSH,
    VIRTIO_BLK_T_IN, VIRTIO_BLK_T_OUT,
    backend::{DiskInfo, Request, RequestKind},
};
use crate::{memory::GuestMemoryMmap, virtio::DeviceError};

/// The discard payload length: sector, sector count and flags.
const DISCARD_PAYLOAD_LEN: usize = 16;

/// What [`parse`] made of a chain.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decoded {
    /// Finish the chain now with `status`; the backend is not involved.
    Reject { status: u8, targets: WriteTargets },
    /// Submit `request`; its results go to `targets`.
    Submit {
        request: Request,
        targets: WriteTargets,
    },
}

/// Where a request's results go: the device-writable data descriptors and
/// the status byte that ends the chain.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct WriteTargets {
    data: Vec<(GuestAddress, u32)>,
    data_len: usize,
    status: GuestAddress,
}

impl WriteTargets {
    /// Splits the writable descriptors into the data region and the status
    /// byte; `None` when the chain has no writable byte for the status.
    fn split(mut writable: Vec<(GuestAddress, u32)>) -> Option<Self> {
        let &(last_addr, last_len) = writable.last()?;
        if last_len == 0 {
            return None;
        }
        let status = last_addr.checked_add(u64::from(last_len) - 1)?;
        if last_len == 1 {
            writable.pop();
        } else if let Some(last) = writable.last_mut() {
            last.1 = last_len - 1;
        }
        let data_len = writable.iter().map(|&(_, len)| len as usize).sum();
        Some(Self {
            data: writable,
            data_len,
            status,
        })
    }

    /// The length of the data region.
    pub(crate) fn data_len(&self) -> usize {
        self.data_len
    }

    /// Writes `data`, when a read succeeded, then `status`, and returns the
    /// used length.
    pub(crate) fn finish(
        &self,
        memory: &GuestMemoryMmap,
        status: u8,
        data: Option<&[u8]>,
    ) -> Result<u32, DeviceError> {
        let mut used = 1;
        if let Some(data) = data {
            let mut rest = data;
            for &(addr, len) in &self.data {
                let (chunk, tail) = rest.split_at(rest.len().min(len as usize));
                memory
                    .write_slice(chunk, addr)
                    .map_err(|_| DeviceError::NeedsReset("block descriptor"))?;
                rest = tail;
            }
            used += data.len() as u32;
        }
        memory
            .write_obj(status, self.status)
            .map_err(|_| DeviceError::NeedsReset("block status"))?;
        Ok(used)
    }
}

/// Parses one chain for a disk described by `info` under the `negotiated`
/// features. A chain without a status byte is a driver error the device
/// cannot report in-band, so it needs a reset; every other defect is
/// reported through the status byte without touching the backend.
pub(crate) fn parse(
    chain: DescriptorChain<&GuestMemoryMmap>,
    memory: &GuestMemoryMmap,
    info: &DiskInfo,
    negotiated: u64,
) -> Result<Decoded, DeviceError> {
    let mut writable = Vec::new();
    let mut readable_after_writable = false;
    for descriptor in chain.clone() {
        if descriptor.is_write_only() {
            writable.push((descriptor.addr(), descriptor.len()));
        } else if !writable.is_empty() {
            readable_after_writable = true;
        }
    }
    let targets = WriteTargets::split(writable).ok_or(DeviceError::NeedsReset("block status"))?;
    // Finishes the chain now, without the backend; `targets` moves out at
    // each return.
    macro_rules! finish {
        ($status:expr) => {
            return Ok(Decoded::Reject {
                status: $status,
                targets,
            })
        };
    }
    if readable_after_writable {
        finish!(VIRTIO_BLK_S_IOERR);
    }

    let Ok(mut reader) = chain.reader(memory) else {
        finish!(VIRTIO_BLK_S_IOERR);
    };
    let mut header = [0u8; REQUEST_HEADER_LEN];
    if reader.read_exact(&mut header).is_err() {
        finish!(VIRTIO_BLK_S_IOERR);
    }
    let request_type = u32::from_le_bytes(header[..4].try_into().expect("four bytes"));
    let sector = u64::from_le_bytes(header[8..].try_into().expect("eight bytes"));
    let payload = reader.available_bytes();

    let kind = match request_type {
        VIRTIO_BLK_T_IN => {
            let len = targets.data_len();
            let Some(offset) = data_offset(info, sector, len).filter(|_| payload == 0) else {
                finish!(VIRTIO_BLK_S_IOERR);
            };
            RequestKind::In {
                offset,
                buf: vec![0; len],
            }
        }
        VIRTIO_BLK_T_OUT => {
            let offset = data_offset(info, sector, payload)
                .filter(|_| !info.read_only && targets.data_len() == 0);
            let Some(offset) = offset else {
                finish!(VIRTIO_BLK_S_IOERR);
            };
            let mut buf = vec![0; payload];
            if reader.read_exact(&mut buf).is_err() {
                finish!(VIRTIO_BLK_S_IOERR);
            }
            RequestKind::Out {
                offset,
                buf,
                sync: negotiated & VIRTIO_BLK_F_FLUSH == 0,
            }
        }
        VIRTIO_BLK_T_FLUSH => {
            if negotiated & VIRTIO_BLK_F_FLUSH == 0 {
                finish!(VIRTIO_BLK_S_UNSUPP);
            }
            if payload != 0 || targets.data_len() != 0 {
                finish!(VIRTIO_BLK_S_IOERR);
            }
            RequestKind::Flush
        }
        VIRTIO_BLK_T_DISCARD => {
            if negotiated & VIRTIO_BLK_F_DISCARD == 0 {
                finish!(VIRTIO_BLK_S_UNSUPP);
            }
            if payload != DISCARD_PAYLOAD_LEN || targets.data_len() != 0 {
                finish!(VIRTIO_BLK_S_IOERR);
            }
            let mut bytes = [0u8; DISCARD_PAYLOAD_LEN];
            if reader.read_exact(&mut bytes).is_err() {
                finish!(VIRTIO_BLK_S_IOERR);
            }
            let flags = u32::from_le_bytes(bytes[12..].try_into().expect("four bytes"));
            if flags != 0 {
                finish!(VIRTIO_BLK_S_UNSUPP);
            }
            let sector = u64::from_le_bytes(bytes[..8].try_into().expect("eight bytes"));
            let sectors = u32::from_le_bytes(bytes[8..12].try_into().expect("four bytes"));
            let Some((offset, len)) = discard_range(info, sector, sectors) else {
                finish!(VIRTIO_BLK_S_IOERR);
            };
            RequestKind::Discard { offset, len }
        }
        _ => finish!(VIRTIO_BLK_S_UNSUPP),
    };
    Ok(Decoded::Submit {
        request: Request { kind },
        targets,
    })
}

/// The byte offset of `len` bytes at `sector`, when the transfer is a whole
/// number of sectors inside the disk and within the bounce buffer limit.
fn data_offset(info: &DiskInfo, sector: u64, len: usize) -> Option<u64> {
    if len > MAX_REQUEST_BYTES || !len.is_multiple_of(SECTOR_SIZE as usize) {
        return None;
    }
    let offset = sector.checked_mul(SECTOR_SIZE)?;
    (offset.checked_add(len as u64)? <= capacity_bytes(info)).then_some(offset)
}

/// The byte range of `sectors` sectors at `sector`, when it is non-empty,
/// aligned to the discard alignment and inside the disk.
fn discard_range(info: &DiskInfo, sector: u64, sectors: u32) -> Option<(u64, u64)> {
    if sectors == 0 {
        return None;
    }
    let offset = sector.checked_mul(SECTOR_SIZE)?;
    let len = u64::from(sectors) * SECTOR_SIZE;
    if offset.checked_add(len)? > capacity_bytes(info) {
        return None;
    }
    let alignment = u64::from(info.discard_sector_alignment.max(1)) * SECTOR_SIZE;
    (offset.is_multiple_of(alignment) && len.is_multiple_of(alignment)).then_some((offset, len))
}

fn capacity_bytes(info: &DiskInfo) -> u64 {
    info.capacity_sectors.saturating_mul(SECTOR_SIZE)
}
