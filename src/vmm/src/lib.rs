// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM with x86_64 ELF loading and placeholder VM/vCPU lifecycle entry points.
//! The lifecycle entry points still panic if called.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

mod bus;
mod config;
mod error;
mod irq;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "VM construction is not wired to kernel loading yet."
    )
)]
mod memory;
#[expect(dead_code, reason = "vCPU workers are not wired yet.")]
mod vcpu;
#[expect(dead_code, reason = "The native engine adapter is not wired yet.")]
mod vm;
