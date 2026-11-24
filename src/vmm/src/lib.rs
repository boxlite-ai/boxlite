// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! BoxLite's native VMM. [`Vm::new`] validates a [`VmConfig`], creates the
//! host VM, registers guest RAM and loads the kernel; [`Vm::run`] runs every
//! vCPU until the guest powers off or resets, or a [`VmControl`] stops it.
//!
//! The VMM owns the guest machine and delegates host operations to
//! `boxlite-hypervisor`. BoxLite runtime integration belongs in its engine adapter.

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod boot;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Only tests use part of this API, and only Linux x86_64 adds devices yet."
    )
)]
mod bus;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Only tests use part of this API, and only Linux x86_64 adds devices yet."
    )
)]
mod chipset;
mod config;
mod control;
#[cfg(target_arch = "x86_64")]
mod cpu_features;
#[cfg_attr(
    not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
    expect(dead_code, reason = "Only the Linux x86_64 Vm::new adds devices yet.")
)]
mod devices;
mod error;
#[cfg_attr(
    not(all(target_arch = "x86_64", any(test, target_os = "linux"))),
    expect(
        dead_code,
        reason = "Only x86_64 runs vCPUs, and only Linux builds a VM yet."
    )
)]
mod events;
#[cfg_attr(
    not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
    expect(dead_code, reason = "Only the Linux x86_64 Vm::new adds devices yet.")
)]
mod hotplug;
#[cfg_attr(
    not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
    expect(dead_code, reason = "Only Linux x86_64 adds devices yet.")
)]
mod irq;
pub(crate) mod lifecycle;
mod memory;
#[cfg(any(test, target_arch = "x86_64"))]
mod vcpu;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "The snapshot parts of the contract have no production device yet, and only Linux x86_64 adds the block device."
    )
)]
mod virtio;
#[cfg_attr(
    not(all(target_arch = "x86_64", any(test, target_os = "linux"))),
    expect(
        dead_code,
        reason = "Only x86_64 runs a VM, and only Linux builds one yet."
    )
)]
mod vm;
#[cfg_attr(
    not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
    expect(dead_code, reason = "Only Linux x86_64 boots guests yet.")
)]
mod x86_boot_layout;

pub use chipset::{BusKind, Conflict};
pub use config::{
    DiskConfig, DiskFormat, FsConfig, FsShareConfig, NetConfig, VmConfig, VsockConfig,
};
pub use control::VmControl;
pub use devices::mem::MemoryStatus;
pub use error::{ControlReason, Error, Result};
pub use lifecycle::VmStatus;
pub use memory::ReclaimPolicy;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use virtio::fs::{AggregateFs, Share, insert_aggregate, lookup_aggregate};
pub use vm::{StopHandle, Vm, VmExit};

/// A recording hypervisor backend shared by the crate's unit tests. Test
/// files live in `tests/<name>/mod.rs`: a subdirectory keeps Cargo from
/// compiling them as integration tests, and the `tests` directory keeps them
/// out of the counted sources and the coverage denominator.
#[cfg(test)]
#[cfg_attr(
    not(target_arch = "x86_64"),
    expect(dead_code, reason = "Only x86_64 runs scripted vCPUs yet.")
)]
#[path = "../tests/mock_vm/mod.rs"]
mod mock_vm;

/// A flat 32-bit guest on a KVM vCPU, shared by the KVM tests that drive the
/// buses without a kernel.
#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
#[path = "../tests/flat_guest/mod.rs"]
mod flat_guest;
