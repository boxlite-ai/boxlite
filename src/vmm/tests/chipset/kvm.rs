// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A chipset built over a real KVM VM: a flat guest reads a claimed and an
//! unclaimed port, and the device's line, armed by the build, reaches KVM.

use super::{Access, ChipsetBuilder, recorder};
use crate::{events::EventLoop, flat_guest::FlatGuest};

/// Where the guest stores what it read.
const RESULTS: u64 = 0x2000;

/// The guest program, as 32-bit flat code.
#[rustfmt::skip]
const PROGRAM: &[u8] = &[
    0xba, 0x00, 0x05, 0x00, 0x00, // mov edx, 0x500: the device's register 0
    0xec,                         // in al, dx
    0xa2, 0x00, 0x20, 0x00, 0x00, // mov [0x2000], al
    0xba, 0x80, 0x00, 0x00, 0x00, // mov edx, 0x80: nobody's port
    0xec,                         // in al, dx
    0xa2, 0x01, 0x20, 0x00, 0x00, // mov [0x2001], al
    0xba, 0x01, 0x05, 0x00, 0x00, // mov edx, 0x501: register 1, which pulses GSI 4
    0xee,                         // out dx, al
    0xf4, 0xeb, 0xfd,             // hlt; jmp hlt
];

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_flat_guest_reads_a_built_chipset() {
    let mut guest = FlatGuest::new(PROGRAM);
    let events = EventLoop::new().unwrap();
    let mut builder = ChipsetBuilder::new(guest.vm().clone(), events.sender());
    let (device, accesses) = recorder(0x42, None);
    let mut device = Some(device);
    builder
        .add("test", |r| {
            r.pio(0x500, 2);
            let mut device = device.take().unwrap();
            device.line = Some(r.line(4));
            Ok(device)
        })
        .unwrap();
    let chipset = builder.build().unwrap();

    let exits = guest.run(|exit| {
        if let Some(exit) = chipset.dispatch(exit) {
            panic!("{exit:?} is not an I/O exit");
        }
        accesses.lock().unwrap().len() < 2
    });

    let mut results = [0; 2];
    guest.read(RESULTS, &mut results);
    assert_eq!(exits, 3);
    assert_eq!(results, [0x42, 0xff], "the device's byte, then all ones");
    assert_eq!(
        *accesses.lock().unwrap(),
        [
            Access::Read {
                offset: 0,
                bytes: vec![0]
            },
            Access::Write {
                offset: 1,
                bytes: vec![0xff]
            }
        ]
    );
    assert_eq!(chipset.buses().pio.unclaimed(), (1, 0), "the read of 0x80");
}
