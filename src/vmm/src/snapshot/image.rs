// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Version 1 pairs a framed machine state file with a raw packed RAM file.

use std::{
    fs::{self, File},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use vm_memory::{Bytes, GuestAddress};

use super::state::MachineState;
use crate::{Error, Result, config::MAX_VCPUS, memory::GuestRam};

const MAGIC: &[u8; 8] = b"BXLVMST1";
const VERSION: u32 = 1;
const HEADER_LEN: usize = 32;
const CHUNK: usize = 1 << 20;
// Bound allocation before decoding, with room for 64 vCPUs at the decoder's
// XSAVE, MSR and CPUID limits, including Postcard's varint overhead.
pub(super) const MAX_MACHINE_STATE_LEN: u64 = 32 << 20;

pub(super) struct Header {
    pub(super) vcpus: u32,
    pub(super) ram_len: u64,
    machine_len: u64,
}

impl Header {
    pub(super) fn read(reader: &mut impl Read) -> Result<Self> {
        let mut bytes = [0; HEADER_LEN];
        reader.read_exact(&mut bytes).map_err(Error::Snapshot)?;
        if &bytes[..8] != MAGIC || u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != VERSION {
            return Err(invalid_data("unknown snapshot magic or version"));
        }
        let header = Self {
            vcpus: u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            ram_len: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            machine_len: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        };
        if !(1..=u32::from(MAX_VCPUS)).contains(&header.vcpus) {
            return Err(invalid_data("invalid snapshot vCPU count"));
        }
        if header.ram_len == 0 {
            return Err(invalid_data("empty snapshot RAM"));
        }
        if !(1..=MAX_MACHINE_STATE_LEN).contains(&header.machine_len) {
            return Err(invalid_data("invalid machine state length"));
        }
        Ok(header)
    }

    pub(super) fn read_machine(&self, reader: &mut impl Read) -> Result<MachineState> {
        let mut bytes = vec![0; self.machine_len as usize];
        reader.read_exact(&mut bytes).map_err(Error::Snapshot)?;
        expect_eof(reader, "trailing bytes in snapshot state file")?;
        MachineState::decode(&bytes, self.vcpus)
    }
}

pub(super) fn expect_eof(reader: &mut impl Read, message: &'static str) -> Result<()> {
    match reader.read_exact(&mut [0]) {
        Ok(()) => Err(invalid_data(message)),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(()),
        Err(error) => Err(Error::Snapshot(error)),
    }
}

fn invalid_data(message: &'static str) -> Error {
    Error::Snapshot(io::Error::new(io::ErrorKind::InvalidData, message))
}

pub(crate) fn write(
    state_writer: &mut dyn Write,
    memory_writer: &mut dyn Write,
    machine: &MachineState,
    ram: &GuestRam,
    check: impl FnMut() -> Result<()>,
) -> Result<()> {
    let count = machine.vcpus.len() as u32;
    write_to_checked(
        state_writer,
        memory_writer,
        count,
        &machine.encode()?,
        ram,
        check,
    )
}

pub(crate) fn write_to_checked(
    state_writer: &mut dyn Write,
    memory_writer: &mut dyn Write,
    count: u32,
    machine: &[u8],
    ram: &GuestRam,
    mut check: impl FnMut() -> Result<()>,
) -> Result<()> {
    let ram_len: u64 = ram.ranges().map(|(_, size)| size as u64).sum();
    let mut header = [0; HEADER_LEN];
    header[..8].copy_from_slice(MAGIC);
    header[8..12].copy_from_slice(&VERSION.to_le_bytes());
    header[12..16].copy_from_slice(&count.to_le_bytes());
    header[16..24].copy_from_slice(&ram_len.to_le_bytes());
    header[24..32].copy_from_slice(&(machine.len() as u64).to_le_bytes());
    for chunk in std::iter::once(header.as_slice()).chain(machine.chunks(CHUNK)) {
        check()?;
        state_writer.write_all(chunk).map_err(Error::Snapshot)?;
    }
    let mut buffer = vec![0; CHUNK];
    for (start, size) in ram.ranges() {
        for offset in (0..size).step_by(CHUNK) {
            check()?;
            let chunk = &mut buffer[..CHUNK.min(size - offset)];
            ram.memory()
                .read_slice(chunk, GuestAddress(start.0 + offset as u64))
                .map_err(|source| Error::Snapshot(io::Error::other(source)))?;
            memory_writer.write_all(chunk).map_err(Error::Snapshot)?;
        }
    }
    check()?;
    state_writer.flush().map_err(Error::Snapshot)?;
    check()?;
    memory_writer.flush().map_err(Error::Snapshot)
}

pub(crate) struct NewFileWriter<'a> {
    path: &'a Path,
    file: File,
    committed: bool,
}

impl<'a> NewFileWriter<'a> {
    pub(crate) fn new(path: &'a Path) -> Result<Self> {
        let mut options = File::options();
        options.write(true).create_new(true).mode(0o600);
        let file = options.open(path).map_err(Error::Snapshot)?;
        Ok(Self {
            path,
            file,
            committed: false,
        })
    }

    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}

impl Write for NewFileWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.file.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Drop for NewFileWriter<'_> {
    fn drop(&mut self) {
        if !self.committed
            && let Ok(open) = self.file.metadata()
            && let Ok(target) = fs::symlink_metadata(self.path)
            && (target.dev(), target.ino()) == (open.dev(), open.ino())
        {
            let _ = fs::remove_file(self.path);
        }
    }
}

#[cfg(test)]
#[path = "../../tests/snapshot/image.rs"]
pub(super) mod tests;
