// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `Image` loading, read back from guest RAM that starts out filled with
//! `0xff`, so every byte checked was written by `load_image`.

use std::io::{self, Cursor};

use vm_memory::{Bytes, GuestAddress};

use super::{LoadedImage, load_image};
use crate::memory::{GuestMemoryMmap, RAM_START};

const RAM_SIZE: usize = 8 << 20;

fn ram() -> GuestMemoryMmap {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(RAM_START), RAM_SIZE)]).unwrap();
    ram.write_slice(&vec![0xff; RAM_SIZE], GuestAddress(RAM_START))
        .unwrap();
    ram
}

/// An `Image` with the 64-byte header of `Documentation/arch/arm64/booting.rst`
/// and `body` after it.
fn image(text_offset: u64, image_size: u64, body: &[u8]) -> Vec<u8> {
    let mut image = vec![0; 64];
    image[8..16].copy_from_slice(&text_offset.to_le_bytes());
    image[16..24].copy_from_slice(&image_size.to_le_bytes());
    image[56..60].copy_from_slice(b"ARM\x64");
    image.extend_from_slice(body);
    image
}

fn read(ram: &GuestMemoryMmap, address: u64, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    ram.read_slice(&mut bytes, GuestAddress(address)).unwrap();
    bytes
}

#[test]
fn loads_the_image_at_its_text_offset_and_claims_its_image_size() {
    let ram = ram();
    let file = image(0x8_0000, 0x40_0000, b"kernel text");

    let loaded = load_image(&ram, &mut Cursor::new(&file)).unwrap();

    let entry = RAM_START + 0x8_0000;
    assert_eq!(
        loaded,
        LoadedImage {
            entry: GuestAddress(entry),
            // The header's image_size covers the BSS beyond the file.
            end: GuestAddress(entry + 0x40_0000),
        }
    );
    assert_eq!(read(&ram, entry, file.len()), file);
    assert_eq!(read(&ram, entry - 1, 1), [0xff], "nothing below the entry");
}

#[test]
fn claims_at_least_the_whole_file() {
    let ram = ram();
    // An image_size of 0 means a pre-3.17 kernel: text offset 0x80000, and
    // no size beyond the file.
    let file = image(0, 0, &[0x55; 4096]);

    let loaded = load_image(&ram, &mut Cursor::new(&file)).unwrap();

    let entry = RAM_START + 0x8_0000;
    assert_eq!(loaded.entry, GuestAddress(entry));
    assert_eq!(loaded.end, GuestAddress(entry + file.len() as u64));
}

#[test]
fn refuses_a_file_that_is_not_an_arm64_image() {
    let ram = ram();
    let mut file = image(0, 0x1000, b"text");
    file[56..60].copy_from_slice(b"MZ\0\0");

    let error = load_image(&ram, &mut Cursor::new(&file)).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{error}");
    assert!(
        read(&ram, RAM_START, RAM_SIZE)
            .iter()
            .all(|&byte| byte == 0xff),
        "RAM untouched"
    );
}

#[test]
fn refuses_an_image_that_does_not_fit_in_ram() {
    let ram = ram();
    let file = image(0, 0x1000, &vec![0; RAM_SIZE]);

    assert!(load_image(&ram, &mut Cursor::new(&file)).is_err());
}

#[test]
fn refuses_an_image_size_that_overflows_or_exceeds_ram() {
    let ram = ram();
    for size in [RAM_SIZE as u64 + 1, u64::MAX] {
        let file = image(0, size, b"text");
        let error = load_image(&ram, &mut Cursor::new(&file)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{size:#x}");
    }
}

#[test]
fn refuses_an_image_extent_that_crosses_a_ram_hole() {
    let ram = GuestMemoryMmap::from_ranges(&[
        (GuestAddress(RAM_START), 0x1000),
        (GuestAddress(RAM_START + 0x2000), 0x1000),
    ])
    .unwrap();
    let file = image(0, 0x3000, b"text");

    let error = load_image(&ram, &mut Cursor::new(&file)).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}
