// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    panic::{self, AssertUnwindSafe},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use boxlite_hypervisor::{
    IoCompletion, MemoryRegion, Vcpu, VcpuExit, VcpuHandle, X86BootRegisters, X86Vcpu, X86Vm,
};

use super::{CompletionEnd, FragmentCpu, StopOnDrop, WAIT, assert_error};
use crate::{
    ControlReason, Error, Vm, VmConfig, VmControl, VmExit, VmStatus,
    bus::BusDevice,
    mock_vm::{Call, MockHandle, MockVcpu, MockVm, Step},
};

pub(super) fn config(vcpu_count: u8) -> VmConfig {
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
        hotplug_mib: 0,
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

pub(super) fn wait_until(mut ready: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ready() {
        assert!(
            start.elapsed() < WAIT,
            "VM did not reach the expected condition"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

pub(super) fn run_with_control<H: X86Vm>(
    vm: &mut Vm<H>,
    control_vm: impl FnOnce(&VmControl) + Send,
) -> crate::Result<VmExit> {
    let control = vm.control();
    thread::scope(|scope| {
        let operator = scope.spawn(|| {
            // Stop even if a test assertion fails while the driver is blocked.
            let stop = StopOnDrop(&control);
            control_vm(stop.0);
        });
        let exit = vm.run();
        operator.join().unwrap();
        exit
    })
}

pub(super) struct ExitGate {
    arrived: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl ExitGate {
    pub(super) fn new() -> (Arc<Self>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (arrived, ready) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        (
            Arc::new(Self {
                arrived,
                release: Mutex::new(resume),
            }),
            ready,
            release,
        )
    }

    pub(super) fn wait(&self) {
        self.arrived.send(()).unwrap();
        self.release.lock().unwrap().recv_timeout(WAIT).unwrap();
    }
}

pub(super) fn pause_at_exit(control: &VmControl, release: mpsc::Sender<()>) -> crate::Result<()> {
    thread::scope(|scope| {
        let pause = scope.spawn(|| control.pause());
        wait_until(|| control.status() == VmStatus::Pausing);
        release.send(()).unwrap();
        pause.join().unwrap()
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

struct KickAttempts {
    failures_left: usize,
    ids: Vec<u32>,
}

impl KickAttempts {
    fn new(failures_left: usize) -> Self {
        Self {
            failures_left,
            ids: Vec::new(),
        }
    }
}

#[derive(Clone)]
enum PauseFault {
    CompleteIo(mpsc::Sender<()>),
    SplitIo {
        gate: Arc<ExitGate>,
        end: CompletionEnd,
        completions: Arc<AtomicUsize>,
    },
    Kick(Arc<AtomicUsize>),
    KickError {
        kind: io::ErrorKind,
        attempts: Arc<Mutex<KickAttempts>>,
    },
    TerminalKick {
        first_kick: Arc<ExitGate>,
        shutdown: Option<Arc<ExitGate>>,
        attempts: Arc<AtomicUsize>,
        handle_ready: mpsc::Sender<MockHandle>,
    },
    Startup {
        gate: Arc<ExitGate>,
        handle_ready: mpsc::Sender<()>,
        release: mpsc::Sender<()>,
    },
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
        if id == 1
            && let PauseFault::Startup { gate, .. } = &self.1
        {
            gate.wait();
        }
        Ok(FailingCpu {
            vcpu: self.0.create_vcpu(id)?,
            id,
            fault: self.1.clone(),
            fragments: match &self.1 {
                PauseFault::SplitIo { end, .. } => Some(FragmentCpu::new(*end)),
                _ => None,
            },
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
    fragments: Option<FragmentCpu>,
}

#[derive(Clone)]
struct FaultyKick {
    handle: MockHandle,
    id: u32,
    fault: PauseFault,
}

impl VcpuHandle for FaultyKick {
    fn kick(&self) -> boxlite_hypervisor::Result<()> {
        match &self.fault {
            PauseFault::Kick(kicks) | PauseFault::NotifyStopped { kicks, .. } => {
                assert_ne!(kicks.fetch_add(1, Ordering::Relaxed), 0, "test kick panic");
            }
            PauseFault::KickError { kind, attempts } => {
                let mut attempts = attempts.lock().unwrap();
                attempts.ids.push(self.id);
                if attempts.failures_left != 0 {
                    attempts.failures_left -= 1;
                    return Err(boxlite_hypervisor::Error::KickVcpu {
                        id: self.id,
                        source: (*kind).into(),
                    });
                }
            }
            PauseFault::TerminalKick {
                first_kick,
                attempts,
                ..
            } if self.id == 0 => {
                let attempt = attempts.fetch_add(1, Ordering::Relaxed);
                if attempt == 0 {
                    first_kick.wait();
                }
                if attempt < 2 {
                    return Err(boxlite_hypervisor::Error::KickVcpu {
                        id: self.id,
                        source: io::ErrorKind::WouldBlock.into(),
                    });
                }
            }
            PauseFault::Startup { release, .. } => {
                let _ = release.send(());
            }
            PauseFault::CompleteIo(_)
            | PauseFault::SplitIo { .. }
            | PauseFault::TerminalKick { .. } => {}
        }
        self.handle.kick()
    }
}

impl Vcpu for FailingCpu {
    type Handle = FaultyKick;

    fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
        if let PauseFault::CompleteIo(entered) = &self.fault {
            entered.send(()).unwrap();
        }
        if let PauseFault::SplitIo { gate, .. } = &self.fault
            && let Some(fragments) = &mut self.fragments
            && fragments.completions == 0
        {
            let exit = fragments.run()?;
            gate.wait();
            return Ok(exit);
        }
        if self.id == 1
            && let PauseFault::TerminalKick {
                shutdown: Some(shutdown),
                ..
            } = &self.fault
        {
            shutdown.wait();
        }
        self.vcpu.run()
    }

    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<IoCompletion<'_>> {
        if matches!(self.fault, PauseFault::CompleteIo(_)) {
            return Err(boxlite_hypervisor::Error::CompletePendingIo {
                id: self.id,
                source: io::Error::other("test I/O completion failure"),
            });
        }
        if let PauseFault::SplitIo { completions, .. } = &self.fault
            && let Some(fragments) = &mut self.fragments
            && fragments.completions < 2
        {
            let completion = fragments.complete_pending_io()?;
            completions.fetch_add(1, Ordering::Relaxed);
            return Ok(completion);
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
        if self.id == 0
            && let PauseFault::Startup { handle_ready, .. } = &self.fault
        {
            handle_ready.send(()).unwrap();
        }
        let handle = self.vcpu.handle();
        if self.id == 0
            && let PauseFault::TerminalKick { handle_ready, .. } = &self.fault
        {
            handle_ready.send(handle.clone()).unwrap();
        }
        FaultyKick {
            handle,
            id: self.id,
            fault: self.fault.clone(),
        }
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
fn transient_pause_kick_retries_and_allows_resume() {
    let backend = MockVm::new();
    let entries = backend.entries();
    let attempts = Arc::new(Mutex::new(KickAttempts::new(1)));
    let mut vm = faulty_vm(
        backend,
        2,
        PauseFault::KickError {
            kind: io::ErrorKind::WouldBlock,
            attempts: Arc::clone(&attempts),
        },
    );

    let exit = run_with_control(&mut vm, |control| {
        wait_until(|| entries.lock().unwrap().len() == 2);
        control
            .pause()
            .expect("transient kick should still allow the VM to pause");
        assert_eq!(control.status(), VmStatus::Paused);
        {
            let kicks = &attempts.lock().unwrap().ids;
            assert!(
                matches!(kicks.as_slice(), [first, peer, retry] if first != peer && first == retry),
                "expected a kick for each vCPU followed by a retry, got {kicks:?}"
            );
        }

        control.resume().unwrap();
        wait_until(|| entries.lock().unwrap().len() == 4);
    });
    assert_eq!(exit.unwrap(), VmExit::StopRequested);
}

#[test]
fn terminal_during_pause_retries_shutdown_kick_after_host_stop() {
    assert_terminal_during_pause_retries_shutdown_kick(VmExit::StopRequested);
}

#[test]
fn terminal_during_pause_retries_shutdown_kick_after_guest_shutdown() {
    assert_terminal_during_pause_retries_shutdown_kick(VmExit::GuestShutdown);
}

fn assert_terminal_during_pause_retries_shutdown_kick(expected: VmExit) {
    let guest_shutdown = expected == VmExit::GuestShutdown;
    let (first_kick, pause_kick_started, finish_pause_kick) = ExitGate::new();
    let (shutdown, guest_entered, release_guest) = ExitGate::new();
    let (handle_ready, handle) = mpsc::channel();
    let backend = MockVm::with_scripts(vec![vec![], vec![Step::Shutdown]]);
    let entries = backend.entries();
    let mut vm = faulty_vm(
        backend,
        if guest_shutdown { 2 } else { 1 },
        PauseFault::TerminalKick {
            first_kick,
            shutdown: guest_shutdown.then_some(shutdown),
            attempts: Arc::default(),
            handle_ready,
        },
    );
    let control = vm.control();
    let lifecycle = Arc::clone(vm.lifecycle());
    let (finished, result) = mpsc::channel();
    let runner = thread::spawn(move || finished.send(vm.run()).unwrap());
    let rescue = handle.recv_timeout(WAIT).unwrap();
    wait_until(|| entries.lock().unwrap().contains(&0));
    if guest_shutdown {
        guest_entered.recv_timeout(WAIT).unwrap();
    }

    let pause = thread::scope(|scope| {
        let pauser = scope.spawn(|| control.pause());
        pause_kick_started.recv_timeout(WAIT).unwrap();
        assert_eq!(control.status(), VmStatus::Pausing);
        if guest_shutdown {
            release_guest.send(()).unwrap();
            wait_until(|| lifecycle.state().is_terminal());
        } else {
            control.stop();
        }
        // Latch the terminal event before the first kick fails, so the next
        // attempt is from shutdown, not the pause retry loop.
        finish_pause_kick.send(()).unwrap();
        pauser.join().unwrap()
    });

    let outcome = result.recv_timeout(WAIT);
    if matches!(outcome, Err(mpsc::RecvTimeoutError::Timeout)) {
        // Unblock the mock only after the hang is observed, then fail on the
        // original timeout rather than letting the test strand a worker.
        rescue.kick().unwrap();
        let _ = result
            .recv_timeout(WAIT)
            .expect("rescue kick did not unblock Vm::run()");
    }
    runner.join().unwrap();
    assert_error(pause, "pause", ControlReason::TerminalOutcome);
    assert_eq!(
        outcome
            .expect("Vm::run() did not return before WAIT")
            .unwrap(),
        expected
    );
}

#[test]
fn single_vcpu_pause_distinguishes_interrupted_and_fatal_kicks() {
    for (kind, failures) in [
        (io::ErrorKind::Interrupted, 6),
        (io::ErrorKind::PermissionDenied, 1),
    ] {
        let backend = MockVm::new();
        let entries = backend.entries();
        let attempts = Arc::new(Mutex::new(KickAttempts::new(failures)));
        let mut vm = faulty_vm(
            backend,
            1,
            PauseFault::KickError {
                kind,
                attempts: Arc::clone(&attempts),
            },
        );

        let exit = run_with_control(&mut vm, |control| {
            wait_until(|| entries.lock().unwrap().len() == 1);
            let pause = control.pause();
            if kind == io::ErrorKind::Interrupted {
                let kicks = {
                    let mut attempts = attempts.lock().unwrap();
                    // Let the shutdown kick succeed even if pause timed out with retries left.
                    attempts.failures_left = 0;
                    attempts.ids.clone()
                };
                // No peer wakes the driver, so six 1-second waits would exceed
                // the 5-second pause timeout.
                pause.expect("interrupted kicks should be retried before the pause deadline");
                assert_eq!(control.status(), VmStatus::Paused);
                assert_eq!(kicks, [0; 7]);
                control.resume().unwrap();
                assert_eq!(control.status(), VmStatus::Running);
            } else {
                assert_error(pause, "pause", ControlReason::TerminalOutcome);
            }
        });
        if kind == io::ErrorKind::Interrupted {
            assert_eq!(exit.unwrap(), VmExit::StopRequested);
        } else {
            assert!(matches!(
                exit,
                Err(Error::Hypervisor(boxlite_hypervisor::Error::KickVcpu { id: 0, source }))
                    if source.kind() == kind
            ));
        }
    }
}

#[test]
fn pause_during_vcpu_startup_parks_every_worker_before_guest_entry() {
    let (gate, configuring, release) = ExitGate::new();
    let (handle_ready, first_handle) = mpsc::channel();
    let backend = MockVm::new();
    let entries = backend.entries();
    let mut vm = faulty_vm(
        backend,
        2,
        PauseFault::Startup {
            gate,
            handle_ready,
            release,
        },
    );
    let lifecycle = Arc::clone(vm.lifecycle());

    let exit = run_with_control(&mut vm, move |control| {
        configuring.recv_timeout(WAIT).unwrap();
        first_handle.recv_timeout(WAIT).unwrap();
        assert_eq!(control.status(), VmStatus::Running);

        // The kick batch starts with only vCPU 0's handle. Its kick lets
        // vCPU 1 finish configuring and both workers leave the start gate.
        control.pause().unwrap();
        assert_eq!(control.status(), VmStatus::Paused);
        assert_eq!(lifecycle.state().acknowledgements, 0b11);
        assert!(entries.lock().unwrap().is_empty());

        control.resume().unwrap();
        wait_until(|| {
            let entries = entries.lock().unwrap();
            entries.contains(&0) && entries.contains(&1)
        });
    });
    assert_eq!(exit.unwrap(), VmExit::StopRequested);
}

#[test]
fn split_mmio_pauses_after_dispatching_the_follow_up_fragment_and_resumes() {
    let (gate, ready, release) = ExitGate::new();
    let completions = Arc::new(AtomicUsize::new(0));
    let backend = MockVm::new();
    let entries = backend.entries();
    let mut vm = faulty_vm(
        backend,
        1,
        PauseFault::SplitIo {
            gate,
            end: CompletionEnd::Done,
            completions: Arc::clone(&completions),
        },
    );
    let exit = run_with_control(&mut vm, move |control| {
        ready.recv_timeout(WAIT).unwrap();
        pause_at_exit(control, release).unwrap();
        assert_eq!(control.status(), VmStatus::Paused);
        assert_eq!(completions.load(Ordering::Relaxed), 2);
        assert!(entries.lock().unwrap().is_empty());
        control.resume().unwrap();
        wait_until(|| !entries.lock().unwrap().is_empty());
    });
    assert_eq!(exit.unwrap(), VmExit::StopRequested);
}

#[test]
fn terminal_exit_during_split_mmio_completion_ends_the_vm() {
    let (gate, ready, release) = ExitGate::new();
    let completions = Arc::new(AtomicUsize::new(0));
    let mut vm = faulty_vm(
        MockVm::new(),
        1,
        PauseFault::SplitIo {
            gate,
            end: CompletionEnd::Reset,
            completions: Arc::clone(&completions),
        },
    );
    let exit = run_with_control(&mut vm, move |control| {
        ready.recv_timeout(WAIT).unwrap();
        assert_error(
            pause_at_exit(control, release),
            "pause",
            ControlReason::TerminalOutcome,
        );
    });
    assert_eq!(exit.unwrap(), VmExit::GuestReset);
    assert_eq!(completions.load(Ordering::Relaxed), 2);
}

#[test]
fn stop_drains_split_mmio_before_worker_exit() {
    let (gate, ready, release) = ExitGate::new();
    let completions = Arc::new(AtomicUsize::new(0));
    let mut vm = faulty_vm(
        MockVm::new(),
        1,
        PauseFault::SplitIo {
            gate,
            end: CompletionEnd::Done,
            completions: Arc::clone(&completions),
        },
    );
    let exit = run_with_control(&mut vm, move |control| {
        ready.recv_timeout(WAIT).unwrap();
        control.stop();
        release.send(()).unwrap();
    });
    assert_eq!(exit.unwrap(), VmExit::StopRequested);
    assert_eq!(completions.load(Ordering::Relaxed), 2);
}
