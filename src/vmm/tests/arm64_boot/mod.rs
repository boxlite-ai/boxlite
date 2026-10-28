// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The arm64 boot path through `prepare`: the `Image`, the device tree and the
//! initramfs as they land in guest RAM, and the boot vCPU's registers.

use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use fdt::Fdt;
use vm_memory::{Bytes, GuestAddress};

use super::prepare;
use crate::{
    config::VmConfig,
    error::Error,
    memory::{GuestRam, RAM_START, ram_ranges},
    vcpu::PSTATE_EL1H_DAIF,
};

const MIB: u64 = 1 << 20;

/// A file under the system temporary directory, removed on drop.
struct TempFile(PathBuf);

impl TempFile {
    fn new(name: &str, bytes: &[u8]) -> Self {
        let path =
            std::env::temp_dir().join(format!("boxlite-arm64-boot-{}-{name}", std::process::id()));
        fs::write(&path, bytes).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// An `Image` with text offset 0 that claims `image_size` bytes.
fn image(image_size: u64) -> Vec<u8> {
    let mut image = vec![0; 64];
    image[16..24].copy_from_slice(&image_size.to_le_bytes());
    image[56..60].copy_from_slice(b"ARM\x64");
    image.extend_from_slice(b"kernel text");
    image
}

fn config(memory_mib: u32, kernel: &TempFile, initramfs: Option<&TempFile>) -> VmConfig {
    VmConfig {
        vcpu_count: 2,
        memory_mib,
        kernel: kernel.path().to_path_buf(),
        cmdline: "console=ttyAMA0 panic=-1".into(),
        initramfs: initramfs.map(|file| file.path().to_path_buf()),
    }
}

fn read(ram: &GuestRam, address: u64, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    ram.memory()
        .read_slice(&mut bytes, GuestAddress(address))
        .unwrap();
    bytes
}

#[test]
fn enters_the_image_with_x0_at_the_device_tree_in_the_last_2_mib() {
    let kernel = TempFile::new("Image", &image(MIB));
    let config = config(64, &kernel, None);
    let ram = GuestRam::new(&ram_ranges(config.memory_mib)).unwrap();

    let setup = prepare(&ram, &config).unwrap();

    let dtb = RAM_START + 62 * MIB;
    assert_eq!(setup.boot_regs.pc, RAM_START);
    assert_eq!(setup.boot_regs.x0, dtb);
    assert_eq!(setup.boot_regs.pstate, PSTATE_EL1H_DAIF);
    assert_eq!(read(&ram, RAM_START + 56, 4), b"ARM\x64");
    let blob = read(&ram, dtb, 2 * MIB as usize);
    let tree = Fdt::new(&blob).unwrap();
    let chosen = tree.find_node("/chosen").unwrap();
    assert_eq!(
        chosen.property("bootargs").unwrap().value,
        b"console=ttyAMA0 panic=-1\0"
    );
}

#[test]
fn places_the_initramfs_below_the_device_tree_and_names_it() {
    let kernel = TempFile::new("Image-initramfs", &image(MIB));
    let archive: Vec<u8> = (0..5000).map(|index| index as u8).collect();
    let initramfs = TempFile::new("initramfs", &archive);
    let config = config(64, &kernel, Some(&initramfs));
    let ram = GuestRam::new(&ram_ranges(config.memory_mib)).unwrap();

    let setup = prepare(&ram, &config).unwrap();

    // The highest page below the device tree that holds 5000 bytes.
    let dtb = setup.boot_regs.x0;
    let start = dtb - 0x2000;
    assert_eq!(read(&ram, start, archive.len()), archive);
    let blob = read(&ram, dtb, 2 * MIB as usize);
    let tree = Fdt::new(&blob).unwrap();
    let chosen = tree.find_node("/chosen").unwrap();
    assert_eq!(
        chosen.property("linux,initrd-start").unwrap().value,
        start.to_be_bytes()
    );
    assert_eq!(
        chosen.property("linux,initrd-end").unwrap().value,
        (start + 5000).to_be_bytes()
    );
}

#[test]
fn refuses_ram_the_image_and_the_device_tree_do_not_both_fit() {
    // 4 MiB of RAM: the device tree takes the upper 2 MiB, where the kernel's
    // 3 MiB would run.
    let kernel = TempFile::new("Image-large", &image(3 * MIB));
    let config = config(4, &kernel, None);
    let ram = GuestRam::new(&ram_ranges(config.memory_mib)).unwrap();

    let error = prepare(&ram, &config).unwrap_err();

    let Error::WriteBootData { what, source } = &error else {
        panic!("{error:?}");
    };
    assert_eq!(*what, "device tree");
    assert_eq!(source.kind(), ErrorKind::InvalidInput);
}

#[test]
fn refuses_an_initramfs_that_reaches_down_into_the_kernel() {
    // 4 MiB of RAM: the kernel claims the first MiB and the device tree the
    // last 2, so a 1.5 MiB archive below the tree would overlap the kernel.
    let kernel = TempFile::new("Image-crowded", &image(MIB));
    let initramfs = TempFile::new("initramfs-large", &vec![0; 3 * MIB as usize / 2]);
    let config = config(4, &kernel, Some(&initramfs));
    let ram = GuestRam::new(&ram_ranges(config.memory_mib)).unwrap();

    let error = prepare(&ram, &config).unwrap_err();

    let Error::LoadInitramfs { path, source } = &error else {
        panic!("{error:?}");
    };
    assert_eq!(path, initramfs.path());
    assert_eq!(source.kind(), ErrorKind::InvalidInput);
}

#[test]
fn names_the_kernel_it_cannot_load() {
    let kernel = TempFile::new("not-an-Image", b"MZ, but not an arm64 Image");
    let config = config(64, &kernel, None);
    let ram = GuestRam::new(&ram_ranges(config.memory_mib)).unwrap();

    let error = prepare(&ram, &config).unwrap_err();

    assert!(
        matches!(&error, Error::LoadKernel { path, .. } if path == kernel.path()),
        "{error:?}"
    );
}
