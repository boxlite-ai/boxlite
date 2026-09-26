// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! x86_64 legacy devices, as specified by the PC standard and the design
//! document's device table (`docs/contributing/architecture/vmm/README.md`, "Devices by
//! milestone", M1).
//!
//! The module tree is architecture-gated at its `pub mod` declaration in
//! `lib.rs`; the buses and interrupt routing themselves are cross-arch.

pub mod i8042;
pub mod rtc;
pub mod serial;

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Write},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        time::{Duration, UNIX_EPOCH},
    };

    use crate::{
        bus::{BusDevice, IoBus},
        devices::{i8042::I8042, rtc::CmosRtc, serial::Serial},
        error::Error,
        irq::{InterruptTarget, IrqSender},
    };

    /// Records every interrupt-line transition.
    #[derive(Default)]
    struct RecordingTarget {
        calls: Mutex<Vec<(u32, bool)>>,
    }

    impl RecordingTarget {
        fn take(&self) -> Vec<(u32, bool)> {
            std::mem::take(&mut *self.calls.lock().unwrap())
        }
    }

    impl InterruptTarget for RecordingTarget {
        fn set_irq_line(&self, line: u32, level: bool) -> Result<(), boxlite_hypervisor::Error> {
            self.calls.lock().unwrap().push((line, level));
            Ok(())
        }
    }

    /// Absorbs console bytes into a buffer the test can inspect.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Sink {
        fn bytes(&self) -> Vec<u8> {
            self.0.lock().unwrap().clone()
        }
    }

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Boxes a concrete device for bus registration.
    fn as_bus_device<T: BusDevice + Send + 'static>(
        device: Arc<Mutex<T>>,
    ) -> Arc<Mutex<dyn BusDevice + Send>> {
        device
    }

    /// 2026-09-22T12:34:56Z (a Tuesday), the fixed wall clock the probe reads.
    const PROBE_NOW: u64 = 1_790_080_496;

    /// The machine the probe drives: the three legacy devices on a fresh
    /// port bus, registered exactly as the M1 lifecycle will build them.
    struct Machine {
        bus: IoBus,
        serial: Arc<Mutex<Serial>>,
        sink: Sink,
        irq: Arc<RecordingTarget>,
        reset: Arc<AtomicBool>,
    }

    fn machine() -> Machine {
        let sink = Sink::default();
        let irq = Arc::new(RecordingTarget::default());
        let target: Arc<dyn InterruptTarget> = {
            let cloned: Arc<RecordingTarget> = Arc::clone(&irq);
            cloned
        };
        let serial = Arc::new(Mutex::new(Serial::new(
            Arc::new(Mutex::new(sink.clone())),
            IrqSender::new(target),
            4,
        )));
        let rtc = Arc::new(Mutex::new(CmosRtc::new(move || {
            UNIX_EPOCH + Duration::from_secs(PROBE_NOW)
        })));
        let reset = Arc::new(AtomicBool::new(false));
        let kbd = Arc::new(Mutex::new(I8042::new(Arc::clone(&reset))));

        let mut bus = IoBus::new();
        bus.insert(
            Serial::PORT_BASE,
            Serial::PORT_WINDOW,
            as_bus_device(serial.clone()),
        )
        .unwrap();
        bus.insert(CmosRtc::PORT_INDEX, 2, as_bus_device(rtc))
            .unwrap();
        // One five-port window at 0x60 covers the data port (offset 0) and
        // the command/status port (offset 4), as libkrun registers it.
        bus.insert(I8042::PORT_BASE, I8042::PORT_WINDOW, as_bus_device(kbd))
            .unwrap();

        Machine {
            bus,
            serial,
            sink,
            irq,
            reset,
        }
    }

    impl Machine {
        fn read(&self, port: u16) -> u8 {
            let mut data = [0u8; 1];
            self.bus.read(port, &mut data).unwrap();
            data[0]
        }

        fn write(&self, port: u16, value: u8) {
            self.bus.write(port, &[value]).unwrap();
        }
    }

    /// Walks the port bus the way a guest kernel's early console, clock, and
    /// shutdown paths do: probe and init the 8250, print, take an incoming
    /// keystroke, read the RTC, reset through i8042, then poke unmapped
    /// ports for robustness. Pure userspace: no /dev/kvm and no vCPU.
    #[test]
    fn kernel_probe_walks_the_legacy_port_bus() {
        let m = machine();

        // 1. Console probe: LSR shows transmitter empty, no RX, no errors,
        //    and no break (bit 4 must stay clear or the guest drops input).
        assert_eq!(m.read(0x3FD), 0x60);

        // 2. 16550A init: DLAB, divisor 12 (9600 baud), 8N1, FIFO on, RX IRQ,
        //    OUT2 armed.
        m.write(0x3FB, 0x80);
        m.write(0x3F8, 0x0C);
        m.write(0x3F9, 0x00);
        m.write(0x3FB, 0x03);
        m.write(0x3FA, 0x07);
        m.write(0x3F9, 0x01);
        m.write(0x3FC, 0x08);
        assert_eq!(m.read(0x3F9), 0x01);
        assert_eq!(m.read(0x3FB), 0x03); // LCR reads back 0x03 (8N1, DLAB clear)

        // 3. TX "hello" one byte at a time; each lands in the host sink.
        for byte in b"hello" {
            m.write(0x3F8, *byte);
        }
        assert_eq!(m.sink.bytes(), b"hello");
        assert!(m.irq.take().is_empty(), "TX must not raise the line");

        // 4. RX path: a keystroke raises GSI 4 until the guest drains it.
        m.serial.lock().unwrap().push_rx(b'x').unwrap();
        assert_eq!(m.irq.take(), vec![(4, true)]);
        assert_eq!(m.read(0x3FD) & 0x01, 1); // data ready
        assert_eq!(m.read(0x3F8), b'x'); // RBR pop
        assert_eq!(m.irq.take(), vec![(4, false)]);
        assert_eq!(m.read(0x3FD) & 0x01, 0);

        // 5. RTC: binary + 24-hour mode (B = 0x06) for legible assertions.
        m.write(CmosRtc::PORT_INDEX, 0x0B);
        m.write(CmosRtc::PORT_DATA, 0x06);
        m.write(CmosRtc::PORT_INDEX, 0x00);
        assert_eq!(m.read(CmosRtc::PORT_DATA), 56); // seconds of PROBE_NOW
        m.write(CmosRtc::PORT_INDEX, 0x04);
        assert_eq!(m.read(CmosRtc::PORT_DATA), 12); // 24-hour mode

        // 6. i8042: no pending output, then the reboot the BoxLite guest
        //    agent performs with reboot(): command 0xFE on the status port
        //    ends the VM.
        assert_eq!(m.read(I8042::PORT_BASE + 4) & 0x01, 0);
        m.write(I8042::PORT_BASE + 4, 0xFE);
        assert!(m.reset.load(Ordering::SeqCst));

        // 7. Unmapped accesses are errors, never panics.
        for port in [0x100u16, 0x63, 0x72, 0x65] {
            assert!(
                matches!(m.bus.read(port, &mut [0u8; 4]), Err(Error::IoUnmapped { port: p }) if p == port)
            );
            assert!(
                matches!(m.bus.write(port, &[0u8; 4]), Err(Error::IoUnmapped { port: p }) if p == port)
            );
        }
    }
}
