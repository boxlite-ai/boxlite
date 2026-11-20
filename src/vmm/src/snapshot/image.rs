// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Version 1: a 32-byte little-endian header, machine state, then packed RAM.

use std::{
    fs::{self, File},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
use vm_memory::{Bytes, GuestAddress};

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
use crate::memory::GuestRam;
use crate::{Error, Result};

const MAGIC: &[u8; 8] = b"BXLMEM01";
const VERSION: u32 = 1;
const HEADER_LEN: u64 = 32;
#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
const CHUNK: usize = 1 << 20;

// Postcard uses at most 5 bytes per XSAVE u32: 65536 * 5 bytes/vCPU.
// CPUID (<=256) and MSR (<=4096) entries are 40/16-byte KVM byte blobs;
// rounding each to 64/32 bytes covers their length prefixes. Together these
// arrays use <=464 KiB/vCPU. Fixed registers, ID and framing fit in 16 KiB,
// so 512 KiB/vCPU leaves >=32 KiB spare. Another 64 KiB covers the platform
// image and machine framing: 32 MiB + 64 KiB at MAX_VCPUS=64.
pub(crate) const MAX_MACHINE_STATE_LEN: u64 =
    (crate::config::MAX_VCPUS as u64) * (512 << 10) + (64 << 10);

#[cfg(test)]
pub(crate) fn write(path: &Path, count: u32, machine: &[u8], ram: &GuestRam) -> Result<()> {
    let mut writer = NewFileWriter::new(path);
    write_to(&mut writer, count, machine, ram)?;
    writer.commit();
    Ok(())
}

#[cfg(test)]
pub(crate) fn write_to<W: Write + ?Sized>(
    writer: &mut W,
    count: u32,
    machine: &[u8],
    ram: &GuestRam,
) -> Result<()> {
    write_to_checked(writer, count, machine, ram, || Ok(()))
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
pub(crate) fn write_to_checked<W: Write + ?Sized>(
    writer: &mut W,
    count: u32,
    machine: &[u8],
    ram: &GuestRam,
    check: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let ram_len = ram_len(ram)?;
    let mut header = [0; HEADER_LEN as usize];
    header[..8].copy_from_slice(MAGIC);
    header[8..12].copy_from_slice(&VERSION.to_le_bytes());
    header[12..16].copy_from_slice(&count.to_le_bytes());
    header[16..24].copy_from_slice(&ram_len.to_le_bytes());
    header[24..32].copy_from_slice(&(machine.len() as u64).to_le_bytes());
    check()?;
    writer.write_all(&header).map_err(Error::Snapshot)?;
    write_body(writer, machine, ram).map_err(Error::Snapshot)
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
fn ram_len(ram: &GuestRam) -> Result<u64> {
    let mut ram_len = 0u64;
    let mut previous_end = 0;
    for region in ram.regions() {
        if region.size == 0 {
            return Err(invalid("empty RAM region"));
        }
        if region.guest_addr < previous_end {
            return Err(invalid("RAM regions must be ordered and non-overlapping"));
        }
        let size = region.size as u64;
        previous_end = region
            .guest_addr
            .checked_add(size)
            .ok_or_else(|| invalid("RAM region end GPA overflows"))?;
        ram_len = ram_len
            .checked_add(size)
            .ok_or_else(|| invalid("RAM byte length overflows"))?;
    }
    if ram_len == 0 {
        return Err(invalid("missing RAM"));
    }
    Ok(ram_len)
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
fn write_body<W: Write + ?Sized>(writer: &mut W, machine: &[u8], ram: &GuestRam) -> io::Result<()> {
    writer.write_all(machine)?;
    let mut buffer = vec![0; CHUNK];
    for region in ram.regions() {
        for offset in (0..region.size).step_by(CHUNK) {
            let len = CHUNK.min(region.size - offset);
            let address = GuestAddress(region.guest_addr + offset as u64);
            ram.memory()
                .read_slice(&mut buffer[..len], address)
                .map_err(io::Error::other)?;
            writer.write_all(&buffer[..len])?;
        }
    }
    writer.flush()
}

pub(crate) struct NewFileWriter {
    path: PathBuf,
    state: FileState,
}

enum FileState {
    Unopened,
    Open(io::BufWriter<File>, (u64, u64)),
    Committed,
}

impl NewFileWriter {
    pub(crate) fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            state: FileState::Unopened,
        }
    }

    // Export flushes the writer before committing it.
    pub(crate) fn commit(&mut self) {
        self.state = FileState::Committed;
    }
}

impl Write for NewFileWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if matches!(self.state, FileState::Unopened) {
            let (file, identity) = open_new(&self.path)?;
            self.state = FileState::Open(io::BufWriter::new(file), identity);
        }
        match &mut self.state {
            FileState::Open(writer, _) => writer.write(buf),
            _ => Err(io::Error::other("image writer is committed")),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match &mut self.state {
            FileState::Open(writer, _) => writer.flush(),
            _ => Ok(()),
        }
    }
}

impl Drop for NewFileWriter {
    fn drop(&mut self) {
        if let FileState::Open(writer, identity) =
            std::mem::replace(&mut self.state, FileState::Committed)
        {
            // Discard pending bytes and keep the inode live through cleanup.
            let (file, _) = writer.into_parts();
            let _ = remove_if_same_file(&self.path, identity);
            drop(file);
        }
    }
}

fn open_new(path: &Path) -> io::Result<(File, (u64, u64))> {
    let file = File::options()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    let meta = file.metadata()?;
    Ok((file, (meta.dev(), meta.ino())))
}

fn remove_if_same_file(path: &Path, identity: (u64, u64)) -> io::Result<()> {
    let result = match fs::symlink_metadata(path) {
        Ok(meta) if (meta.dev(), meta.ino()) == identity => fs::remove_file(path),
        Ok(_) => Ok(()),
        Err(error) => Err(error),
    };
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Refuse existing targets and remove a newly created target if the export fails.
#[cfg(test)]
pub(crate) fn create(path: &Path, write: impl FnOnce(&mut File) -> Result<()>) -> Result<()> {
    let (mut file, identity) = open_new(path).map_err(Error::Snapshot)?;
    if let Err(error) = write(&mut file) {
        remove_if_same_file(path, identity).map_err(|cleanup| {
            let cause: &dyn std::fmt::Display = match &error {
                Error::Snapshot(source) => source,
                _ => &error,
            };
            Error::Snapshot(io::Error::other(format!(
                "{cause}; removing incomplete image: {cleanup}"
            )))
        })?;
        return Err(error);
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
    #[cfg(test)]
    pub(crate) fn read(file: &mut File) -> Result<Self> {
        let file_len = file.metadata().map_err(Error::Snapshot)?.len();
        Self::read_from(file, Some(file_len))
    }

    pub(crate) fn read_from(reader: &mut impl Read, file_len: Option<u64>) -> Result<Self> {
        let mut bytes = [0; HEADER_LEN as usize];
        reader.read_exact(&mut bytes).map_err(Error::Snapshot)?;
        if &bytes[..8] != MAGIC || u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != VERSION {
            return Err(invalid("unknown image magic or version"));
        }
        let header = Self {
            vcpus: u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            ram_len: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            machine_len: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        };
        if !(1..=u32::from(crate::config::MAX_VCPUS)).contains(&header.vcpus) {
            return Err(invalid("vCPU count must be in 1..=64"));
        }
        if header.machine_len > MAX_MACHINE_STATE_LEN {
            return Err(invalid("machine state exceeds length limit"));
        }
        // Restore validates the RAM layout and KVM's GPA limit before allocating RAM.
        let total_len = HEADER_LEN
            .checked_add(header.machine_len)
            .and_then(|n| n.checked_add(header.ram_len));
        if total_len.is_none_or(|total| file_len.is_some_and(|len| total > len)) {
            return Err(invalid("image lengths exceed file bounds"));
        }
        Ok(header)
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn read_machine(
        &self,
        reader: &mut impl Read,
    ) -> Result<super::state::MachineState> {
        let mut bytes = vec![
            0;
            usize::try_from(self.machine_len)
                .map_err(|_| invalid("machine length exceeds address space"))?
        ];
        reader.read_exact(&mut bytes).map_err(Error::Snapshot)?;
        // Version 1 starts with the Postcard sequence length (a usize varint).
        // Check it before Vec deserialization can reserve or decode any records;
        // the byte-length limit alone does not bound the number of elements.
        let (count, _) = postcard::take_from_bytes::<usize>(&bytes)
            .map_err(|error| Error::Snapshot(io::Error::other(error)))?;
        if !(1..=usize::from(crate::config::MAX_VCPUS)).contains(&count) {
            return Err(invalid("vCPU count must be in 1..=64"));
        }
        if count as u64 != u64::from(self.vcpus) {
            return Err(invalid("vCPU count differs from machine state"));
        }
        let state: super::state::MachineState = postcard::from_bytes(&bytes)
            .map_err(|error| Error::Snapshot(io::Error::other(error)))?;
        if state
            .vcpus
            .iter()
            .enumerate()
            .any(|(id, record)| usize::from(record.id) != id)
        {
            return Err(invalid("vCPU records must be contiguous and ordered by id"));
        }
        Ok(state)
    }
}

fn invalid(reason: &'static str) -> Error {
    Error::Snapshot(io::Error::new(io::ErrorKind::InvalidInput, reason))
}
