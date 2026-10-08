// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Tests for the ELF loader: one synthetic image exercises every decoding
//! and placement rule.

use std::io;

use vm_memory::{Bytes, GuestAddress, GuestMemoryMmap};

use super::{Segment, load_elf, parse};
use crate::boot::KernelLayout;

/// Physical start, file offset, file size, memory size and flags of each
/// fixture segment: code, data, and a BSS-only segment.
const SEGMENTS: [(u64, u64, u64, u64, u32); 3] = [
    (0x10_0000, 0x100, 8, 0x20, 5),
    (0x10_2000, 0x200, 4, 0x10, 6),
    (0x10_3000, 0, 0, 0x80, 6),
];
const FIXTURE_LAYOUT: KernelLayout = KernelLayout {
    entry: 0x10_0000,
    start: 0x10_0000,
    end: 0x10_3080,
};

fn put16(image: &mut [u8], offset: usize, value: u16) {
    image[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put32(image: &mut [u8], offset: usize, value: u32) {
    image[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put64(image: &mut [u8], offset: usize, value: u64) {
    image[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

/// Offset of program header `index` in the fixture.
fn header(index: usize) -> usize {
    64 + index * 56
}

/// A minimal x86_64 executable: three `PT_LOAD` segments whose virtual
/// addresses live in the kernel's negative half, as a real `vmlinux` has.
fn fixture() -> Vec<u8> {
    let mut image = vec![0u8; 0x204];
    image[..7].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1, 1]);
    put16(&mut image, 16, 2);
    put16(&mut image, 18, 62);
    put32(&mut image, 20, 1);
    put64(&mut image, 24, FIXTURE_LAYOUT.entry);
    put64(&mut image, 32, 64);
    put16(&mut image, 52, 64);
    put16(&mut image, 54, 56);
    put16(&mut image, 56, SEGMENTS.len() as u16);
    image[0x100..0x108].copy_from_slice(b"CODE1234");
    image[0x200..0x204].copy_from_slice(b"DATA");
    for (index, (paddr, offset, filesz, memsz, flags)) in SEGMENTS.into_iter().enumerate() {
        let base = header(index);
        put32(&mut image, base, 1);
        put32(&mut image, base + 4, flags);
        put64(&mut image, base + 8, offset);
        put64(&mut image, base + 16, paddr + 0xffff_8000_0000_0000);
        put64(&mut image, base + 24, paddr);
        put64(&mut image, base + 32, filesz);
        put64(&mut image, base + 40, memsz);
        put64(&mut image, base + 48, 1);
    }
    image
}

fn expected_segments() -> Vec<Segment> {
    SEGMENTS
        .iter()
        .map(|&(start, offset, filesz, memsz, flags)| Segment {
            start,
            end: start + memsz,
            file_end: start + filesz,
            offset: offset as usize,
            executable: flags & 1 != 0,
        })
        .collect()
}

fn reject(image: &[u8], reason: &str) {
    let error = parse(image).expect_err(reason);
    assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{error}");
    assert!(error.to_string().contains(reason), "{error}");
}

#[test]
fn decodes_load_segments_sorted_by_address_and_skips_notes() {
    let image = fixture();
    let mut reversed = image.clone();
    reversed[header(0)..header(1)].copy_from_slice(&image[header(2)..header(3)]);
    reversed[header(2)..header(3)].copy_from_slice(&image[header(0)..header(1)]);
    for image in [image, reversed] {
        let (segments, layout) = parse(&image).unwrap();
        assert_eq!(layout, FIXTURE_LAYOUT);
        assert_eq!(segments, expected_segments());
    }
    let mut noted = fixture();
    put32(&mut noted, header(2), 4);
    put64(&mut noted, header(2) + 8, u64::MAX);
    let (segments, layout) = parse(&noted).unwrap();
    assert_eq!(
        (segments.len(), layout.end),
        (2, 0x10_2010),
        "notes are skipped"
    );
}

#[test]
fn rejects_wrong_class_endianness_type_machine_and_header_sizes() {
    for offset in [0, 4, 5, 6, 16, 18, 20, 52] {
        let mut image = fixture();
        image[offset] ^= 0x40;
        reject(&image, "expected a little-endian x86_64 ELF64 executable");
    }
    for (offset, value, reason) in [
        (54, 0, "invalid ELF program header table"),
        (32, 63, "invalid ELF program header table"),
        (32, u64::MAX, "ELF file range overflow"),
    ] {
        let mut image = fixture();
        put64(&mut image, offset, value);
        reject(&image, reason);
    }
}

#[test]
fn rejects_every_truncated_prefix() {
    let image = fixture();
    for len in 0..image.len() {
        let error = parse(&image[..len]).expect_err("truncated image");
        assert_eq!(
            error.kind(),
            io::ErrorKind::InvalidData,
            "prefix {len}: {error}"
        );
    }
}

#[test]
fn rejects_segment_sizes_offsets_and_addresses_the_image_cannot_hold() {
    let mut image = fixture();
    put64(&mut image, header(1) + 32, 0x11);
    reject(&image, "nonzero memory size >= file size");
    let mut image = fixture();
    put64(&mut image, header(2) + 40, 0);
    reject(&image, "nonzero memory size >= file size");
    let mut image = fixture();
    put64(&mut image, header(1) + 8, 0x201);
    reject(&image, "truncated ELF file range 0x201..0x205");
    let mut image = fixture();
    put64(&mut image, header(2) + 24, u64::MAX - 1);
    reject(&image, "load segment address overflow");
}

#[test]
fn rejects_overlapping_segments_including_bss_only_overlap() {
    for (field, start) in [(header(1) + 24, 0x10_0008), (header(2) + 24, 0x10_2008)] {
        let mut image = fixture();
        put64(&mut image, field, start);
        reject(&image, "overlapping ELF load segments");
    }
}

#[test]
fn rejects_entries_outside_file_backed_executable_bytes() {
    for entry in [0, 0x0f_ffff, 0x10_0008, 0x10_2000, 0x10_3000, 0x20_0000] {
        let mut image = fixture();
        put64(&mut image, 24, entry);
        reject(&image, "is outside file-backed executable segments");
    }
    let mut image = fixture();
    put32(&mut image, header(0) + 4, 4);
    reject(&image, "is outside file-backed executable segments");
}

#[test]
fn rejects_dynamic_images_and_images_without_load_segments() {
    for kind in [2, 3] {
        let mut image = fixture();
        put32(&mut image, header(2), kind);
        reject(&image, "dynamic linking is not supported");
    }
    let mut image = fixture();
    for index in 0..SEGMENTS.len() {
        put32(&mut image, header(index), 4);
    }
    reject(&image, "is outside file-backed executable segments");
}

/// RAM for the synthetic images: the fixture's segments end below 2 MiB.
const RAM_SIZE: usize = 2 << 20;

fn ram(size: usize) -> GuestMemoryMmap<()> {
    GuestMemoryMmap::from_ranges(&[(GuestAddress(0), size)]).expect("anonymous guest RAM")
}

fn read(ram: &GuestMemoryMmap<()>, address: u64, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    ram.read_slice(&mut bytes, GuestAddress(address))
        .expect("read guest RAM");
    bytes
}

fn fill(ram: &GuestMemoryMmap<()>, address: u64, len: usize, value: u8) {
    ram.write_slice(&vec![value; len], GuestAddress(address))
        .expect("write guest RAM");
}

fn reject_load(image: &[u8], reason: &str) {
    let error = load_elf(&ram(RAM_SIZE), image).expect_err(reason);
    assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{error}");
    assert!(error.to_string().contains(reason), "{error}");
}

#[test]
fn loads_file_bytes_at_physical_addresses_and_zeroes_bss() {
    let ram = ram(RAM_SIZE);
    let span = (FIXTURE_LAYOUT.end - FIXTURE_LAYOUT.start) as usize;
    fill(&ram, FIXTURE_LAYOUT.start, span, 0xff);

    assert_eq!(load_elf(&ram, &fixture()).unwrap(), FIXTURE_LAYOUT);

    let mut code = b"CODE1234".to_vec();
    code.resize(0x20, 0);
    assert_eq!(read(&ram, 0x10_0000, 0x20), code);
    assert_eq!(
        read(&ram, 0x10_0020, 0x1fe0),
        vec![0xff; 0x1fe0],
        "gap must stay untouched"
    );
    let mut data = b"DATA".to_vec();
    data.resize(0x10, 0);
    assert_eq!(read(&ram, 0x10_2000, 0x10), data);
    assert_eq!(
        read(&ram, 0x10_2010, 0xff0),
        vec![0xff; 0xff0],
        "gap must stay untouched"
    );
    assert_eq!(
        read(&ram, 0x10_3000, 0x80),
        vec![0; 0x80],
        "BSS-only segment must be zero"
    );
    assert_eq!(
        read(&ram, 0, 0x10_0000),
        vec![0; 0x10_0000],
        "first MiB must stay untouched"
    );
}

#[test]
fn accepts_a_segment_ending_exactly_at_the_end_of_ram() {
    let mut image = fixture();
    let last = header(2);
    put64(&mut image, last + 40, RAM_SIZE as u64 - 0x10_3000);
    let layout = load_elf(&ram(RAM_SIZE), &image).unwrap();
    assert_eq!(layout.end, RAM_SIZE as u64);

    put64(&mut image, last + 40, RAM_SIZE as u64 - 0x10_3000 + 1);
    reject_load(&image, "is not backed by guest RAM");
}

#[test]
fn rejects_segments_below_the_first_mib_or_outside_ram() {
    let last = header(2);
    for (field, value, reason) in [
        (last + 24, 0x0f_ff00, "is below the first MiB"),
        (last + 40, 0x20_0000, "is not backed by guest RAM"),
    ] {
        let mut image = fixture();
        put64(&mut image, field, value);
        reject_load(&image, reason);
    }
}

#[test]
fn leaves_ram_untouched_on_rejection() {
    let ram = ram(RAM_SIZE);
    let span = (FIXTURE_LAYOUT.end - FIXTURE_LAYOUT.start) as usize;
    fill(&ram, FIXTURE_LAYOUT.start, span, 0xff);
    for (field, value) in [(header(2) + 24, 0x10_2008), (header(2) + 40, 0x20_0000)] {
        let mut image = fixture();
        put64(&mut image, field, value);
        load_elf(&ram, &image).expect_err("rejected image");
        assert_eq!(read(&ram, FIXTURE_LAYOUT.start, span), vec![0xff; span]);
    }
}
