// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The VM contract every backend implements.

use crate::{MemoryRegion, Result, Vcpu};

/// A VM on the host hypervisor.
///
/// Each backend's constructor creates the VM and the host's interrupt
/// controller, since creation differs per host. HVF and KVM provide the whole
/// controller in-kernel; WHP (M10) provides only local APICs. Callers create
/// every vCPU before running any: KVM on arm64 initialises its interrupt
/// controller only once all vCPUs exist.
pub trait Vm: Send + Sync {
    /// The backend's vCPU type.
    type Vcpu: Vcpu;

    /// Maps host memory into the guest physical address space.
    ///
    /// # Safety
    ///
    /// The host range must stay mapped, and back nothing but this guest
    /// region, until both conditions hold:
    ///
    /// - [`unmap_memory`](Self::unmap_memory) for this region succeeds, or the
    ///   VM and every vCPU created from it are dropped.
    /// - Every host-side user has stopped accessing the range, including
    ///   device workers and in-flight host I/O.
    ///
    /// A failed unmap can leave the guest mapping in place, and on KVM a live
    /// vCPU keeps the VM's memory mappings alive.
    ///
    /// The guest can change the range at any time. Use guest-memory access
    /// primitives that preserve Rust's aliasing rules, not ordinary Rust
    /// references into guest-accessible memory. Conflicting host-side accesses
    /// require synchronization or atomic operations. Guest-shared protocols
    /// such as virtqueues require their specified atomicity and memory
    /// ordering; a host mutex does not synchronize with the guest. Raw pointers
    /// and volatile accesses alone do not provide these guarantees.
    unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()>;

    /// Removes a region added with [`map_memory`](Self::map_memory).
    fn unmap_memory(&self, region: &MemoryRegion) -> Result<()>;

    /// Creates vCPU `id`, bound to the calling thread.
    ///
    /// Call it on the thread that will run the vCPU: HVF rejects vCPU calls
    /// from any other thread.
    fn create_vcpu(&self, id: u32) -> Result<Self::Vcpu>;

    /// Sets interrupt `line` to `level`, from any thread.
    ///
    /// `line` is a GIC SPI INTID (32 and up) on arm64 and a GSI on x86_64. An
    /// edge-triggered interrupt is a set followed by a clear.
    fn set_irq_line(&self, line: u32, level: bool) -> Result<()>;
}
