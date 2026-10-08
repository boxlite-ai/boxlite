// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM skeleton with VM and vCPU entry points, plus x86_64 ELF kernel
//! loading. The entry points are placeholders that panic if called.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "Vm::new does not load the kernel yet.")
)]
mod boot;
mod bus;
mod config;
mod error;
mod irq;
mod memory;
#[expect(dead_code, reason = "vCPU workers are not wired yet.")]
mod vcpu;
#[expect(dead_code, reason = "The native engine adapter is not wired yet.")]
mod vm;
