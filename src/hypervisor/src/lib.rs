// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Host hypervisor backend skeleton. No VM operations are implemented yet.
//!
//! This crate owns host-specific mechanisms; `boxlite-vmm` owns the guest
//! machine configuration, memory backing, execution policy, and devices.
//!
//! Backends are selected at compile time rather than dispatched at run time,
//! since HVF and KVM never coexist on one host.

mod error;
mod exit;
mod memory;
mod vcpu;
mod vm;

pub use exit::VcpuExit;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod hvf;

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod kvm;

// The exact complement of the two backend cfgs above: without this, a host with
// neither backend builds green into a library that exposes no VM operations.
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ),
)))]
compile_error!("boxlite-hypervisor supports macOS arm64 (HVF) and Linux x86_64/arm64 (KVM) only");
