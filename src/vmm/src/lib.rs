// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM skeleton with VM and vCPU entry points, x86_64 boot preparation,
//! the buses, interrupt lines and event loop devices use, and the x86_64
//! legacy devices. `Vm::new` validates the configuration, creates the host VM
//! and registers guest RAM; boot preparation, buses and devices are not wired
//! into it yet. The `run` entry points are placeholders that panic if called.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "Vm::new does not load the kernel yet.")
)]
mod boot;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "vCPU workers do not dispatch exits yet.")
)]
mod bus;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "Only the unwired Vm::new uses it.")
)]
mod config;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "vCPU workers are not wired yet.")
)]
mod cpu_features;
#[cfg(target_arch = "x86_64")]
#[cfg_attr(not(test), expect(dead_code, reason = "No VM registers devices yet."))]
mod devices;
mod error;
#[cfg_attr(not(test), expect(dead_code, reason = "No VM creates devices yet."))]
mod events;
#[cfg_attr(not(test), expect(dead_code, reason = "No VM creates devices yet."))]
mod irq;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "Only the unwired Vm::new uses it.")
)]
mod memory;
#[expect(dead_code, reason = "vCPU workers are not wired yet.")]
mod vcpu;
#[expect(dead_code, reason = "The native engine adapter is not wired yet.")]
mod vm;

/// A recording hypervisor backend shared by the crate's unit tests. Test
/// files live in `tests/<name>/mod.rs`: a subdirectory keeps Cargo from
/// compiling them as integration tests, and the `tests` directory keeps them
/// out of the counted sources and the coverage denominator.
#[cfg(test)]
#[path = "../tests/mock_vm/mod.rs"]
mod mock_vm;
