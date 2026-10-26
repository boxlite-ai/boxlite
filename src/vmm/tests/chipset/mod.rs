// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The chipset builder: claims, every conflict in one report, lines that
//! are not armed until the build, dispatch to the device at its offset, and
//! sharing across vCPU threads.

use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use boxlite_hypervisor::VcpuExit;

use super::{BusKind, ChipsetBuilder, Conflict};
#[cfg(target_arch = "x86_64")]
use crate::bus::UNCLAIMED_READ;
use crate::{
    bus::BusDevice,
    error::Error,
    events::{Event, EventLoop, EventSender},
    irq::IrqLine,
    mock_vm::{Call, MockVm},
};

/// One access a recorder saw, at its register offset, with the bytes it
/// arrived with.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Access {
    Read { offset: u64, bytes: Vec<u8> },
    Write { offset: u64, bytes: Vec<u8> },
}

/// Every access a recorder saw, shared with the test.
type Accesses = Arc<Mutex<Vec<Access>>>;

/// Records every access and answers reads with `reply`.
struct Recorder {
    accesses: Accesses,
    reply: u8,
    line: Option<IrqLine>,
}

impl BusDevice for Recorder {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        self.accesses.lock().unwrap().push(Access::Read {
            offset,
            bytes: data.to_vec(),
        });
        data.fill(self.reply);
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        self.accesses.lock().unwrap().push(Access::Write {
            offset,
            bytes: data.to_vec(),
        });
        if let Some(line) = &self.line {
            line.pulse().unwrap();
        }
    }
}

fn recorder(reply: u8, line: Option<IrqLine>) -> (Recorder, Accesses) {
    let accesses = Accesses::default();
    (
        Recorder {
            accesses: accesses.clone(),
            reply,
            line,
        },
        accesses,
    )
}

fn builder(vm: &Arc<MockVm>) -> (ChipsetBuilder, EventLoop) {
    let events = EventLoop::new().unwrap();
    (ChipsetBuilder::new(vm.clone(), events.sender()), events)
}

#[cfg(target_arch = "x86_64")]
#[test]
fn build_reports_every_conflict_at_once_naming_both_sides() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);
    builder.reserve(BusKind::Pio, 0x40, 4, "in-kernel PIT");
    builder.reserve(BusKind::Mmio, 0xfee0_0000, 0x1000, "in-kernel local APIC");

    builder
        .add("com1", |r| {
            r.pio(0x3f8, 8);
            Ok(recorder(0, Some(r.line(4))).0)
        })
        .unwrap();
    builder
        .add("intruder", |r| {
            r.pio(0x3fe, 4); // runs into com1
            r.pio(0x42, 1); // the PIT's
            r.mmio(0xfee0_0800, 0x10); // the local APIC's
            r.mmio(0x1000, 0); // empty
            Ok(recorder(0, Some(r.line(4))).0) // com1's line
        })
        .unwrap();
    builder
        .add("quiet", |r| {
            r.pio(0x70, 2);
            Ok(recorder(0, None).0)
        })
        .unwrap();

    let error = builder.build().err().expect("conflicts fail the build");
    let Error::ChipsetConflicts(conflicts) = &error else {
        panic!("{error:?}");
    };
    assert_eq!(
        conflicts,
        &[
            Conflict::RangeTaken {
                bus: BusKind::Pio,
                claimant: "intruder",
                base: 0x3fe,
                len: 4,
                owner: "com1",
            },
            Conflict::RangeTaken {
                bus: BusKind::Pio,
                claimant: "intruder",
                base: 0x42,
                len: 1,
                owner: "in-kernel PIT",
            },
            Conflict::RangeTaken {
                bus: BusKind::Mmio,
                claimant: "intruder",
                base: 0xfee0_0800,
                len: 0x10,
                owner: "in-kernel local APIC",
            },
            Conflict::InvalidRange {
                bus: BusKind::Mmio,
                claimant: "intruder",
                base: 0x1000,
                len: 0,
            },
            Conflict::LineTaken {
                line: 4,
                claimant: "intruder",
                owner: "com1",
            },
        ]
    );
    assert_eq!(
        error.to_string(),
        "5 chipset conflict(s): \
         intruder claims port range 0x3fe+0x4, held by com1; \
         intruder claims port range 0x42+0x1, held by in-kernel PIT; \
         intruder claims MMIO range 0xfee00800+0x10, held by in-kernel local APIC; \
         intruder claims MMIO range 0x1000+0x0, which is empty or wraps; \
         intruder claims interrupt line 4, held by com1;"
    );
}

#[cfg(target_arch = "x86_64")]
#[test]
fn a_built_chipset_dispatches_to_each_device_at_its_register_offset() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);
    let (serial, serial_accesses) = recorder(0x60, None);
    let (controller, controller_accesses) = recorder(0, None);
    builder
        .add("com1", |r| {
            r.pio(0x3f8, 8);
            Ok(serial)
        })
        .unwrap();
    builder
        .add("i8042", |r| {
            r.pio(0x60, 1);
            r.pio_with_offset(0x64, 1, 4);
            Ok(controller)
        })
        .unwrap();
    let chipset = builder.build().unwrap();

    let mut line_status = [0];
    assert!(
        chipset
            .dispatch(VcpuExit::IoIn {
                port: 0x3fd,
                bytes: &mut line_status,
            })
            .is_none()
    );
    assert!(
        chipset
            .dispatch(VcpuExit::IoOut {
                port: 0x64,
                bytes: &[0xfe],
            })
            .is_none()
    );
    let mut between_i8042_ports = [0];
    assert!(
        chipset
            .dispatch(VcpuExit::IoIn {
                port: 0x61,
                bytes: &mut between_i8042_ports,
            })
            .is_none()
    );
    assert!(matches!(
        chipset.dispatch(VcpuExit::Halted),
        Some(VcpuExit::Halted)
    ));

    assert_eq!(line_status, [0x60]);
    assert_eq!(between_i8042_ports, [UNCLAIMED_READ]);
    assert_eq!(
        *serial_accesses.lock().unwrap(),
        [Access::Read {
            offset: 5,
            bytes: vec![0]
        }]
    );
    assert_eq!(
        *controller_accesses.lock().unwrap(),
        [Access::Write {
            offset: 4,
            bytes: vec![0xfe]
        }]
    );
    assert_eq!(chipset.buses().pio.unclaimed(), (1, 0));
}

/// The arm64 platform claims only MMIO ranges and SPIs; the same rules hold.
#[test]
fn mmio_claims_and_lines_conflict_on_every_architecture() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);
    builder.reserve(
        BusKind::Mmio,
        0x3fff_0000,
        0x1_0000,
        "in-kernel GIC distributor",
    );
    builder
        .add("uart", |r| {
            r.mmio(0x4000_2000, 0x1000);
            Ok(recorder(0, Some(r.line(32))).0)
        })
        .unwrap();
    builder
        .add("rtc", |r| {
            r.mmio(0x4000_2800, 0x1000); // runs into the UART
            r.mmio(0x3fff_8000, 0x100); // inside the distributor
            Ok(recorder(0, Some(r.line(32))).0) // the UART's line
        })
        .unwrap();

    let error = builder.build().err().expect("conflicts fail the build");
    let Error::ChipsetConflicts(conflicts) = &error else {
        panic!("{error:?}");
    };
    assert_eq!(
        conflicts,
        &[
            Conflict::RangeTaken {
                bus: BusKind::Mmio,
                claimant: "rtc",
                base: 0x4000_2800,
                len: 0x1000,
                owner: "uart",
            },
            Conflict::RangeTaken {
                bus: BusKind::Mmio,
                claimant: "rtc",
                base: 0x3fff_8000,
                len: 0x100,
                owner: "in-kernel GIC distributor",
            },
            Conflict::LineTaken {
                line: 32,
                claimant: "rtc",
                owner: "uart",
            },
        ]
    );
}

/// A line claimed in a constructor reaches the host only once the build
/// succeeds, so a device that a conflict discards never raised anything.
#[test]
fn a_constructor_cannot_raise_a_line_before_the_build() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);
    builder
        .add("com1", |r| Ok(recorder(0, Some(r.line(4))).0))
        .unwrap();
    builder
        .add("eager", |r| {
            let line = r.line(4);
            let error = line.pulse().unwrap_err();
            assert!(matches!(error, Error::LineNotArmed(4)), "{error:?}");
            Ok(recorder(0, Some(line)).0)
        })
        .unwrap();

    let error = builder.build().err().expect("GSI 4 is claimed twice");

    assert!(
        matches!(&error, Error::ChipsetConflicts(conflicts) if conflicts.len() == 1),
        "{error:?}"
    );
    assert_eq!(
        vm.calls(),
        [],
        "no host call before or after the failed build"
    );
}

/// A rejected claim does not take the line, so every later claimant is
/// told about the first owner.
#[test]
fn every_line_conflict_names_the_first_owner() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);
    for name in ["com1", "second", "third"] {
        builder
            .add(name, |r| Ok(recorder(0, Some(r.line(4))).0))
            .unwrap();
    }

    let error = builder.build().err().expect("GSI 4 is claimed thrice");

    let Error::ChipsetConflicts(conflicts) = &error else {
        panic!("{error:?}");
    };
    assert_eq!(
        conflicts,
        &[
            Conflict::LineTaken {
                line: 4,
                claimant: "second",
                owner: "com1",
            },
            Conflict::LineTaken {
                line: 4,
                claimant: "third",
                owner: "com1",
            },
        ]
    );
}

#[test]
fn lines_reach_the_host_once_the_build_succeeds() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);
    let mut line = None;
    builder
        .add("uart", |r| {
            r.mmio(0x4000_2000, 0x1000);
            line = Some(r.line(32));
            Ok(recorder(0, None).0)
        })
        .unwrap();

    let chipset = builder.build().unwrap();
    line.expect("the constructor ran").pulse().unwrap();

    assert_eq!(
        vm.calls(),
        [
            Call::SetIrqLine {
                line: 32,
                level: true
            },
            Call::SetIrqLine {
                line: 32,
                level: false
            },
        ]
    );
    drop(chipset);
}

/// Ends the VM on any write, through the sender its constructor kept.
struct Resetter(EventSender);

impl BusDevice for Resetter {
    fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

    fn write(&mut self, _offset: u64, _data: &[u8]) {
        self.0.send(Event::GuestReset);
    }
}

#[test]
fn a_device_ends_the_vm_through_the_builders_event_loop() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, mut events) = builder(&vm);
    builder
        .add("reset", |r| {
            r.mmio(0x1000, 1);
            Ok(Resetter(r.event_sender()))
        })
        .unwrap();
    let chipset = builder.build().unwrap();
    assert!(events.wait(Some(Duration::ZERO)).unwrap().is_none());

    chipset.dispatch(VcpuExit::MmioWrite {
        guest_addr: 0x1000,
        bytes: &[1],
    });

    let event = events.wait(Some(Duration::ZERO)).unwrap();
    assert!(matches!(event, Some(Event::GuestReset)), "{event:?}");
}

#[test]
fn a_device_constructor_failure_ends_the_build_at_once() {
    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);

    let error = builder
        .add("broken", |r| -> crate::error::Result<Recorder> {
            r.mmio(0x1000, 0x10);
            Err(Error::InvalidVcpuCount(0))
        })
        .unwrap_err();

    assert!(matches!(error, Error::InvalidVcpuCount(0)), "{error:?}");
    assert!(builder.build().is_ok(), "the failed device left no claim");
}

#[test]
fn one_chipset_serves_every_vcpu_thread_and_devices_keep_their_lines() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<super::Chipset>();

    let vm = Arc::new(MockVm::new());
    let (mut builder, _events) = builder(&vm);
    let (device, accesses) = recorder(0x5a, None);
    let (notifier, _) = recorder(0, None);
    builder
        .add("virtio0", |r| {
            r.mmio(0xd000_0000, 0x1000);
            Ok(device)
        })
        .unwrap();
    builder
        .add("virtio1", |r| {
            r.mmio(0xd000_1000, 0x1000);
            let line = r.line(5);
            Ok(Recorder {
                line: Some(line),
                ..notifier
            })
        })
        .unwrap();
    let chipset = Arc::new(builder.build().unwrap());

    let threads: Vec<_> = (0..4)
        .map(|vcpu| {
            let chipset = Arc::clone(&chipset);
            thread::spawn(move || {
                for round in 0..250u64 {
                    let mut data = [0; 4];
                    assert!(
                        chipset
                            .dispatch(VcpuExit::MmioRead {
                                guest_addr: 0xd000_0000 + round % 0x1000,
                                bytes: &mut data,
                            })
                            .is_none()
                    );
                    assert_eq!(data, [0x5a; 4]);
                    chipset.dispatch(VcpuExit::MmioWrite {
                        guest_addr: 0xd000_1050,
                        bytes: &[vcpu],
                    });
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }

    assert_eq!(accesses.lock().unwrap().len(), 1000);
    let edges = vm
        .calls()
        .iter()
        .filter(|call| {
            matches!(
                call,
                Call::SetIrqLine {
                    line: 5,
                    level: true
                }
            )
        })
        .count();
    assert_eq!(edges, 1000, "every notify pulsed virtio1's line");
    assert_eq!(chipset.buses().mmio.unclaimed(), (0, 0));
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "kvm.rs"]
mod kvm;
