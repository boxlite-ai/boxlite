// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native VMM skeleton. No VM lifecycle or device operations are implemented yet.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

mod bus;
mod config;
mod error;
mod irq;
mod memory;
mod vcpu;
mod vm;
