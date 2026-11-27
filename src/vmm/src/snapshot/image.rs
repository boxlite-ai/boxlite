// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Version 1 pairs a framed machine state file with a raw packed RAM file.

use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

use vm_memory::{Bytes, GuestAddress};

use crate::{Error, Result, memory::GuestRam};

pub(super) const MAGIC: &[u8; 8] = b"BXLVMST1";
pub(super) const VERSION: u32 = 1;
pub(super) const HEADER_LEN: usize = 32;
pub(super) const CHUNK: usize = 1 << 20;

pub(super) struct Header {
    pub(super) vcpus: u32,
    pub(super) ram_len: u64,
    machine_len: u64,
}

pub(crate) fn write_to(
    state_writer: &mut dyn Write,
    memory_writer: &mut dyn Write,
    count: u32,
    machine: &[u8],
    ram: &GuestRam,
) -> Result<()> {
    let header = Header {
        vcpus: count,
        ram_len: ram.ranges().map(|(_, size)| size as u64).sum(),
        machine_len: machine.len() as u64,
    };
    let mut bytes = [0; HEADER_LEN];
    bytes[..8].copy_from_slice(MAGIC);
    bytes[8..12].copy_from_slice(&VERSION.to_le_bytes());
    bytes[12..16].copy_from_slice(&header.vcpus.to_le_bytes());
    bytes[16..24].copy_from_slice(&header.ram_len.to_le_bytes());
    bytes[24..32].copy_from_slice(&header.machine_len.to_le_bytes());
    state_writer.write_all(&bytes).map_err(Error::Snapshot)?;
    state_writer.write_all(machine).map_err(Error::Snapshot)?;
    let mut buffer = vec![0; CHUNK];
    for (start, size) in ram.ranges() {
        for offset in (0..size).step_by(CHUNK) {
            let chunk = &mut buffer[..CHUNK.min(size - offset)];
            ram.boot_memory()
                .read_slice(chunk, GuestAddress(start.0 + offset as u64))
                .map_err(|source| Error::Snapshot(io::Error::other(source)))?;
            memory_writer.write_all(chunk).map_err(Error::Snapshot)?;
        }
    }
    state_writer.flush().map_err(Error::Snapshot)?;
    memory_writer.flush().map_err(Error::Snapshot)
}

pub(crate) fn create_new_file(path: &Path) -> Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(Error::Snapshot)
}

#[cfg(test)]
#[path = "../../tests/snapshot/image.rs"]
pub(super) mod tests;
