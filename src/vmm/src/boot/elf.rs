// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Loads the pinned x86_64 ELF kernel through rust-vmm.

use std::io::{self, Read, Seek, SeekFrom};

use linux_loader::loader::{Elf, KernelLoader};
use vm_memory::{GuestMemoryBackend, ReadVolatile};

#[derive(Debug)]
pub(crate) struct LoadedKernel {
    pub entry: u64,
    /// Lowest physical address of the loadable segments, or zero if none.
    /// Used to keep the boot page tables clear of the kernel's memory.
    pub start: u64,
    /// Exclusive physical end of the loadable segments, including BSS.
    pub end: u64,
}

/// Copies the loadable segments into fresh zero-filled RAM and returns the
/// entry and physical bounds of the kernel. linux-loader's `kernel_end` skips
/// segments with `p_filesz == 0`, so compute the bounds separately to keep
/// boot page tables out of pure BSS as well.
///
/// BSS relies on the initial zeroes. A failed load may have written RAM;
/// discard that RAM before retrying.
pub(crate) fn load_elf<M, K>(ram: &M, kernel: &mut K) -> io::Result<LoadedKernel>
where
    M: GuestMemoryBackend,
    K: Read + ReadVolatile + Seek,
{
    let (start, end) = kernel_bounds(kernel)?;
    let loaded = Elf::load(ram, None, kernel, None).map_err(io::Error::other)?;
    Ok(LoadedKernel {
        entry: loaded.kernel_load.0,
        start,
        end,
    })
}

fn kernel_bounds(kernel: &mut (impl Read + Seek)) -> io::Result<(u64, u64)> {
    const ELF64_HEADER_SIZE: usize = 64;
    const ELF64_PROGRAM_HEADER_SIZE: usize = 56;
    const PT_LOAD: u32 = 1;

    let invalid = |message| io::Error::new(io::ErrorKind::InvalidInput, message);
    kernel.seek(SeekFrom::Start(0))?;
    let mut header = [0; ELF64_HEADER_SIZE];
    kernel.read_exact(&mut header)?;
    if &header[..4] != b"\x7fELF" || header[4] != 2 || header[5] != 1 {
        return Err(invalid("expected a little-endian ELF64 kernel"));
    }
    let phoff = u64::from_le_bytes(header[0x20..0x28].try_into().unwrap());
    let phentsize = u16::from_le_bytes(header[0x36..0x38].try_into().unwrap());
    let phnum = u16::from_le_bytes(header[0x38..0x3a].try_into().unwrap());
    if usize::from(phentsize) != ELF64_PROGRAM_HEADER_SIZE || phoff < ELF64_HEADER_SIZE as u64 {
        return Err(invalid("invalid ELF64 program-header size or offset"));
    }
    phoff
        .checked_add(u64::from(phentsize) * u64::from(phnum))
        .ok_or_else(|| invalid("ELF64 program-header table end overflows"))?;
    kernel.seek(SeekFrom::Start(phoff))?;
    let mut start: Option<u64> = None;
    let mut end = 0;
    for _ in 0..phnum {
        let mut program = [0; ELF64_PROGRAM_HEADER_SIZE];
        kernel.read_exact(&mut program)?;
        if u32::from_le_bytes(program[..4].try_into().unwrap()) == PT_LOAD {
            let paddr = u64::from_le_bytes(program[24..32].try_into().unwrap());
            let filesz = u64::from_le_bytes(program[32..40].try_into().unwrap());
            let memsz = u64::from_le_bytes(program[40..48].try_into().unwrap());
            if filesz > memsz {
                return Err(invalid("ELF64 segment file size exceeds memory size"));
            }
            let segment_end = paddr
                .checked_add(memsz)
                .ok_or_else(|| invalid("ELF64 segment end overflows"))?;
            start = Some(start.map_or(paddr, |start| start.min(paddr)));
            end = end.max(segment_end);
        }
    }
    Ok((start.unwrap_or(0), end))
}

#[cfg(test)]
#[path = "../../tests/elf/mod.rs"]
pub(crate) mod tests;
