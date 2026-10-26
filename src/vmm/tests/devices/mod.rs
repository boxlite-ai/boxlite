// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The legacy platform through the chipset, with the mock VM as the
//! interrupt controller: serial output and THRE, a failing interrupt, the
//! i8042 reset, and the port map.

use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use super::{COM1, I8042_COMMAND, I8042_DATA, add_legacy_devices};
use crate::{
    bus::UNCLAIMED_READ,
    chipset::{Chipset, ChipsetBuilder, Conflict},
    devices::console::{ConsoleWorker, DEFAULT_QUEUE_BYTES},
    error::Error,
    events::{Event, EventLoop},
    mock_vm::{Call, MockVm},
};

const IER: u64 = COM1 + 1;
const IIR: u64 = COM1 + 2;
const LSR: u64 = COM1 + 5;
/// IER: interrupt when the transmitter holding register is empty.
const IER_THRE: u8 = 0x02;
/// IIR with THRE pending and the FIFO bits of a 16550A.
const IIR_THRE: u8 = 0xc2;

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

struct Machine {
    chipset: Chipset,
    console: ConsoleWorker,
    vm: Arc<MockVm>,
    events: EventLoop,
}

impl Machine {
    fn new(vm: MockVm, output: Output) -> Self {
        let vm = Arc::new(vm);
        let events = EventLoop::new().unwrap();
        let (writer, console) =
            ConsoleWorker::spawn(Box::new(output), DEFAULT_QUEUE_BYTES).unwrap();
        let mut builder = ChipsetBuilder::new(vm.clone(), events.sender());
        add_legacy_devices(&mut builder, writer).unwrap();
        Self {
            chipset: builder.build().unwrap(),
            console,
            vm,
            events,
        }
    }

    fn outb(&self, port: u64, value: u8) {
        self.chipset.buses().pio.write(port, &[value]);
    }

    fn inb(&self, port: u64) -> u8 {
        let mut value = [0];
        self.chipset.buses().pio.read(port, &mut value);
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

    assert_eq!(machine.vm.calls(), GSI_4_EDGE.repeat(3));
    assert!(machine.next_event().is_none());
    machine.console.finish();
    assert_eq!(*output.0.lock().unwrap(), b"hi");
}

#[test]
fn a_failed_interrupt_is_reported_once_and_stops_the_vm() {
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
    let event = machine.next_event();
    machine.outb(I8042_COMMAND, 0xfe);
    assert!(matches!(event, Some(Event::GuestReset)), "{event:?}");
    assert!(
        machine.next_event().is_none(),
        "only the first reset is sent"
    );
}

#[test]
fn the_legacy_ports_and_the_in_kernel_windows_are_the_only_claims() {
    let machine = Machine::new(MockVm::new(), Output::default());

    // The ports around each device, those between the i8042 ports, and the
    // PIT's speaker port, which KVM serves and no device may take.
    for port in [0x3f7, 0x400, 0x5f, 0x61, 0x62, 0x63, 0x65, 0x80] {
        assert_eq!(machine.inb(port), UNCLAIMED_READ, "port {port:#x}");
    }
    assert_eq!(machine.chipset.buses().pio.unclaimed(), (8, 0));
    // The transmitter is idle.
    assert_eq!(machine.inb(LSR), 0x60);
    // The UART registers take byte accesses only.
    let mut wide = [0; 2];
    machine.chipset.buses().pio.read(COM1, &mut wide);
    machine.chipset.buses().pio.write(COM1, b"ab");
    assert_eq!(wide, [UNCLAIMED_READ; 2]);
}

#[test]
fn a_second_platform_conflicts_with_every_legacy_claim() {
    let vm = Arc::new(MockVm::new());
    let events = EventLoop::new().unwrap();
    let mut builder = ChipsetBuilder::new(vm, events.sender());
    let (writer, _console) = ConsoleWorker::spawn(Box::new(Output::default()), 16).unwrap();
    let (second, _second_console) = ConsoleWorker::spawn(Box::new(Output::default()), 16).unwrap();
    add_legacy_devices(&mut builder, writer).unwrap();
    add_legacy_devices(&mut builder, second).unwrap();

    let error = builder.build().err().expect("the ports are taken");
    let Error::ChipsetConflicts(conflicts) = &error else {
        panic!("{error:?}");
    };
    let named: Vec<String> = conflicts.iter().map(ToString::to_string).collect();
    assert_eq!(
        named,
        [
            "in-kernel PIC claims port range 0x20+0x2, held by in-kernel PIC",
            "in-kernel PIC claims port range 0xa0+0x2, held by in-kernel PIC",
            "in-kernel PIC claims port range 0x4d0+0x2, held by in-kernel PIC",
            "in-kernel PIT claims port range 0x40+0x4, held by in-kernel PIT",
            "in-kernel PIT claims port range 0x61+0x1, held by in-kernel PIT",
            "in-kernel IOAPIC claims MMIO range 0xfec00000+0x1000, held by in-kernel IOAPIC",
            "in-kernel local APIC claims MMIO range 0xfee00000+0x1000, held by in-kernel local APIC",
            "com1 claims port range 0x3f8+0x8, held by com1",
            "com1 claims interrupt line 4, held by com1",
            "i8042 claims port range 0x60+0x1, held by i8042",
            "i8042 claims port range 0x64+0x1, held by i8042",
        ]
    );
    assert!(matches!(
        conflicts[8],
        Conflict::LineTaken {
            line: 4,
            claimant: "com1",
            owner: "com1"
        }
    ));
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "kvm.rs"]
mod kvm;
