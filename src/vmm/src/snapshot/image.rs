// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Version 1: a 32-byte little-endian header, machine state, then raw RAM.

use std::{
    fs::{self, File},
    io::{self, BufWriter, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

use vm_memory::{Bytes, GuestAddress};

use crate::{Error, Result, memory::GuestRam};

const MAGIC: &[u8; 8] = b"BXLMEM01";
const VERSION: u32 = 1;
const HEADER_LEN: u64 = 32;
const CHUNK: usize = 1 << 20;

// Postcard uses at most 5 bytes per XSAVE u32: 65536 * 5 bytes/vCPU.
// CPUID (<=256) and MSR (<=4096) entries are 40/16-byte KVM byte blobs;
// rounding each to 64/32 bytes covers their length prefixes. Together these
// arrays use <=464 KiB/vCPU. Fixed registers, ID and framing fit in 16 KiB,
// so 512 KiB/vCPU leaves >=32 KiB spare. Another 64 KiB covers the platform
// image and machine framing: 32 MiB + 64 KiB at MAX_VCPUS=64.
pub(crate) const MAX_MACHINE_STATE_LEN: u64 =
    (crate::config::MAX_VCPUS as u64) * (512 << 10) + (64 << 10);

pub(crate) fn write(path: &Path, count: u32, machine: &[u8], ram: &GuestRam) -> Result<()> {
    let mut regions = ram.regions();
    let region = regions.next().ok_or_else(|| invalid("missing RAM"))?;
    if region.guest_addr != 0 || regions.next().is_some() {
        return Err(invalid("export requires one RAM region at GPA 0"));
    }
    create(path, |writer| {
        writer.write_all(MAGIC)?;
        writer.write_all(&VERSION.to_le_bytes())?;
        writer.write_all(&count.to_le_bytes())?;
        writer.write_all(&(region.size as u64).to_le_bytes())?;
        writer.write_all(&(machine.len() as u64).to_le_bytes())?;
        writer.write_all(machine)?;
        let mut buffer = vec![0; CHUNK];
        for offset in (0..region.size).step_by(CHUNK) {
            let len = CHUNK.min(region.size - offset);
            ram.memory()
                .read_slice(&mut buffer[..len], GuestAddress(offset as u64))
                .map_err(io::Error::other)?;
            writer.write_all(&buffer[..len])?;
        }
        Ok(())
    })
}

/// Refuse existing targets; remove a newly created target on any write/flush failure.
pub(crate) fn create(
    path: &Path,
    write: impl FnOnce(&mut BufWriter<File>) -> io::Result<()>,
) -> Result<()> {
    let file = File::options()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(Error::Snapshot)?;
    let mut writer = BufWriter::new(file);
    let result = write(&mut writer).and_then(|()| writer.flush());
    // Do not let BufWriter retry buffered writes after failure.
    drop(writer.into_parts());
    if let Err(error) = result {
        fs::remove_file(path).map_err(|cleanup| {
            Error::Snapshot(io::Error::other(format!(
                "{error}; removing incomplete image: {cleanup}"
            )))
        })?;
        return Err(Error::Snapshot(error));
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct Header {
    pub(crate) vcpus: u32,
    pub(crate) ram_len: u64,
    pub(crate) machine_len: u64,
}

impl Header {
    pub(crate) fn read(file: &mut File) -> Result<Self> {
        let mut bytes = [0; HEADER_LEN as usize];
        file.read_exact(&mut bytes).map_err(Error::Snapshot)?;
        if &bytes[..8] != MAGIC || u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != VERSION {
            return Err(invalid("unknown image magic or version"));
        }
        let header = Self {
            vcpus: u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            ram_len: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            machine_len: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        };
        if header.machine_len > MAX_MACHINE_STATE_LEN {
            return Err(invalid("machine state exceeds length limit"));
        }
        // Restore validates the RAM layout and KVM's GPA limit before allocating RAM.
        let file_len = file.metadata().map_err(Error::Snapshot)?.len();
        if HEADER_LEN
            .checked_add(header.machine_len)
            .and_then(|n| n.checked_add(header.ram_len))
            .is_none_or(|n| n > file_len)
        {
            return Err(invalid("image lengths exceed file bounds"));
        }
        Ok(header)
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn read_machine(&self, file: &mut File) -> Result<super::state::MachineState> {
        let mut bytes = vec![
            0;
            usize::try_from(self.machine_len)
                .map_err(|_| invalid("machine length exceeds address space"))?
        ];
        file.read_exact(&mut bytes).map_err(Error::Snapshot)?;
        let state: super::state::MachineState = postcard::from_bytes(&bytes)
            .map_err(|error| Error::Snapshot(io::Error::other(error)))?;
        if state.vcpus.len() as u64 != u64::from(self.vcpus) {
            return Err(invalid("vCPU count differs from machine state"));
        }
        Ok(state)
    }
}

fn invalid(reason: &'static str) -> Error {
    Error::Snapshot(io::Error::new(io::ErrorKind::InvalidInput, reason))
}
