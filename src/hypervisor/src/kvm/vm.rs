// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{io, sync::Mutex};

use kvm_bindings::{KVM_API_VERSION, KVM_PIT_SPEAKER_DUMMY, kvm_pit_config};
use kvm_ioctls::{Cap, Kvm, VmFd};

use super::memory::MemorySlots;
use crate::{Error, MemoryRegion, Result};

/// An x86_64 KVM VM with an in-kernel interrupt controller and timer.
///
/// Memory backing remains owned by the caller, under the same lifetime contract
/// as [`crate::Vm::map_memory`]. Dropping this value closes the VM descriptor.
#[derive(Debug)]
pub struct KvmVm {
    fd: VmFd,
    slots: Mutex<MemorySlots>,
}

impl KvmVm {
    /// Opens `/dev/kvm`, verifies the required API, and creates the empty VM.
    pub fn new() -> Result<Self> {
        Self::create().map_err(Error::CreateVm)
    }

    fn create() -> io::Result<Self> {
        let kvm = Kvm::new().map_err(|error| {
            let source = io::Error::from_raw_os_error(error.errno());
            if matches!(source.raw_os_error(), Some(libc::ENOENT | libc::ENODEV)) {
                io::Error::new(io::ErrorKind::Unsupported, source)
            } else {
                source
            }
        })?;
        let version = kvm.get_api_version();
        if version != KVM_API_VERSION as i32 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!("KVM API version {version}; expected {KVM_API_VERSION}"),
            ));
        }
        for capability in [
            Cap::UserMemory,
            Cap::Irqchip,
            Cap::Pit2,
            Cap::SetTssAddr,
            Cap::ImmediateExit,
        ] {
            if !kvm.check_extension(capability) {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!("KVM capability {capability:?} is unavailable"),
                ));
            }
        }
        // SAFETY: sysconf has no pointer arguments and does not modify memory.
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page_size <= 0 {
            return Err(io::Error::other("cannot determine the host page size"));
        }
        let fd = kvm.create_vm().map_err(io::Error::from)?;
        // Intel KVM reserves three pages below 4 GiB for real-mode emulation.
        // Keep them in the architecture's MMIO hole, outside guest RAM.
        fd.set_tss_address(0xfffb_d000).map_err(io::Error::from)?;
        fd.create_irq_chip().map_err(io::Error::from)?;
        fd.create_pit2(kvm_pit_config {
            flags: KVM_PIT_SPEAKER_DUMMY,
            ..Default::default()
        })
        .map_err(io::Error::from)?;
        Ok(Self {
            fd,
            slots: Mutex::new(MemorySlots::new(kvm.get_nr_memslots(), page_size as usize)),
        })
    }

    /// Registers caller-owned RAM at a guest physical address.
    ///
    /// # Safety
    ///
    /// The caller must uphold [`crate::Vm::map_memory`]'s backing-memory,
    /// aliasing, synchronization and lifetime requirements.
    pub unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        let install = || {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| io::Error::other("KVM memory slot lock is poisoned"))?;
            slots.map(region, |mapping| {
                // SAFETY: the caller guarantees valid backing memory. MemorySlots
                // checks the ranges and retains the slot only after KVM accepts it.
                unsafe { self.fd.set_user_memory_region(mapping) }.map_err(io::Error::from)
            })
        };
        install().map_err(|source| Error::MapMemory {
            guest_addr: region.guest_addr,
            size: region.size,
            source,
        })
    }

    /// Removes exactly the mapping identified by all three region fields.
    /// A failed removal retains the slot and its backing-memory requirements.
    pub fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        let remove = || {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| io::Error::other("KVM memory slot lock is poisoned"))?;
            slots.unmap(region, |mapping| {
                // SAFETY: a zero-sized region deletes the slot; KVM does not
                // dereference the supplied userspace address.
                unsafe { self.fd.set_user_memory_region(mapping) }.map_err(io::Error::from)
            })
        };
        remove().map_err(|source| Error::UnmapMemory {
            guest_addr: region.guest_addr,
            size: region.size,
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::ptr::NonNull;

    use kvm_bindings::{KVM_IRQCHIP_IOAPIC, kvm_irqchip, kvm_regs};

    use super::*;

    struct Ram(NonNull<u8>);

    impl Ram {
        fn new() -> Self {
            // SAFETY: anonymous mmap owns one writable page, released in Drop.
            let pointer = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    4096,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                    -1,
                    0,
                )
            };
            assert_ne!(pointer, libc::MAP_FAILED);
            Self(NonNull::new(pointer.cast()).unwrap())
        }

        fn region(&self) -> MemoryRegion {
            MemoryRegion {
                guest_addr: 0x1000,
                host_addr: self.0,
                size: 4096,
            }
        }
    }

    impl Drop for Ram {
        fn drop(&mut self) {
            // SAFETY: tests drop their VM and vCPU before this backing page.
            unsafe { libc::munmap(self.0.as_ptr().cast(), 4096) };
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn constructor_creates_interrupt_controller_and_timer() {
        let vm = KvmVm::new().unwrap();
        let mut irqchip = kvm_irqchip {
            chip_id: KVM_IRQCHIP_IOAPIC,
            ..Default::default()
        };
        vm.fd.get_irqchip(&mut irqchip).unwrap();
        vm.fd
            .get_pit2()
            .expect("KvmVm::new must create the in-kernel PIT");
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn registered_ram_supplies_instructions_to_a_real_vcpu() {
        // mov dx,0x3f8; mov al,'K'; out dx,al; hlt
        let program = [0xba, 0xf8, 0x03, 0xb0, b'K', 0xee, 0xf4];
        let ram = Ram::new();
        // SAFETY: the allocation is large enough and not yet visible to KVM.
        unsafe { std::ptr::copy_nonoverlapping(program.as_ptr(), ram.0.as_ptr(), program.len()) };
        let vm = KvmVm::new().unwrap();
        // SAFETY: ram is uniquely owned and outlives vm and vcpu.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        let mut vcpu = vm.fd.create_vcpu(0).unwrap();
        let mut segments = vcpu.get_sregs().unwrap();
        segments.cs.base = 0;
        segments.cs.selector = 0;
        vcpu.set_sregs(&segments).unwrap();
        vcpu.set_regs(&kvm_regs {
            rip: 0x1000,
            rflags: 2,
            ..Default::default()
        })
        .unwrap();
        match vcpu.run().unwrap() {
            kvm_ioctls::VcpuExit::IoOut(port, bytes) => {
                assert_eq!(port, 0x3f8);
                assert_eq!(bytes, b"K");
            }
            exit => panic!("unexpected exit: {exit:?}"),
        }
        vcpu.set_kvm_immediate_exit(1);
        assert_eq!(vcpu.run().unwrap_err().errno(), libc::EINTR);
        drop(vcpu);
        vm.unmap_memory(&ram.region()).unwrap();
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn removed_memory_can_be_replaced_at_the_same_guest_address() {
        let original = Ram::new();
        let replacement = Ram::new();
        let vm = KvmVm::new().unwrap();
        // SAFETY: each allocation outlives the VM; no vCPU or device accesses it.
        unsafe { vm.map_memory(&original.region()) }.unwrap();
        vm.unmap_memory(&original.region()).unwrap();
        // SAFETY: replacement is a separate allocation with the same lifetime.
        unsafe { vm.map_memory(&replacement.region()) }.unwrap();
        vm.unmap_memory(&replacement.region()).unwrap();
    }
}
