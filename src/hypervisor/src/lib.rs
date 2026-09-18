//! Host hypervisor backend skeleton. No VM operations are implemented yet.
//!
//! This crate owns host-specific mechanisms; `boxlite-vmm` owns the guest
//! machine configuration, memory backing, execution policy, and devices.

mod error;
mod exit;
mod memory;
mod vcpu;
mod vm;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod hvf;

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod kvm;
