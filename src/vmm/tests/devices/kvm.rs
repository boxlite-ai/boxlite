// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The legacy platform under a real KVM vCPU, without a kernel: a flat
//! 32-bit guest writes COM1, reads the CMOS seconds and what no device
//! holds, and resets through the i8042.

use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use super::add_legacy_devices;
use crate::{
    chipset::ChipsetBuilder,
    devices::console::ConsoleWorker,
    events::{Event, EventLoop},
    flat_guest::FlatGuest,
};

/// Where the guest stores what it read, and the byte it must never reach.
const RESULTS: u64 = 0x2000;
const AFTER_RESET: usize = 0xc;
/// The CMOS RTC reports 2026-01-02T03:04:05Z.
const CMOS_TIME: i64 = 1_767_323_045_000_000_000;

/// Guest serial output, shared with the test.
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl Write for Output {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The guest program, as 32-bit flat code.
#[rustfmt::skip]
const PROGRAM: &[u8] = &[
    0xba, 0xf8, 0x03, 0x00, 0x00,       // mov edx, 0x3f8
    0xb0, b'O', 0xee,                   // mov al, 'O'; out dx, al
    0xb0, b'K', 0xee,                   // mov al, 'K'; out dx, al
    0x66, 0xed,                         // in ax, dx: a wide read the UART declines
    0x66, 0xa3, 0x06, 0x20, 0x00, 0x00, // mov [0x2006], ax
    0xba, 0x80, 0x00, 0x00, 0x00,       // mov edx, 0x80: nobody's port
    0xec,                               // in al, dx
    0xa2, 0x00, 0x20, 0x00, 0x00,       // mov [0x2000], al
    0xba, 0x70, 0x00, 0x00, 0x00,       // mov edx, 0x70
    0xb0, 0x00, 0xee,                   // mov al, 0; out dx, al: CMOS seconds
    0xba, 0x71, 0x00, 0x00, 0x00,       // mov edx, 0x71
    0xec,                               // in al, dx
    0xa2, 0x01, 0x20, 0x00, 0x00,       // mov [0x2001], al
    0xa1, 0x00, 0x00, 0x00, 0xd0,       // mov eax, [0xd0000000]: nobody's MMIO
    0xa3, 0x08, 0x20, 0x00, 0x00,       // mov [0x2008], eax
    0xc7, 0x05, 0x00, 0x00, 0x00, 0xd0, 0x78, 0x56, 0x34, 0x12, // mov dword [0xd0000000], 0x12345678
    0xba, 0x64, 0x00, 0x00, 0x00,       // mov edx, 0x64
    0xb0, 0xfe, 0xee,                   // mov al, 0xfe; out dx, al: reset
    0xc6, 0x05, 0x0c, 0x20, 0x00, 0x00, 0x01, // mov byte [0x200c], 1: must never run
    0xf4, 0xeb, 0xfd,                   // hlt; jmp hlt
];

#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm"]
fn a_flat_guest_drives_the_legacy_platform_until_its_reset() {
    let mut guest = FlatGuest::new(PROGRAM);
    let output = Output::default();
    let (writer, mut console) = ConsoleWorker::spawn(Box::new(output.clone()), 1024).unwrap();
    let mut events = EventLoop::new().unwrap();
    let mut builder = ChipsetBuilder::new(guest.vm().clone(), events.sender());
    add_legacy_devices(&mut builder, writer, Box::new(|| CMOS_TIME)).unwrap();
    let chipset = builder.build().unwrap();

    // The run stops at the first event, so the guest runs no instruction
    // after the exit that sent it.
    let mut end = None;
    let exits = guest.run(|exit| {
        if let Some(exit) = chipset.dispatch(exit) {
            panic!("{exit:?} is not an I/O exit");
        }
        end = events.wait(Some(Duration::ZERO)).unwrap();
        end.is_none()
    });
    console.finish();

    assert!(matches!(end, Some(Event::GuestReset)), "{end:?}");
    assert_eq!(*output.0.lock().unwrap(), b"OK");
    let mut results = [0u8; 0x10];
    guest.read(RESULTS, &mut results);
    assert_eq!(results[0], 0xff, "nobody's port reads all ones");
    assert_eq!(results[1], 0x05, "CMOS seconds, in BCD, from the clock");
    assert_eq!(&results[6..8], [0xff, 0xff], "a wide UART read is declined");
    assert_eq!(&results[8..12], [0xff; 4], "nobody's MMIO reads all ones");
    assert_eq!(
        results[AFTER_RESET], 0,
        "no instruction ran after the reset"
    );
    assert_eq!(chipset.buses().pio.unclaimed(), (1, 0), "the read of 0x80");
    assert_eq!(
        chipset.buses().mmio.unclaimed(),
        (1, 1),
        "the MMIO read and write"
    );
    // 'O', 'K', the wide read, port 0x80, the CMOS index and data, the MMIO
    // read and write, and the reset.
    assert_eq!(exits, 9);
}
