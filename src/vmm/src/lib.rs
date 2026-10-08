// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM skeleton with VM and vCPU entry points. The machine
//! configuration is validated and guest RAM allocated here; the entry points
//! are placeholders that panic if called.
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
