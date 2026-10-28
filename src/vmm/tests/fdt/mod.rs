// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The device tree as Linux reads it: each blob is parsed back and checked
//! against the bindings in `Documentation/devicetree/bindings/`.

use std::collections::BTreeMap;

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

/// One node of a parsed device tree.
#[derive(Debug, Default)]
struct Node {
    name: String,
    properties: BTreeMap<String, Vec<u8>>,
    children: Vec<Node>,
}

impl Node {
    fn child(&self, name: &str) -> &Node {
        self.children
            .iter()
            .find(|child| child.name == name)
            .unwrap_or_else(|| panic!("no node {name} under {:?}", self.name))
    }

    fn property(&self, name: &str) -> &[u8] {
        self.properties
            .get(name)
            .unwrap_or_else(|| panic!("no property {name} in {:?}", self.name))
    }

    fn has(&self, name: &str) -> bool {
        self.properties.contains_key(name)
    }

    fn u32s(&self, name: &str) -> Vec<u32> {
        self.property(name)
            .chunks(4)
            .map(|cell| u32::from_be_bytes(cell.try_into().unwrap()))
            .collect()
    }

    fn u64s(&self, name: &str) -> Vec<u64> {
        self.property(name)
            .chunks(8)
            .map(|cells| u64::from_be_bytes(cells.try_into().unwrap()))
            .collect()
    }

    fn strings(&self, name: &str) -> Vec<&str> {
        let value = self.property(name);
        let value = value.strip_suffix(&[0]).expect("NUL-terminated");
        value
            .split(|&byte| byte == 0)
            .map(|string| std::str::from_utf8(string).unwrap())
            .collect()
    }
}

/// Parses a flattened device tree (the devicetree specification, chapter 5).
fn parse(blob: &[u8]) -> Node {
    let word = |offset: usize| u32::from_be_bytes(blob[offset..offset + 4].try_into().unwrap());
    assert_eq!(word(0), 0xd00d_feed, "magic");
    assert_eq!(word(4) as usize, blob.len(), "totalsize");
    let (structure, strings) = (word(8) as usize, word(12) as usize);
    let c_string = |start: usize| {
        let len = blob[start..].iter().position(|&byte| byte == 0).unwrap();
        String::from_utf8(blob[start..start + len].to_vec()).unwrap()
    };
    let mut stack: Vec<Node> = Vec::new();
    let mut at = structure;
    loop {
        let token = word(at);
        at += 4;
        match token {
            1 => {
                let name = c_string(at);
                at = (at + name.len() + 1).next_multiple_of(4);
                stack.push(Node {
                    name,
                    ..Node::default()
                });
            }
            2 => {
                let node = stack.pop().expect("an open node");
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => return node,
                }
            }
            3 => {
                let (len, name) = (word(at) as usize, word(at + 4) as usize);
                let value = blob[at + 8..at + 8 + len].to_vec();
                at = (at + 8 + len).next_multiple_of(4);
                let node = stack.last_mut().expect("a property outside a node");
                node.properties.insert(c_string(strings + name), value);
            }
            4 => {}
            other => panic!("token {other} at {:#x}", at - 4),
        }
    }
}

/// The node whose `compatible` lists `compatible`.
fn compatible<'a>(root: &'a Node, compatible: &str) -> &'a Node {
    root.children
        .iter()
        .find(|node| node.has("compatible") && node.strings("compatible").contains(&compatible))
        .unwrap_or_else(|| panic!("no node compatible with {compatible}"))
}

#[test]
fn describes_each_vcpu_by_its_mpidr_started_with_psci_over_hvc() {
    let root = parse(&device_tree(&config(20, 64), None).unwrap());

    let cpus = root.child("cpus");
    assert_eq!(cpus.u32s("#address-cells"), [1]);
    assert_eq!(cpus.u32s("#size-cells"), [0]);
    let mut described = Vec::new();
    for cpu in &cpus.children {
        assert_eq!(cpu.strings("device_type"), ["cpu"], "{}", cpu.name);
        assert_eq!(cpu.strings("compatible"), ["arm,arm-v8"], "{}", cpu.name);
        assert_eq!(cpu.strings("enable-method"), ["psci"], "{}", cpu.name);
        let [mpidr] = cpu.u32s("reg")[..] else {
            panic!("{} has one reg cell", cpu.name);
        };
        assert_eq!(cpu.name, format!("cpu@{mpidr:x}"));
        described.push(mpidr);
    }
    // Linux finds the boot CPU's node by MPIDR, as KVM and QEMU lay them out:
    // 16 per Aff1 cluster.
    let expected: Vec<u32> = (0..20).map(|id| (id % 16) | ((id / 16) << 8)).collect();
    assert_eq!(described, expected);

    let psci = root.child("psci");
    assert_eq!(psci.strings("compatible"), ["arm,psci-0.2"]);
    assert_eq!(psci.strings("method"), ["hvc"]);
}

#[test]
fn describes_ram_and_the_command_line() {
    let root = parse(&device_tree(&config(1, 64), None).unwrap());

    assert_eq!(root.name, "");
    assert_eq!(root.strings("compatible"), ["linux,dummy-virt"]);
    assert_eq!(root.u32s("#address-cells"), [2]);
    assert_eq!(root.u32s("#size-cells"), [2]);
    let memory = root.child("memory@80000000");
    assert_eq!(memory.strings("device_type"), ["memory"]);
    assert_eq!(memory.u64s("reg"), [RAM_START, 64 << 20]);
    let chosen = root.child("chosen");
    assert_eq!(chosen.strings("bootargs"), [CMDLINE]);
    assert_eq!(chosen.strings("stdout-path"), ["/pl011@40002000"]);
    assert!(!chosen.has("linux,initrd-start"));
    assert!(!chosen.has("linux,initrd-end"));
}

#[test]
fn names_the_initramfs_with_an_exclusive_end() {
    let start = RAM_START + (40 << 20);
    let root = parse(&device_tree(&config(1, 64), Some((GuestAddress(start), 5000))).unwrap());

    let chosen = root.child("chosen");
    assert_eq!(chosen.u64s("linux,initrd-start"), [start]);
    assert_eq!(chosen.u64s("linux,initrd-end"), [start + 5000]);
}

#[test]
fn routes_the_timer_and_the_pl011_through_the_gic() {
    let vcpus = 4;
    let root = parse(&device_tree(&config(vcpus, 64), None).unwrap());

    let gic = compatible(&root, "arm,gic-v3");
    assert_eq!(gic.name, "intc@3fff0000");
    assert!(gic.has("interrupt-controller"));
    assert_eq!(gic.u32s("#interrupt-cells"), [3]);
    // The distributor, then one 128 KiB redistributor per vCPU.
    assert_eq!(
        gic.u64s("reg"),
        [
            GICD_BASE,
            GICD_SIZE,
            GICR_BASE,
            u64::from(vcpus) * GICR_FRAME_SIZE
        ]
    );
    assert_eq!(root.u32s("interrupt-parent"), gic.u32s("phandle"));

    // Secure and non-secure physical, virtual and hypervisor timers: PPIs 13,
    // 14, 11 and 10, level-high, as QEMU and Firecracker describe them.
    let timer = compatible(&root, "arm,armv8-timer");
    assert_eq!(
        timer.u32s("interrupts"),
        [1, 13, 4, 1, 14, 4, 1, 11, 4, 1, 10, 4]
    );
    assert!(timer.has("always-on"));

    let clock = compatible(&root, "fixed-clock");
    assert_eq!(clock.u32s("#clock-cells"), [0]);
    assert_eq!(clock.u32s("clock-frequency"), [24_000_000]);

    let uart = root.child("pl011@40002000");
    assert_eq!(uart.strings("compatible"), ["arm,pl011", "arm,primecell"]);
    assert_eq!(uart.u64s("reg"), [PL011_BASE, PL011_SIZE]);
    assert_eq!(uart.u32s("interrupts"), [0, PL011_SPI - 32, 4]);
    // The AMBA bus needs `apb_pclk` and the driver one more clock, so the one
    // fixed clock serves both names.
    let clock_phandle = clock.u32s("phandle")[0];
    assert_eq!(uart.u32s("clocks"), [clock_phandle, clock_phandle]);
    assert_eq!(uart.strings("clock-names"), ["uartclk", "apb_pclk"]);
}
