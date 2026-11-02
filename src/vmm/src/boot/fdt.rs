// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The device tree that describes the arm64 machine to Linux: the vCPUs and
//! how PSCI starts them, RAM, the command line and initramfs, the GICv3, the
//! architected timer, and the PL011 with the clock it needs. The nodes follow
//! Firecracker's, with the PL011 in place of its `ns16550a`, and the bindings
//! in Linux's `Documentation/devicetree/bindings/`.

use std::io;

use vm_fdt::FdtWriter;
use vm_memory::GuestAddress;

use crate::{
    config::VmConfig,
    devices::arm64::{
        GICD_BASE, GICD_SIZE, GICR_BASE, GICR_FRAME_SIZE, PL011_BASE, PL011_SIZE, PL011_SPI,
    },
    memory::RAM_START,
    vcpu::mpidr,
};

/// The phandles that name the GIC and the PL011's clock.
const GIC_PHANDLE: u32 = 1;
const CLOCK_PHANDLE: u32 = 2;
/// The first `interrupts` cell, and the flag the third carries
/// (`interrupt-controller/arm,gic-v3.yaml`).
const SPI: u32 = 0;
const PPI: u32 = 1;
const LEVEL_HIGH: u32 = 4;
/// The architected timer's PPIs, as INTIDs minus 16: the secure and
/// non-secure physical, virtual and hypervisor timers.
const TIMER_PPIS: [u32; 4] = [13, 14, 11, 10];
/// The fixed clock behind the PL011, at the rate QEMU and Firecracker give it.
const CLOCK_HZ: u32 = 24_000_000;

/// Builds the device tree blob for `config`, with the initramfs at
/// `initramfs`, a start and a size, when there is one.
pub(crate) fn device_tree(
    config: &VmConfig,
    initramfs: Option<(GuestAddress, usize)>,
) -> io::Result<Vec<u8>> {
    write_tree(config, initramfs).map_err(io::Error::other)
}

fn write_tree(
    config: &VmConfig,
    initramfs: Option<(GuestAddress, usize)>,
) -> vm_fdt::FdtWriterResult<Vec<u8>> {
    let mut fdt = FdtWriter::new()?;
    let root = fdt.begin_node("")?;
    fdt.property_string("compatible", "linux,dummy-virt")?;
    fdt.property_u32("#address-cells", 2)?;
    fdt.property_u32("#size-cells", 2)?;
    fdt.property_u32("interrupt-parent", GIC_PHANDLE)?;

    let cpus = fdt.begin_node("cpus")?;
    fdt.property_u32("#address-cells", 1)?;
    fdt.property_u32("#size-cells", 0)?;
    for id in 0..config.vcpu_count {
        // Linux finds each CPU, and the target of each CPU_ON, by this MPIDR.
        let reg = u32::try_from(mpidr(id)).expect("Aff0 and Aff1 fit 32 bits");
        let cpu = fdt.begin_node(&format!("cpu@{reg:x}"))?;
        fdt.property_string("device_type", "cpu")?;
        fdt.property_string("compatible", "arm,arm-v8")?;
        fdt.property_string("enable-method", "psci")?;
        fdt.property_u32("reg", reg)?;
        fdt.end_node(cpu)?;
    }
    fdt.end_node(cpus)?;

    let memory = fdt.begin_node(&format!("memory@{RAM_START:x}"))?;
    fdt.property_string("device_type", "memory")?;
    fdt.property_array_u64("reg", &[RAM_START, u64::from(config.memory_mib) << 20])?;
    fdt.end_node(memory)?;

    let chosen = fdt.begin_node("chosen")?;
    fdt.property_string("bootargs", &config.cmdline)?;
    fdt.property_string("stdout-path", &format!("/pl011@{PL011_BASE:x}"))?;
    if let Some((start, size)) = initramfs {
        fdt.property_u64("linux,initrd-start", start.0)?;
        // The end is exclusive (`chosen.yaml` in dt-schema).
        fdt.property_u64("linux,initrd-end", start.0 + size as u64)?;
    }
    fdt.end_node(chosen)?;

    let psci = fdt.begin_node("psci")?;
    fdt.property_string("compatible", "arm,psci-0.2")?;
    fdt.property_string("method", "hvc")?;
    fdt.end_node(psci)?;

    let gic = fdt.begin_node(&format!("intc@{GICD_BASE:x}"))?;
    fdt.property_string("compatible", "arm,gic-v3")?;
    fdt.property_null("interrupt-controller")?;
    fdt.property_u32("#interrupt-cells", 3)?;
    // The distributor, then one redistributor frame per vCPU.
    let redistributors = u64::from(config.vcpu_count) * GICR_FRAME_SIZE;
    fdt.property_array_u64("reg", &[GICD_BASE, GICD_SIZE, GICR_BASE, redistributors])?;
    fdt.property_phandle(GIC_PHANDLE)?;
    fdt.end_node(gic)?;

    let timer = fdt.begin_node("timer")?;
    fdt.property_string("compatible", "arm,armv8-timer")?;
    let interrupts: Vec<u32> = TIMER_PPIS
        .iter()
        .flat_map(|&ppi| [PPI, ppi, LEVEL_HIGH])
        .collect();
    fdt.property_array_u32("interrupts", &interrupts)?;
    fdt.property_null("always-on")?;
    fdt.end_node(timer)?;

    let clock = fdt.begin_node("apb-pclk")?;
    fdt.property_string("compatible", "fixed-clock")?;
    fdt.property_u32("#clock-cells", 0)?;
    fdt.property_u32("clock-frequency", CLOCK_HZ)?;
    fdt.property_phandle(CLOCK_PHANDLE)?;
    fdt.end_node(clock)?;

    let uart = fdt.begin_node(&format!("pl011@{PL011_BASE:x}"))?;
    fdt.property_string_list(
        "compatible",
        vec!["arm,pl011".into(), "arm,primecell".into()],
    )?;
    fdt.property_array_u64("reg", &[PL011_BASE, PL011_SIZE])?;
    fdt.property_array_u32("interrupts", &[SPI, PL011_SPI - 32, LEVEL_HIGH])?;
    // The AMBA bus probes only with `apb_pclk`, and the driver needs a
    // second clock, so the one fixed clock serves both names.
    fdt.property_array_u32("clocks", &[CLOCK_PHANDLE, CLOCK_PHANDLE])?;
    fdt.property_string_list("clock-names", vec!["uartclk".into(), "apb_pclk".into()])?;
    fdt.end_node(uart)?;

    fdt.end_node(root)?;
    fdt.finish()
}

#[cfg(test)]
#[path = "../../tests/fdt/mod.rs"]
mod tests;
