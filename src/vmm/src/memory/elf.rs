// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;

use super::KERNEL_MIN_ADDR;

const ELF_HEADER_SIZE: usize = 64;
const PROGRAM_HEADER_SIZE: usize = 56;
const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const PT_INTERP: u32 = 3;
const PF_X: u32 = 1;

pub(super) struct Layout {
    pub(super) entry: u64,
    pub(super) end: u64,
}

struct Segment {
    start: u64,
    end: u64,
    file_end: u64,
    executable: bool,
}

pub(super) fn validate(image: &[u8], ram_bytes: u64) -> io::Result<Layout> {
    let header = image
        .get(..ELF_HEADER_SIZE)
        .ok_or_else(|| invalid("truncated ELF header"))?;
    // ELF64, little-endian, current ident/version, ET_EXEC, EM_X86_64.
    if &header[..7] != b"\x7fELF\x02\x01\x01"
        || u16_at(header, 16) != 2
        || u16_at(header, 18) != 62
        || u32_at(header, 20) != 1
        || u16_at(header, 52) as usize != ELF_HEADER_SIZE
    {
        return Err(invalid("expected a little-endian x86_64 ELF executable"));
    }
    let entry = u64_at(header, 24);
    let table_offset = u64_at(header, 32);
    let count = u16_at(header, 56) as usize;
    if u16_at(header, 54) as usize != PROGRAM_HEADER_SIZE
        || table_offset < ELF_HEADER_SIZE as u64
        || count == 0
    {
        return Err(invalid("invalid ELF program header table"));
    }
    let table = file_range(image, table_offset, (count * PROGRAM_HEADER_SIZE) as u64)?;
    let mut segments = Vec::new();
    for (index, header) in table
        .as_chunks::<PROGRAM_HEADER_SIZE>()
        .0
        .iter()
        .enumerate()
    {
        match u32_at(header, 0) {
            PT_LOAD => segments.push(
                segment(header, image, ram_bytes)
                    .map_err(|source| invalid(format!("segment {index}: {source}")))?,
            ),
            PT_DYNAMIC | PT_INTERP => {
                return Err(invalid("dynamic linking is not supported for a kernel"));
            }
            _ => {}
        }
    }
    segments.sort_unstable_by_key(|segment| segment.start);
    if segments.windows(2).any(|pair| pair[0].end > pair[1].start) {
        return Err(invalid("overlapping ELF load segments"));
    }
    if !segments
        .iter()
        .any(|segment| segment.executable && (segment.start..segment.file_end).contains(&entry))
    {
        return Err(invalid(format!(
            "entry {entry:#x} is outside file-backed executable segments"
        )));
    }
    Ok(Layout {
        entry,
        // The entry check above establishes that a loadable segment exists.
        end: segments.last().expect("validated load segment").end,
    })
}

fn segment(header: &[u8], image: &[u8], ram_bytes: u64) -> io::Result<Segment> {
    let offset = u64_at(header, 8);
    let virtual_addr = u64_at(header, 16);
    let start = u64_at(header, 24);
    let file_size = u64_at(header, 32);
    let memory_size = u64_at(header, 40);
    let alignment = u64_at(header, 48);
    if file_size > memory_size || memory_size == 0 {
        return Err(invalid(
            "load segment must have nonzero memory size >= file size",
        ));
    }
    let end = start
        .checked_add(memory_size)
        .ok_or_else(|| invalid("load segment address overflow"))?;
    if start < KERNEL_MIN_ADDR || end > ram_bytes {
        return Err(invalid(format!(
            "load range {start:#x}..{end:#x} is outside kernel RAM {KERNEL_MIN_ADDR:#x}..{ram_bytes:#x}"
        )));
    }
    if alignment > 1
        && (!alignment.is_power_of_two() || virtual_addr % alignment != offset % alignment)
    {
        return Err(invalid("invalid ELF virtual address/file alignment"));
    }
    file_range(image, offset, file_size)?;
    Ok(Segment {
        start,
        end,
        // file_size <= memory_size, whose end was checked above.
        file_end: start + file_size,
        executable: u32_at(header, 4) & PF_X != 0,
    })
}

fn file_range(image: &[u8], offset: u64, size: u64) -> io::Result<&[u8]> {
    let end = offset
        .checked_add(size)
        .ok_or_else(|| invalid("ELF file range overflow"))?;
    if end > image.len() as u64 {
        return Err(invalid(format!(
            "truncated ELF file range {offset:#x}..{end:#x}, file size {:#x}",
            image.len()
        )));
    }
    Ok(&image[offset as usize..end as usize])
}

// Callers pass a complete fixed-size ELF/program header before decoding fields.
fn u16_at(header: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(header[offset..offset + 2].try_into().unwrap())
}

fn u32_at(header: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap())
}

fn u64_at(header: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(header[offset..offset + 8].try_into().unwrap())
}

fn invalid(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason.into())
}
