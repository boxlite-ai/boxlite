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
use vm_memory::GuestAddressSpace as _;

use boxlite_hypervisor::{
    IoCompletion, KvmVcpu, KvmVm, Vcpu, VcpuExit, VcpuHandle as _, X86BootRegisters, X86Segment,
};
use vm_memory::{Bytes, GuestAddress};

use crate::memory::{GuestMemoryMmap, GuestRam, ram_ranges};

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
        let regs = load(&ram.memory().memory(), program);
        let mut vcpu = vm.create_vcpu(0).expect("create vCPU");
        vcpu.set_boot_registers(&regs).unwrap();
        Self { vcpu, vm, ram }
    }

    /// The host VM, which is also the interrupt controller.
    pub(crate) fn vm(&self) -> &Arc<KvmVm> {
        &self.vm
    }

    /// Runs the guest until `serve` returns `false`, then serves any remaining
    /// exits from the current instruction without starting another. Returns the
    /// total number of exits served. A guest that stops exiting fails the test.
    pub(crate) fn run(&mut self, serve: impl FnMut(VcpuExit<'_>) -> bool) -> usize {
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
        let exits = drive_vcpu(&mut self.vcpu, serve);
        drop(finished);
        watchdog.join().unwrap();
        exits
    }

    /// Reads guest RAM at `addr`.
    pub(crate) fn read(&self, addr: u64, data: &mut [u8]) {
        self.ram
            .memory()
            .memory()
            .read_slice(data, GuestAddress(addr))
            .unwrap();
    }
}

fn drive_vcpu(vcpu: &mut impl Vcpu, mut serve: impl FnMut(VcpuExit<'_>) -> bool) -> usize {
    let mut exits = 0;
    loop {
        match vcpu.run().expect("run vCPU") {
            VcpuExit::Interrupted => panic!("the guest stopped exiting after {exits} exits"),
            exit => {
                exits += 1;
                if !serve(exit) {
                    break;
                }
            }
        }
    }
    while let IoCompletion::Exit(exit) = vcpu.complete_pending_io().expect("complete pending I/O") {
        match exit {
            VcpuExit::Interrupted => panic!("the guest stopped exiting after {exits} exits"),
            exit => {
                exits += 1;
                // The stop request is already latched; finish this instruction.
                serve(exit);
            }
        }
    }
    exits
}

/// Writes `program` at [`CODE`] and the flat GDT into `memory`, and returns
/// the registers that enter the program in 32-bit protected mode.
pub(crate) fn load(memory: &GuestMemoryMmap, program: &[u8]) -> X86BootRegisters {
    memory.write_slice(program, GuestAddress(CODE)).unwrap();
    for (index, descriptor) in [0u64, 0x00cf_9b00_0000_ffff, 0x00cf_9300_0000_ffff]
        .into_iter()
        .enumerate()
    {
        memory
            .write_obj(descriptor, GuestAddress(GDT + index as u64 * 8))
            .unwrap();
    }
    let code = X86Segment {
        limit: u32::MAX,
        selector: 8,
        attributes: 0xc09b,
        ..Default::default()
    };
    X86BootRegisters {
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
    }
}

impl Drop for FlatGuest {
    fn drop(&mut self) {
        let _ = self.ram.unmap(&*self.vm);
    }
}

#[cfg(test)]
mod tests {
    use boxlite_hypervisor::Result;

    use super::*;
    use crate::mock_vm::MockHandle;

    #[derive(Default)]
    struct SplitIoCpu {
        entered: bool,
        completions: usize,
    }

    impl Vcpu for SplitIoCpu {
        type Handle = MockHandle;

        fn run(&mut self) -> Result<VcpuExit<'_>> {
            assert!(!self.entered, "the guest must not re-enter after stop");
            self.entered = true;
            Ok(VcpuExit::MmioWrite {
                guest_addr: 0x1fff,
                bytes: b"A",
            })
        }

        fn complete_pending_io(&mut self) -> Result<IoCompletion<'_>> {
            self.completions += 1;
            match self.completions {
                1 => Ok(IoCompletion::Exit(VcpuExit::MmioWrite {
                    guest_addr: 0x2000,
                    bytes: b"B",
                })),
                2 => Ok(IoCompletion::Done),
                _ => panic!("the drain must stop at Done"),
            }
        }

        fn handle(&self) -> Self::Handle {
            unreachable!("driving the mock does not use a watchdog")
        }
    }

    #[test]
    fn serves_follow_up_mmio_before_stopping() {
        let mut cpu = SplitIoCpu::default();
        let mut writes = Vec::new();
        let exits = drive_vcpu(&mut cpu, |exit| {
            let VcpuExit::MmioWrite { guest_addr, bytes } = exit else {
                panic!("expected an MMIO write, got {exit:?}");
            };
            writes.push((guest_addr, bytes[0]));
            false
        });

        assert_eq!((exits, writes.len()), (2, 2), "count and serve both exits");
        assert_eq!(writes, [(0x1fff, b'A'), (0x2000, b'B')]);
        assert_eq!(cpu.completions, 2);
    }
}
