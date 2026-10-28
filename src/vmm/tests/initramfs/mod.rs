// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Initramfs placement, read back from guest RAM that starts out filled with
//! `0xff`, so every byte checked was written by `load_initramfs`.
//!
//! RAM starts at `BASE`, not 0, as on arm64, so a slot that crosses the start
//! of RAM is caught.

use std::io;

use vm_memory::{Bytes, GuestAddress};

use super::load_initramfs;
use crate::memory::GuestMemoryMmap;

const BASE: u64 = 0x8000_0000;
const RAM_SIZE: usize = 4 << 20;
const RAM_END: GuestAddress = GuestAddress(BASE + RAM_SIZE as u64);

fn ram() -> GuestMemoryMmap {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(BASE), RAM_SIZE)]).unwrap();
    ram.write_slice(&vec![0xff; RAM_SIZE], GuestAddress(BASE))
        .unwrap();
    ram
}

/// An archive of `size` bytes with a repeating pattern.
fn archive(size: usize) -> Vec<u8> {
    (0..size).map(|index| index as u8).collect()
}

fn read(ram: &GuestMemoryMmap, address: u64, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    ram.read_slice(&mut bytes, GuestAddress(address)).unwrap();
    bytes
}

#[test]
fn places_the_archive_in_the_top_page_aligned_slot() {
    let ram = ram();
    let archive = archive(5000);

    let start = load_initramfs(&ram, &mut &archive[..], archive.len(), RAM_END).unwrap();

    // 4 MiB minus 5000 bytes, rounded down to a page.
    assert_eq!(start, GuestAddress(BASE + 0x3f_e000));
    assert_eq!(read(&ram, start.0, archive.len()), archive);
    assert_eq!(
        read(&ram, start.0 - 1, 1),
        [0xff],
        "nothing below the start"
    );
}

#[test]
fn places_the_archive_below_an_end_inside_ram() {
    let ram = ram();
    let archive = archive(5000);
    let end = GuestAddress(BASE + (2 << 20));

    let start = load_initramfs(&ram, &mut &archive[..], archive.len(), end).unwrap();

    assert_eq!(start, GuestAddress(BASE + (2 << 20) - 0x2000));
    assert_eq!(read(&ram, start.0, archive.len()), archive);
    assert_eq!(read(&ram, end.0, 1), [0xff], "nothing at or above the end");
}

#[test]
fn preserves_x86_placement_at_the_top_of_zero_based_ram() {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), RAM_SIZE)]).unwrap();
    let archive = archive(5000);

    let start = load_initramfs(
        &ram,
        &mut &archive[..],
        archive.len(),
        GuestAddress(RAM_SIZE as u64),
    )
    .unwrap();

    assert_eq!(start, GuestAddress(0x3f_e000));
    assert_eq!(read(&ram, start.0, archive.len()), archive);
}

#[test]
fn fits_an_archive_that_fills_the_ram_region() {
    let ram = ram();

    let start = load_initramfs(&ram, &mut &archive(RAM_SIZE)[..], RAM_SIZE, RAM_END).unwrap();
    assert_eq!(start, GuestAddress(BASE));
}

#[test]
fn refuses_an_empty_or_oversized_archive_before_writing() {
    let ram = ram();
    // Empty, and one byte larger than the region.
    for size in [0, RAM_SIZE + 1] {
        let error = load_initramfs(&ram, &mut &archive(size)[..], size, RAM_END).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{size} bytes");
    }
    // An end with no RAM below it.
    let error = load_initramfs(&ram, &mut &archive(16)[..], 16, GuestAddress(BASE)).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(
        read(&ram, BASE, RAM_SIZE).iter().all(|&byte| byte == 0xff),
        "RAM untouched"
    );
}
