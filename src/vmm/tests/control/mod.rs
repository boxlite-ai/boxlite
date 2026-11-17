// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Epoch/ACK protocol tests run on every host; owned execution tests use the
//! x86_64 mock driver. Hardware tests require Linux x86_64 and /dev/kvm.

use std::{io, sync::mpsc, thread, time::Duration};

use boxlite_hypervisor::{Vcpu, VcpuExit, VcpuHandle};

use super::*;
use crate::events::{Event, EventLoop};

fn park(parking: &Parking, timeout: Duration) -> mpsc::Receiver<ParkResult> {
    let (tx, rx) = mpsc::channel();
    parking.send(ParkCommand::Park(Instant::now() + timeout, tx));
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
}

#[test]
fn all_ack_bits_are_required_and_duplicates_and_late_epochs_do_not_count() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new();
    let result = park(&parking, Duration::from_secs(10));
    assert!(parking.supervise(3, &sender).0);
    for (generation, id) in [(0, 0), (2, 0), (1, 3), (1, 64), (1, 0), (1, 0), (1, 2)] {
        ack(&parking, generation, id);
    }
    parking.supervise(3, &sender);
    assert_eq!(result.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Running);
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

    let result = park(&parking, Duration::from_secs(10));
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
    let parking = Parking::new();
    let result = park(&parking, Duration::from_secs(10));
    parking.supervise(64, &sender);
    for id in 0..64 {
        ack(&parking, 1, id);
    }
    parking.supervise(64, &sender);
    assert_eq!(result.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(1));
    resume(&parking, 1, &sender, 64).unwrap();
    parking.mailbox.lock().unwrap().generation = u64::MAX;
    let result = park(&parking, Duration::from_secs(10));
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
    let parking = Parking::new();
    let first = park(&parking, Duration::from_secs(10));
    let second = park(&parking, Duration::from_secs(10));
    parking.supervise(1, &sender);
    assert_eq!(
        second.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::InvalidState)
    );
    ack(&parking, 1, 0);
    parking.supervise(1, &sender);
    assert_eq!(first.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(1));
    let repeated = park(&parking, Duration::from_secs(10));
    parking.supervise(1, &sender);
    assert_eq!(
        repeated.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::InvalidState)
    );
}

#[test]
fn timeout_is_terminal_and_late_ack_cannot_publish_paused() {
    let mut events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new();
    let result = park(&parking, Duration::ZERO);
    parking.supervise(2, &sender);
    assert_eq!(
        result.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::DeadlineTimeout)
    );
    assert!(sender.is_stopping());
    assert!(matches!(
        events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::StopRequested)
    ));
    for id in 0..2 {
        ack(&parking, 1, id);
    }
    parking.supervise(2, &sender);
    assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Stopping);
    let rejected = park(&parking, Duration::from_secs(1));
    assert_eq!(
        rejected.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::InvalidState)
    );
}

#[test]
fn terminal_stop_wins_over_queued_pause_or_final_ack() {
    for last_ack in [false, true] {
        let events = EventLoop::new().unwrap();
        let sender = events.sender();
        let parking = Parking::new();
        let result = park(&parking, Duration::from_secs(10));
        if last_ack {
            parking.supervise(1, &sender);
            ack(&parking, 1, 0);
        }
        sender.send(Event::StopRequested);
        parking.supervise(1, &sender);
        assert_eq!(
            result.recv_timeout(Duration::from_secs(1)).unwrap(),
            Err(ControlReason::TerminalOutcome)
        );
        assert_eq!(parking.mailbox.lock().unwrap().status, VmStatus::Stopping);
    }
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
    let parking = Parking::new();
    let result = park(&parking, Duration::from_secs(10));
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
        parking.wait_for_ack(Duration::from_secs(1));
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
    let parking = Parking::new();
    let result = park(&parking, Duration::from_secs(10));
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
    }
}

#[cfg(target_arch = "x86_64")]
mod execution;

#[test]
fn condvar_wait_observes_the_parking_deadline_without_ack() {
    let events = EventLoop::new().unwrap();
    let sender = events.sender();
    let parking = Parking::new();
    let result = park(&parking, Duration::from_secs(10));
    parking.supervise(1, &sender);
    parking
        .mailbox
        .lock()
        .unwrap()
        .pending
        .as_mut()
        .unwrap()
        .deadline = Instant::now() + Duration::from_millis(5);
    assert_eq!(parking.wait_for_ack(Duration::from_secs(1)), Duration::ZERO);
    parking.supervise(1, &sender);
    assert_eq!(
        result.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(ControlReason::DeadlineTimeout)
    );
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
    let parking = Arc::new(Parking::new());
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
    let parking = Arc::new(Parking::new());
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
        parking.wait_for_ack(Duration::from_secs(1));
        parking.supervise(1, &sender);
        wait_for_command(&parking);
        parking.supervise(1, &sender);
        caller.join().unwrap();
        worker.join().unwrap();
    });
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
    let parking = Arc::new(Parking::new());
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
            handle.export(&path),
            Err(Error::Control {
                reason: ControlReason::InvalidState,
                ..
            })
        ));
    }
    parking.mailbox.lock().unwrap().status = VmStatus::Paused;
    handle.devices = true;
    assert!(matches!(
        handle.export(&path),
        Err(Error::Control {
            reason: ControlReason::UnsupportedDevice,
            ..
        })
    ));
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
    let parking = Parking::new();
    let result = park(&parking, Duration::from_secs(10));
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

#[test]
fn pause_resume_and_export_commands_interrupt_the_supervisor_wait() {
    let parking = Parking::new();
    for kind in 0..3 {
        parking.mailbox.lock().unwrap().status = if kind == 0 {
            VmStatus::Running
        } else {
            VmStatus::Paused
        };
        thread::scope(|scope| {
            let (ready, waiting) = mpsc::channel();
            let parking = &parking;
            *parking.ack_wait_ready.lock().unwrap() = Some(ready);
            let waiter = scope.spawn(move || parking.wait_for_ack(Duration::from_secs(5)));
            waiting.recv().unwrap();
            // The ready signal is sent with this lock held inside wait_for_ack.
            // Acquiring it proves the condvar wait has released the mailbox.
            drop(parking.mailbox.lock().unwrap());
            let (tx, _rx) = mpsc::channel();
            let command = match kind {
                0 => ParkCommand::Park(Instant::now() + Duration::from_secs(10), tx),
                1 => ParkCommand::Resume(1, tx),
                _ => {
                    let (tx, _rx) = mpsc::channel();
                    ParkCommand::Export("unused".into(), tx)
                }
            };
            let sent = Instant::now();
            let broadcasts = parking.broadcasts.load(Ordering::Relaxed);
            parking.send(command);
            // A waiter whose own timeout already expired also returns zero
            // elapsed; the broadcast makes the wake independent of that.
            assert!(
                parking.broadcasts.load(Ordering::Relaxed) > broadcasts,
                "command {kind} did not broadcast"
            );
            assert_eq!(
                waiter.join().unwrap(),
                Duration::ZERO,
                "command {kind} did not wake supervisor"
            );
            assert!(
                sent.elapsed() < Duration::from_secs(1),
                "command {kind} waited for the poll timeout"
            );
        });
        parking.mailbox.lock().unwrap().commands.clear();
    }
}
