// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM skeleton with VM and vCPU entry points.
//! `Vm::new` validates the configuration, creates the host VM and registers
//! guest RAM; the `run` entry points are placeholders that panic if called.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

mod bus;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "Only the unwired Vm::new uses it.")
)]
mod config;
mod error;
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
#[path = "../tests/fake_vm/mod.rs"]
mod fake_vm;
