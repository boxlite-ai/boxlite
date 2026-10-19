// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The zero page and command line, read back from guest RAM that starts out
//! filled with `0xff`, so every byte checked was written by
//! `write_boot_params`.

use std::io;

use linux_loader::loader::bootparam::boot_params;
use vm_memory::{Bytes, GuestAddress};

use super::write_boot_params;
use crate::{
    config::{MAX_CMDLINE_BYTES, VmConfig},
    memory::{GuestMemoryMmap, ram_ranges},
};

const CMDLINE: &str = "console=ttyS0 panic=-1";
const ZERO_PAGE: u64 = 0x7000;
const E820_RAM: u32 = 1;

fn ram(size: usize) -> GuestMemoryMmap {
    let ram = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), size)]).unwrap();
    ram.write_slice(&vec![0xff; size], GuestAddress(0)).unwrap();
    ram
}

fn zero_page(ram: &GuestMemoryMmap) -> boot_params {
    ram.read_obj(GuestAddress(ZERO_PAGE)).unwrap()
}

/// The E820 table as `(addr, size, type)`, copied out of the packed entries.
fn e820(params: &boot_params) -> Vec<(u64, u64, u32)> {
    params.e820_table[..usize::from(params.e820_entries)]
        .iter()
        .map(|entry| (entry.addr, entry.size, entry.r#type))
        .collect()
}

#[test]
fn fills_the_setup_header_and_writes_the_command_line() {
    let ram = ram(16 << 20);
    assert_eq!(
        write_boot_params(&ram, CMDLINE, &ram_ranges(16), None).unwrap(),
        ZERO_PAGE
    );

    let params = zero_page(&ram);
    let hdr = params.hdr;
    // boot.rst: no assigned loader ID, the boot flag and "HdrS" magic, the
    // 16 MiB alignment Firecracker and libkrun use, and no loadflags.
    assert_eq!(
        (
            hdr.type_of_loader,
            hdr.boot_flag,
            hdr.header,
            hdr.kernel_alignment,
            hdr.loadflags,
        ),
        (0xff, 0xaa55, 0x5372_6448, 0x100_0000, 0)
    );
    assert_eq!(
        (hdr.cmd_line_ptr, hdr.cmdline_size),
        (0x2_0000, CMDLINE.len() as u32 + 1)
    );
    let mut line = vec![0; CMDLINE.len() + 1];
    ram.read_slice(&mut line, GuestAddress(hdr.cmd_line_ptr.into()))
        .unwrap();
    assert_eq!(line, [CMDLINE.as_bytes(), b"\0"].concat());
    // The guest has no ACPI tables and no initramfs.
    assert_eq!(
        (params.acpi_rsdp_addr, hdr.ramdisk_image, hdr.ramdisk_size),
        (0, 0, 0)
    );
}

#[test]
fn records_the_initramfs_in_the_setup_header() {
    let ram = ram(16 << 20);
    let initramfs = (GuestAddress(0xff_f000), 372);
    write_boot_params(&ram, CMDLINE, &ram_ranges(16), Some(initramfs)).unwrap();
    let hdr = zero_page(&ram).hdr;
    assert_eq!((hdr.ramdisk_image, hdr.ramdisk_size), (0xff_f000, 372));
}

#[test]
fn refuses_an_initramfs_beyond_the_32_bit_fields_before_writing() {
    let ram = ram(1 << 20);
    let above_4_gib = (GuestAddress(1 << 32), 1);
    let error = write_boot_params(&ram, CMDLINE, &ram_ranges(1), Some(above_4_gib)).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    let byte: u8 = ram.read_obj(GuestAddress(ZERO_PAGE)).unwrap();
    assert_eq!(byte, 0xff, "nothing written at the zero page");
}

#[test]
fn lists_ram_as_usable_e820_entries_outside_the_low_memory_hole() {
    // [0x9_FC00, 1 MiB) holds the MP table and the legacy BIOS areas; 1 MiB
    // of RAM has nothing above it.
    for (memory_mib, expected) in [
        (
            16,
            vec![(0, 0x9_fc00, E820_RAM), (0x10_0000, 15 << 20, E820_RAM)],
        ),
        (1, vec![(0, 0x9_fc00, E820_RAM)]),
    ] {
        let ram = ram((memory_mib as usize) << 20);
        write_boot_params(&ram, CMDLINE, &ram_ranges(memory_mib), None).unwrap();
        assert_eq!(e820(&zero_page(&ram)), expected, "{memory_mib} MiB");
    }
}

#[test]
fn refuses_more_e820_entries_than_the_zero_page_holds_before_writing() {
    // Every range above 1 MiB becomes one entry; the table has 128 slots.
    let ranges: Vec<_> = (0..129)
        .map(|index| (GuestAddress(0x10_0000 + index * 0x2000), 0x1000))
        .collect();
    let ram = ram(1 << 20);

    let error = write_boot_params(&ram, CMDLINE, &ranges, None).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    for address in [ZERO_PAGE, 0x2_0000] {
        let byte: u8 = ram.read_obj(GuestAddress(address)).unwrap();
        assert_eq!(byte, 0xff, "nothing written at {address:#x}");
    }

    write_boot_params(&ram, CMDLINE, &ranges[..128], None).unwrap();
    assert_eq!(e820(&zero_page(&ram)).len(), 128);
}

#[test]
fn agrees_with_validate_on_command_line_limits() {
    for (cmdline, accepted) in [
        ("a".repeat(MAX_CMDLINE_BYTES - 1), true),
        ("a".repeat(MAX_CMDLINE_BYTES), false),
        ("root=/dev/vdb\0".into(), false),
        ("console=ttyS0\nquiet".into(), false),
        ("init=/caf\u{e9}".into(), false),
    ] {
        let written = write_boot_params(&ram(1 << 20), &cmdline, &ram_ranges(1), None);
        assert_eq!(
            written.map_err(|error| error.kind()).err(),
            (!accepted).then_some(io::ErrorKind::InvalidInput),
            "{cmdline:?}"
        );
        let config = VmConfig {
            vcpu_count: 1,
            memory_mib: 1,
            kernel: "vmlinux".into(),
            cmdline,
            initramfs: None,
        };
        assert_eq!(config.validate().is_ok(), accepted, "{config:?}");
    }
}
