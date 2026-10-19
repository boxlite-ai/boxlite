// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Initramfs placement, read back from guest RAM that starts out filled with
//! `0xff`, so every byte checked was written by `load_initramfs`.

use std::io;

use vm_memory::{Bytes, GuestAddress};

use super::load_initramfs;
use crate::memory::GuestMemoryMmap;

const RAM_SIZE: usize = 4 << 20;
/// A kernel loaded from 1 MiB that ends mid-page; the archive may start at
/// the next page, `FLOOR`.
const KERNEL_END: u64 = 0x10_3080;
const FLOOR: u64 = 0x10_4000;

fn ram() -> GuestMemoryMmap {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), RAM_SIZE)]).unwrap();
    ram.write_slice(&vec![0xff; RAM_SIZE], GuestAddress(0))
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

    let start = load_initramfs(&ram, &mut &archive[..], archive.len(), KERNEL_END).unwrap();

    // 4 MiB minus 5000 bytes, rounded down to a page.
    assert_eq!(start, GuestAddress(0x3f_e000));
    assert_eq!(read(&ram, start.0, archive.len()), archive);
    assert_eq!(
        read(&ram, start.0 - 1, 1),
        [0xff],
        "nothing below the start"
    );
}

#[test]
fn fits_an_archive_that_starts_at_the_page_after_the_kernel() {
    let ram = ram();
    let size = RAM_SIZE - FLOOR as usize;

    let start = load_initramfs(&ram, &mut &archive(size)[..], size, KERNEL_END).unwrap();
    assert_eq!(start, GuestAddress(FLOOR));
}

#[test]
fn refuses_an_empty_or_oversized_archive_before_writing() {
    let ram = ram();
    // Empty, one byte too large, and a kernel end with no next page.
    for (size, kernel_end) in [
        (0, KERNEL_END),
        (RAM_SIZE - FLOOR as usize + 1, KERNEL_END),
        (1, u64::MAX),
    ] {
        let error = load_initramfs(&ram, &mut &archive(size)[..], size, kernel_end).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{size} bytes");
    }
    let above_kernel = read(&ram, FLOOR, RAM_SIZE - FLOOR as usize);
    assert!(
        above_kernel.iter().all(|&byte| byte == 0xff),
        "RAM untouched"
    );
}
