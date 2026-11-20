// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    panic::{self, AssertUnwindSafe},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use boxlite_hypervisor::{
    MemoryRegion, Vcpu, VcpuExit, VcpuHandle, X86BootRegisters, X86Vcpu, X86Vm,
};
use vm_memory::{Bytes, GuestAddress};

use super::{WAIT, assert_error};
use crate::{
    ControlReason, Error, Vm, VmConfig, VmControl, VmExit, VmStatus,
    bus::BusDevice,
    mock_vm::{Call, MockHandle, MockVcpu, MockVm, Step},
};

fn config(vcpu_count: u8) -> VmConfig {
    VmConfig {
        vcpu_count,
        memory_mib: 1,
        kernel: "unused".into(),
        cmdline: String::new(),
        initramfs: None,
        disks: vec![],
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
    }
}

fn bare(backend: MockVm, count: u8) -> Vm<MockVm> {
    Vm::with_backend(
        config(count),
        || Ok(backend),
        |_, _| Ok(X86BootRegisters::default()),
        |_, _| Ok(()),
    )
    .unwrap()
}

fn wait_until(mut ready: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ready() {
        assert!(
            start.elapsed() < WAIT,
            "VM did not reach the expected condition"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

fn run_with_control<H: X86Vm>(
    vm: &mut Vm<H>,
    control_vm: impl FnOnce(&VmControl) + Send,
) -> crate::Result<VmExit> {
    let control = vm.control();
    thread::scope(|scope| {
        let operator = scope.spawn(|| {
            // Stop even if a test assertion fails while the driver is blocked.
            struct StopOnDrop<'a>(&'a VmControl);
            impl Drop for StopOnDrop<'_> {
                fn drop(&mut self) {
                    self.0.stop();
                }
            }

            let stop = StopOnDrop(&control);
            control_vm(stop.0);
        });
        let exit = vm.run();
        operator.join().unwrap();
        exit
    })
}

#[test]
fn initial_pause_prevents_guest_entry_and_running_pauses_are_reversible() {
    for count in [1, 64] {
        let backend = MockVm::new();
        let log = backend.log();
        let entries = backend.entries();
        let mut vm = bare(backend, count);
        let control = vm.control();
        control.pause().unwrap();
        assert_eq!(control.status(), VmStatus::Created);

        let exit = run_with_control(&mut vm, |control| {
            control.wait_paused(WAIT).unwrap();
            assert_eq!(control.status(), VmStatus::Paused);
            assert!(entries.lock().unwrap().is_empty());

            for _ in 0..3 {
                let previous = entries.lock().unwrap().len();
                control.resume().unwrap();
                assert_eq!(control.status(), VmStatus::Running);
                wait_until(|| entries.lock().unwrap().len() > previous);
                control.pause().unwrap();
                assert_eq!(control.status(), VmStatus::Paused);
                control.wait_paused(Duration::ZERO).unwrap();
            }
            // Stop while the vCPUs are parked.
        });

        assert_eq!(exit.unwrap(), VmExit::StopRequested);
        assert_eq!(control.status(), VmStatus::Exited);
        assert_error(
            control.wait_paused(Duration::ZERO),
            "wait_paused",
            ControlReason::TerminalOutcome,
        );
        assert!(matches!(vm.run(), Err(Error::AlreadyRan)));
        {
            let calls = log.lock().unwrap();
            assert_eq!(
                calls
                    .iter()
                    .filter(|call| matches!(call, Call::DropVcpu { .. }))
                    .count(),
                usize::from(count)
            );
            assert!(!calls.iter().any(|call| matches!(call, Call::Unmap { .. })));
        }
        drop(vm);
        assert!(matches!(
            log.lock().unwrap().last(),
            Some(Call::Unmap { .. })
        ));
    }
}

#[test]
fn stop_or_drop_before_run_ends_an_initial_pause_without_guest_entry() {
    for run in [true, false] {
        let backend = MockVm::new();
        let entries = backend.entries();
        let log = backend.log();
        let mut vm = bare(backend, 2);
        let control = vm.control();
        control.pause().unwrap();
        thread::scope(|scope| {
            let waiter = scope.spawn(|| control.wait_paused(WAIT));
            if run {
                control.stop();
                assert_eq!(vm.run().unwrap(), VmExit::StopRequested);
            }
            drop(vm);
            assert_error(
                waiter.join().unwrap(),
                "wait_paused",
                ControlReason::TerminalOutcome,
            );
        });
        assert_eq!(control.status(), VmStatus::Exited);
        assert!(entries.lock().unwrap().is_empty());
        assert!(
            !log.lock().unwrap().iter().any(|call| {
                matches!(call, Call::SetCpuFeatures { .. } | Call::DropVcpu { .. })
            })
        );
    }
}

#[test]
fn guest_shutdown_after_resume_is_the_run_outcome() {
    let mut vm = bare(MockVm::with_scripts(vec![vec![Step::Shutdown]]), 1);
    vm.control().pause().unwrap();
    let exit = run_with_control(&mut vm, |control| {
        control.wait_paused(WAIT).unwrap();
        let resumed = control.resume();
        // The guest can shut down before the resume caller reacquires the lock.
        if resumed.is_err() {
            assert_error(resumed, "resume", ControlReason::TerminalOutcome);
        }
        wait_until(|| control.status() == VmStatus::Exited);
    });
    assert_eq!(exit.unwrap(), VmExit::GuestShutdown);
}

#[test]
fn pause_capability_uses_the_composed_chipset() {
    struct Idle;
    impl BusDevice for Idle {
        fn read(&mut self, _: u64, _: &mut [u8]) {}
        fn write(&mut self, _: u64, _: &[u8]) {}
    }

    let mut vm = Vm::with_backend(
        config(1),
        || Ok(MockVm::new()),
        |_, _| Ok(X86BootRegisters::default()),
        |chipset, _| chipset.add("idle", |_| Ok(Idle)),
    )
    .unwrap();
    assert_error(
        vm.control().pause(),
        "pause",
        ControlReason::UnsupportedDevice,
    );
    let exit = run_with_control(&mut vm, |control| {
        wait_until(|| control.status() == VmStatus::Running);
        assert_error(control.pause(), "pause", ControlReason::UnsupportedDevice);
    });
    assert_eq!(exit.unwrap(), VmExit::StopRequested);
}

#[derive(Clone)]
enum PauseFault {
    CompleteIo(mpsc::Sender<()>),
    Kick(Arc<AtomicUsize>),
    NotifyStopped {
        peer_parked: Arc<AtomicBool>,
        kicks: Arc<AtomicUsize>,
    },
}

struct FaultyVm(MockVm, PauseFault);

fn faulty_vm(backend: MockVm, count: u8, fault: PauseFault) -> Vm<FaultyVm> {
    Vm::with_backend(
        config(count),
        || Ok(FaultyVm(backend, fault)),
        |_, _| Ok(X86BootRegisters::default()),
        |_, _| Ok(()),
    )
    .unwrap()
}

impl boxlite_hypervisor::Vm for FaultyVm {
    type Vcpu = FailingCpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        // SAFETY: The delegate receives the same mapping and lifetime contract.
        unsafe { self.0.map_memory(region) }
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        self.0.unmap_memory(region)
    }

    fn create_vcpu(&self, id: u32) -> boxlite_hypervisor::Result<Self::Vcpu> {
        Ok(FailingCpu {
            vcpu: self.0.create_vcpu(id)?,
            id,
            fault: self.1.clone(),
        })
    }

    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        self.0.set_irq_line(line, level)
    }
}

impl X86Vm for FaultyVm {
    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        &[]
    }
}

struct FailingCpu {
    vcpu: MockVcpu,
    id: u32,
    fault: PauseFault,
}

#[derive(Clone)]
struct FaultyKick(MockHandle, Option<Arc<AtomicUsize>>);

impl VcpuHandle for FaultyKick {
    fn kick(&self) -> boxlite_hypervisor::Result<()> {
        if let Some(kicks) = &self.1 {
            assert_ne!(kicks.fetch_add(1, Ordering::Relaxed), 0, "test kick panic");
        }
        self.0.kick()
    }
}

impl Vcpu for FailingCpu {
    type Handle = FaultyKick;

    fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
        if let PauseFault::CompleteIo(entered) = &self.fault {
            entered.send(()).unwrap();
        }
        self.vcpu.run()
    }

    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<()> {
        if matches!(self.fault, PauseFault::CompleteIo(_)) {
            return Err(boxlite_hypervisor::Error::CompletePendingIo {
                id: self.id,
                source: io::Error::other("test I/O completion failure"),
            });
        }
        self.vcpu.complete_pending_io()
    }

    fn notify_guest_stopped(&mut self) -> boxlite_hypervisor::Result<()> {
        if self.id == 1
            && let PauseFault::NotifyStopped { peer_parked, .. } = &self.fault
        {
            wait_until(|| peer_parked.load(Ordering::Acquire));
            return Err(boxlite_hypervisor::Error::ConfigureVcpu {
                id: self.id,
                operation: "notify guest stopped",
                source: io::Error::other("test guest clock notification failure"),
            });
        }
        Ok(())
    }

    fn handle(&self) -> Self::Handle {
        let kicks = match &self.fault {
            PauseFault::CompleteIo(_) => None,
            PauseFault::Kick(kicks) | PauseFault::NotifyStopped { kicks, .. } => {
                Some(Arc::clone(kicks))
            }
        };
        FaultyKick(self.vcpu.handle(), kicks)
    }
}

impl X86Vcpu for FailingCpu {
    fn set_cpu_features(
        &mut self,
        cpuid: &[boxlite_hypervisor::X86CpuidEntry],
        msrs: &[boxlite_hypervisor::X86Msr],
    ) -> boxlite_hypervisor::Result<()> {
        self.vcpu.set_cpu_features(cpuid, msrs)
    }

    fn set_boot_registers(&mut self, regs: &X86BootRegisters) -> boxlite_hypervisor::Result<()> {
        self.vcpu.set_boot_registers(regs)
    }
}

#[test]
fn failed_io_completion_ends_the_vm_and_rejects_the_in_flight_pause() {
    let (entered, ready) = mpsc::channel();
    let mut vm = faulty_vm(MockVm::new(), 1, PauseFault::CompleteIo(entered));

    let exit = run_with_control(&mut vm, move |control| {
        ready.recv_timeout(WAIT).unwrap();
        assert_error(control.pause(), "pause", ControlReason::TerminalOutcome);
        assert_error(
            control.wait_paused(WAIT),
            "wait_paused",
            ControlReason::TerminalOutcome,
        );
    });
    assert!(matches!(
        exit,
        Err(Error::Hypervisor(
            boxlite_hypervisor::Error::CompletePendingIo { .. }
        ))
    ));
    assert_eq!(vm.control().status(), VmStatus::Exited);
}

#[test]
fn failed_stop_notification_releases_a_parked_peer_despite_a_kick_panic() {
    let peer_parked = Arc::new(AtomicBool::new(false));
    let kicks = Arc::new(AtomicUsize::new(0));
    let mut vm = faulty_vm(
        MockVm::new(),
        2,
        PauseFault::NotifyStopped {
            peer_parked: Arc::clone(&peer_parked),
            kicks: Arc::clone(&kicks),
        },
    );
    let lifecycle = Arc::clone(vm.lifecycle());
    vm.control().pause().unwrap();
    let (finished, result) = mpsc::channel();
    let runner = thread::spawn(move || finished.send(vm.run()).unwrap());

    wait_until(|| lifecycle.state().acknowledgements == 1);
    peer_parked.store(true, Ordering::Release);
    assert!(matches!(
        result.recv_timeout(WAIT).expect("VM run did not return"),
        Err(Error::Hypervisor(
            boxlite_hypervisor::Error::ConfigureVcpu {
                id: 1,
                operation: "notify guest stopped",
                ..
            }
        ))
    ));
    runner.join().unwrap();
    assert_eq!(kicks.load(Ordering::Relaxed), 2);
}

#[test]
fn pause_kick_panic_releases_vcpus_before_unwinding() {
    let backend = MockVm::new();
    let entries = backend.entries();
    let kicks = Arc::new(AtomicUsize::new(0));
    let mut vm = faulty_vm(backend, 2, PauseFault::Kick(Arc::clone(&kicks)));
    let control = vm.control();
    let (finished, result) = mpsc::channel();
    let runner = thread::spawn(move || {
        let outcome = panic::catch_unwind(AssertUnwindSafe(|| vm.run()));
        finished.send(outcome).unwrap();
    });

    wait_until(|| entries.lock().unwrap().len() == 2);
    let pause = control.pause();
    assert!(
        result
            .recv_timeout(WAIT)
            .expect("VM run did not unwind")
            .is_err()
    );
    assert_error(pause, "pause", ControlReason::TerminalOutcome);
    runner.join().unwrap();
    assert_eq!(kicks.load(Ordering::Relaxed), 3);
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_device_less_guest_pauses_resumes_and_stops() {
    const COUNTER: GuestAddress = GuestAddress(0x2000);
    let mut memory = None;
    let mut vm = Vm::with_backend(
        config(2),
        boxlite_hypervisor::KvmVm::new,
        |ram, _| {
            memory = Some(Arc::clone(ram.memory()));
            // lock inc dword ptr [0x2000]; jmp back to the increment.
            let program = [0xf0, 0xff, 0x05, 0x00, 0x20, 0x00, 0x00, 0xeb, 0xf7];
            Ok(crate::flat_guest::load(ram.memory(), &program))
        },
        |_, _| Ok(()),
    )
    .unwrap();
    let memory = memory.unwrap();
    let counter = || memory.load::<u32>(COUNTER, Ordering::Relaxed).unwrap();
    vm.control().pause().unwrap();
    let exit = run_with_control(&mut vm, |control| {
        control.wait_paused(WAIT).unwrap();
        for _ in 0..3 {
            let previous = counter();
            control.resume().unwrap();
            assert_eq!(control.status(), VmStatus::Running);
            wait_until(|| counter() != previous);
            control.pause().unwrap();
            assert_eq!(control.status(), VmStatus::Paused);
        }
    });
    assert_eq!(exit.unwrap(), VmExit::StopRequested);
}
