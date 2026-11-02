// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The device tree as Linux reads it: each blob is parsed back and checked
//! against the bindings in `Documentation/devicetree/bindings/`.

use fdt::{Fdt, node::FdtNode};
use vm_memory::GuestAddress;

use super::device_tree;
use crate::{
    config::VmConfig,
    devices::arm64::{
        GICD_BASE, GICD_SIZE, GICR_BASE, GICR_FRAME_SIZE, PL011_BASE, PL011_SIZE, PL011_SPI,
    },
    memory::RAM_START,
};

const CMDLINE: &str = "console=ttyAMA0 earlycon panic=-1";

fn config(vcpu_count: u8, memory_mib: u32) -> VmConfig {
    VmConfig {
        vcpu_count,
        memory_mib,
        kernel: "Image".into(),
        cmdline: CMDLINE.into(),
        initramfs: None,
    }
}

fn u32s(node: FdtNode<'_, '_>, name: &str) -> Vec<u32> {
    node.property(name)
        .unwrap()
        .value
        .chunks(4)
        .map(|cell| u32::from_be_bytes(cell.try_into().unwrap()))
        .collect()
}

fn u64s(node: FdtNode<'_, '_>, name: &str) -> Vec<u64> {
    node.property(name)
        .unwrap()
        .value
        .chunks(8)
        .map(|cells| u64::from_be_bytes(cells.try_into().unwrap()))
        .collect()
}

fn strings<'a>(node: FdtNode<'_, 'a>, name: &str) -> Vec<&'a str> {
    let value = node.property(name).unwrap().value;
    let value = value.strip_suffix(&[0]).expect("NUL-terminated");
    value
        .split(|&byte| byte == 0)
        .map(|string| std::str::from_utf8(string).unwrap())
        .collect()
}

fn parse(blob: &[u8]) -> Fdt<'_> {
    let tree = Fdt::new(blob).unwrap();
    assert_eq!(tree.total_size(), blob.len(), "totalsize");
    tree
}

#[test]
fn describes_each_vcpu_by_its_mpidr_started_with_psci_over_hvc() {
    let blob = device_tree(&config(20, 64), None).unwrap();
    let tree = parse(&blob);

    let cpus = tree.find_node("/cpus").unwrap();
    assert_eq!(u32s(cpus, "#address-cells"), [1]);
    assert_eq!(u32s(cpus, "#size-cells"), [0]);
    let mut described = Vec::new();
    for cpu in cpus.children() {
        assert_eq!(strings(cpu, "device_type"), ["cpu"], "{}", cpu.name);
        assert_eq!(strings(cpu, "compatible"), ["arm,arm-v8"], "{}", cpu.name);
        assert_eq!(strings(cpu, "enable-method"), ["psci"], "{}", cpu.name);
        let [mpidr] = u32s(cpu, "reg")[..] else {
            panic!("{} has one reg cell", cpu.name);
        };
        assert_eq!(cpu.name, format!("cpu@{mpidr:x}"));
        described.push(mpidr);
    }
    // Linux finds the boot CPU's node by MPIDR, as KVM and QEMU lay them out:
    // 16 per Aff1 cluster.
    let expected: Vec<u32> = (0..20).map(|id| (id % 16) | ((id / 16) << 8)).collect();
    assert_eq!(described, expected);

    let psci = tree.find_node("/psci").unwrap();
    assert_eq!(strings(psci, "compatible"), ["arm,psci-0.2"]);
    assert_eq!(strings(psci, "method"), ["hvc"]);
}

#[test]
fn describes_ram_and_the_command_line() {
    let blob = device_tree(&config(1, 64), None).unwrap();
    let tree = parse(&blob);

    let root = tree.find_node("/").unwrap();
    assert_eq!(root.name, "");
    assert_eq!(strings(root, "compatible"), ["linux,dummy-virt"]);
    assert_eq!(u32s(root, "#address-cells"), [2]);
    assert_eq!(u32s(root, "#size-cells"), [2]);
    let memory = tree.find_node("/memory@80000000").unwrap();
    assert_eq!(strings(memory, "device_type"), ["memory"]);
    assert_eq!(u64s(memory, "reg"), [RAM_START, 64 << 20]);
    let chosen = tree.find_node("/chosen").unwrap();
    assert_eq!(strings(chosen, "bootargs"), [CMDLINE]);
    assert_eq!(strings(chosen, "stdout-path"), ["/pl011@40002000"]);
    assert!(chosen.property("linux,initrd-start").is_none());
    assert!(chosen.property("linux,initrd-end").is_none());
}

#[test]
fn names_the_initramfs_with_an_exclusive_end() {
    let start = RAM_START + (40 << 20);
    let blob = device_tree(&config(1, 64), Some((GuestAddress(start), 5000))).unwrap();
    let tree = parse(&blob);

    let chosen = tree.find_node("/chosen").unwrap();
    assert_eq!(u64s(chosen, "linux,initrd-start"), [start]);
    assert_eq!(u64s(chosen, "linux,initrd-end"), [start + 5000]);
}

#[test]
fn routes_the_timer_and_the_pl011_through_the_gic() {
    let vcpus = 4;
    let blob = device_tree(&config(vcpus, 64), None).unwrap();
    let tree = parse(&blob);
    let root = tree.find_node("/").unwrap();

    let gic = tree.find_compatible(&["arm,gic-v3"]).unwrap();
    assert_eq!(gic.name, "intc@3fff0000");
    assert!(gic.property("interrupt-controller").is_some());
    assert_eq!(u32s(gic, "#interrupt-cells"), [3]);
    // The distributor, then one 128 KiB redistributor per vCPU.
    assert_eq!(
        u64s(gic, "reg"),
        [
            GICD_BASE,
            GICD_SIZE,
            GICR_BASE,
            u64::from(vcpus) * GICR_FRAME_SIZE
        ]
    );
    assert_eq!(u32s(root, "interrupt-parent"), u32s(gic, "phandle"));

    // Secure and non-secure physical, virtual and hypervisor timers: PPIs 13,
    // 14, 11 and 10, level-high, as QEMU and Firecracker describe them.
    let timer = tree.find_compatible(&["arm,armv8-timer"]).unwrap();
    assert_eq!(
        u32s(timer, "interrupts"),
        [1, 13, 4, 1, 14, 4, 1, 11, 4, 1, 10, 4]
    );
    assert!(timer.property("always-on").is_some());

    let clock = tree.find_compatible(&["fixed-clock"]).unwrap();
    assert_eq!(u32s(clock, "#clock-cells"), [0]);
    assert_eq!(u32s(clock, "clock-frequency"), [24_000_000]);

    let uart = tree.find_node("/pl011@40002000").unwrap();
    assert_eq!(strings(uart, "compatible"), ["arm,pl011", "arm,primecell"]);
    assert_eq!(u64s(uart, "reg"), [PL011_BASE, PL011_SIZE]);
    assert_eq!(u32s(uart, "interrupts"), [0, PL011_SPI - 32, 4]);
    // The AMBA bus needs `apb_pclk` and the driver one more clock, so the one
    // fixed clock serves both names.
    let clock_phandle = u32s(clock, "phandle")[0];
    assert_eq!(u32s(uart, "clocks"), [clock_phandle, clock_phandle]);
    assert_eq!(strings(uart, "clock-names"), ["uartclk", "apb_pclk"]);
}
