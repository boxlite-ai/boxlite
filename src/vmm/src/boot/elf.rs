// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Decodes an x86_64 ELF `vmlinux` into the segments the VMM places at the
//! physical addresses its program headers name. Every check runs over the
//! immutable image; placement in guest RAM and the copy are the next slice.

use std::io;

use super::KernelLayout;

/// ELF64 file header size (`e_ehsize`).
const ELF_HEADER_SIZE: usize = 64;
/// ELF64 program header entry size (`e_phentsize`).
const PROGRAM_HEADER_SIZE: usize = 56;
/// `\x7fELF`, then `ELFCLASS64`, `ELFDATA2LSB` and `EV_CURRENT`.
const IDENT: [u8; 7] = [0x7f, b'E', b'L', b'F', 2, 1, 1];
/// `e_type` of an executable file.
const ET_EXEC: u16 = 2;
/// `e_machine` of x86-64.
const EM_X86_64: u16 = 62;
/// Program header types: loadable segment, dynamic linking table, interpreter.
const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const PT_INTERP: u32 = 3;
/// Program header flag of an executable segment.
const PF_X: u32 = 1;

/// One `PT_LOAD` segment, placed physically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Segment {
    /// Physical start (`p_paddr`).
    pub(crate) start: u64,
    /// Physical end, exclusive, BSS included.
    pub(crate) end: u64,
    /// Physical end of the file-backed bytes; `file_end..end` is BSS.
    pub(crate) file_end: u64,
    /// Offset of the file-backed bytes in the image.
    pub(crate) offset: usize,
    pub(crate) executable: bool,
}

/// Decodes the headers and checks every segment against the image.
///
/// The segments come back in ascending physical order without overlaps, each
/// with its file bytes inside `image`, and the entry lies in file-backed
/// executable bytes. Any violation is `InvalidData` and names the rule.
pub(crate) fn parse(image: &[u8]) -> io::Result<(Vec<Segment>, KernelLayout)> {
    let header = image
        .get(..ELF_HEADER_SIZE)
        .ok_or_else(|| invalid("truncated ELF header"))?;
    if header[..IDENT.len()] != IDENT
        || u16_at(header, 16) != ET_EXEC
        || u16_at(header, 18) != EM_X86_64
        || u32_at(header, 20) != 1
        || usize::from(u16_at(header, 52)) != ELF_HEADER_SIZE
    {
        return Err(invalid("expected a little-endian x86_64 ELF64 executable"));
    }
    let entry = u64_at(header, 24);
    let table_offset = u64_at(header, 32);
    let count = usize::from(u16_at(header, 56));
    if usize::from(u16_at(header, 54)) != PROGRAM_HEADER_SIZE
        || table_offset < ELF_HEADER_SIZE as u64
        || count == 0
    {
        return Err(invalid("invalid ELF program header table"));
    }
    let table = file_range(image, table_offset, (count * PROGRAM_HEADER_SIZE) as u64)?;
    let mut segments = Vec::with_capacity(count);
    let (program_headers, _) = table.as_chunks::<PROGRAM_HEADER_SIZE>();
    for (index, program_header) in program_headers.iter().enumerate() {
        match u32_at(program_header, 0) {
            PT_LOAD => segments.push(
                segment(image, program_header)
                    .map_err(|error| invalid(format!("segment {index}: {error}")))?,
            ),
            PT_DYNAMIC | PT_INTERP => {
                return Err(invalid("dynamic linking is not supported for a kernel"));
            }
            _ => {}
        }
    }
    segments.sort_by_key(|segment| segment.start);
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
    // The entry check proves there is at least one segment.
    let start = segments.first().map_or(0, |segment| segment.start);
    let end = segments.last().map_or(0, |segment| segment.end);
    Ok((segments, KernelLayout { entry, start, end }))
}

fn segment(image: &[u8], header: &[u8]) -> io::Result<Segment> {
    let offset = u64_at(header, 8);
    let start = u64_at(header, 24);
    let file_size = u64_at(header, 32);
    let memory_size = u64_at(header, 40);
    if memory_size == 0 || file_size > memory_size {
        return Err(invalid("expected a nonzero memory size >= file size"));
    }
    let end = start
        .checked_add(memory_size)
        .ok_or_else(|| invalid("load segment address overflow"))?;
    file_range(image, offset, file_size)?;
    Ok(Segment {
        start,
        end,
        file_end: start + file_size,
        offset: offset as usize,
        executable: u32_at(header, 4) & PF_X != 0,
    })
}

/// Returns `image[offset..offset + size]` or an error naming the missing range.
fn file_range(image: &[u8], offset: u64, size: u64) -> io::Result<&[u8]> {
    let end = offset
        .checked_add(size)
        .ok_or_else(|| invalid("ELF file range overflow"))?;
    usize::try_from(offset)
        .ok()
        .zip(usize::try_from(end).ok())
        .and_then(|(offset, end)| image.get(offset..end))
        .ok_or_else(|| invalid(format!("truncated ELF file range {offset:#x}..{end:#x}")))
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(array(bytes, offset))
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(array(bytes, offset))
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(array(bytes, offset))
}

/// Fixed-size copy out of a header; callers pass offsets inside a header slice
/// whose length was checked, so an out-of-range offset is a bug.
fn array<const N: usize>(bytes: &[u8], offset: usize) -> [u8; N] {
    let mut out = [0; N];
    out.copy_from_slice(&bytes[offset..offset + N]);
    out
}

fn invalid(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason.into())
}

// Crate-private tests live under the crate's `tests` directory so they stay
// out of coverage denominators while keeping `pub(crate)` access.
#[cfg(test)]
#[path = "../../tests/boot/mod.rs"]
mod tests;
