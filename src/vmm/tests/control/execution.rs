// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use boxlite_hypervisor::{MemoryRegion, X86BootRegisters, X86Vcpu, X86Vm};

use super::*;
use crate::{
    Vm,
    bus::BusDevice,
    mock_vm::{Call, MockHandle, MockVcpu, MockVm},
};

fn config(count: u8) -> crate::VmConfig {
    crate::VmConfig {
        vcpu_count: count,
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

#[test]
fn owned_pause_resume_and_terminal_join_preserve_mapping_lifetime() {
    let backend = MockVm::new();
    let log = backend.log();
    let mut handle = bare(backend, 4).spawn().unwrap();
    assert!(matches!(
        handle.resume(),
        Err(Error::Control {
            reason: ControlReason::InvalidState,
            ..
        })
    ));
    for _ in 0..10 {
        handle.pause().unwrap();
        assert_eq!(handle.status(), VmStatus::Paused);
        assert!(matches!(
            handle.pause(),
            Err(Error::Control {
                reason: ControlReason::InvalidState,
                ..
            })
        ));
        handle.resume().unwrap();
        assert_eq!(handle.status(), VmStatus::Running);
    }
    handle.pause().unwrap();
    handle.stop();
    assert!(matches!(
        handle.resume(),
        Err(Error::Control {
            reason: ControlReason::InvalidState,
            ..
        })
    ));
    assert_eq!(handle.join().unwrap(), VmExit::StopRequested);
    let calls = log.lock().unwrap();
    let unmap = calls
        .iter()
        .position(|c| matches!(c, Call::Unmap { .. }))
        .unwrap();
    let dropped: Vec<_> = calls
        .iter()
        .enumerate()
        .filter(|(_, c)| matches!(c, Call::DropVcpu { .. }))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(dropped.len(), 4);
    assert!(dropped.iter().all(|&i| i < unmap));
}

#[test]
fn drop_stops_and_joins_paused_vcpus_before_unmapping() {
    let backend = MockVm::new();
    let log = backend.log();
    let mut handle = bare(backend, 2).spawn().unwrap();
    handle.pause().unwrap();
    drop(handle);
    let calls = log.lock().unwrap();
    assert!(matches!(calls.last(), Some(Call::Unmap { .. })));
    assert_eq!(
        calls
            .iter()
            .filter(|c| matches!(c, Call::DropVcpu { .. }))
            .count(),
        2
    );
}

#[test]
fn external_stop_wakes_parked_workers_and_is_always_terminal() {
    let mut handle = bare(MockVm::new(), 2).spawn().unwrap();
    handle.pause().unwrap();
    handle.stop_handle().stop();
    assert_ne!(handle.status(), VmStatus::Paused);
    assert!(handle.resume().is_err());
    assert_eq!(handle.join().unwrap(), VmExit::StopRequested);
}

#[test]
fn an_already_run_vm_cannot_spawn() {
    let mut vm = bare(MockVm::new(), 1);
    vm.stop_handle().stop();
    vm.run().unwrap();
    assert!(matches!(vm.spawn(), Err(Error::AlreadyRan)));
}

#[test]
fn device_presence_is_from_chipset_and_refused_before_pause_or_kick() {
    struct Idle;
    impl BusDevice for Idle {
        fn read(&mut self, _: u64, _: &mut [u8]) {}
        fn write(&mut self, _: u64, _: &[u8]) {}
    }
    // Config has no device flags, but actual composition contains a device.
    let vm = Vm::with_backend(
        config(1),
        || Ok(MockVm::new()),
        |_, _| Ok(X86BootRegisters::default()),
        |chipset, _| chipset.add("idle", |_| Ok(Idle)),
    )
    .unwrap();
    let mut handle = vm.spawn().unwrap();
    assert!(matches!(
        handle.pause(),
        Err(Error::Control {
            reason: ControlReason::UnsupportedDevice,
            ..
        })
    ));
    let state = handle.parking.mailbox.lock().unwrap();
    assert_eq!(state.generation, 0);
    assert!(!state.requested);
    assert!(state.commands.is_empty());
    drop(state);
    handle.stop();
    handle.join().unwrap();
}

#[derive(Clone, Copy)]
enum Failure {
    Healthy,
    Kick,
    Io,
    NotifyPanic,
}

struct Backend {
    mock: MockVm,
    failure: Failure,
    entered: mpsc::Sender<()>,
    io_gate: Option<Arc<Mutex<mpsc::Receiver<()>>>>,
}
struct Cpu {
    mock: MockVcpu,
    failure: Failure,
    entered: mpsc::Sender<()>,
    io_gate: Option<Arc<Mutex<mpsc::Receiver<()>>>>,
}
#[derive(Clone)]
struct Handle {
    mock: MockHandle,
    fail: bool,
}
impl VcpuHandle for Handle {
    fn kick(&self) -> boxlite_hypervisor::Result<()> {
        self.mock.kick()?;
        if self.fail {
            Err(boxlite_hypervisor::Error::RunVcpu {
                id: 0,
                source: io::Error::other("kick failure"),
            })
        } else {
            Ok(())
        }
    }
}
impl boxlite_hypervisor::Vm for Backend {
    type Vcpu = Cpu;
    unsafe fn map_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        // SAFETY: forwards the caller's mapping and lifetime contract unchanged.
        unsafe { self.mock.map_memory(region) }
    }
    fn unmap_memory(&self, region: &MemoryRegion) -> boxlite_hypervisor::Result<()> {
        self.mock.unmap_memory(region)
    }
    fn create_vcpu(&self, id: u32) -> boxlite_hypervisor::Result<Cpu> {
        Ok(Cpu {
            mock: self.mock.create_vcpu(id)?,
            failure: self.failure,
            entered: self.entered.clone(),
            io_gate: self.io_gate.clone(),
        })
    }
    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        self.mock.set_irq_line(line, level)
    }
}
impl X86Vm for Backend {
    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        &[]
    }
}
impl Vcpu for Cpu {
    type Handle = Handle;
    fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
        let _ = self.entered.send(());
        self.mock.run()
    }
    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<()> {
        if matches!(self.failure, Failure::Io) {
            if let Some(gate) = &self.io_gate {
                self.entered.send(()).unwrap();
                gate.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap();
            }
            Err(boxlite_hypervisor::Error::RunVcpu {
                id: 0,
                source: io::Error::other("I/O failure"),
            })
        } else {
            self.mock.complete_pending_io()
        }
    }
    fn notify_guest_stopped(&mut self) -> boxlite_hypervisor::Result<()> {
        if matches!(self.failure, Failure::NotifyPanic) {
            panic!("worker panic at pause");
        }
        Ok(())
    }
    fn handle(&self) -> Handle {
        Handle {
            mock: self.mock.handle(),
            fail: matches!(self.failure, Failure::Kick),
        }
    }
}
impl X86Vcpu for Cpu {
    fn set_cpu_features(
        &mut self,
        cpuid: &[boxlite_hypervisor::X86CpuidEntry],
        msrs: &[boxlite_hypervisor::X86Msr],
    ) -> boxlite_hypervisor::Result<()> {
        self.mock.set_cpu_features(cpuid, msrs)
    }
    fn set_boot_registers(&mut self, regs: &X86BootRegisters) -> boxlite_hypervisor::Result<()> {
        self.mock.set_boot_registers(regs)
    }
}

#[test]
fn kick_failure_io_failure_and_worker_panic_cannot_leave_paused() {
    for failure in [Failure::Kick, Failure::Io, Failure::NotifyPanic] {
        let (entered, ready) = mpsc::channel();
        let backend = Backend {
            mock: MockVm::new(),
            failure,
            entered,
            io_gate: None,
        };
        let vm = Vm::with_backend(
            config(1),
            || Ok(backend),
            |_, _| Ok(X86BootRegisters::default()),
            |_, _| Ok(()),
        )
        .unwrap();
        let mut handle = vm.spawn().unwrap();
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(handle.pause().is_err());
        assert_ne!(handle.status(), VmStatus::Paused);
        assert!(handle.join().is_err());
    }
}

#[test]
fn pause_stop_race_rejects_pause_and_joins() {
    let mut handle = bare(MockVm::new(), 2).spawn().unwrap();
    // Use the mailbox barrier to place terminal stop after pause admission but
    // before publication of its final ACK, without timing assumptions.
    let (parked, result) = mpsc::channel();
    let mut state = handle.parking.mailbox.lock().unwrap();
    state
        .commands
        .push_back(ParkCommand::Park(Arc::new(()), parked));
    handle.stop_handle().stop();
    drop(state);
    assert_eq!(
        result.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::TerminalOutcome)
    );
    assert!(handle.pause().is_err());
    assert_ne!(handle.status(), VmStatus::Paused);
    assert_eq!(handle.join().unwrap(), VmExit::StopRequested);
}

#[test]
fn handle_is_send_sync_and_debug() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<VmHandle<MockVm>>();
    let handle = bare(MockVm::new(), 1).spawn().unwrap();
    assert!(format!("{handle:?}").starts_with("VmHandle"));
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn kvm_device_less_guest_pauses_resumes_and_stops() {
    let vm = Vm::with_backend(
        config(2),
        boxlite_hypervisor::KvmVm::new,
        |ram, _| {
            // jmp $: no userspace devices or guest exit is required.
            Ok(crate::flat_guest::load(ram.memory(), &[0xeb, 0xfe]))
        },
        |_, _| Ok(()),
    )
    .unwrap();
    let mut handle = vm.spawn().unwrap();
    for _ in 0..3 {
        handle.pause().unwrap();
        assert_eq!(handle.status(), VmStatus::Paused);
        handle.resume().unwrap();
    }
    handle.stop_handle().stop();
    assert_eq!(handle.join().unwrap(), VmExit::StopRequested);
}

#[test]
fn wait_paused_after_supervisor_exit_reports_terminal_outcome() {
    let mut handle = bare(MockVm::new(), 1).spawn().unwrap();
    handle.stop();
    handle.join_supervisor().unwrap();
    assert_eq!(handle.status(), VmStatus::Exited);
    assert!(matches!(
        handle.wait_paused(Duration::ZERO),
        Err(Error::Control {
            operation: "wait_paused",
            reason: ControlReason::TerminalOutcome,
        })
    ));
}

#[test]
fn wait_paused_wakes_on_real_worker_failure() {
    let (entered, ready) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let backend = Backend {
        mock: MockVm::new(),
        failure: Failure::Io,
        entered,
        io_gate: Some(Arc::new(Mutex::new(gate))),
    };
    let vm = Vm::with_backend(
        config(1),
        || Ok(backend),
        |_, _| Ok(X86BootRegisters::default()),
        |_, _| Ok(()),
    )
    .unwrap();
    let handle = vm.spawn().unwrap();
    let _release_io = ReleaseIo(release.clone());
    ready.recv_timeout(Duration::from_secs(1)).unwrap();
    let parking = &handle.parking;
    let result = park(parking);
    ready.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(handle.status(), VmStatus::Pausing);
    thread::scope(|scope| {
        let (admitted, waiting) = mpsc::channel();
        *parking.paused_wait_ready.lock().unwrap() = Some(admitted);
        let waiter = scope.spawn(|| handle.wait_paused(Duration::from_secs(1)));
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(parking.mailbox.lock().unwrap());
        assert!(!waiter.is_finished());
        release.send(()).unwrap();
        assert!(matches!(
            waiter.join().unwrap(),
            Err(Error::Control {
                operation: "wait_paused",
                reason: ControlReason::TerminalOutcome,
            })
        ));
    });
    assert_eq!(result.recv().unwrap(), Err(ControlReason::TerminalOutcome));
    assert!(matches!(
        handle.status(),
        VmStatus::Stopping | VmStatus::Exited
    ));
    assert!(matches!(
        handle.join(),
        Err(Error::Hypervisor(boxlite_hypervisor::Error::RunVcpu { .. }))
    ));
}

/// Virtual time at the real driver's event-wait boundary. Each tick is
/// acknowledged, so an unfinished wait is observable without wall-clock races.
pub(crate) struct DriveWait {
    requests: mpsc::Sender<(Option<Duration>, usize, usize)>,
    ticks: mpsc::Receiver<(Duration, mpsc::Sender<(usize, usize)>)>,
    rounds: usize,
    completed: usize,
}
impl DriveWait {
    pub(crate) fn wait(
        &mut self,
        timeout: Option<Duration>,
        sender: &EventSender,
    ) -> io::Result<Option<Event>> {
        self.rounds += 1;
        self.requests
            .send((timeout, self.rounds, self.completed))
            .unwrap();
        let mut remaining = timeout.unwrap();
        loop {
            let Ok((elapsed, progress)) = self.ticks.recv() else {
                sender.send(Event::StopRequested);
                return Ok(Some(Event::StopRequested));
            };
            if elapsed >= remaining {
                self.completed += 1;
                progress.send((self.rounds, self.completed)).unwrap();
                return Ok(None);
            }
            remaining -= elapsed;
            progress.send((self.rounds, self.completed)).unwrap();
        }
    }
}

fn idle_drive_budget(status: VmStatus) {
    let (entered, ready) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let backend = Backend {
        mock: MockVm::new(),
        failure: if status == VmStatus::Pausing {
            Failure::Io
        } else {
            Failure::Healthy
        },
        entered,
        // Hold before ACK only in Pausing; Paused uses already parked workers.
        io_gate: Some(Arc::new(Mutex::new(gate))),
    };
    let mut vm = Vm::with_backend(
        config(1),
        || Ok(backend),
        |_, _| Ok(X86BootRegisters::default()),
        |_, _| Ok(()),
    )
    .unwrap();
    let parking = Parking::new(vm.sender.clone());
    {
        let mut state = parking.mailbox.lock().unwrap();
        state.status = status;
        state.generation = 1;
        state.requested = status != VmStatus::Running;
        if status == VmStatus::Pausing {
            let (reply, _result) = mpsc::channel();
            state.pending = Some(PendingPark {
                generation: 1,
                seen: 0,
                reply,
            });
        }
    }
    let (requests, observed) = mpsc::channel();
    let (ticks, clock) = mpsc::channel();
    *parking.drive_wait.lock().unwrap() = Some(DriveWait {
        requests,
        ticks: clock,
        rounds: 0,
        completed: 0,
    });
    thread::scope(|scope| {
        // Drop the clock before joining, even when the first assertion fails.
        let driver = scope.spawn(|| vm.drive(&parking));
        let _release_io = ReleaseIo(release);
        let ticks = ticks;
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(2)).unwrap(),
            (Some(crate::events::RECHECK), 1, 0)
        );
        if status == VmStatus::Paused {
            wait_for_ack(&parking);
        } else if status == VmStatus::Pausing {
            ready.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(parking.mailbox.lock().unwrap().acknowledgements.is_empty());
        }
        let broadcasts = parking.broadcasts.load(Ordering::Relaxed);
        let (progress, counts) = mpsc::channel();
        ticks
            .send((Duration::from_millis(999), progress.clone()))
            .unwrap();
        assert_eq!(counts.recv_timeout(Duration::from_secs(1)).unwrap(), (1, 0));
        assert!(matches!(
            observed.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        ticks.send((Duration::from_millis(1), progress)).unwrap();
        assert_eq!(counts.recv_timeout(Duration::from_secs(1)).unwrap(), (1, 1));
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            (Some(crate::events::RECHECK), 2, 1)
        );
        assert_eq!(parking.mailbox.lock().unwrap().status, status);
        if status == VmStatus::Paused {
            assert_eq!(parking.broadcasts.load(Ordering::Relaxed), broadcasts);
        }
        drop(ticks);
        drop(_release_io);
        let _ = driver.join().unwrap();
    });
}

#[test]
fn running_idle_drive_waits_one_second() {
    idle_drive_budget(VmStatus::Running);
}

#[test]
fn paused_idle_drive_waits_one_second_without_broadcasting() {
    idle_drive_budget(VmStatus::Paused);
}

#[test]
fn pausing_without_ack_drive_waits_one_second() {
    idle_drive_budget(VmStatus::Pausing);
}

#[test]
fn coalesced_commands_drain_exports_before_sleeping() {
    let mut vm = bare(MockVm::new(), 1);
    let parking = Parking::new(vm.sender.clone());
    let (export, exported) = mpsc::channel();
    for path in ["first", "second"] {
        parking.send(ParkCommand::Export(path.into(), export.clone()));
    }
    let (resume, resumed) = mpsc::channel();
    parking.send(ParkCommand::Resume(0, resume));
    let (requests, observed) = mpsc::channel();
    let (ticks, clock) = mpsc::channel();
    *parking.drive_wait.lock().unwrap() = Some(DriveWait {
        requests,
        ticks: clock,
        rounds: 0,
        completed: 0,
    });
    thread::scope(|scope| {
        let driver = scope.spawn(|| vm.drive(&parking));
        let ticks = ticks;
        for round in 1..=2 {
            assert_eq!(
                observed.recv_timeout(Duration::from_secs(2)).unwrap(),
                (Some(Duration::ZERO), round, round - 1)
            );
            assert!(
                exported
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .is_err()
            );
            let (progress, counts) = mpsc::channel();
            ticks.send((Duration::ZERO, progress)).unwrap();
            assert_eq!(
                counts.recv_timeout(Duration::from_secs(1)).unwrap(),
                (round, round)
            );
        }
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            (Some(crate::events::RECHECK), 3, 2)
        );
        assert_eq!(
            resumed.try_recv().unwrap(),
            Err(ControlReason::InvalidState)
        );
        assert!(parking.mailbox.lock().unwrap().commands.is_empty());
        drop(ticks);
        assert_eq!(driver.join().unwrap().unwrap(), VmExit::StopRequested);
    });
}
