// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fmt::Debug,
    sync::{Arc, Barrier, mpsc},
    thread,
    time::{Duration, Instant},
};

use super::{Command, Lifecycle, VmStatus};
use crate::{
    ControlReason, DiskConfig, DiskFormat, Error, FsConfig, NetConfig, VmConfig, VmControl,
    VsockConfig,
    control::ControlRegistry,
    events::{Event, EventLoop},
};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod execution;

const WAIT: Duration = Duration::from_secs(10);

fn fixture(device_less: bool) -> (EventLoop, Arc<Lifecycle>, VmControl) {
    let events = EventLoop::new().unwrap();
    let lifecycle = Arc::new(Lifecycle::new(events.sender(), device_less));
    let control = ControlRegistry::default().finish(Arc::clone(&lifecycle));
    (events, lifecycle, control)
}

fn assert_error(result: crate::Result<()>, operation: &str, reason: ControlReason) {
    assert!(
        matches!(&result, Err(Error::Control { operation: op, reason: why })
            if *op == operation && *why == reason),
        "{result:?}"
    );
}

#[test]
fn control_is_clone_send_sync_and_debug() {
    fn assert_traits<T: Clone + Send + Sync + Debug>() {}
    assert_traits::<VmControl>();
}

#[test]
fn stop_latches_one_event_and_is_idempotent_after_exit() {
    let (mut events, lifecycle, control) = fixture(true);
    let sender = events.sender();

    assert_eq!(control.status(), VmStatus::Created);
    control.stop();
    control.clone().stop();
    assert_eq!(control.status(), VmStatus::Stopping);
    assert!(!lifecycle.state().run_claimed);
    assert!(sender.is_stopping());
    assert!(matches!(
        events.wait(Some(Duration::ZERO)).unwrap(),
        Some(Event::StopRequested)
    ));
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());

    #[cfg(target_arch = "x86_64")]
    {
        assert!(matches!(lifecycle.begin_run(), Ok(false)));
        assert!(matches!(lifecycle.begin_run(), Err(Error::AlreadyRan)));
    }

    lifecycle.mark_exited();
    control.stop();
    assert_eq!(control.status(), VmStatus::Exited);
    assert!(lifecycle.state().sender.is_none());
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn created_pause_reservation_survives_wait_timeouts_and_disallows_resume() {
    let (_, _, control) = fixture(false);
    assert_error(control.pause(), "pause", ControlReason::UnsupportedDevice);

    let (_, lifecycle, control) = fixture(true);
    assert_error(control.resume(), "resume", ControlReason::InvalidState);
    assert_error(
        control.wait_paused(Duration::ZERO),
        "wait_paused",
        ControlReason::InvalidState,
    );
    control.pause().unwrap();
    assert_eq!(control.status(), VmStatus::Created);
    assert_error(control.pause(), "pause", ControlReason::InvalidState);
    assert_error(control.resume(), "resume", ControlReason::InvalidState);
    for timeout in [Duration::ZERO, Duration::from_millis(10), Duration::ZERO] {
        assert_error(
            control.wait_paused(timeout),
            "wait_paused",
            ControlReason::DeadlineTimeout,
        );
    }
    assert!(lifecycle.state().command.is_some());
}

#[test]
fn created_pause_has_one_winner_and_stop_or_exit_releases_waiters() {
    for stop in [true, false] {
        let (_, lifecycle, control) = fixture(true);
        let other = control.clone();
        let contender = thread::spawn(move || other.pause());
        let first = control.pause();
        let second = contender.join().unwrap();
        match (first, second) {
            (Ok(()), rejected) | (rejected, Ok(())) => {
                assert_error(rejected, "pause", ControlReason::InvalidState);
            }
            results => panic!("expected one initial pause reservation: {results:?}"),
        }
        thread::scope(|scope| {
            let (ready, waiting) = mpsc::channel();
            let waiters = [&lifecycle; 2].map(|lifecycle| {
                let ready = ready.clone();
                scope.spawn(move || {
                    let state = lifecycle.state();
                    let Some(Command::Park(epoch)) = state.command else {
                        panic!("initial pause was never reserved");
                    };
                    // Signal while holding the lock so teardown cannot run
                    // before this waiter releases it in the condition wait.
                    ready.send(()).unwrap();
                    lifecycle.await_pause(state, epoch, WAIT).1
                })
            });
            for _ in 0..waiters.len() {
                waiting.recv_timeout(WAIT).unwrap();
            }
            let terminating = Instant::now();
            if stop {
                control.stop();
            } else {
                lifecycle.mark_exited();
            }
            for waiter in waiters {
                assert_eq!(waiter.join().unwrap(), Err(ControlReason::TerminalOutcome));
            }
            assert!(terminating.elapsed() < WAIT / 2);
        });
        assert_error(control.pause(), "pause", ControlReason::InvalidState);
        assert_error(control.resume(), "resume", ControlReason::InvalidState);
    }
}

#[test]
fn driver_requires_a_distinct_ack_from_every_vcpu_in_the_current_epoch() {
    for count in [1, 64] {
        let (mut events, lifecycle, control) = fixture(true);
        control.pause().unwrap();
        assert!(lifecycle.begin_run().unwrap());
        assert!(matches!(lifecycle.begin_run(), Err(Error::AlreadyRan)));
        assert_eq!(control.status(), VmStatus::Pausing);
        assert_error(control.pause(), "pause", ControlReason::InvalidState);
        assert_error(control.resume(), "resume", ControlReason::InvalidState);
        let epoch = lifecycle.state().epoch;
        for id in 0..count - 1 {
            lifecycle.state().acknowledge(epoch, id);
        }
        if count > 1 {
            lifecycle.state().acknowledge(epoch, 0);
        }
        lifecycle.state().acknowledge(epoch, count);
        lifecycle.state().acknowledge(epoch - 1, count - 1);
        lifecycle.drive(count);
        assert_error(
            control.wait_paused(Duration::ZERO),
            "wait_paused",
            ControlReason::DeadlineTimeout,
        );
        for _ in 0..2 {
            lifecycle.state().acknowledge(epoch, count - 1);
        }
        assert!(!lifecycle.drive(count));
        assert_eq!(control.status(), VmStatus::Paused);
        control.wait_paused(Duration::ZERO).unwrap();

        let other = control.clone();
        let resume = thread::spawn(move || other.resume());
        assert!(events.wait(Some(WAIT)).unwrap().is_none());
        assert!(!lifecycle.drive(count));
        resume.join().unwrap().unwrap();
        assert_eq!(control.status(), VmStatus::Running);
        assert_error(
            control.wait_paused(Duration::ZERO),
            "wait_paused",
            ControlReason::InvalidState,
        );
    }
}

#[test]
fn epoch_overflow_rejects_pause_without_claiming_the_slot() {
    let (_, lifecycle, control) = fixture(true);
    lifecycle.begin_run().unwrap();
    lifecycle.state().epoch = u64::MAX;
    assert_error(control.pause(), "pause", ControlReason::InvalidState);
    assert_eq!(control.status(), VmStatus::Running);
    assert!(lifecycle.state().command.is_none());
}

#[test]
fn pause_timeout_withdraws_only_an_unaccepted_command() {
    let (mut events, lifecycle, control) = fixture(true);
    lifecycle.begin_run().unwrap();
    assert_error(
        lifecycle.pause(Duration::from_millis(10)),
        "pause",
        ControlReason::DeadlineTimeout,
    );
    assert!(!lifecycle.drive(1));
    assert_eq!(control.status(), VmStatus::Running);
    assert!(events.wait(Some(WAIT)).unwrap().is_none()); // Withdrawn request's wake.

    let driver_state = lifecycle.clone();
    let pause = thread::spawn(move || driver_state.pause(Duration::from_secs(1)));
    assert!(events.wait(Some(WAIT)).unwrap().is_none());
    assert!(lifecycle.drive(1));
    assert_error(
        pause.join().unwrap(),
        "pause",
        ControlReason::DeadlineTimeout,
    );
    assert_eq!(control.status(), VmStatus::Pausing);
    assert_error(control.pause(), "pause", ControlReason::InvalidState);
    let epoch = lifecycle.state().epoch;
    lifecycle.state().acknowledge(epoch, 0);
    lifecycle.drive(1);
    control.wait_paused(Duration::ZERO).unwrap();
}

#[test]
fn competing_clones_claim_only_one_command_slot() {
    let (mut events, lifecycle, control) = fixture(true);
    lifecycle.begin_run().unwrap();

    for (operation, request) in [
        (
            "pause",
            VmControl::pause as fn(&VmControl) -> crate::Result<()>,
        ),
        ("resume", VmControl::resume),
        ("pause", VmControl::pause),
    ] {
        let start = Arc::new(Barrier::new(2));
        let (done, result) = mpsc::channel();
        let callers = [control.clone(), control.clone()].map(|control| {
            let (start, done) = (start.clone(), done.clone());
            thread::spawn(move || {
                start.wait();
                done.send(request(&control)).unwrap();
            })
        });
        let rejected = result.recv_timeout(WAIT).unwrap();
        assert!(events.wait(Some(WAIT)).unwrap().is_none());
        if lifecycle.drive(1) {
            let epoch = lifecycle.state().epoch;
            if epoch > 1 {
                lifecycle.state().acknowledge(epoch - 1, 0);
                lifecycle.drive(1);
                assert_error(
                    control.wait_paused(Duration::ZERO),
                    "wait_paused",
                    ControlReason::DeadlineTimeout,
                );
            }
            lifecycle.state().acknowledge(epoch, 0);
            lifecycle.drive(1);
        }
        assert_error(rejected, operation, ControlReason::InvalidState);
        result.recv_timeout(WAIT).unwrap().unwrap();
        for caller in callers {
            caller.join().unwrap();
        }
    }
}

#[test]
fn terminal_stop_rejects_queued_and_accepted_operations() {
    for (operation, accepted) in [("pause", false), ("pause", true), ("resume", false)] {
        let (mut events, lifecycle, control) = fixture(true);
        if operation == "resume" {
            control.pause().unwrap();
        }
        lifecycle.begin_run().unwrap();
        if operation == "resume" {
            lifecycle.state().acknowledge(1, 0);
            lifecycle.drive(1);
        }

        let other = control.clone();
        let request = thread::spawn(move || match operation {
            "pause" => other.pause(),
            _ => other.resume(),
        });
        assert!(events.wait(Some(WAIT)).unwrap().is_none());
        if accepted {
            assert!(lifecycle.drive(1));
            events.sender().send(Event::GuestShutdown);
            lifecycle.state().acknowledge(1, 0);
            assert!(!lifecycle.drive(1));
            assert_ne!(control.status(), VmStatus::Paused);
            lifecycle.mark_stopping();
        } else {
            control.stop();
        }
        assert_error(
            request.join().unwrap(),
            operation,
            ControlReason::TerminalOutcome,
        );
        assert_error(
            control.wait_paused(Duration::ZERO),
            "wait_paused",
            ControlReason::TerminalOutcome,
        );
    }
}

#[test]
fn device_less_validation_rejects_each_userspace_device() {
    let empty = VmConfig {
        vcpu_count: 1,
        memory_mib: 16,
        kernel: "vmlinux".into(),
        cmdline: String::new(),
        initramfs: None,
        disks: Vec::new(),
        filesystem: None,
        vsock: None,
        network: None,
        virtio_console: false,
        hotplug_mib: 0,
    };
    empty.validate_device_less().unwrap();
    assert!(matches!(
        VmConfig {
            vcpu_count: 0,
            ..empty.clone()
        }
        .validate_device_less(),
        Err(Error::InvalidVcpuCount(0))
    ));

    for config in [
        VmConfig {
            disks: vec![DiskConfig {
                block_id: "data".into(),
                path: "disk.raw".into(),
                format: DiskFormat::Raw,
                read_only: true,
            }],
            ..empty.clone()
        },
        VmConfig {
            filesystem: Some(FsConfig {
                tag: "shared".into(),
                shares: Vec::new(),
            }),
            ..empty.clone()
        },
        VmConfig {
            vsock: Some(VsockConfig {
                cid: 3,
                listen: Vec::new(),
                connect: Vec::new(),
            }),
            ..empty.clone()
        },
        VmConfig {
            network: Some(NetConfig {
                path: "network.sock".into(),
                mac: [2, 0, 0, 0, 0, 1],
            }),
            ..empty.clone()
        },
        VmConfig {
            virtio_console: true,
            ..empty.clone()
        },
        VmConfig {
            hotplug_mib: 128,
            ..empty
        },
    ] {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        let error = crate::Vm::new_device_less(config).unwrap_err();
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        let error = config.validate_device_less().unwrap_err();

        assert!(matches!(
            error,
            Error::Control {
                operation: "new_device_less",
                reason: ControlReason::UnsupportedDevice,
            }
        ));
    }
}
