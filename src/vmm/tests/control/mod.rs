// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! ID routing through VM construction, real block devices and worker events.

use std::{cell::Cell, fs::File, io, time::Duration};

use boxlite_hypervisor::VcpuExit;

use super::{BootRegisters, Vm};
use crate::{
    DiskConfig, DiskFormat, VmConfig,
    error::Error,
    mock_vm::MockVm,
    virtio::{blk, mmio::Slots},
};

const IMAGE_BYTES: u64 = 1 << 20;
const BASE: u64 = 0xd000_0000;
const TIMEOUT: Duration = Duration::from_secs(5);

fn config(disks: Vec<DiskConfig>) -> VmConfig {
    VmConfig {
        vcpu_count: 1,
        memory_mib: 2,
        kernel: "unused".into(),
        cmdline: String::new(),
        initramfs: None,
        disks,
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
        hotplug_mib: 0,
    }
}

fn disk(id: &str, path: std::path::PathBuf) -> DiskConfig {
    DiskConfig {
        block_id: id.into(),
        path,
        format: DiskFormat::Raw,
        read_only: false,
    }
}

fn write(vm: &Vm<MockVm>, base: u64, offset: u64, value: u32) {
    assert!(
        vm.chipset
            .as_ref()
            .unwrap()
            .dispatch(VcpuExit::MmioWrite {
                guest_addr: base + offset,
                bytes: &value.to_le_bytes(),
            })
            .is_none()
    );
}

fn read(vm: &Vm<MockVm>, base: u64, offset: u64) -> u32 {
    let mut bytes = [0; 4];
    assert!(
        vm.chipset
            .as_ref()
            .unwrap()
            .dispatch(VcpuExit::MmioRead {
                guest_addr: base + offset,
                bytes: &mut bytes,
            })
            .is_none()
    );
    u32::from_le_bytes(bytes)
}

fn activate(vm: &Vm<MockVm>, index: usize) {
    let base = BASE + index as u64 * 0x1000;
    let queue_base = 0x10000 * (index as u32 + 1);
    // Negotiate VERSION_1 and install an empty queue in zeroed guest RAM.
    for (offset, value) in [
        (0x070, 1),
        (0x070, 3),
        (0x024, 1),
        (0x020, 1),
        (0x070, 0xb),
        (0x030, 0),
        (0x038, 16),
        (0x080, queue_base),
        (0x090, queue_base + 0x1000),
        (0x0a0, queue_base + 0x2000),
        (0x044, 1),
        (0x070, 0xf),
    ] {
        write(vm, base, offset, value);
    }
    assert_eq!(read(vm, base, 0x070), 0xf);
}

#[test]
fn block_id_routes_growth_independently_of_disk_order() {
    for ids in [["archive", "data"], ["data", "archive"]] {
        let dir = tempfile::tempdir().unwrap();
        let disks: Vec<_> = ids
            .iter()
            .map(|id| {
                let path = dir.path().join(format!("{id}.raw"));
                File::create(&path).unwrap().set_len(IMAGE_BYTES).unwrap();
                disk(id, path)
            })
            .collect();
        let vm = Vm::with_devices(
            config(disks.clone()),
            || Ok(MockVm::new()),
            |_, _| Ok(BootRegisters::default()),
            |chipset, mut ctx, config, _| {
                let mut slots = Slots::new();
                for (index, disk) in config.disks.iter().enumerate() {
                    blk::add_disk(chipset, &mut ctx, disk, index, slots.take()?)?;
                }
                Ok(None)
            },
        )
        .unwrap();
        for index in 0..2 {
            activate(&vm, index);
        }
        let control = vm.control();
        assert_eq!(
            control
                .resize_disk("missing", 2 * IMAGE_BYTES, TIMEOUT)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            control
                .resize_disk("data", 2 * IMAGE_BYTES, TIMEOUT)
                .unwrap(),
            2 * IMAGE_BYTES
        );
        for (index, disk) in disks.iter().enumerate() {
            let target = disk.block_id == "data";
            let expected = if target { 2 * IMAGE_BYTES } else { IMAGE_BYTES };
            assert_eq!(std::fs::metadata(&disk.path).unwrap().len(), expected);
            let base = BASE + index as u64 * 0x1000;
            assert_eq!(u64::from(read(&vm, base, 0x100)), expected / 512);
            assert_eq!(read(&vm, base, 0x104), 0);
            assert_eq!(read(&vm, base, 0x0fc), u32::from(target));
        }
        assert_eq!(
            control
                .clone()
                .resize_disk("data", 2 * IMAGE_BYTES, TIMEOUT)
                .unwrap(),
            2 * IMAGE_BYTES
        );
        drop(vm);
        assert_eq!(
            control
                .resize_disk("data", 3 * IMAGE_BYTES, TIMEOUT)
                .unwrap_err()
                .kind(),
            io::ErrorKind::BrokenPipe
        );
    }
}

#[test]
fn invalid_block_ids_fail_before_host_creation() {
    for ids in [vec![""], vec!["same", "same"]] {
        let called = Cell::new(false);
        let result = Vm::with_backend(
            config(ids.iter().map(|id| disk(id, "unused".into())).collect()),
            || {
                called.set(true);
                Ok(MockVm::new())
            },
            |_, _| Ok(BootRegisters::default()),
            |_, _| Ok(()),
        );
        let error = result.unwrap_err();
        assert!(matches!(&error, Error::InvalidDiskId(id) if id == ids[0]));
        assert!(error.to_string().contains(ids[0]));
        assert!(!called.get());
    }
}
