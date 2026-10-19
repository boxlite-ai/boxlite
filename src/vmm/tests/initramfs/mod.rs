// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Unit tests for initramfs placement, boundary checks, and test archive generation.

use std::io::{self, Cursor};

use vm_memory::{Bytes, GuestAddress};

use super::load_initramfs;
use crate::memory::GuestMemoryMmap;

const RAM_SIZE: usize = 256 << 20;

/// A minimal 132-byte x86_64 static ELF binary that calls `exit_group(42)`.
pub(crate) fn init_elf() -> Vec<u8> {
    let mut elf = vec![0u8; 132];
    elf[..4].copy_from_slice(b"\x7fELF");
    elf[4] = 2; // ELFCLASS64
    elf[5] = 1; // ELFDATA2LSB
    elf[6] = 1; // EV_CURRENT
    elf[16..18].copy_from_slice(&2u16.to_le_bytes()); // ET_EXEC
    elf[18..20].copy_from_slice(&62u16.to_le_bytes()); // EM_X86_64
    elf[20..24].copy_from_slice(&1u32.to_le_bytes()); // EV_CURRENT
    elf[24..32].copy_from_slice(&0x40_0078u64.to_le_bytes()); // e_entry (0x400000 + 120)
    elf[32..40].copy_from_slice(&64u64.to_le_bytes()); // e_phoff (immediately after Ehdr)
    elf[52..54].copy_from_slice(&64u16.to_le_bytes()); // e_ehsize
    elf[54..56].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize
    elf[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum

    let ph = &mut elf[64..120];
    ph[0..4].copy_from_slice(&1u32.to_le_bytes()); // PT_LOAD
    ph[4..8].copy_from_slice(&5u32.to_le_bytes()); // PF_R | PF_X
    ph[8..16].copy_from_slice(&0u64.to_le_bytes()); // p_offset
    ph[16..24].copy_from_slice(&0x40_0000u64.to_le_bytes()); // p_vaddr
    ph[24..32].copy_from_slice(&0x40_0000u64.to_le_bytes()); // p_paddr
    ph[32..40].copy_from_slice(&132u64.to_le_bytes()); // p_filesz
    ph[40..48].copy_from_slice(&132u64.to_le_bytes()); // p_memsz
    ph[48..56].copy_from_slice(&0x1000u64.to_le_bytes()); // p_align

    elf[120..132].copy_from_slice(&[
        0xb8, 0xe7, 0x00, 0x00, 0x00, // mov eax, 231 (sys_exit_group)
        0xbf, 0x2a, 0x00, 0x00, 0x00, // mov edi, 42
        0x0f, 0x05, // syscall
    ]);
    elf
}

fn cpio_header(ino: u32, mode: u32, filesize: u32, namesize: u32) -> [u8; 110] {
    let mut header = [0u8; 110];
    header[0..6].copy_from_slice(b"070701");
    let fields = [
        ino, mode, 0, 0, 1, 0, filesize, 0, 0, // maj, min
        0, 0, // rmaj, rmin
        namesize, 0, // check
    ];
    for (i, val) in fields.iter().enumerate() {
        let hex = format!("{val:08X}");
        header[6 + i * 8..6 + (i + 1) * 8].copy_from_slice(hex.as_bytes());
    }
    header
}

/// A minimal 372-byte uncompressed newc cpio archive containing the 132-byte `/init`.
pub(crate) fn fixture() -> Vec<u8> {
    let mut archive = Vec::with_capacity(372);
    let elf = init_elf();

    archive.extend_from_slice(&cpio_header(1, 0o100755, elf.len() as u32, 5));
    archive.extend_from_slice(b"init\0\0");
    archive.extend_from_slice(&elf);

    archive.extend_from_slice(&cpio_header(0, 0, 0, 11));
    archive.extend_from_slice(b"TRAILER!!!\0\0\0");

    archive
}

fn ram(size: usize) -> GuestMemoryMmap {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), size)]).unwrap();
    ram.write_slice(&vec![0xff; size], GuestAddress(0)).unwrap();
    ram
}

#[test]
fn fixture_sizes_match_design_specification() {
    assert_eq!(init_elf().len(), 132);
    assert_eq!(fixture().len(), 372);
}

#[test]
fn places_archive_at_top_of_ram_page_aligned() {
    let memory = ram(RAM_SIZE);
    let archive = fixture();
    let kernel_end = 0x10_3080;
    let ram_end = RAM_SIZE as u64;

    let loaded = load_initramfs(&memory, &mut Cursor::new(&archive), kernel_end, ram_end).unwrap();

    assert_eq!(loaded.address, 0x0fff_f000);
    assert_eq!(loaded.size, 372);

    let mut written = vec![0u8; 372];
    memory
        .read_slice(&mut written, GuestAddress(loaded.address))
        .unwrap();
    assert_eq!(written, archive);
}

#[test]
fn refuses_empty_archive_before_writing() {
    let memory = ram(RAM_SIZE);
    let mut empty = Cursor::new(b"");
    let error = load_initramfs(&memory, &mut empty, 0x10_3080, RAM_SIZE as u64).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(error.to_string(), "the initramfs archive is empty");
}

#[test]
fn refuses_archive_overlapping_kernel_before_writing() {
    let memory = ram(RAM_SIZE);
    let archive = fixture();
    let error = load_initramfs(
        &memory,
        &mut Cursor::new(&archive),
        0x0fff_f001,
        RAM_SIZE as u64,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        error.to_string(),
        "the initramfs archive overlaps with the kernel"
    );

    let error = load_initramfs(&memory, &mut Cursor::new(&archive), 0, 100).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}
