// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The arm64 platform through the chipset, with the mock VM as the GIC: the
//! PL011's identification, flags, output and level interrupt at the access
//! widths Linux uses, and the GIC windows no device may claim.

use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use boxlite_hypervisor::VcpuExit;

use super::{GICD_BASE, GICR_BASE, PL011_BASE, PL011_SPI, add_platform_devices};
use crate::{
    bus::BusDevice,
    chipset::{Chipset, ChipsetBuilder, Conflict},
    devices::console::{ConsoleWorker, DEFAULT_QUEUE_BYTES},
    error::Error,
    events::{Event, EventLoop},
    mock_vm::{Call, MockVm},
};

const DR: u64 = 0x000;
const FR: u64 = 0x018;
const IBRD: u64 = 0x024;
const FBRD: u64 = 0x028;
const LCR_H: u64 = 0x02c;
const CR: u64 = 0x030;
const IFLS: u64 = 0x034;
const IMSC: u64 = 0x038;
const RIS: u64 = 0x03c;
const MIS: u64 = 0x040;
const ICR: u64 = 0x044;
/// The transmit interrupt bit in IMSC, RIS, MIS and ICR.
const TX: u64 = 1 << 5;

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
        add_platform_devices(&mut builder, writer).unwrap();
        Self {
            chipset: builder.build().unwrap(),
            console,
            vm,
            events,
        }
    }

    /// Reads `len` bytes of the PL011 register at `offset`, little endian.
    fn read(&self, offset: u64, len: usize) -> u64 {
        let mut bytes = [0; 8];
        let exit = VcpuExit::MmioRead {
            guest_addr: PL011_BASE + offset,
            bytes: &mut bytes[..len],
        };
        assert!(self.chipset.dispatch(exit).is_none());
        u64::from_le_bytes(bytes)
    }

    /// Writes the low `len` bytes of `value` to the register at `offset`.
    fn write(&self, offset: u64, len: usize, value: u64) {
        let bytes = value.to_le_bytes();
        let exit = VcpuExit::MmioWrite {
            guest_addr: PL011_BASE + offset,
            bytes: &bytes[..len],
        };
        assert!(self.chipset.dispatch(exit).is_none());
    }

    fn line_changes(&self) -> Vec<Call> {
        self.vm
            .calls()
            .into_iter()
            .filter(|call| matches!(call, Call::SetIrqLine { .. }))
            .collect()
    }
}

#[test]
fn identifies_as_an_arm_pl011_to_32_bit_reads() {
    let machine = Machine::new(MockVm::new(), Output::default());
    // PeriphID0-3 and PCellID0-3: part 0x011, designer Arm, revision 1, as the
    // AMBA bus packs them (`drivers/amba/bus.c`).
    for (offset, value) in [
        (0xfe0, 0x11),
        (0xfe4, 0x10),
        (0xfe8, 0x14),
        (0xfec, 0x00),
        (0xff0, 0x0d),
        (0xff4, 0xf0),
        (0xff8, 0x05),
        (0xffc, 0xb1),
    ] {
        assert_eq!(machine.read(offset, 4), value, "{offset:#x}");
    }
}

#[test]
fn reports_an_empty_transmit_fifo_and_no_input() {
    let machine = Machine::new(MockVm::new(), Output::default());
    // TXFE and RXFE; never TXFF or BUSY, which Linux polls before and after
    // each byte.
    assert_eq!(machine.read(FR, 2), 0x90);
    assert_eq!(machine.read(DR, 2), 0);
}

#[test]
fn sends_each_data_register_write_to_the_console() {
    let output = Output::default();
    let mut machine = Machine::new(MockVm::new(), output.clone());
    // earlycon writes bytes; the driver writes halfwords.
    machine.write(DR, 1, u64::from(b'o'));
    machine.write(DR, 2, u64::from(b'k'));
    machine.write(DR, 4, u64::from(b'!'));
    machine.console.finish();
    assert_eq!(*output.0.lock().unwrap(), b"ok!");
}

#[test]
fn unsupported_access_widths_read_ones_and_have_no_effect() {
    let output = Output::default();
    let mut machine = Machine::new(MockVm::new(), output.clone());
    for width in [3, 8] {
        let expected = u64::MAX >> (8 * (8 - width));
        assert_eq!(machine.read(FR, width), expected);
        machine.write(IMSC, width, TX);
        machine.write(DR, width, u64::from(b'x'));
    }
    machine.console.finish();
    assert!(output.0.lock().unwrap().is_empty());
    assert!(machine.line_changes().is_empty());
    assert_eq!(machine.read(IMSC, 2), 0);
}

#[test]
fn keeps_the_registers_linux_programs() {
    let machine = Machine::new(MockVm::new(), Output::default());
    // Reset values: TXE and RXE in CR, half-full FIFO levels in IFLS.
    assert_eq!(machine.read(CR, 2), 0x300);
    assert_eq!(machine.read(IFLS, 2), 0x12);
    for (offset, value) in [
        (IBRD, 0x1a),
        (FBRD, 0x03),
        (LCR_H, 0x70),
        (CR, 0x301),
        (IFLS, 0x24),
    ] {
        machine.write(offset, 2, value);
        assert_eq!(machine.read(offset, 2), value, "{offset:#x}");
    }
}

#[test]
fn holds_the_interrupt_while_the_guest_unmasks_transmit() {
    let machine = Machine::new(MockVm::new(), Output::default());
    assert_eq!(machine.read(RIS, 2), TX, "the FIFO is always ready");
    assert_eq!(machine.read(MIS, 2), 0);
    assert!(machine.line_changes().is_empty());

    machine.write(IMSC, 2, TX);
    assert_eq!(machine.read(MIS, 2), TX);
    // Linux never clears TXIS; the FIFO stays ready, so the level holds.
    machine.write(ICR, 2, 0x7ff);
    assert_eq!(machine.read(MIS, 2), TX);
    machine.write(IMSC, 2, 0);

    assert_eq!(
        machine.line_changes(),
        [
            Call::SetIrqLine {
                line: PL011_SPI,
                level: true
            },
            Call::SetIrqLine {
                line: PL011_SPI,
                level: false
            },
        ]
    );
}

#[test]
fn a_failed_interrupt_ends_the_vm_once() {
    // The first host call, raising the line, fails.
    let mut machine = Machine::new(MockVm::failing_at(&[0]), Output::default());
    machine.write(IMSC, 2, TX);
    machine.write(IMSC, 2, 0);
    machine.write(IMSC, 2, TX);

    let first = machine.events.wait(Some(Duration::ZERO)).unwrap();
    assert!(
        matches!(first, Some(Event::DeviceFailed(Error::Hypervisor(_)))),
        "{first:?}"
    );
    assert!(machine.events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn reserves_the_gic_windows_for_the_host() {
    struct Quiet;

    impl BusDevice for Quiet {
        fn read(&mut self, _offset: u64, _data: &mut [u8]) {}

        fn write(&mut self, _offset: u64, _data: &[u8]) {}
    }

    let events = EventLoop::new().unwrap();
    let (writer, _console) = ConsoleWorker::spawn(Box::new(Output::default()), 64).unwrap();
    let mut builder = ChipsetBuilder::new(Arc::new(MockVm::new()), events.sender());
    add_platform_devices(&mut builder, writer).unwrap();
    builder
        .add("in the distributor", |resources| {
            resources.mmio(GICD_BASE + 0x100, 4);
            Ok(Quiet)
        })
        .unwrap();
    builder
        .add("in the last redistributor", |resources| {
            resources.mmio(GICD_BASE - 4, 4);
            Ok(Quiet)
        })
        .unwrap();
    builder
        .add("in the first redistributor", |resources| {
            resources.mmio(GICR_BASE, 4);
            Ok(Quiet)
        })
        .unwrap();

    let Err(Error::ChipsetConflicts(conflicts)) = builder.build() else {
        panic!("a device took a GIC window");
    };
    let owners: Vec<_> = conflicts
        .iter()
        .map(|conflict| match conflict {
            Conflict::RangeTaken { owner, .. } => *owner,
            other => panic!("{other}"),
        })
        .collect();
    assert_eq!(
        owners,
        [
            "in-kernel GIC distributor",
            "in-kernel GIC redistributors",
            "in-kernel GIC redistributors",
        ]
    );
}
