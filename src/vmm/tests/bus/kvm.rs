// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The port bus, a deferred MMIO access and an interrupt line under a real
//! KVM VM: a flat guest reaches a test device at its register offset, a
//! deferred read completes on the run thread's thread and reaches the guest,
//! and a line set through `KVM_IRQ_LINE` skips the host call for a repeated
//! level.

use std::sync::{Arc, Mutex};

use boxlite_hypervisor::{KvmVm, VcpuExit};
use mio::{Poll, Token, Waker as MioWaker};

use super::{BusDevice, BusIo, BusRange, Buses, Dispatch, PendingIo, accesses, recorder};
use crate::{
    bus::DeferredIo,
    flat_guest::FlatGuest,
    io::{Completer, Completion, ConfigBytes, Waker},
    irq::{IrqChip, IrqLine},
    virtio::control::ControlQueue,
};

/// The test device's ports, and the register the guest writes last.
const DEVICE: u64 = 0x500;
const DONE: u64 = 3;
/// Where the guest stores the byte it read.
const RESULT: u64 = 0x2000;
/// The deferred MMIO window.
const MMIO: u64 = 0xd000_0000;

/// The guest program, as 32-bit flat code.
#[rustfmt::skip]
const PROGRAM: &[u8] = &[
    0xba, 0x02, 0x05, 0x00, 0x00, // mov edx, 0x502: register 2
    0xb0, 0x5a, 0xee,             // mov al, 0x5a; out dx, al
    0xec,                         // in al, dx
    0xa2, 0x00, 0x20, 0x00, 0x00, // mov [0x2000], al
    0xba, 0x03, 0x05, 0x00, 0x00, // mov edx, 0x503: register 3
    0xee,                         // out dx, al: the byte read, as the last access
    0xf4, 0xeb, 0xfd,             // hlt; jmp hlt
];

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_flat_guest_reaches_a_port_device_at_its_register_offset() {
    let mut guest = FlatGuest::new(PROGRAM);
    let device = recorder(0x42);
    let mut buses = Buses::default();
    let shared: Arc<Mutex<dyn BusDevice>> = device.clone();
    buses
        .pio
        .insert(BusRange::new(DEVICE, 4).unwrap(), "test", Some((shared, 0)))
        .unwrap();

    let exits = guest.run(|exit| {
        if let Dispatch::Passthrough(exit) = buses.dispatch(exit) {
            panic!("{exit:?} is not an I/O exit");
        }
        !accesses(&device)
            .iter()
            .any(|(write, offset, _)| *write && *offset == DONE)
    });

    assert_eq!(exits, 3);
    assert_eq!(
        accesses(&device),
        [
            (true, 2, vec![0x5a]),
            (false, 2, vec![0]),
            (true, DONE, vec![0x42]),
        ],
        "the guest got the device's byte back"
    );
    let mut result = [0];
    guest.read(RESULT, &mut result);
    assert_eq!(result, [0x42]);
    assert_eq!(buses.pio.unclaimed(), (0, 0));
}

/// A device whose MMIO reads defer until the run thread advances them, then
/// answer `reply`.
struct Later {
    reply: u8,
    readiness: Option<(Completion<()>, Completer<()>)>,
}

impl BusDevice for Later {
    fn read(&mut self, _offset: u64, _len: usize) -> BusIo<ConfigBytes> {
        let (completion, completer) = Completion::new();
        self.readiness = Some((completion.clone(), completer));
        BusIo::Deferred(completion)
    }

    fn write(&mut self, _offset: u64, _data: &[u8]) -> BusIo<()> {
        BusIo::Complete(())
    }

    fn progress(&mut self, request: &mut PendingIo) -> BusIo<()> {
        if let PendingIo::Read { len, bytes, .. } = request {
            *bytes = Some(ConfigBytes::fill(self.reply, *len));
        }
        BusIo::Complete(())
    }
}

/// Guest program, as 32-bit flat code: read the deferred window, store what
/// it answered, and report the low byte on the device's last register.
#[rustfmt::skip]
const DEFERRED_PROGRAM: &[u8] = &[
    0xa1, 0x00, 0x00, 0x00, 0xd0, // mov eax, [0xd0000000]
    0xa3, 0x00, 0x20, 0x00, 0x00, // mov [0x2000], eax
    0xba, 0x03, 0x05, 0x00, 0x00, // mov edx, 0x503: the last register
    0xa0, 0x00, 0x20, 0x00, 0x00, // mov al, [0x2000]
    0xee,                         // out dx, al: the byte the device answered
    0xf4, 0xeb, 0xfd,             // hlt; jmp hlt
];

/// A real KVM vCPU leaves an MMIO read pending; the test advances it the way
/// the run thread does and the guest must see the device's answer.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_flat_guest_reads_a_deferred_mmio_access() {
    let mut guest = FlatGuest::new(DEFERRED_PROGRAM);
    let later = Arc::new(Mutex::new(Later {
        reply: 0x5a,
        readiness: None,
    }));
    let done = recorder(0);
    let mut buses = Buses::default();
    let deferred: Arc<Mutex<dyn BusDevice>> = later.clone();
    buses
        .mmio
        .insert(
            BusRange::new(MMIO, 0x10).unwrap(),
            "later",
            Some((deferred, 0)),
        )
        .unwrap();
    let shared: Arc<Mutex<dyn BusDevice>> = done.clone();
    buses
        .pio
        .insert(BusRange::new(DEVICE, 4).unwrap(), "done", Some((shared, 0)))
        .unwrap();
    let poll = Box::leak(Box::new(Poll::new().unwrap()));
    let control_waker = MioWaker::new(poll.registry(), Token(0)).unwrap();
    let queue = ControlQueue::new(Arc::new(control_waker));
    let handle = queue.handle();
    let waker: Waker = handle.waker();

    let exits = guest.run(|exit| {
        match buses.dispatch(exit) {
            Dispatch::Handled => {}
            Dispatch::Passthrough(exit) => panic!("{exit:?} is not an I/O exit"),
            Dispatch::DeferredRead {
                mut exit,
                completion,
                io,
            } => {
                handle.defer(DeferredIo::Read(io));
                queue.pump(&waker);
                let bytes = completion.wait().expect("the run thread answered");
                let VcpuExit::MmioRead { bytes: buffer, .. } = &mut exit else {
                    panic!("a deferred read carries a read exit");
                };
                buffer.copy_from_slice(bytes.as_slice());
            }
            Dispatch::DeferredWrite { .. } => panic!("the device defers no writes"),
        }
        !accesses(&done)
            .iter()
            .any(|(write, offset, _)| *write && *offset == DONE)
    });

    assert_eq!(exits, 2, "the deferred read, then the report");
    let mut result = [0; 4];
    guest.read(RESULT, &mut result);
    assert_eq!(result, [0x5a; 4], "the pending read reached the guest");
    assert_eq!(accesses(&done), [(true, DONE, vec![0x5a])]);
    assert_eq!(buses.mmio.unclaimed(), (0, 0));
    assert_eq!(buses.pio.unclaimed(), (0, 0));
}

/// KVM's interrupt controller, recording every host call that succeeded.
struct Recording {
    vm: Arc<KvmVm>,
    calls: Mutex<Vec<(u32, bool)>>,
}

impl IrqChip for Recording {
    fn set_line(&self, line: u32, level: bool) -> crate::error::Result<()> {
        self.vm.set_irq_line(line, level)?;
        self.calls.lock().unwrap().push((line, level));
        Ok(())
    }
}

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_line_reaches_kvm_and_a_repeated_level_makes_no_call() {
    let guest = FlatGuest::new(&[0xf4]);
    let chip = Arc::new(Recording {
        vm: Arc::clone(guest.vm()),
        calls: Mutex::default(),
    });

    let line = IrqLine::new(chip.clone(), 4);
    line.set_level(true).unwrap();
    line.set_level(true).unwrap();
    line.set_level(false).unwrap();
    line.pulse().unwrap();
    let held = IrqLine::new(chip.clone(), 5);
    held.set_level(true).unwrap();
    drop(held);

    assert_eq!(
        *chip.calls.lock().unwrap(),
        [
            (4, true),
            (4, false),
            (4, true),
            (4, false),
            (5, true),
            (5, false),
        ]
    );
}
