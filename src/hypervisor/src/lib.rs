// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Host hypervisor backends. The [`Vm`] and [`Vcpu`] traits are the contract
//! every backend implements. KVM x86_64 currently provides VM creation and
//! memory registration; vCPU execution, HVF and WHP are not implemented yet.
//!
//! This crate owns host-specific mechanisms; `boxlite-vmm` owns the guest
//! machine configuration, memory backing, execution policy, and devices.
//!
//! Backends are selected at compile time rather than dispatched at run time,
//! since no host has more than one of HVF, KVM and WHP.

mod error;
mod exit;
mod memory;
mod vcpu;
mod vm;

pub use error::{Error, Result};
pub use exit::VcpuExit;
pub use memory::MemoryRegion;
pub use vcpu::{Vcpu, VcpuHandle};
pub use vm::Vm;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod hvf;

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod kvm;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use kvm::KvmVm;

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
mod whp;

// The exact complement of the three backend cfgs above: without this, a host with
// no backend builds green into a library that exposes no VM operations.
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ),
    all(target_os = "windows", target_arch = "x86_64"),
)))]
compile_error!(
    "boxlite-hypervisor supports macOS arm64 (HVF), Linux x86_64/arm64 (KVM) and Windows x86_64 (WHP) only"
);
