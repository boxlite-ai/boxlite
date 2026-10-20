// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The legacy devices through the port bus, with the mock VM as the interrupt
//! controller: serial output and THRE, a failing sink, a failing interrupt,
//! the i8042 reset, and the port map.

use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use super::DeviceManager;
use crate::{
    bus::{Buses, UNCLAIMED_READ},
    error::Error,
    events::{Event, EventLoop},
    mock_vm::{Call, MockVm},
};

const COM1: u64 = 0x3f8;
const IER: u64 = COM1 + 1;
const IIR: u64 = COM1 + 2;
const LSR: u64 = COM1 + 5;
/// IER: interrupt when the transmitter holding register is empty.
const IER_THRE: u8 = 0x02;
/// IIR with THRE pending and the FIFO bits of a 16550A.
const IIR_THRE: u8 = 0xc2;
const CMOS: u64 = 0x70;
const I8042_DATA: u64 = 0x60;
const I8042_COMMAND: u64 = 0x64;

/// One edge on GSI 4.
const GSI_4_EDGE: [Call; 2] = [
    Call::SetIrqLine {
        line: 4,
        level: true,
    },
    Call::SetIrqLine {
        line: 4,
        level: false,
    },
];

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

/// A sink that takes nothing, like a console pipe whose reader went away.
struct Broken;

impl Write for Broken {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Machine {
    buses: Buses,
    devices: DeviceManager,
    vm: Arc<MockVm>,
    events: EventLoop,
}

impl Machine {
    fn new(vm: MockVm, serial_out: impl Write + Send + 'static) -> Self {
        let vm = Arc::new(vm);
        let events = EventLoop::new().unwrap();
        let mut buses = Buses::default();
        let devices = DeviceManager::new(
            &mut buses,
            vm.clone(),
            &events.sender(),
            Box::new(serial_out),
            Box::new(|| 0),
        )
        .unwrap();
        Self {
            buses,
            devices,
            vm,
            events,
        }
    }

    fn outb(&self, port: u64, value: u8) {
        self.buses.pio.write(port, &[value]);
    }

    fn inb(&self, port: u64) -> u8 {
        let mut value = [0];
        self.buses.pio.read(port, &mut value);
        value[0]
    }

    fn next_event(&mut self) -> Option<Event> {
        self.events.wait(Some(Duration::ZERO)).unwrap()
    }
}

#[test]
fn guest_output_reaches_the_sink_and_thre_raises_gsi_4() {
    let output = Output::default();
    let mut machine = Machine::new(MockVm::new(), output.clone());

    // Linux probes for a working THRE interrupt by enabling it.
    machine.outb(IER, IER_THRE);
    assert_eq!(machine.inb(IIR), IIR_THRE, "the IER write raises THRE");
    machine.outb(COM1, b'h');
    // THRE fires again only once the guest has read IIR.
    assert_eq!(machine.inb(IIR), IIR_THRE);
    machine.outb(COM1, b'i');

    assert_eq!(*output.0.lock().unwrap(), b"hi");
    assert_eq!(machine.vm.calls(), GSI_4_EDGE.repeat(3));
    assert_eq!(machine.devices.serial_dropped_bytes(), 0);
    assert!(machine.next_event().is_none());
}

#[test]
fn a_failing_sink_drops_the_byte_and_still_raises_thre() {
    let mut machine = Machine::new(MockVm::new(), Broken);

    machine.outb(IER, IER_THRE);
    machine.inb(IIR);
    machine.outb(COM1, b'x');

    assert_eq!(machine.devices.serial_dropped_bytes(), 1);
    assert_eq!(machine.vm.calls(), GSI_4_EDGE.repeat(2));
    assert!(machine.next_event().is_none(), "a lost byte keeps the VM");
}

#[test]
fn a_failed_interrupt_is_reported_once() {
    // The first two sets of GSI 4 fail, so neither edge completes.
    let mut machine = Machine::new(MockVm::failing_at(&[0, 1]), Output::default());

    machine.outb(IER, IER_THRE);
    machine.inb(IIR);
    machine.outb(COM1, b'x');

    let event = machine.next_event();
    assert!(
        matches!(
            event,
            Some(Event::DeviceFailed(Error::Hypervisor(
                boxlite_hypervisor::Error::SetIrqLine { line: 4, .. }
            )))
        ),
        "{event:?}"
    );
    assert!(machine.next_event().is_none(), "reported once");
}

#[test]
fn the_first_0xfe_at_the_command_port_resets_the_guest() {
    let mut machine = Machine::new(MockVm::new(), Output::default());

    machine.outb(I8042_DATA, 0xfe);
    machine.outb(I8042_COMMAND, 0xad);
    assert!(machine.next_event().is_none());
    // No byte waiting and room for a command, so Linux sends the reset.
    assert_eq!(machine.inb(I8042_COMMAND), 0);

    machine.outb(I8042_COMMAND, 0xfe);
    machine.outb(I8042_COMMAND, 0xfe);
    let event = machine.next_event();
    assert!(matches!(event, Some(Event::GuestReset)), "{event:?}");
    assert!(
        machine.next_event().is_none(),
        "only the first reset is sent"
    );
}

#[test]
fn claims_the_legacy_ports_only_once() {
    let output = Output::default();
    let mut machine = Machine::new(MockVm::new(), output.clone());

    // The ports around each device, and those between the i8042 ports.
    for port in [0x3f7, 0x400, 0x6f, 0x72, 0x5f, 0x61, 0x62, 0x63, 0x65] {
        assert_eq!(machine.inb(port), UNCLAIMED_READ, "port {port:#x}");
    }
    // The transmitter is idle, and CMOS register B reads 24-hour mode.
    assert_eq!(machine.inb(LSR), 0x60);
    machine.outb(CMOS, 0x0b);
    assert_eq!(machine.inb(CMOS + 1), 0x02);
    // The UART registers take byte accesses only.
    let mut wide = [0; 2];
    machine.buses.pio.read(COM1, &mut wide);
    machine.buses.pio.write(COM1, b"ab");
    assert_eq!(wide, [UNCLAIMED_READ; 2]);
    assert!(output.0.lock().unwrap().is_empty());

    let events = EventLoop::new().unwrap();
    let error = DeviceManager::new(
        &mut machine.buses,
        Arc::new(MockVm::new()),
        &events.sender(),
        Box::new(Output::default()),
        Box::new(|| 0),
    )
    .err()
    .expect("the ports are taken");
    assert!(
        matches!(
            error,
            Error::Overlap {
                base: 0x3f8,
                len: 8
            }
        ),
        "{error:?}"
    );
}
