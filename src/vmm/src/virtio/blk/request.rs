// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! virtio-blk request parsing and execution.
//!
//! A chain carries a readable request header, request data in the direction
//! the type requires, and one writable status byte at the end. The queue
//! adapter owns the used ring and notification decision; this module only
//! executes one chain and returns the used length, including the status byte.

use std::io::{Read, Write};

use virtio_queue::{DescriptorChain, Reader, Writer};

use super::{
    MAX_REQUEST_BYTES, REQUEST_HEADER_LEN, SECTOR_SIZE, VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH,
    VIRTIO_BLK_F_WRITE_ZEROES, VIRTIO_BLK_S_IOERR, VIRTIO_BLK_S_OK, VIRTIO_BLK_S_UNSUPP,
    VIRTIO_BLK_T_DISCARD, VIRTIO_BLK_T_FLUSH, VIRTIO_BLK_T_IN, VIRTIO_BLK_T_OUT,
    VIRTIO_BLK_T_WRITE_ZEROES, VIRTIO_BLK_WRITE_ZEROES_FLAG_UNMAP, backend::BlkBackend,
};
use crate::{memory::GuestMemoryMmap, virtio::DeviceError};

/// Executes one descriptor chain and returns its used length.
pub(crate) fn execute(
    chain: DescriptorChain<&GuestMemoryMmap>,
    backend: &mut BlkBackend,
    negotiated: u64,
    memory: &GuestMemoryMmap,
) -> Result<u32, DeviceError> {
    let mut writer = chain
        .clone()
        .writer(memory)
        .map_err(|_| DeviceError::NeedsReset("block descriptor"))?;
    let writable = writer.available_bytes();
    if writable == 0 {
        return Err(DeviceError::NeedsReset("block status"));
    }
    let status = writer
        .split_at(writable - 1)
        .map_err(|_| DeviceError::NeedsReset("block status"))?;

    let mut reader = match chain.reader(memory) {
        Ok(reader) => reader,
        Err(_) => return finish(status, VIRTIO_BLK_S_IOERR, 1),
    };
    if reader.available_bytes() < REQUEST_HEADER_LEN {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    let mut header = [0u8; REQUEST_HEADER_LEN];
    if reader.read_exact(&mut header).is_err() {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    let request_type = u32::from_le_bytes(header[..4].try_into().expect("four bytes"));
    let sector = u64::from_le_bytes(header[8..16].try_into().expect("eight bytes"));

    match request_type {
        VIRTIO_BLK_T_IN => read_request(reader, writer, status, backend, sector),
        VIRTIO_BLK_T_OUT => write_request(reader, writer, status, backend, sector, negotiated),
        VIRTIO_BLK_T_FLUSH => flush_request(reader, writer, status, backend, negotiated),
        VIRTIO_BLK_T_DISCARD => discard_request(reader, writer, status, backend, negotiated),
        VIRTIO_BLK_T_WRITE_ZEROES => zero_request(reader, writer, status, backend, negotiated),
        _ => finish(status, VIRTIO_BLK_S_UNSUPP, 1),
    }
}

fn read_request(
    reader: Reader<'_>,
    mut writer: Writer<'_>,
    status: Writer<'_>,
    backend: &BlkBackend,
    sector: u64,
) -> Result<u32, DeviceError> {
    if reader.available_bytes() != 0 {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    let len = writer.available_bytes();
    let Some(offset) = data_offset(backend, sector, len) else {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    };
    let mut buffer = vec![0u8; len];
    if backend.read_at(offset, &mut buffer).is_err() {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    if writer.write_all(&buffer).is_err() {
        return Err(DeviceError::NeedsReset("block descriptor"));
    }
    finish(status, VIRTIO_BLK_S_OK, len as u32 + 1)
}

fn write_request(
    mut reader: Reader<'_>,
    writer: Writer<'_>,
    status: Writer<'_>,
    backend: &BlkBackend,
    sector: u64,
    negotiated: u64,
) -> Result<u32, DeviceError> {
    if backend.read_only() || writer.available_bytes() != 0 {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    let len = reader.available_bytes();
    let Some(offset) = data_offset(backend, sector, len) else {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    };
    let mut buffer = vec![0u8; len];
    if reader.read_exact(&mut buffer).is_err() {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    if backend.write_at(offset, &buffer).is_err() {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    // If FLUSH is offered but not negotiated, commit the write before OK.
    if negotiated & VIRTIO_BLK_F_FLUSH == 0 && backend.flush().is_err() {
        return finish(status, VIRTIO_BLK_S_IOERR, 1);
    }
    finish(status, VIRTIO_BLK_S_OK, 1)
}

fn flush_request(
    reader: Reader<'_>,
    writer: Writer<'_>,
    status: Writer<'_>,
    backend: &BlkBackend,
    negotiated: u64,
) -> Result<u32, DeviceError> {
    if negotiated & VIRTIO_BLK_F_FLUSH == 0 || !empty_data(reader, writer) {
        return finish(status, VIRTIO_BLK_S_UNSUPP, 1);
    }
    match backend.flush() {
        Ok(()) => finish(status, VIRTIO_BLK_S_OK, 1),
        Err(_) => finish(status, VIRTIO_BLK_S_IOERR, 1),
    }
}

fn discard_request(
    reader: Reader<'_>,
    writer: Writer<'_>,
    status: Writer<'_>,
    backend: &mut BlkBackend,
    negotiated: u64,
) -> Result<u32, DeviceError> {
    let (offset, len, flags) =
        match range_request(reader, writer, backend, negotiated, VIRTIO_BLK_F_DISCARD) {
            Ok(range) => range,
            Err(RangeError::Unsupported) => return finish(status, VIRTIO_BLK_S_UNSUPP, 1),
            Err(RangeError::Invalid) => return finish(status, VIRTIO_BLK_S_IOERR, 1),
        };
    if flags != 0 {
        return finish(status, VIRTIO_BLK_S_UNSUPP, 1);
    }
    match backend.discard(offset, len) {
        Ok(()) => finish(status, VIRTIO_BLK_S_OK, 1),
        Err(_) => finish(status, VIRTIO_BLK_S_IOERR, 1),
    }
}

fn zero_request(
    reader: Reader<'_>,
    writer: Writer<'_>,
    status: Writer<'_>,
    backend: &mut BlkBackend,
    negotiated: u64,
) -> Result<u32, DeviceError> {
    let (offset, len, flags) = match range_request(
        reader,
        writer,
        backend,
        negotiated,
        VIRTIO_BLK_F_WRITE_ZEROES,
    ) {
        Ok(range) => range,
        Err(RangeError::Unsupported) => return finish(status, VIRTIO_BLK_S_UNSUPP, 1),
        Err(RangeError::Invalid) => return finish(status, VIRTIO_BLK_S_IOERR, 1),
    };
    if flags & !VIRTIO_BLK_WRITE_ZEROES_FLAG_UNMAP != 0 {
        return finish(status, VIRTIO_BLK_S_UNSUPP, 1);
    }
    let unmap = flags & VIRTIO_BLK_WRITE_ZEROES_FLAG_UNMAP != 0;
    match backend.write_zeroes(offset, len, unmap) {
        Ok(()) => finish(status, VIRTIO_BLK_S_OK, 1),
        Err(_) => finish(status, VIRTIO_BLK_S_IOERR, 1),
    }
}

enum RangeError {
    Unsupported,
    Invalid,
}

/// Parses the 16-byte discard/write-zeroes payload and validates its range.
fn range_request(
    mut reader: Reader<'_>,
    writer: Writer<'_>,
    backend: &BlkBackend,
    negotiated: u64,
    feature: u64,
) -> Result<(u64, u64, u32), RangeError> {
    if negotiated & feature == 0 {
        return Err(RangeError::Unsupported);
    }
    if writer.available_bytes() != 0 || reader.available_bytes() != 16 {
        return Err(RangeError::Invalid);
    }
    let mut payload = [0u8; 16];
    reader
        .read_exact(&mut payload)
        .map_err(|_| RangeError::Invalid)?;
    let sector = u64::from_le_bytes(payload[..8].try_into().map_err(|_| RangeError::Invalid)?);
    let sectors = u64::from(u32::from_le_bytes(
        payload[8..12].try_into().map_err(|_| RangeError::Invalid)?,
    ));
    let flags = u32::from_le_bytes(
        payload[12..16]
            .try_into()
            .map_err(|_| RangeError::Invalid)?,
    );
    if sectors == 0 {
        return Err(RangeError::Invalid);
    }
    let len = sectors
        .checked_mul(SECTOR_SIZE)
        .ok_or(RangeError::Invalid)?;
    let offset = sector.checked_mul(SECTOR_SIZE).ok_or(RangeError::Invalid)?;
    let end = offset.checked_add(len).ok_or(RangeError::Invalid)?;
    if end > capacity_bytes(backend) {
        return Err(RangeError::Invalid);
    }
    let alignment = u64::from(backend.discard_sector_alignment()).saturating_mul(SECTOR_SIZE);
    if offset % alignment != 0 || len % alignment != 0 {
        return Err(RangeError::Invalid);
    }
    Ok((offset, len, flags))
}

fn empty_data(reader: Reader<'_>, writer: Writer<'_>) -> bool {
    reader.available_bytes() == 0 && writer.available_bytes() == 0
}

fn data_offset(backend: &BlkBackend, sector: u64, len: usize) -> Option<u64> {
    if len > MAX_REQUEST_BYTES || !len.is_multiple_of(SECTOR_SIZE as usize) {
        return None;
    }
    let offset = sector.checked_mul(SECTOR_SIZE)?;
    (offset.checked_add(len as u64)? <= capacity_bytes(backend)).then_some(offset)
}

fn capacity_bytes(backend: &BlkBackend) -> u64 {
    backend.capacity_sectors().saturating_mul(SECTOR_SIZE)
}

fn finish(mut status: Writer<'_>, code: u8, used: u32) -> Result<u32, DeviceError> {
    status
        .write_all(&[code])
        .map_err(|_| DeviceError::NeedsReset("block status"))?;
    Ok(used)
}
