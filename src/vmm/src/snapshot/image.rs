// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Version 1 pairs a framed machine state file with a raw packed RAM file.

use std::{
    fs::{self, File},
    io::{self, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use vm_memory::{Bytes, GuestAddress};

use super::state::MachineState;
use crate::{Error, Result, memory::GuestRam};

const MAGIC: &[u8; 8] = b"BXLVMST1";
const VERSION: u32 = 1;
const HEADER_LEN: usize = 32;
const CHUNK: usize = 1 << 20;

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
