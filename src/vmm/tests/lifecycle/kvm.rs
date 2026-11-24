// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

use boxlite_hypervisor::{
    KvmVcpu, KvmVcpuHandle, KvmVm, MemoryRegion, Result, Vcpu, VcpuExit, X86BootRegisters,
    X86CpuidEntry, X86Msr, X86Vcpu, X86Vm,
};
use vm_memory::{Bytes, GuestAddress, GuestAddressSpace};

use super::{
    WAIT,
    execution::{ExitGate, config, pause_at_exit, run_with_control, wait_until},
};
use crate::{Vm, VmExit, VmStatus, flat_guest};

const COUNTER: GuestAddress = GuestAddress(0x2000);
const READBACK: GuestAddress = GuestAddress(0x2004);
const MMIO_SPLIT_ADDR: u64 = 0xd000_0ffe;

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_device_less_guest_pauses_resumes_and_stops() {
    let mut memory = None;
    let mut vm = Vm::with_backend(
        config(2),
        KvmVm::new,
        |ram, _| {
            memory = Some(ram.memory().clone());
            // lock inc dword ptr [0x2000]; jmp back to the increment.
            let program = [0xf0, 0xff, 0x05, 0x00, 0x20, 0x00, 0x00, 0xeb, 0xf7];
            Ok(flat_guest::load(&ram.memory().memory(), &program))
        },
        |_, _| Ok(()),
    )
    .unwrap();
    let memory = memory.unwrap();
    let counter = || {
        memory
            .memory()
            .load::<u32>(COUNTER, Ordering::Relaxed)
            .unwrap()
    };
    vm.control().pause().unwrap();
    let exit = run_with_control(&mut vm, |control| {
        control.wait_paused(WAIT).unwrap();
        assert_eq!(counter(), 0);
        for _ in 0..3 {
            let previous = counter();
            control.resume().unwrap();
            assert_eq!(control.status(), VmStatus::Running);
            wait_until(|| counter() != previous);
            control.pause().unwrap();
            assert_eq!(control.status(), VmStatus::Paused);
            let paused = counter();
            thread::sleep(Duration::from_millis(20));
            assert_eq!(counter(), paused);
        }
    });
    assert_eq!(exit.unwrap(), VmExit::StopRequested);
}

#[derive(Clone, Copy, Debug)]
enum SplitAccess {
    Read,
    Write,
}

impl SplitAccess {
    fn is_fragment(self, exit: &VcpuExit<'_>, addr: u64) -> bool {
        match (self, exit) {
            (Self::Read, VcpuExit::MmioRead { guest_addr, bytes }) => {
                *guest_addr == addr && bytes.len() == 2
            }
            (Self::Write, VcpuExit::MmioWrite { guest_addr, bytes }) => {
                *guest_addr == addr && bytes.len() == 2
            }
            _ => false,
        }
    }
}

struct GatedKvmVm {
    vm: KvmVm,
    gate: Arc<ExitGate>,
    access: SplitAccess,
    completed_fragments: Arc<AtomicUsize>,
}

impl boxlite_hypervisor::Vm for GatedKvmVm {
    type Vcpu = GatedKvmVcpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        // SAFETY: The delegate receives the same mapping and lifetime contract.
        unsafe { self.vm.map_memory(region) }
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        self.vm.unmap_memory(region)
    }

    fn create_vcpu(&self, id: u32) -> Result<Self::Vcpu> {
        Ok(GatedKvmVcpu {
            vcpu: self.vm.create_vcpu(id)?,
            gate: Some(Arc::clone(&self.gate)),
            access: self.access,
            check_completion: false,
            completed_fragments: Arc::clone(&self.completed_fragments),
        })
    }

    fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        self.vm.set_irq_line(line, level)
    }
}

impl X86Vm for GatedKvmVm {
    fn supported_cpuid(&self) -> &[X86CpuidEntry] {
        self.vm.supported_cpuid()
    }
}

struct GatedKvmVcpu {
    vcpu: KvmVcpu,
    gate: Option<Arc<ExitGate>>,
    access: SplitAccess,
    check_completion: bool,
    completed_fragments: Arc<AtomicUsize>,
}

impl Vcpu for GatedKvmVcpu {
    type Handle = KvmVcpuHandle;

    fn run(&mut self) -> Result<VcpuExit<'_>> {
        let exit = self.vcpu.run()?;
        if self.access.is_fragment(&exit, MMIO_SPLIT_ADDR)
            && let Some(gate) = self.gate.take()
        {
            self.check_completion = true;
            gate.wait();
        }
        Ok(exit)
    }

    fn complete_pending_io(&mut self) -> Result<Option<VcpuExit<'_>>> {
        let exit = self.vcpu.complete_pending_io()?;
        if std::mem::take(&mut self.check_completion) {
            assert!(
                exit.as_ref()
                    .is_some_and(|exit| self.access.is_fragment(exit, MMIO_SPLIT_ADDR + 2)),
                "expected the second {:?} fragment from completion, got {exit:?}",
                self.access
            );
            self.completed_fragments.fetch_add(1, Ordering::Relaxed);
        }
        Ok(exit)
    }

    fn notify_guest_stopped(&mut self) -> Result<()> {
        self.vcpu.notify_guest_stopped()
    }

    fn handle(&self) -> Self::Handle {
        self.vcpu.handle()
    }
}

impl X86Vcpu for GatedKvmVcpu {
    fn set_cpu_features(&mut self, cpuid: &[X86CpuidEntry], msrs: &[X86Msr]) -> Result<()> {
        self.vcpu.set_cpu_features(cpuid, msrs)
    }

    fn set_boot_registers(&mut self, regs: &X86BootRegisters) -> Result<()> {
        self.vcpu.set_boot_registers(regs)
    }
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_device_less_guest_pauses_and_resumes_across_split_mmio() {
    #[rustfmt::skip]
    const PROGRAM: [u8; 29] = [
        0xa1, 0xfe, 0x0f, 0x00, 0xd0,                               // mov eax, [0xd0000ffe]
        0xa3, 0x04, 0x20, 0x00, 0x00,                               // mov [0x2004], eax
        0xc7, 0x05, 0xfe, 0x0f, 0x00, 0xd0, 0x78, 0x56, 0x34, 0x12, // mov dword [0xd0000ffe], 0x12345678
        0xf0, 0xff, 0x05, 0x00, 0x20, 0x00, 0x00,                   // lock inc dword [0x2000]
        0xeb, 0xe3,                                                 // jmp to the start
    ];

    for access in [SplitAccess::Read, SplitAccess::Write] {
        let (gate, ready, release) = ExitGate::new();
        let completed_fragments = Arc::new(AtomicUsize::new(0));
        let mut memory = None;
        let mut vm = Vm::with_backend(
            config(1),
            || {
                Ok(GatedKvmVm {
                    vm: KvmVm::new()?,
                    gate,
                    access,
                    completed_fragments: Arc::clone(&completed_fragments),
                })
            },
            |ram, _| {
                memory = Some(ram.memory().clone());
                let guest = ram.memory().memory();
                guest.store(0u32, COUNTER, Ordering::Relaxed).unwrap();
                guest
                    .store(0xdead_beefu32, READBACK, Ordering::Relaxed)
                    .unwrap();
                Ok(flat_guest::load(&guest, &PROGRAM))
            },
            |_, _| Ok(()),
        )
        .unwrap();
        let memory = memory.unwrap();
        let load = |addr| {
            memory
                .memory()
                .load::<u32>(addr, Ordering::Relaxed)
                .unwrap()
        };
        let exit = run_with_control(&mut vm, move |control| {
            ready.recv_timeout(WAIT).unwrap();
            pause_at_exit(control, release).unwrap();
            assert_eq!(control.status(), VmStatus::Paused);
            assert_eq!(completed_fragments.load(Ordering::Relaxed), 1);
            let paused = load(COUNTER);
            assert_eq!(paused, 0);
            assert_eq!(
                load(READBACK),
                match access {
                    SplitAccess::Read => 0xdead_beef,
                    SplitAccess::Write => u32::MAX,
                }
            );
            thread::sleep(Duration::from_millis(20));
            assert_eq!(load(COUNTER), paused);
            control.resume().unwrap();
            wait_until(|| load(COUNTER) > paused);
            assert_eq!(load(READBACK), u32::MAX);
            control.stop();
        });
        assert_eq!(exit.unwrap(), VmExit::StopRequested);
    }
}
