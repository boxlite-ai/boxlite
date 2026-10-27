// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The port bus and an interrupt line under a real KVM VM: a flat guest
//! reaches a test device at its register offset, and a line set through
//! `KVM_IRQ_LINE` skips the host call for a repeated level.

use std::sync::{Arc, Mutex};

use boxlite_hypervisor::KvmVm;

use super::{BusDevice, BusRange, Buses, accesses, recorder};
use crate::{
    flat_guest::FlatGuest,
    irq::{IrqChip, IrqLine},
};

/// The test device's ports, and the register the guest writes last.
const DEVICE: u64 = 0x500;
const DONE: u64 = 3;
/// Where the guest stores the byte it read.
const RESULT: u64 = 0x2000;

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
        if let Some(exit) = buses.dispatch(exit) {
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
