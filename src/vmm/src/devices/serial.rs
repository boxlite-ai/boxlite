// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The 8250/16550A UART at PC ports `0x3F8`–`0x3FF` on GSI 4.
//!
//! The guest kernel's early console writes here before any driver probes,
//! so the transmit path is a plain byte sink (BoxLite's `console.log` in
//! the future, a buffer in tests). The receive path holds a small FIFO and
//! raises or lowers its level-triggered line as data arrives and drains.
//!
//! Register semantics follow the PC 16550A as emulated by libkrun's
//! vendored `serial_port` and Firecracker's `devices/legacy/serial`
//! (pin e12b9b3 / 68698ad respectively); deliberate simplifications are
//! commented at each register.

use std::{
    collections::VecDeque,
    io::Write,
    sync::{Arc, Mutex},
};

use boxlite_hypervisor::Result;

use crate::{bus::BusDevice, irq::IrqSender};

/// Where a guest keystroke waits before the driver drains it. 16 is the
/// real 16550A receive FIFO depth.
const RX_FIFO_DEPTH: usize = 16;

/// Line-control: bit 7 selects the baud-rate register view (DLAB).
const LCR_DLAB: u8 = 0x80;
/// Interrupt-enable: received-data-available interrupt (bit 0, "ERDAI").
const IER_ERDAI: u8 = 0x01;
/// The interrupt-enable bits the 16550A latches (ERDAI/ETHREI/ELSI/EMSI).
const IER_VALID_BITS: u8 = 0x0F;
/// FIFO-control: enable the FIFO (bit 0). The part is a 16550A once set.
const FCR_FIFO_ENABLE: u8 = 0x01;
/// FIFO-control: reset the receive FIFO (self-clearing on real hardware).
const FCR_RX_RST: u8 = 0x02;
/// FIFO-control: reset the transmit FIFO (self-clearing on real hardware).
const FCR_TX_RST: u8 = 0x04;
/// Modem-control: data terminal ready, ring through loopback to DSR.
const MCR_DTR: u8 = 0x01;
/// Modem-control: request to send, ring through loopback to CTS.
const MCR_RTS: u8 = 0x02;
/// Modem-control: auxiliary output 1, ring through loopback to RI.
const MCR_OUT1: u8 = 0x04;
/// Modem-control: the driver's "interrupts may fire" bit, loopback to DCD.
const MCR_OUT2: u8 = 0x08;
/// Modem-control: internal loopback, RX wired to TX.
const MCR_LOOP: u8 = 0x10;

// Interrupt identification: bit 0 = no interrupt pending; bits 2:1 = ID.
// Bits 7:6 = 0b11 report a 16550A FIFO present, so Linux's 8250 autoconfig
// identifies the part as a PORT_16550A (not a bare 8250) once the FIFO is
// enabled by writing FCR bit 0.
const IIR_FIFO_ENABLED: u8 = 0xC0;
const IIR_NO_INTERRUPT: u8 = 0x01;
const IIR_RECEIVED_DATA: u8 = 0x04;

// Line status bits the guest polls.
const LSR_DATA_READY: u8 = 0x01;
const LSR_OVERRUN: u8 = 0x02;
/// Idle line: bit 5 (holding register empty) and bit 6 (transmitter
/// completely empty). This device absorbs every write into its sink, so
/// both are always set. Bit 4 is the break indicator: setting it would
/// make the guest treat every received character as a break. An idle LSR
/// is therefore 0x60, as in Firecracker and crosvm.
const LSR_IDLE: u8 = 0x60;

/// An emulated 16550A serial port.
///
/// `sink` is shared through an `Arc<Mutex<..>>` because the device sits
/// behind the bus lock but the M2 console bridge will also hold it.
pub struct Serial {
    sink: Arc<Mutex<dyn Write + Send>>,
    irq: IrqSender,
    gsi: u32,
    lcr: u8,
    /// Interrupt enables, stored as the part latches them (bits 3:0: data,
    /// transmitter-empty, line-status, modem-status). Only the data-available
    /// bit drives this device's line; the rest are stored so a driver's
    /// write-and-read-back probe sees what it wrote.
    ier: u8,
    /// Whether the FIFO is enabled (FCR bit 0). The reset bits are
    /// self-clearing pulses applied on write; trigger levels are not kept.
    fifo_enabled: bool,
    mcr: u8,
    scr: u8,
    /// Divisor latch, visible at offsets 0/1 while DLAB is set.
    brl: [u8; 2],
    rx: VecDeque<u8>,
    /// The receiver-error latch (reported in LSR bit 1, cleared by an LSR
    /// read, as on the part).
    overrun: bool,
    /// Current level of the interrupt line; transitions are injected only
    /// when it changes.
    raised: bool,
    /// The last line transition that failed to inject. A `BusDevice` access
    /// cannot return an error, so a failed injection is remembered and
    /// retried on the next access that touches the device.
    pending_line: Option<bool>,
}

impl Serial {
    /// The first of the eight consecutive ports the device occupies.
    pub const PORT_BASE: u16 = 0x3F8;
    /// The width of that port window.
    pub const PORT_WINDOW: u16 = 8;

    /// Creates a port writing its console output to `sink` and signalling
    /// received data on `gsi`.
    pub fn new(sink: Arc<Mutex<dyn Write + Send>>, irq: IrqSender, gsi: u32) -> Self {
        Self {
            sink,
            irq,
            gsi,
            lcr: 0,
            ier: 0,
            fifo_enabled: false,
            mcr: 0,
            scr: 0,
            brl: [0; 2],
            rx: VecDeque::new(),
            overrun: false,
            raised: false,
            pending_line: None,
        }
    }

    /// Queues a host-side received byte, raising the interrupt line if the
    /// driver enabled and armed the port.
    ///
    /// This is the entry point for the future console bridge (host input →
    /// guest) and for tests. A full FIFO drops the new byte and flags an
    /// overrun in LSR, as the part does.
    pub fn push_rx(&mut self, byte: u8) -> Result<()> {
        if self.rx.len() >= RX_FIFO_DEPTH {
            self.overrun = true;
            return Ok(());
        }
        self.rx.push_back(byte);
        self.sync_line()
    }

    /// True when the driver wants a data-available interrupt: ERDAI set in
    /// IER and OUT2 set in MCR (the UART's master interrupt gate).
    fn rx_irq_armed(&self) -> bool {
        (self.ier & IER_ERDAI) != 0 && (self.mcr & MCR_OUT2) != 0
    }

    /// True when loopback is set: MCR bit 4. (FCR bit 4 is not loopback on
    /// real hardware; only MCR bit 4 is.)
    fn loopback(&self) -> bool {
        (self.mcr & MCR_LOOP) != 0
    }

    /// Drives the level-triggered line to "pending data while armed",
    /// injecting only a change.
    fn sync_line(&mut self) -> Result<()> {
        let want = self.rx_irq_armed() && !self.rx.is_empty();
        if want == self.raised {
            return Ok(());
        }
        match self.irq.set_level(self.gsi, want) {
            Ok(()) => {
                self.raised = want;
                self.pending_line = None;
                Ok(())
            }
            Err(error) => {
                // The line is stuck at its old level; `reconcile_line` will
                // retry on the next access.
                self.pending_line = Some(want);
                Err(error)
            }
        }
    }

    /// Retries the line transition a previous access could not complete,
    /// recomputing the target from current device state so a drain or arm
    /// that happened since the failure is reflected.
    fn reconcile_line(&mut self) {
        if self.pending_line.is_some() {
            let _ = self.sync_line();
        }
    }

    /// One-byte read at register offset `offset`.
    fn read_byte(&mut self, offset: u64) -> u8 {
        let dlab = (self.lcr & LCR_DLAB) != 0;
        match offset {
            0 if dlab => self.brl[0],
            0 => {
                let byte = self.rx.pop_front().unwrap_or(0);
                // Data ready cleared once the queue drains: drop the line.
                let _ = self.sync_line();
                byte
            }
            1 if dlab => self.brl[1],
            1 => self.ier,
            2 => {
                // Reading IIR does not consume the receive FIFO. Bits 7:6
                // report a 16550A FIFO present when FCR bit 0 has been set.
                let fifo = if self.fifo_enabled {
                    IIR_FIFO_ENABLED
                } else {
                    0
                };
                if self.rx_irq_armed() && !self.rx.is_empty() {
                    fifo | IIR_RECEIVED_DATA
                } else {
                    fifo | IIR_NO_INTERRUPT
                }
            }
            3 => self.lcr, // LCR is readable, as on the real part.
            // MCR is write-only; loopback echoes the mode bit back so
            // the driver's self-test can see it took.
            4 if self.loopback() => MCR_LOOP,
            4 => 0,
            5 => {
                let mut lsr = LSR_IDLE;
                if !self.rx.is_empty() {
                    lsr |= LSR_DATA_READY;
                }
                if self.overrun {
                    lsr |= LSR_OVERRUN;
                    // Receiver error flags are read-clear on the part: the
                    // act of reading LSR reports the latch and empties it.
                    self.overrun = false;
                }
                lsr
            }
            // In loopback the part rings the control lines into the modem
            // status inputs: RTS→CTS, DTR→DSR, OUT1→RI, OUT2→DCD. Linux's
            // autoconfig writes MCR 0x1A and expects MSR & 0xF0 == 0x90.
            6 if self.loopback() => {
                let mut msr = 0u8;
                if (self.mcr & MCR_RTS) != 0 {
                    msr |= 0x10; // CTS
                }
                if (self.mcr & MCR_DTR) != 0 {
                    msr |= 0x20; // DSR
                }
                if (self.mcr & MCR_OUT1) != 0 {
                    msr |= 0x40; // RI
                }
                if (self.mcr & MCR_OUT2) != 0 {
                    msr |= 0x80; // DCD
                }
                msr
            }
            6 => 0,
            7 => self.scr,
            // The bus caps this window at 8 bytes; defensive like real
            // unclaimed space.
            _ => 0,
        }
    }

    /// One-byte write at register offset `offset`.
    fn write_byte(&mut self, offset: u64, value: u8) {
        let dlab = (self.lcr & LCR_DLAB) != 0;
        match offset {
            0 if dlab => self.brl[0] = value,
            0 => {
                if self.loopback() {
                    // Loopback: TX feeds RX directly, never the host sink.
                    let _ = self.push_rx(value);
                } else {
                    // A failing sink (closed console.log) drops the byte:
                    // the guest must not be able to stall on host I/O here.
                    let _ = self.transmit(value);
                }
            }
            1 if dlab => self.brl[1] = value,
            1 => {
                self.ier = value & IER_VALID_BITS; // latched; only ERDAI acts
                let _ = self.sync_line(); // arming can raise a buffered RX
            }
            2 => {
                if (value & (FCR_RX_RST | FCR_TX_RST)) != 0 {
                    self.rx.clear();
                    self.overrun = false;
                    let _ = self.sync_line(); // the reset can lower the line
                }
                self.fifo_enabled = (value & FCR_FIFO_ENABLE) != 0;
            }
            // Intentionally no parity generation or break: the BoxLite
            // console is always 8N1. WLS/STB/PEN/EPAR are stored but never
            // acted on. Bit 6 (set-break) is masked out; DLAB (bit 7) is
            // kept, so baud-rate programming works.
            3 => self.lcr = value & 0xBF,
            4 => {
                self.mcr = value & 0x1F;
                let _ = self.sync_line(); // OUT2 can arm a buffered RX
            }
            5 | 6 => {} // LSR/MSR are read-only; writes are scratch noise.
            7 => self.scr = value,
            _ => {}
        }
    }

    /// Writes one console byte to the host sink.
    fn transmit(&mut self, byte: u8) -> std::io::Result<()> {
        let mut sink = self
            .sink
            .lock()
            .map_err(|_| std::io::Error::other("console sink poisoned"))?;
        sink.write_all(&[byte])
    }
}

impl BusDevice for Serial {
    /// Multi-byte accesses walk consecutive registers, which is how a wide
    /// `in` lands inside an 8-byte port window. No register combination can
    /// panic: guest input is untrusted.
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        self.reconcile_line();
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = self.read_byte(offset.saturating_add(i as u64));
        }
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        self.reconcile_line();
        for (i, byte) in data.iter().enumerate() {
            self.write_byte(offset.saturating_add(i as u64), *byte);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;

    use boxlite_hypervisor::Error as HypError;

    use super::*;
    use crate::irq::InterruptTarget;

    /// Records line transitions.
    #[derive(Default)]
    struct Target {
        calls: Mutex<Vec<(u32, bool)>>,
    }

    impl InterruptTarget for Target {
        fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
            self.calls.lock().unwrap().push((line, level));
            Ok(())
        }
    }

    /// Fails the first injection with `level` true.
    struct FailFirstRaise(Mutex<bool>);

    impl InterruptTarget for FailFirstRaise {
        fn set_irq_line(&self, _line: u32, level: bool) -> Result<()> {
            let mut armed = self.0.lock().unwrap();
            if level && *armed {
                *armed = false;
                return Err(HypError::SetIrqLine {
                    line: 4,
                    source: std::io::Error::other("busy"),
                });
            }
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Port {
        serial: Serial,
        sink: Sink,
        irq: Arc<Target>,
    }

    fn port() -> Port {
        let sink = Sink::default();
        let irq = Arc::new(Target::default());
        let target: Arc<dyn InterruptTarget> = {
            let cloned: Arc<Target> = Arc::clone(&irq);
            cloned
        };
        let serial = Serial::new(
            Arc::new(Mutex::new(sink.clone())),
            IrqSender::new(target),
            4,
        );
        Port { serial, sink, irq }
    }

    impl Port {
        fn read(&mut self, offset: u64) -> u8 {
            let mut data = [0u8; 1];
            self.serial.read(offset, &mut data);
            data[0]
        }

        fn write(&mut self, offset: u64, value: u8) {
            self.serial.write(offset, &[value]);
        }

        fn calls(&self) -> Vec<(u32, bool)> {
            std::mem::take(&mut *self.irq.calls.lock().unwrap())
        }
    }

    /// The kernel's 16550A init: DLAB, divisor 12, 8N1, FIFOs on, RX IRQ on,
    /// OUT2 armed.
    fn init(port: &mut Port) {
        port.write(3, 0x80); // LCR: DLAB
        port.write(0, 0x0C); // divisor low
        port.write(1, 0x00); // divisor high
        port.write(3, 0x03); // LCR: 8N1, DLAB off
        port.write(2, 0x07); // FCR: FIFO enable + both resets
        port.write(1, 0x01); // IER: ERDAI
        port.write(4, MCR_OUT2); // arm the interrupt gate
    }

    #[test]
    fn dlab_switches_the_baud_and_data_views() {
        let mut port = port();
        port.write(3, LCR_DLAB);
        port.write(0, 0x0C);
        port.write(1, 0x00);
        assert_eq!(port.read(0), 0x0C);
        assert_eq!(port.read(1), 0x00);
        port.write(3, 0x03);
        // DLAB is off: offset 0 serves RBR again. LCR reads back 0x03.
        assert_eq!(port.read(3), 0x03);
        assert_eq!(port.read(0), 0); // RBR, empty — not the divisor latch
    }

    #[test]
    fn ier_latches_all_four_enable_bits() {
        let mut port = port();
        port.write(1, 0xFF);
        assert_eq!(port.read(1), 0x0F, "bits 3:0 latch; bits 7:4 do not exist");
        port.write(4, MCR_OUT2); // arm the gate
        assert!(port.calls().is_empty(), "enables alone never move the line");
        port.serial.push_rx(b'x').unwrap();
        assert_eq!(port.calls(), vec![(4, true)], "ERDAI alone drives the line");
    }

    #[test]
    fn thr_writes_reach_the_sink() {
        let mut port = port();
        port.write(0, b'h');
        port.write(0, b'i');
        assert_eq!(port.sink.0.lock().unwrap().as_slice(), b"hi");
        assert!(port.calls().is_empty(), "TX never raises the line");
    }

    #[test]
    fn received_byte_raises_level_irq_until_drained() {
        let mut port = port();
        init(&mut port);
        assert!(port.calls().is_empty(), "init alone never moves the line");

        port.serial.push_rx(b'x').unwrap();
        assert_eq!(port.calls(), vec![(4, true)]);
        assert_eq!(port.read(5) & LSR_DATA_READY, LSR_DATA_READY);
        assert_eq!(port.read(2) & 0x0F, IIR_RECEIVED_DATA);
        assert_eq!(
            port.read(2) & 0x0F,
            IIR_RECEIVED_DATA,
            "IIR reads keep the byte"
        );

        assert_eq!(port.read(0), b'x');
        assert_eq!(port.calls(), vec![(4, false)]);
        assert_eq!(port.read(5) & LSR_DATA_READY, 0);
    }

    #[test]
    fn arming_after_buffering_raises_immediately() {
        let mut port = port();
        port.write(3, 0x03);
        port.write(1, 0x01); // ERDAI while still no OUT2
        port.serial.push_rx(b'a').unwrap();
        assert!(port.calls().is_empty());
        port.write(4, MCR_OUT2); // arming with a queued byte
        assert_eq!(port.calls(), vec![(4, true)]);
    }

    #[test]
    fn unarmed_port_buffers_without_raising() {
        let mut port = port();
        port.serial.push_rx(b'q').unwrap(); // no IER, no OUT2
        assert!(port.calls().is_empty());
        assert_eq!(port.read(5) & LSR_DATA_READY, LSR_DATA_READY);
        assert_eq!(port.read(2) & 0x0F, IIR_NO_INTERRUPT);
    }

    #[test]
    fn loopback_routes_thr_to_rbr_not_the_sink() {
        let mut port = port();
        port.write(4, MCR_LOOP);
        assert_eq!(port.read(4), MCR_LOOP);
        port.write(0, b'z');
        assert!(port.sink.0.lock().unwrap().is_empty());
        assert_eq!(port.read(0), b'z');
        // The datasheet mapping: RTS→CTS, DTR→DSR, OUT1→RI, OUT2→DCD.
        port.write(4, MCR_LOOP | MCR_RTS);
        assert_eq!(port.read(6), 0x10); // CTS only
        port.write(4, MCR_LOOP | MCR_OUT2);
        assert_eq!(port.read(6), 0x80); // DCD only
        // Linux autoconfig's probe byte: MCR 0x1A expects MSR & 0xF0 == 0x90.
        port.write(4, 0x1A | MCR_LOOP);
        assert_eq!(port.read(6) & 0xF0, 0x90);
    }

    #[test]
    fn fifo_enable_reports_16550a_in_iir() {
        let mut port = port();
        // Before FCR bit 0 is set, IIR bits 7:6 are clear: bare 8250.
        assert_eq!(port.read(2) & IIR_FIFO_ENABLED, 0);
        // Writing FCR bit 0 enables the FIFO; IIR now reports 16550A.
        port.write(2, FCR_FIFO_ENABLE);
        assert_eq!(port.read(2) & IIR_FIFO_ENABLED, IIR_FIFO_ENABLED);
        // TX still reaches the sink: FCR does not engage loopback.
        port.write(0, b'w');
        assert_eq!(port.sink.0.lock().unwrap().as_slice(), b"w");
    }

    #[test]
    fn fifo_reset_clears_the_receive_queue() {
        let mut port = port();
        init(&mut port);
        port.serial.push_rx(b'a').unwrap();
        port.serial.push_rx(b'b').unwrap();
        assert_eq!(port.calls(), vec![(4, true)]);

        port.write(2, FCR_RX_RST | FCR_TX_RST);
        assert_eq!(port.calls(), vec![(4, false)], "the reset lowers the line");
        assert_eq!(port.read(5) & LSR_DATA_READY, 0);
        assert_eq!(port.read(0), 0); // RBR now empty
    }

    #[test]
    fn full_fifo_drops_and_flags_overrun() {
        let mut port = port();
        for i in 0..(RX_FIFO_DEPTH as u8 + 3) {
            port.serial.push_rx(i).unwrap();
        }
        assert_eq!(port.read(5) & LSR_OVERRUN, LSR_OVERRUN);
        assert_eq!(
            port.read(5) & LSR_OVERRUN,
            0,
            "the error latch clears on LSR read"
        );
        // The first bytes survive; the overflow was dropped.
        assert_eq!(port.read(0), 0);
    }

    #[test]
    fn idle_lsr_is_transmitter_empty_no_errors() {
        let mut port = port();
        assert_eq!(port.read(5), LSR_IDLE);
    }

    #[test]
    fn wide_accesses_walk_registers_without_panic() {
        let mut port = port();
        init(&mut port);
        // Four bytes from RBR span RBR, IER, IIR, LCR.
        let mut data = [0u8; 4];
        port.serial.read(0, &mut data);
        assert_eq!(data, [0, 0x01, IIR_NO_INTERRUPT | IIR_FIFO_ENABLED, 0x03]);
        // A two-byte write spans THR and IER: only 'p' reaches the sink;
        // 'q' lands in IER and its ERDAI bit keeps the armed state.
        port.serial.write(0, b"pq");
        assert_eq!(port.sink.0.lock().unwrap().as_slice(), b"p");
        assert_eq!(port.read(1), 0x01);
        // Absurd widths and offsets are noise, not crashes.
        let mut junk = [0u8; 8];
        port.serial.read(250, &mut junk);
        port.serial.write(u64::MAX, &[0; 8]);
    }

    #[test]
    fn failed_line_transition_is_retried_on_the_next_access() {
        let sink = Sink::default();
        let fail: Arc<dyn InterruptTarget> = {
            let concrete: Arc<FailFirstRaise> = Arc::new(FailFirstRaise(Mutex::new(true)));
            concrete
        };
        let mut serial = Serial::new(Arc::new(Mutex::new(sink)), IrqSender::new(fail), 4);
        serial.ier = IER_ERDAI;
        serial.mcr = MCR_OUT2;

        // The raise fails; push_rx surfaces it but remembers the target level.
        assert_eq!(
            serial.push_rx(b'x').err().map(|e| e.to_string()).as_deref(),
            Some("failed to set interrupt line 4")
        );
        assert_eq!(serial.pending_line, Some(true));
        assert!(!serial.raised);
        // The next access retries; this time the injection succeeds.
        let mut data = [0u8; 1];
        serial.read(5, &mut data);
        assert!(serial.raised);
        assert!(serial.pending_line.is_none());
        // Draining lowers the line cleanly.
        serial.read(0, &mut data);
        assert_eq!(data[0], b'x');
        assert!(!serial.raised);
        assert!(serial.pending_line.is_none());
    }

    #[test]
    fn sink_errors_drop_bytes_without_stalling_the_guest() {
        struct Dead;
        impl Write for Dead {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let dead: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(Dead));
        let target: Arc<dyn InterruptTarget> = {
            let concrete: Arc<Target> = Arc::new(Target::default());
            concrete
        };
        let mut serial = Serial::new(dead, IrqSender::new(target), 4);
        // A guest write to a broken console must not panic or error out.
        serial.write(0, b"lost");
        let mut data = [0u8; 1];
        serial.read(5, &mut data);
        assert_eq!(data[0], LSR_IDLE);
    }
}
