// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM skeleton with type-checked VM and vCPU loops.
//! Backend, device, and worker operations are placeholders that panic if called.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

mod bus;
mod config;
mod error;
mod irq;
mod memory;
#[expect(dead_code, reason = "Worker wiring follows the loop skeleton.")]
mod vcpu;
#[expect(dead_code, reason = "The native engine adapter is not wired yet.")]
mod vm;
