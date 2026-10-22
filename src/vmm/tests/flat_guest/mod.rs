// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A flat 32-bit guest on a real KVM vCPU, for the KVM tests that drive the
//! buses without a kernel. The guest runs in protected mode with paging off,
//! so a linear address is a guest address, from [`CODE`].

use std::{
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

use boxlite_hypervisor::{KvmVcpu, KvmVm, VcpuExit, VcpuHandle as _, X86BootRegisters, X86Segment};
use vm_memory::{Bytes, GuestAddress};

use crate::memory::{GuestRam, ram_ranges};

/// Where the program starts.
pub(crate) const CODE: u64 = 0x1000;
/// Where the GDT sits: a null, a flat code and a flat data descriptor.
const GDT: u64 = 0x500;
/// How long a guest may run before the test fails; a guest that halts
/// waits in the kernel and makes no more exits.
const TIMEOUT: Duration = Duration::from_secs(10);

/// One vCPU in 2 MiB of RAM, with the program loaded at [`CODE`].
pub(crate) struct FlatGuest {
    // Field order is load-bearing: the vCPU and the VM go before the RAM.
    vcpu: KvmVcpu,
    vm: Arc<KvmVm>,
    ram: GuestRam,
}

impl FlatGuest {
    pub(crate) fn new(program: &[u8]) -> Self {
        let mut ram = GuestRam::new(&ram_ranges(2)).unwrap();
        let vm = Arc::new(KvmVm::new().expect("create KVM VM"));
        ram.map(&*vm).expect("map guest RAM");
        let memory = ram.memory();
        memory.write_slice(program, GuestAddress(CODE)).unwrap();
        for (index, descriptor) in [0u64, 0x00cf_9b00_0000_ffff, 0x00cf_9300_0000_ffff]
            .into_iter()
            .enumerate()
        {
            memory
                .write_obj(descriptor, GuestAddress(GDT + index as u64 * 8))
                .unwrap();
        }
        let mut vcpu = vm.create_vcpu(0).expect("create vCPU");
        let code = X86Segment {
            limit: u32::MAX,
            selector: 8,
            attributes: 0xc09b,
            ..Default::default()
        };
        vcpu.set_boot_registers(&X86BootRegisters {
            rip: CODE,
            rsp: 0x8000,
            rflags: 2,
            cr0: 1,
            code,
            data: X86Segment {
                selector: 16,
                attributes: 0xc093,
                ..code
            },
            gdt_base: GDT,
            gdt_limit: 23,
            ..Default::default()
        })
        .unwrap();
        Self { vcpu, vm, ram }
    }

    /// The host VM, which is also the interrupt controller.
    pub(crate) fn vm(&self) -> &Arc<KvmVm> {
        &self.vm
    }

    /// Runs the guest, handing each exit to `serve`, until `serve` returns
    /// `false`; the guest then runs no further instruction. Returns how many
    /// exits it made. A guest that stops exiting fails the test.
    pub(crate) fn run(&mut self, mut serve: impl FnMut(VcpuExit<'_>) -> bool) -> usize {
        let (finished, deadline) = mpsc::channel::<()>();
        let kick = self.vcpu.handle();
        let watchdog = thread::spawn(move || {
            if matches!(
                deadline.recv_timeout(TIMEOUT),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                kick.kick().unwrap();
            }
        });
        let mut exits = 0;
        loop {
            match self.vcpu.run().expect("run vCPU") {
                VcpuExit::Interrupted => panic!("the guest stopped exiting after {exits} exits"),
                exit => {
                    exits += 1;
                    if !serve(exit) {
                        break;
                    }
                }
            }
        }
        self.vcpu.complete_pending_io().unwrap();
        drop(finished);
        watchdog.join().unwrap();
        exits
    }

    /// Reads guest RAM at `addr`.
    pub(crate) fn read(&self, addr: u64, data: &mut [u8]) {
        self.ram
            .memory()
            .read_slice(data, GuestAddress(addr))
            .unwrap();
    }
}

impl Drop for FlatGuest {
    fn drop(&mut self) {
        let _ = self.ram.unmap(&*self.vm);
    }
}
