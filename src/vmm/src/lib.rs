// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM: guest machine, memory layout, and device model.
//! The VM lifecycle entry points are still placeholders that panic if called;
//! the address buses, interrupt routing, and x86_64 legacy devices are
//! implemented.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

pub mod bus;
mod config;
#[cfg(target_arch = "x86_64")]
pub mod devices;
pub mod error;
pub mod irq;
mod memory;
#[expect(dead_code, reason = "vCPU workers are not wired yet.")]
mod vcpu;
#[expect(dead_code, reason = "The native engine adapter is not wired yet.")]
mod vm;
