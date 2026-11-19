// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Epoch/ACK protocol tests run on every host; owned execution tests use the
//! x86_64 mock driver. Hardware tests require Linux x86_64 and /dev/kvm.

use std::{io, sync::mpsc, thread, time::Duration};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use std::time::Instant;

use boxlite_hypervisor::{Vcpu, VcpuExit, VcpuHandle};

use super::*;
use crate::events::{Event, EventLoop};

fn park(parking: &Parking) -> mpsc::Receiver<ParkResult> {
    let (tx, rx) = mpsc::channel();
    parking.send(ParkCommand::Park(Arc::new(()), tx));
    rx
}

fn resume(parking: &Parking, generation: u64, sender: &EventSender, count: u8) -> ParkResult {
    let (tx, rx) = mpsc::channel();
    parking.send(ParkCommand::Resume(generation, tx));
    parking.supervise(count, sender);
    rx.recv_timeout(Duration::from_secs(1)).unwrap()
}

fn ack(parking: &Parking, generation: u64, id: u8) {
    parking
        .mailbox
        .lock()
        .unwrap()
        .acknowledgements
        .push_back((generation, id));
    parking.changed.notify_all();
    parking.sender.wake();
}

#[test]
fn all_ack_bits_are_required_and_duplicates_and_late_epochs_do_not_count() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let result = park(&parking);
    assert!(parking.supervise(3, &sender).0);
    for (generation, id) in [(0, 0), (2, 0), (1, 3), (1, 64), (1, 0), (1, 0), (1, 2)] {
        ack(&parking, generation, id);
    }
    parking.supervise(3, &sender);
    assert_eq!(result.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Pausing);
    ack(&parking, 1, 1);
    parking.supervise(3, &sender);
    assert_eq!(result.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(1));
    assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Paused);
    assert_eq!(
        resume(&parking, 0, &sender, 3),
        Err(ControlReason::InvalidState)
    );
    assert_eq!(resume(&parking, 1, &sender, 3), Ok(1));
    assert_eq!(
        resume(&parking, 1, &sender, 3),
        Err(ControlReason::InvalidState)
    );

    let result = park(&parking);
    parking.supervise(3, &sender);
    for id in 0..3 {
        ack(&parking, 1, id);
    }
    parking.supervise(3, &sender);
    assert_eq!(result.try_recv(), Err(mpsc::TryRecvError::Empty));
    for id in 0..3 {
        ack(&parking, 2, id);
    }
    parking.supervise(3, &sender);
    assert_eq!(result.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(2));
}

#[test]
fn sixty_four_vcpus_and_epoch_overflow() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let result = park(&parking);
    parking.supervise(64, &sender);
    for id in 0..64 {
        ack(&parking, 1, id);
    }
    parking.supervise(64, &sender);
    assert_eq!(result.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(1));
    resume(&parking, 1, &sender, 64).unwrap();
    parking.mailbox.lock().unwrap().generation = u64::MAX;
    let result = park(&parking);
    assert!(!parking.supervise(64, &sender).0);
    assert_eq!(
        result.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::InvalidState)
    );
}

#[test]
fn repeat_pause_is_invalid_not_idempotent() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let first = park(&parking);
    let second = park(&parking);
    parking.supervise(1, &sender);
    assert_eq!(
        second.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::InvalidState)
    );
    ack(&parking, 1, 0);
    parking.supervise(1, &sender);
    assert_eq!(first.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(1));
    let repeated = park(&parking);
    parking.supervise(1, &sender);
    assert_eq!(
        repeated.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::InvalidState)
    );
}

#[test]
fn timeout_before_admission_withdraws_park_and_allows_retry() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Arc::new(Parking::new(events.sender()));
    let mut handle = VmHandle::<crate::mock_vm::MockVm> {
        parking: parking.clone(),
        stop: StopHandle(sender.clone()),
        supervisor: None,
        devices: false,
        backend: PhantomData,
    };
    assert!(matches!(
        handle.request(true, Duration::ZERO),
        Err(Error::Control {
            operation: "pause",
            reason: ControlReason::DeadlineTimeout,
        })
    ));
    let state = parking.mailbox.lock().unwrap();
    assert!(state.commands.is_empty());
    assert!(state.pending.is_none());
    assert!(!state.requested);
    assert_eq!(state.generation, 0);
    drop(state);
    assert_eq!(handle.status(), VmStatus::Running);
    assert!(matches!(
        handle.wait_paused(Duration::ZERO),
        Err(Error::Control {
            operation: "wait_paused",
            reason: ControlReason::InvalidState,
        })
    ));
    assert!(!parking.supervise(1, &sender).0);
    thread::scope(|scope| {
        let _abort = AbortParking(&parking);
        scope.spawn(|| {
            wait_for_command(&parking);
            assert_eq!(parking.mailbox.lock().unwrap().commands.len(), 1);
            assert!(parking.supervise(1, &sender).0);
            ack(&parking, 1, 0);
            parking.supervise(1, &sender);
        });
        handle.pause().unwrap();
        assert_eq!(handle.status(), VmStatus::Paused);
        assert_eq!(parking.mailbox.lock().unwrap().generation, 1);
    });
}

#[test]
fn caller_timeout_keeps_parking_and_accepts_late_ack() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Arc::new(Parking::new(events.sender()));
    let handle = VmHandle::<crate::mock_vm::MockVm> {
        parking: parking.clone(),
        stop: StopHandle(sender.clone()),
        supervisor: None,
        devices: false,
        backend: PhantomData,
    };
    thread::scope(|scope| {
        let _abort = AbortParking(&parking);
        let (ready, waiting) = mpsc::channel();
        let (release_wait, wait_gate) = mpsc::channel();
        let _release_wait = ReleaseIo(release_wait.clone());
        *parking.pause_wait_gate.lock().unwrap() = Some((ready, wait_gate));
        let caller = scope.spawn(move || {
            let mut handle = handle;
            assert!(matches!(
                handle.request(true, Duration::from_millis(20)),
                Err(Error::Control {
                    operation: "pause",
                    reason: ControlReason::DeadlineTimeout,
                })
            ));
            handle
        });
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        parking.supervise(1, &sender);
        let (progress, observed) = mpsc::channel();
        let (release, io_gate) = mpsc::channel();
        let _release_io = ReleaseIo(release.clone());
        let worker = scope.spawn(|| {
            parking
                .checkpoint(
                    0,
                    &mut FakeVcpu {
                        io_done: progress,
                        release_io: io_gate,
                        fail: false,
                    },
                )
                .unwrap();
        });
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            "completing"
        );
        release_wait.send(()).unwrap();
        let mut handle = caller.join().unwrap();
        assert_eq!(handle.status(), VmStatus::Pausing);
        assert!(parking.mailbox.lock().unwrap().pending.is_some());
        assert!(!sender.is_stopping());
        assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
        assert!(matches!(
            handle.wait_paused(Duration::from_millis(5)),
            Err(Error::Control {
                operation: "wait_paused",
                reason: ControlReason::DeadlineTimeout,
            })
        ));
        assert_eq!(handle.status(), VmStatus::Pausing);
        assert!(matches!(
            handle.pause(),
            Err(Error::Control {
                operation: "pause",
                reason: ControlReason::InvalidState,
            })
        ));
        assert!(matches!(
            handle.resume(),
            Err(Error::Control {
                operation: "resume",
                reason: ControlReason::InvalidState,
            })
        ));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image");
        assert!(matches!(
            handle.export_to_file(&path),
            Err(Error::Control {
                operation: "export",
                reason: ControlReason::InvalidState,
            })
        ));
        assert!(!path.exists());
        assert!(parking.mailbox.lock().unwrap().commands.is_empty());
        release.send(()).unwrap();
        for expected in ["completed", "notified"] {
            assert_eq!(
                observed.recv_timeout(Duration::from_secs(1)).unwrap(),
                expected
            );
        }
        wait_for_ack(&parking);
        thread::scope(|scope| {
            let (ready, waiting) = mpsc::channel();
            *parking.paused_wait_ready.lock().unwrap() = Some(ready);
            let waiter = scope.spawn(|| handle.wait_paused(Duration::from_secs(1)));
            waiting.recv_timeout(Duration::from_secs(1)).unwrap();
            drop(parking.mailbox.lock().unwrap());
            assert!(!waiter.is_finished());
            parking.supervise(1, &sender);
            waiter.join().unwrap().unwrap();
        });
        assert_eq!(handle.status(), VmStatus::Paused);
        handle.wait_paused(Duration::ZERO).unwrap();
        assert!(matches!(
            handle.pause(),
            Err(Error::Control {
                operation: "pause",
                reason: ControlReason::InvalidState,
            })
        ));
        handle.stop();
        worker.join().unwrap();
    });
}

#[test]
fn wait_paused_rejects_running_and_stop_terminates_pending_parking() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Arc::new(Parking::new(events.sender()));
    let handle = VmHandle::<crate::mock_vm::MockVm> {
        parking: parking.clone(),
        stop: StopHandle(sender.clone()),
        supervisor: None,
        devices: false,
        backend: PhantomData,
    };
    assert!(matches!(
        handle.wait_paused(Duration::ZERO),
        Err(Error::Control {
            operation: "wait_paused",
            reason: ControlReason::InvalidState,
        })
    ));
    assert!(parking.mailbox.lock().unwrap().commands.is_empty());
    let result = park(&parking);
    parking.supervise(1, &sender);
    assert_eq!(handle.status(), VmStatus::Pausing);
    thread::scope(|scope| {
        let (ready, waiting) = mpsc::channel();
        *parking.paused_wait_ready.lock().unwrap() = Some(ready);
        let waiter = scope.spawn(|| handle.wait_paused(Duration::from_secs(1)));
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(parking.mailbox.lock().unwrap());
        assert!(!waiter.is_finished());
        handle.stop();
        assert!(matches!(
            waiter.join().unwrap(),
            Err(Error::Control {
                operation: "wait_paused",
                reason: ControlReason::TerminalOutcome,
            })
        ));
    });
    assert_eq!(handle.status(), VmStatus::Stopping);
    assert_eq!(result.recv().unwrap(), Err(ControlReason::TerminalOutcome));
    assert!(parking.mailbox.lock().unwrap().pending.is_none());
    assert!(matches!(
        handle.wait_paused(Duration::ZERO),
        Err(Error::Control {
            operation: "wait_paused",
            reason: ControlReason::TerminalOutcome,
        })
    ));
}

#[test]
fn wait_paused_and_caller_timeout_observe_external_stop_before_supervisor_publication() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Arc::new(Parking::new(events.sender()));
    let handle = VmHandle::<crate::mock_vm::MockVm> {
        parking: parking.clone(),
        stop: StopHandle(sender.clone()),
        supervisor: None,
        devices: false,
        backend: PhantomData,
    };
    let stop = handle.stop_handle();
    let (ready, waiting) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    *parking.pause_wait_gate.lock().unwrap() = Some((ready, gate));
    let handle = thread::scope(|scope| {
        let _release_wait = ReleaseIo(release.clone());
        let caller = scope.spawn(move || {
            let mut handle = handle;
            assert!(matches!(
                handle.request(true, Duration::ZERO),
                Err(Error::Control {
                    operation: "pause",
                    reason: ControlReason::TerminalOutcome,
                })
            ));
            handle
        });
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        parking.supervise(1, &sender);
        stop.stop();
        release.send(()).unwrap();
        caller.join().unwrap()
    });
    assert_eq!(handle.status(), VmStatus::Stopping);
    assert!(matches!(
        handle.wait_paused(Duration::ZERO),
        Err(Error::Control {
            operation: "wait_paused",
            reason: ControlReason::TerminalOutcome,
        })
    ));
    ack(&parking, 1, 0);
    parking.supervise(1, &sender);
    assert!(parking.mailbox.lock().unwrap().pending.is_none());
    assert_eq!(handle.status(), VmStatus::Stopping);
}

#[test]
fn terminal_stop_or_worker_failure_wins_over_queued_pause_or_final_ack() {
    for worker_failure in [false, true] {
        for last_ack in [false, true] {
            let events = EventLoop::new().unwrap();
            let sender = events.sender();
            let parking = Parking::new(events.sender());
            let result = park(&parking);
            if last_ack {
                parking.supervise(1, &sender);
                ack(&parking, 1, 0);
            }
            sender.send(if worker_failure {
                Event::VcpuFailed(Error::VcpuPanicked { vcpu: 0 })
            } else {
                Event::StopRequested
            });
            parking.supervise(1, &sender);
            assert_eq!(
                result.recv_timeout(Duration::from_secs(1)).unwrap(),
                Err(ControlReason::TerminalOutcome)
            );
            assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Stopping);
        }
    }
}

#[test]
fn caller_timeout_does_not_request_terminal_stop() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Arc::new(Parking::new(events.sender()));
    let handle = VmHandle::<crate::mock_vm::MockVm> {
        parking: parking.clone(),
        stop: StopHandle(sender.clone()),
        supervisor: None,
        devices: false,
        backend: PhantomData,
    };
    thread::scope(|scope| {
        let _abort = AbortParking(&parking);
        let (ready, waiting) = mpsc::channel();
        let (release_wait, wait_gate) = mpsc::channel();
        let _release_wait = ReleaseIo(release_wait.clone());
        *parking.pause_wait_gate.lock().unwrap() = Some((ready, wait_gate));
        let caller = scope.spawn(move || {
            let mut handle = handle;
            assert!(matches!(
                handle.request(true, Duration::from_millis(20)),
                Err(Error::Control {
                    operation: "pause",
                    reason: ControlReason::DeadlineTimeout,
                })
            ));
            handle
        });
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        parking.supervise(1, &sender);
        release_wait.send(()).unwrap();
        parking.supervise(1, &sender);
        let _handle = caller.join().unwrap();
        assert!(!sender.is_stopping());
        assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
    });
}

#[derive(Clone)]
struct FakeHandle;
impl VcpuHandle for FakeHandle {
    fn kick(&self) -> boxlite_hypervisor::Result<()> {
        Ok(())
    }
}

struct FakeVcpu {
    io_done: mpsc::Sender<&'static str>,
    release_io: mpsc::Receiver<()>,
    fail: bool,
}

impl Vcpu for FakeVcpu {
    type Handle = FakeHandle;
    fn run(&mut self) -> boxlite_hypervisor::Result<VcpuExit<'_>> {
        panic!("checkpoint must not enter guest")
    }
    fn complete_pending_io(&mut self) -> boxlite_hypervisor::Result<()> {
        self.io_done.send("completing").unwrap();
        self.release_io
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        if self.fail {
            return Err(boxlite_hypervisor::Error::RunVcpu {
                id: 0,
                source: io::Error::other("I/O failure"),
            });
        }
        self.io_done.send("completed").unwrap();
        Ok(())
    }
    fn notify_guest_stopped(&mut self) -> boxlite_hypervisor::Result<()> {
        self.io_done.send("notified").unwrap();
        Ok(())
    }
    fn handle(&self) -> FakeHandle {
        FakeHandle
    }
}

#[test]
fn ack_follows_io_and_notification_and_parked_worker_serves_commands_on_its_thread() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let result = park(&parking);
    parking.supervise(1, &sender);
    let (progress, observed) = mpsc::channel();
    let (release, io_gate) = mpsc::channel();
    thread::scope(|scope| {
        let _abort = AbortParking(&parking);
        let worker = scope.spawn(|| {
            let mut vcpu = FakeVcpu {
                io_done: progress,
                release_io: io_gate,
                fail: false,
            };
            parking.checkpoint(0, &mut vcpu).unwrap();
        });
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            "completing"
        );
        parking.supervise(1, &sender);
        assert_eq!(result.try_recv(), Err(mpsc::TryRecvError::Empty));
        release.send(()).unwrap();
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            "completed"
        );
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            "notified"
        );
        wait_for_ack(&parking);
        parking.supervise(1, &sender);
        assert_eq!(result.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(1));
        let owner = worker.thread().id();
        let (tx, rx) = mpsc::channel();
        parking.mailbox.lock().unwrap().accesses.push_back((
            0,
            Box::new(move || {
                tx.send(thread::current().id()).unwrap();
            }),
        ));
        parking.changed.notify_all();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), owner);
        assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Paused);
        parking.stop();
        worker.join().unwrap();
    });
}

#[test]
fn failed_pending_io_never_acknowledges() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let result = park(&parking);
    parking.supervise(1, &sender);
    let (progress, _observed) = mpsc::channel();
    let (release, io_gate) = mpsc::channel();
    release.send(()).unwrap();
    let mut vcpu = FakeVcpu {
        io_done: progress,
        release_io: io_gate,
        fail: true,
    };
    assert!(parking.checkpoint(0, &mut vcpu).is_err());
    parking.supervise(1, &sender);
    assert_eq!(result.try_recv(), Err(mpsc::TryRecvError::Empty));
    parking.stop();
}

#[test]
fn device_less_configuration_rejects_every_device_kind() {
    let config = crate::VmConfig {
        vcpu_count: 1,
        memory_mib: 1,
        kernel: "unused".into(),
        cmdline: String::new(),
        initramfs: None,
        disks: vec![],
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
    };
    config.validate_device_less().unwrap();
    for kind in 0..5 {
        let mut config = config.clone();
        match kind {
            0 => config.disks.push(crate::DiskConfig {
                path: "unused".into(),
                format: crate::DiskFormat::Raw,
                read_only: true,
            }),
            1 => {
                config.filesystem = Some(crate::FsConfig {
                    tag: "unused".into(),
                    shares: vec![],
                })
            }
            2 => {
                config.vsock = Some(crate::VsockConfig {
                    cid: 3,
                    listen: vec![],
                    connect: vec![],
                })
            }
            3 => {
                config.network = Some(crate::NetConfig {
                    path: "unused".into(),
                    mac: [0; 6],
                })
            }
            4 => config.virtio_console = true,
            _ => unreachable!(),
        }
        assert!(matches!(
            config.validate_device_less(),
            Err(Error::Control {
                reason: ControlReason::UnsupportedDevice,
                ..
            })
        ));
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert!(matches!(
            crate::Vm::new_device_less(config),
            Err(Error::Control {
                reason: ControlReason::UnsupportedDevice,
                ..
            })
        ));
    }
}

#[cfg(target_arch = "x86_64")]
pub(super) mod execution;

#[test]
fn pending_park_uses_recheck_budget_and_late_ack_publishes_paused() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(sender.clone());
    let result = park(&parking);
    assert_eq!(
        parking.supervise(1, &sender),
        (true, crate::events::RECHECK)
    );
    assert_eq!(
        parking.supervise(1, &sender),
        (false, crate::events::RECHECK)
    );
    assert_eq!(result.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Pausing);
    ack(&parking, 1, 0);
    parking.supervise(1, &sender);
    assert_eq!(result.recv().unwrap(), Ok(1));
    assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Paused);
}

#[test]
fn public_handle_rejects_actual_chipset_devices_without_submitting_a_request() {
    use crate::{bus::BusDevice, chipset::ChipsetBuilder, mock_vm::MockVm};
    struct Idle;
    impl BusDevice for Idle {
        fn read(&mut self, _: u64, _: &mut [u8]) {}
        fn write(&mut self, _: u64, _: &[u8]) {}
    }
    let events = EventLoop::new().unwrap();
    let mut builder = ChipsetBuilder::new(Arc::new(MockVm::new()), events.sender());
    builder.add("idle", |_| Ok(Idle)).unwrap();
    let chipset = builder.build().unwrap();
    let parking = Arc::new(Parking::new(events.sender()));
    let mut handle = VmHandle::<MockVm> {
        parking: parking.clone(),
        stop: StopHandle(events.sender()),
        supervisor: None,
        devices: !chipset.is_empty(),
        backend: PhantomData,
    };
    assert!(matches!(
        handle.pause(),
        Err(Error::Control {
            reason: ControlReason::UnsupportedDevice,
            ..
        })
    ));
    let state = parking.mailbox.lock().unwrap();
    assert_eq!(state.generation, 0);
    assert!(!state.requested);
    assert!(state.commands.is_empty());
    drop(state);
    handle.stop();
    assert!(matches!(
        handle.pause(),
        Err(Error::Control {
            reason: ControlReason::InvalidState,
            ..
        })
    ));
    parking.mailbox.lock().unwrap().status = VmStatus::Exited;
    handle.stop();
    assert_eq!(handle.status(), VmStatus::Exited);
}

#[test]
fn public_handle_pause_and_resume_use_the_supervisors_ack_fence() {
    use crate::mock_vm::MockVm;
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Arc::new(Parking::new(events.sender()));
    let handle = VmHandle::<MockVm> {
        parking: parking.clone(),
        stop: StopHandle(sender.clone()),
        supervisor: None,
        devices: false,
        backend: PhantomData,
    };
    // The test drives the supervisor explicitly, but every request, transition
    // and worker checkpoint is production code.
    thread::scope(|scope| {
        let _abort = AbortParking(&parking);
        let caller = scope.spawn(move || {
            let mut handle = handle;
            assert!(handle.resume().is_err());
            handle.pause().unwrap();
            assert_eq!(handle.status(), VmStatus::Paused);
            assert!(handle.pause().is_err());
            handle.resume().unwrap();
            assert_eq!(handle.status(), VmStatus::Running);
            handle.stop();
        });
        wait_for_command(&parking);
        parking.supervise(1, &sender);
        let (progress, observed) = mpsc::channel();
        let (release, io_gate) = mpsc::channel();
        release.send(()).unwrap();
        let worker = scope.spawn(|| {
            parking
                .checkpoint(
                    0,
                    &mut FakeVcpu {
                        io_done: progress,
                        release_io: io_gate,
                        fail: false,
                    },
                )
                .unwrap();
        });
        for expected in ["completing", "completed", "notified"] {
            assert_eq!(
                observed.recv_timeout(Duration::from_secs(1)).unwrap(),
                expected
            );
        }
        wait_for_ack(&parking);
        parking.supervise(1, &sender);
        wait_for_command(&parking);
        parking.supervise(1, &sender);
        caller.join().unwrap();
        worker.join().unwrap();
    });
}

fn wait_for_ack(parking: &Parking) {
    let state = parking.mailbox.lock().unwrap();
    let (state, _) = parking
        .changed
        .wait_timeout_while(state, Duration::from_secs(1), |state| {
            state.acknowledgements.is_empty()
        })
        .unwrap();
    assert!(
        !state.acknowledgements.is_empty(),
        "vCPU did not acknowledge"
    );
}

fn wait_for_command(parking: &Parking) {
    let state = parking.mailbox.lock().unwrap();
    let (state, _) = parking
        .changed
        .wait_timeout_while(state, Duration::from_secs(1), |state| {
            state.commands.is_empty()
        })
        .unwrap();
    assert!(!state.commands.is_empty(), "control request did not arrive");
}

/// Open pending I/O before joining workers, including on assertion failure.
struct ReleaseIo(mpsc::Sender<()>);
impl Drop for ReleaseIo {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

/// Release parked workers before the test scope joins, including on assertion failure.
struct AbortParking<'a>(&'a Parking);
impl Drop for AbortParking<'_> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
impl boxlite_hypervisor::X86Vcpu for FakeVcpu {
    fn set_cpu_features(
        &mut self,
        _: &[boxlite_hypervisor::X86CpuidEntry],
        _: &[boxlite_hypervisor::X86Msr],
    ) -> boxlite_hypervisor::Result<()> {
        Ok(())
    }
    fn set_boot_registers(
        &mut self,
        _: &boxlite_hypervisor::X86BootRegisters,
    ) -> boxlite_hypervisor::Result<()> {
        Ok(())
    }
}

#[test]
fn export_refuses_nonpaused_and_devices_without_queueing() {
    let events = EventLoop::new().unwrap();
    let parking = Arc::new(Parking::new(events.sender()));
    let mut handle = VmHandle::<crate::mock_vm::MockVm> {
        parking: parking.clone(),
        stop: StopHandle(events.sender()),
        supervisor: None,
        devices: false,
        backend: PhantomData,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    for status in [VmStatus::Running, VmStatus::Stopping, VmStatus::Exited] {
        parking.mailbox.lock().unwrap().status = status;
        assert!(matches!(
            handle.export_to_file(&path),
            Err(Error::Control {
                reason: ControlReason::InvalidState,
                ..
            })
        ));
    }
    parking.mailbox.lock().unwrap().status = VmStatus::Paused;
    handle.devices = true;
    assert!(matches!(
        handle.export_to_file(&path),
        Err(Error::Control {
            reason: ControlReason::UnsupportedDevice,
            ..
        })
    ));
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        handle.devices = false;
        for result in [
            handle.export(io::sink()).map(drop),
            handle.export_to_file(&path),
        ] {
            assert!(matches!(
                result,
                Err(Error::Snapshot(error)) if error.kind() == io::ErrorKind::Unsupported
            ));
        }
        assert_eq!(handle.status(), VmStatus::Paused);
    }
    assert!(parking.mailbox.lock().unwrap().commands.is_empty());
    assert!(!path.exists());
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "../snapshot/execution.rs"]
mod snapshot;

#[test]
fn paused_supervision_does_not_broadcast_without_a_transition() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let result = park(&parking);
    parking.supervise(1, &sender);
    ack(&parking, 1, 0);
    parking.supervise(1, &sender);
    assert_eq!(result.recv().unwrap(), Ok(1));
    let broadcasts = parking.broadcasts.load(Ordering::Relaxed);
    for _ in 0..10 {
        parking.supervise(1, &sender);
    }
    assert_eq!(
        parking.broadcasts.load(Ordering::Relaxed),
        broadcasts,
        "idle supervisor broadcast while Paused"
    );
}

fn command_wakes_real_poller(kind: u8) {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    {
        let mut state = parking.mailbox.lock().unwrap();
        state.status = if kind == 0 {
            VmStatus::Running
        } else {
            VmStatus::Paused
        };
        state.generation = 1;
        state.requested = kind != 0;
    }
    let (ready, release) = crate::events::tests::PollGate::install(&mut events);
    let (tx, rx) = mpsc::channel();
    let (export, exported) = mpsc::channel();
    thread::scope(|scope| {
        let waiter = scope.spawn(|| events.wait(Some(crate::events::RECHECK)));
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        parking.send(match kind {
            0 => ParkCommand::Park(Arc::new(()), tx),
            1 => ParkCommand::Resume(1, tx),
            _ => ParkCommand::Export(Box::new(io::sink()), export),
        });
        release.send(()).unwrap();
        assert!(waiter.join().unwrap().unwrap().is_none());
    });
    assert_eq!(events.wake_polls, 1, "command did not wake mio poll");
    assert_eq!(events.poll_calls, 1, "command wake was swallowed");
    assert!(!sender.is_stopping());
    let (kick, wait) = parking.supervise(1, &sender);
    match kind {
        0 => {
            assert!(kick);
            assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Pausing);
        }
        1 => assert_eq!(rx.try_recv().unwrap(), Ok(1)),
        _ => {
            assert_eq!(
                wait,
                Duration::ZERO,
                "Export must reach export_pending without sleeping"
            );
            // Device admission is checked by the real exporter without capture I/O.
            #[cfg(target_arch = "x86_64")]
            {
                let ram =
                    crate::memory::GuestRam::new(&[(vm_memory::GuestAddress(0), 4096)]).unwrap();
                crate::Vm::export_pending(&parking, &crate::mock_vm::MockVm::new(), &ram, 1, true);
                assert!(matches!(
                    exported.recv().unwrap().0,
                    Err(Error::Control {
                        reason: ControlReason::UnsupportedDevice,
                        ..
                    })
                ));
                assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Paused);
                assert!(parking.mailbox.lock().unwrap().commands.is_empty());
                assert_eq!(parking.supervise(1, &sender).1, crate::events::RECHECK);
            }
            #[cfg(not(target_arch = "x86_64"))]
            drop(exported);
        }
    }
}

#[test]
fn park_command_wakes_real_poller() {
    command_wakes_real_poller(0);
}

#[test]
fn resume_command_wakes_real_poller() {
    command_wakes_real_poller(1);
}

#[test]
fn export_command_wakes_real_poller() {
    command_wakes_real_poller(2);
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn export_supervisor_rechecks_lifecycle_and_device_admission() {
    let events = EventLoop::new().unwrap();
    let parking = Parking::new(events.sender());
    let ram = crate::memory::GuestRam::new(&[(vm_memory::GuestAddress(0), 4096)]).unwrap();
    let host = crate::mock_vm::MockVm::new();
    for (status, devices, reason) in [
        (VmStatus::Running, false, ControlReason::InvalidState),
        (VmStatus::Paused, true, ControlReason::UnsupportedDevice),
    ] {
        parking.mailbox.lock().unwrap().status = status;
        let (tx, rx) = mpsc::channel();
        parking.send(ParkCommand::Export(Box::new(Vec::new()), tx));
        crate::Vm::export_pending(&parking, &host, &ram, 1, devices);
        let (result, writer) = rx.recv().unwrap();
        assert!(
            matches!(result, Err(Error::Control { operation: "export", reason: actual }) if actual == reason)
        );
        assert!(parking.mailbox.lock().unwrap().commands.is_empty());
        let writer: Box<dyn Any> = writer;
        assert!(writer.downcast::<Vec<u8>>().unwrap().is_empty());
    }
    for (status, requested) in [(VmStatus::Running, true), (VmStatus::Paused, false)] {
        let mut mailbox = parking.mailbox.lock().unwrap();
        mailbox.status = status;
        mailbox.requested = requested;
        drop(mailbox);
        assert!(matches!(
            crate::Vm::export_image(&parking, &host, &ram, 1, &mut Vec::new()),
            Err(Error::Control {
                operation: "export",
                reason: ControlReason::InvalidState
            })
        ));
        assert!(parking.mailbox.lock().unwrap().captures.is_empty());
    }
}

#[test]
fn terminal_parking_rejects_queued_and_new_export_commands() {
    let events = EventLoop::new().unwrap();
    let parking = Parking::new(events.sender());
    let (tx, rx) = mpsc::channel();
    parking.send(ParkCommand::Export(Box::new(io::sink()), tx));
    parking.stop();
    assert!(matches!(
        rx.recv().unwrap().0,
        Err(Error::Control {
            operation: "export",
            reason: ControlReason::TerminalOutcome
        })
    ));
    let (tx, rx) = mpsc::channel();
    parking.send(ParkCommand::Export(Box::new(io::sink()), tx));
    assert!(matches!(
        rx.recv().unwrap().0,
        Err(Error::Control {
            operation: "export",
            reason: ControlReason::InvalidState
        })
    ));
    assert!(parking.mailbox.lock().unwrap().commands.is_empty());
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn cancelled_capture_returns_a_terminal_error_without_an_image() {
    let events = EventLoop::new().unwrap();
    let parking = Parking::new(events.sender());
    {
        let mut state = parking.mailbox.lock().unwrap();
        state.status = VmStatus::Paused;
        state.requested = true;
    }
    let ram = crate::memory::GuestRam::new(&[(vm_memory::GuestAddress(0), 4096)]).unwrap();
    let host = crate::mock_vm::MockVm::new();
    let mut bytes = Vec::new();
    thread::scope(|scope| {
        let caller = scope.spawn(|| crate::Vm::export_image(&parking, &host, &ram, 1, &mut bytes));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some((id, reply)) = parking.mailbox.lock().unwrap().captures.pop_front() {
                assert_eq!(id, 0);
                drop(reply); // A lost owning worker must not strand the exporter.
                break;
            }
            if Instant::now() >= deadline {
                parking.stop();
                panic!("capture was not queued");
            }
            thread::yield_now();
        }
        assert!(matches!(
            caller.join().unwrap(),
            Err(Error::Control {
                operation: "export",
                reason: ControlReason::TerminalOutcome
            })
        ));
    });
    assert!(bytes.is_empty());
}

#[test]
fn control_and_snapshot_errors_keep_their_public_messages_and_causes() {
    use std::error::Error as _;
    for (reason, message) in [
        (ControlReason::InvalidState, "invalid state"),
        (
            ControlReason::UnsupportedDevice,
            "operation requires a device-less VM",
        ),
        (
            ControlReason::DeadlineTimeout,
            "vCPU acknowledgements are still incomplete",
        ),
        (ControlReason::TerminalOutcome, "the VM is stopping"),
    ] {
        assert_eq!(reason.to_string(), message);
        let error = reason.for_operation("export");
        assert_eq!(error.to_string(), format!("export: {message}"));
        assert!(error.source().is_none());
    }
    let error = Error::Snapshot(io::Error::new(io::ErrorKind::PermissionDenied, "denied"));
    assert_eq!(error.to_string(), "memory snapshot failed");
    assert_eq!(error.source().unwrap().to_string(), "denied");
}

#[test]
fn parking_stop_wakes_without_forging_a_terminal_event() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let (ready, release) = crate::events::tests::PollGate::install(&mut events);
    thread::scope(|scope| {
        let waiter = scope.spawn(|| events.wait(Some(crate::events::RECHECK)));
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        parking.stop();
        release.send(()).unwrap();
        assert!(waiter.join().unwrap().unwrap().is_none());
    });
    assert_eq!(events.wake_polls, 1);
    assert_eq!(events.poll_calls, 1);
    assert!(!sender.is_stopping());
    sender.send(Event::GuestReset);
    sender.send(Event::StopRequested);
    assert!(matches!(
        events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::GuestReset)
    ));
}

#[test]
fn checkpoint_ack_wakes_real_poller() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new(events.sender());
    let result = park(&parking);
    parking.supervise(1, &sender);
    // Consume the command wake before observing the independent ACK wake.
    assert!(events.wait(Some(crate::events::RECHECK)).unwrap().is_none());
    let previous = events.wake_polls;
    let (ready, release_poll) = crate::events::tests::PollGate::install(&mut events);
    let (progress, observed) = mpsc::channel();
    let (release_io, io_gate) = mpsc::channel();
    thread::scope(|scope| {
        let _abort = AbortParking(&parking);
        let _release = ReleaseIo(release_io.clone());
        let worker = scope.spawn(|| {
            parking.checkpoint(
                0,
                &mut FakeVcpu {
                    io_done: progress,
                    release_io: io_gate,
                    fail: false,
                },
            )
        });
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(1)).unwrap(),
            "completing"
        );
        thread::scope(|poll_scope| {
            let waiter = poll_scope.spawn(|| events.wait(Some(crate::events::RECHECK)));
            ready.recv_timeout(Duration::from_secs(1)).unwrap();
            release_io.send(()).unwrap();
            release_poll.send(()).unwrap();
            assert!(waiter.join().unwrap().unwrap().is_none());
        });
        assert_eq!(events.wake_polls, previous + 1, "ACK did not wake poll");
        parking.supervise(1, &sender);
        assert_eq!(result.try_recv().unwrap(), Ok(1));
        parking.stop();
        worker.join().unwrap().unwrap();
    });
}
