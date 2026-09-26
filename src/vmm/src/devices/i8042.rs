// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The i8042 keyboard controller at ports `0x60` (data) and `0x64` (command).
//!
//! In a microVM this device exists for one instruction: the guest writing
//! `0xFE` (reset CPU) to the command port. BoxLite's guest agent ends every
//! box with `reboot(RESTART)` — x86_64 has no ACPI power-off — so that byte
//! is the VM's shutdown path: the design document has the VMM's i8042 turn
//! the reset `IoOut` into the VM's termination.
//!
//! The reset is reported by setting an injected `Arc<AtomicBool>`; the
//! future `Vm::run` poller watches that flag and drives the stop protocol
//! (design, "Stopping"). The device never exits the process itself.
//!
//! Everything else the driver probes must answer, or kernel probing stalls.
//! The two ports have strictly separate command spaces: the controller's
//! own commands arrive on 0x64, while keyboard commands the guest writes to
//! 0x60 pass through to the attached device, which answers there — and the
//! device keeps its own one-deep parameter state (`F0`, `ED`, `F3` wait for
//! a follow-up byte). The controller's translation bit (command register
//! bit 6) selects whether the keyboard's scan-set query answers with
//! translated codes (43/41/3F) or the raw set number, which is what Linux's
//! `atkbd` branches on. Linux's `i8042` and `atkbd` drivers also wait for
//! Input-Buffer-Full to stay clear before writing — so this emulation,
//! which consumes every byte synchronously, always reports the input
//! buffer empty. Behavior cross-checked against libkrun/Firecracker's
//! `devices/legacy/i8042` (e12b9b3 / 68698ad), QEMU's `hw/input/ps2.c`,
//! the AT keyboard command set, and the standard five-port window
//! registration at `0x60` that carries the two ports by offset.

use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::bus::BusDevice;

/// Output-buffer-full: the guest must read port 0x60 before more responses.
const STATUS_OUT_DATA: u8 = 0x01;
/// Self-test passed: the BIOS post always ran fine in a VM.
const STATUS_SELF_TEST_OK: u8 = 0x04;

// Controller commands written to port 0x64. Only the two-step commands take
// a parameter, which arrives on the data port.
const CMD_READ_CONTROL: u8 = 0x20;
const CMD_WRITE_CONTROL: u8 = 0x60;
const CMD_DISABLE_SECOND_PORT: u8 = 0xA7;
const CMD_ENABLE_SECOND_PORT: u8 = 0xA8;
const CMD_DISABLE_FIRST_PORT: u8 = 0xAD;
const CMD_ENABLE_FIRST_PORT: u8 = 0xAE;
const CMD_CONTROLLER_TEST: u8 = 0xAA;
const CMD_READ_OUTPUT_PORT: u8 = 0xD0;
const CMD_WRITE_OUTPUT_PORT: u8 = 0xD1;
const CMD_RESET_CPU: u8 = 0xFE;

// Keyboard commands the guest writes to port 0x60; the controller forwards
// them to the attached device, which answers on the same port.
const KBD_SET_LED: u8 = 0xED; // parameter: LED state
const KBD_ECHO: u8 = 0xEE;
const KBD_SET_SCANSET: u8 = 0xF0; // parameter: set 1–3, or 0 to query
const KBD_READ_ID: u8 = 0xF2;
const KBD_SET_REPEAT: u8 = 0xF3; // parameter: repeat rate/delay
const KBD_RESET_DISABLE: u8 = 0xF5; // defaults (set 2), then stop scanning
const KBD_RESET_DEFAULTS: u8 = 0xF6; // defaults (set 2)
const KBD_RESEND: u8 = 0xFE; // repeat the last byte sent to the host
const KBD_RESET: u8 = 0xFF; // defaults (set 2); BAT follows the ack

// Replies. The controller self-test answers 0x55 (i8042 datasheet); the
// keyboard's built-in assurance test answers 0xAA after its ack.
const KBD_ACK: u8 = 0xFA;
const CONTROLLER_TEST_PASS: u8 = 0x55;
const KBD_BAT_PASS: u8 = 0xAA;

/// Query answers for `F0 00`, the translated set codes the AT command set
/// documents (set 1 → 43, set 2 → 41, set 3 → 3F). Linux's `atkbd`
/// `GSCANSET` reads exactly one of these after the second ack.
const fn scanset_code(set: u8) -> u8 {
    match set {
        1 => 0x43,
        3 => 0x3F,
        _ => 0x41,
    }
}

// Control register bits, positions verbatim from Linux's <linux/i8042.h>
// (I8042_CTR_KBDINT/AUXINT/KBDDIS/AUXDIS/XLATE). The port bits carry disable
// semantics: commands 0xAD/0xA7 set them to lock a port out, 0xAE/0xAC
// clear them. A BIOS-clean controller boots with the ports enabled (bits
// clear), translation on, and both interrupt enables set: 0x43.
const CONTROL_KBD_INTERRUPT: u8 = 0x01;
const CONTROL_AUX_INTERRUPT: u8 = 0x02;
const CONTROL_FIRST_PORT_DISABLED: u8 = 0x10;
const CONTROL_SECOND_PORT_DISABLED: u8 = 0x20;
const CONTROL_TRANSLATION: u8 = 0x40;

/// Controller commands whose parameter byte arrives on the data port.
#[derive(PartialEq, Eq)]
enum Expect {
    /// 0x60: the payload is the controller's new control register.
    ControlByte,
    /// 0xD1: the payload drives the output port latch.
    OutputPort,
}

/// Keyboard commands waiting for their parameter byte on port 0x60.
#[derive(PartialEq, Eq)]
enum KbdExpect {
    /// `F0`: the payload selects a scan-code set, or 0 queries the current
    /// one, which answers (translated or raw) after the ack.
    ScanSet,
    /// `ED`/`F3`: the payload configures LEDs or repeat timing; we have
    /// neither device, so it is swallowed behind an ack.
    Parameter,
}

/// An emulated i8042 PS/2 host controller.
///
/// Register it on the [`IoBus`] as one five-port window at `0x60`: offset 0
/// is the data port, offset 4 the command/status port.
pub struct I8042 {
    reset: Arc<AtomicBool>,
    /// The controller's control register, readable via 0x20.
    command: u8,
    /// The output latch, readable via 0xD0.
    output_port: u8,
    expect: Option<Expect>,
    kbd_expect: Option<KbdExpect>,
    /// The attached keyboard's scan-code set; PS/2 keyboards boot in set 2.
    scan_set: u8,
    /// Host-visible responses, drained one byte per 0x60 read. Each byte
    /// remembers whether it came from the keyboard, so `FE` resend re-sends
    /// only keyboard traffic.
    resp: VecDeque<(u8, bool)>,
    /// The last keyboard byte the host read; what `FE` re-queues.
    last_kbd_sent: Option<u8>,
}

impl I8042 {
    /// The first port of the five-port window the device occupies.
    pub const PORT_BASE: u16 = 0x60;
    /// The width of that window (0x60..=0x64).
    pub const PORT_WINDOW: u16 = 5;

    /// Creates a controller whose CPU-reset command raises `reset_requested`.
    pub fn new(reset_requested: Arc<AtomicBool>) -> Self {
        Self {
            reset: reset_requested,
            // 0x43: POST passed, both ports enabled (disable bits clear),
            // translation on, both interrupt enables set — what a
            // clean-booting PC reports through CMD_READ_CONTROL.
            command: CONTROL_KBD_INTERRUPT | CONTROL_AUX_INTERRUPT | CONTROL_TRANSLATION,
            output_port: 0,
            expect: None,
            kbd_expect: None,
            scan_set: 2,
            resp: VecDeque::new(),
            last_kbd_sent: None,
        }
    }

    /// Queues a controller reply, replacing anything the driver never read.
    fn push(&mut self, bytes: &[u8]) {
        self.replace_reply(bytes, false);
    }

    /// Queues a keyboard reply.
    fn push_kbd(&mut self, bytes: &[u8]) {
        self.replace_reply(bytes, true);
    }

    /// Drivers wait for the previous reply's bytes before writing again, so
    /// the queue is empty at every push in a well-behaved probe sequence;
    /// replacing it is safe for the bytes a buggy driver left unread.
    fn replace_reply(&mut self, bytes: &[u8], keyboard: bool) {
        self.resp.clear();
        self.resp.extend(bytes.iter().map(|b| (*b, keyboard)));
    }

    fn read_status(&mut self) -> u8 {
        // Input-buffer-full (bit 1) always reads clear: the emulation
        // consumes every byte synchronously, so the driver's wait for a
        // writable controller before a parameter byte — before every
        // keyboard write as well — never times out.
        let mut status = STATUS_SELF_TEST_OK;
        if !self.resp.is_empty() {
            status |= STATUS_OUT_DATA;
        }
        status
    }

    fn read_data(&mut self) -> u8 {
        match self.resp.pop_front() {
            Some((byte, true)) => {
                self.last_kbd_sent = Some(byte);
                byte
            }
            Some((byte, false)) => byte,
            None => 0,
        }
    }

    fn write_command(&mut self, value: u8) {
        match value {
            CMD_RESET_CPU => self.reset.store(true, Ordering::SeqCst),
            CMD_READ_CONTROL => self.push(&[self.command]),
            CMD_WRITE_CONTROL => self.expect = Some(Expect::ControlByte),
            // The enable/disable commands set and clear the two port
            // disable bits we keep of the control register.
            CMD_DISABLE_FIRST_PORT => self.command |= CONTROL_FIRST_PORT_DISABLED,
            CMD_ENABLE_FIRST_PORT => self.command &= !CONTROL_FIRST_PORT_DISABLED,
            CMD_DISABLE_SECOND_PORT => self.command |= CONTROL_SECOND_PORT_DISABLED,
            CMD_ENABLE_SECOND_PORT => self.command &= !CONTROL_SECOND_PORT_DISABLED,
            CMD_CONTROLLER_TEST => self.push(&[CONTROLLER_TEST_PASS]),
            CMD_READ_OUTPUT_PORT => self.push(&[self.output_port]),
            CMD_WRITE_OUTPUT_PORT => self.expect = Some(Expect::OutputPort),
            // Deliberate leniency: acknowledge an unknown controller
            // command so a probe cannot stall the guest on it.
            _ => self.push(&[KBD_ACK]),
        }
    }

    fn write_data(&mut self, value: u8) {
        if let Some(expect) = self.expect.take() {
            // The byte is a pending controller command's parameter.
            match expect {
                Expect::ControlByte => self.command = value,
                Expect::OutputPort => self.output_port = value,
            }
            return;
        }
        if let Some(kbd_expect) = self.kbd_expect.take() {
            // The byte is the pending keyboard command's parameter.
            match kbd_expect {
                KbdExpect::Parameter => self.push_kbd(&[KBD_ACK]),
                KbdExpect::ScanSet => match value {
                    1..=3 => {
                        self.scan_set = value;
                        self.push_kbd(&[KBD_ACK]);
                    }
                    // GSCANSET: the set's code follows the ack — translated
                    // values with the controller's translation bit set, the
                    // raw set number with it clear. atkbd parses both forms.
                    0 => {
                        let code = if (self.command & CONTROL_TRANSLATION) != 0 {
                            scanset_code(self.scan_set)
                        } else {
                            self.scan_set
                        };
                        self.push_kbd(&[KBD_ACK, code]);
                    }
                    // An invalid set keeps the current one; real keyboards
                    // acknowledge twice.
                    _ => self.push_kbd(&[KBD_ACK, KBD_ACK]),
                },
            }
            return;
        }
        // Otherwise the controller forwards it to the attached keyboard, a
        // standard scancode-set-2 device.
        match value {
            KBD_SET_LED | KBD_SET_REPEAT => {
                self.kbd_expect = Some(KbdExpect::Parameter);
                self.push_kbd(&[KBD_ACK]);
            }
            KBD_SET_SCANSET => {
                self.kbd_expect = Some(KbdExpect::ScanSet);
                self.push_kbd(&[KBD_ACK]);
            }
            // F5, F6 and FF restore the keyboard defaults: set 2 (QEMU's
            // ps2.c does the same on every one of them).
            KBD_RESET_DISABLE | KBD_RESET_DEFAULTS => {
                self.scan_set = 2;
                self.push_kbd(&[KBD_ACK]);
            }
            KBD_RESET => {
                self.scan_set = 2;
                // Ack, then the built-in assurance test passes. atkbd's
                // RESET_BAT reads exactly this pair.
                self.push_kbd(&[KBD_ACK, KBD_BAT_PASS]);
            }
            // FE repeats the last byte sent to the host without dropping
            // anything still queued behind it.
            KBD_RESEND => match self.last_kbd_sent {
                Some(byte) => self.resp.push_front((byte, true)),
                None => self.push_kbd(&[KBD_ACK]),
            },
            KBD_READ_ID => self.push_kbd(&[KBD_ACK, 0xAB, 0x00]),
            KBD_ECHO => self.push_kbd(&[KBD_ECHO]),
            // Deliberate leniency: acknowledge anything else (enable,
            // disable, make/break modes, stray bytes) so a driver probe
            // can never stall the guest on an unsupported command.
            _ => self.push_kbd(&[KBD_ACK]),
        }
    }
}

impl BusDevice for I8042 {
    /// Offset 0 serves the data port and offset 4 the command/status port;
    /// a multi-byte access visits distinct ports byte by byte, like
    /// consecutive `inb`/`outb` across the five-port window. Only reads of
    /// the data port pop the reply queue. Ports between and outside read 0
    /// and ignore writes.
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = match offset.saturating_add(i as u64) {
                0 => self.read_data(),
                4 => self.read_status(),
                _ => 0,
            };
        }
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        for (i, byte) in data.iter().enumerate() {
            match offset.saturating_add(i as u64) {
                0 => self.write_data(*byte),
                4 => self.write_command(*byte),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller() -> (I8042, Arc<AtomicBool>) {
        let reset = Arc::new(AtomicBool::new(false));
        (I8042::new(Arc::clone(&reset)), reset)
    }

    /// Reads the data port (window offset 0).
    fn read_data(dev: &mut I8042) -> u8 {
        let mut data = [0u8; 1];
        dev.read(0, &mut data);
        data[0]
    }

    /// Reads the status port (window offset 4).
    fn read_status(dev: &mut I8042) -> u8 {
        let mut data = [0u8; 1];
        dev.read(4, &mut data);
        data[0]
    }

    fn write_command(dev: &mut I8042, value: u8) {
        dev.write(4, &[value]);
    }

    fn write_data(dev: &mut I8042, value: u8) {
        dev.write(0, &[value]);
    }

    /// Reads the current scan-code set through the GSCANSET sequence.
    fn query_scan_set(dev: &mut I8042) -> u8 {
        write_data(dev, KBD_SET_SCANSET);
        assert_eq!(read_data(dev), KBD_ACK);
        write_data(dev, 0x00);
        assert_eq!(read_data(dev), KBD_ACK);
        read_data(dev)
    }

    #[test]
    fn reset_command_sets_the_shutdown_flag() {
        let (mut dev, reset) = controller();
        assert!(!reset.load(Ordering::SeqCst));
        write_command(&mut dev, CMD_RESET_CPU);
        assert!(reset.load(Ordering::SeqCst));
    }

    #[test]
    fn status_tracks_the_output_buffer() {
        let (mut dev, _) = controller();
        // Fresh controller: self-test OK, no pending byte.
        assert_eq!(read_status(&mut dev), STATUS_SELF_TEST_OK);
        write_data(&mut dev, KBD_READ_ID);
        assert_eq!(read_status(&mut dev) & STATUS_OUT_DATA, STATUS_OUT_DATA);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(read_data(&mut dev), 0xAB);
        assert_eq!(read_data(&mut dev), 0x00);
        // Drained: the data-ready bit drops again.
        assert_eq!(read_status(&mut dev) & STATUS_OUT_DATA, 0);
        // Reading past the end answers zero, never a panic.
        assert_eq!(read_data(&mut dev), 0);
    }

    #[test]
    fn input_buffer_is_always_writable() {
        // The driver's protocol: after a command byte it waits for
        // IBF == 0 before writing the parameter. A synchronous emulation
        // must never hold it high — not even between a two-step command
        // and its parameter, controller or keyboard alike.
        let (mut dev, _) = controller();
        write_command(&mut dev, CMD_WRITE_CONTROL);
        assert_eq!(read_status(&mut dev) & 0x02, 0);
        write_data(&mut dev, 0x47);
        assert_eq!(read_status(&mut dev) & 0x02, 0);
        write_data(&mut dev, KBD_SET_SCANSET);
        assert_eq!(read_status(&mut dev) & 0x02, 0);
    }

    /// The `atkbd` GSCANSET sequence (ATKBD_CMD_GSCANSET = 0x11f0) with
    /// the controller's translation on: the query answers the translated
    /// set code.
    #[test]
    fn scancode_set_query_and_switch_translated() {
        let (mut dev, _) = controller();
        assert_eq!(query_scan_set(&mut dev), scanset_code(2)); // boots in set 2
        assert_eq!(read_status(&mut dev) & STATUS_OUT_DATA, 0);

        // SSCANSET: switch to set 3, query sees its translated code.
        write_data(&mut dev, KBD_SET_SCANSET);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        write_data(&mut dev, 0x03);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(
            read_status(&mut dev) & STATUS_OUT_DATA,
            0,
            "a set switch acks alone"
        );
        assert_eq!(query_scan_set(&mut dev), scanset_code(3));

        // An invalid set keeps the current one and acks twice.
        write_data(&mut dev, KBD_SET_SCANSET);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        write_data(&mut dev, 0x07);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(query_scan_set(&mut dev), scanset_code(3));
    }

    /// With translation off (control register bit 6 cleared), the query
    /// answers the raw set number — the other form atkbd parses.
    #[test]
    fn scancode_set_query_is_raw_without_translation() {
        let (mut dev, _) = controller();
        write_command(&mut dev, CMD_WRITE_CONTROL);
        // Ports enabled (disable bits clear), translation off: the 0x00 of
        // the BIOS value minus XLATE.
        write_data(&mut dev, CONTROL_KBD_INTERRUPT | CONTROL_AUX_INTERRUPT);
        assert_eq!(query_scan_set(&mut dev), 2);
        write_data(&mut dev, KBD_SET_SCANSET);
        read_data(&mut dev);
        write_data(&mut dev, 0x01);
        read_data(&mut dev);
        assert_eq!(query_scan_set(&mut dev), 1);
    }

    #[test]
    fn reset_commands_restore_scan_set_two() {
        let (mut dev, _) = controller();
        // Move to set 3 first, then every reset path must bring set 2 back.
        write_data(&mut dev, KBD_SET_SCANSET);
        read_data(&mut dev);
        write_data(&mut dev, 0x03);
        read_data(&mut dev);
        assert_eq!(query_scan_set(&mut dev), scanset_code(3));

        for cmd in [KBD_RESET_DISABLE, KBD_RESET_DEFAULTS, KBD_RESET] {
            write_data(&mut dev, cmd);
            read_data(&mut dev); // FA (FF also queued AA; drained by the query's clear-push)
            assert_eq!(
                query_scan_set(&mut dev),
                scanset_code(2),
                "after {cmd:#02x}"
            );
        }
    }

    #[test]
    fn resend_repeats_the_last_keyboard_byte() {
        let (mut dev, _) = controller();
        write_data(&mut dev, KBD_READ_ID);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(read_data(&mut dev), 0xAB);
        // The host NAKs AB and asks for it again: FE re-queues the last
        // keyboard byte ahead of the unread remainder, no clearing.
        write_data(&mut dev, KBD_RESEND);
        assert_eq!(read_data(&mut dev), 0xAB);
        assert_eq!(read_data(&mut dev), 0x00);
        // A resend with no history yet acknowledges instead.
        let (mut fresh, _) = controller();
        write_data(&mut fresh, KBD_RESEND);
        assert_eq!(read_data(&mut fresh), KBD_ACK);
    }

    #[test]
    fn led_and_repeat_parameters_are_swallowed_behind_acks() {
        let (mut dev, _) = controller();
        for cmd in [KBD_SET_LED, KBD_SET_REPEAT] {
            write_data(&mut dev, cmd);
            assert_eq!(read_data(&mut dev), KBD_ACK);
            assert_eq!(
                read_status(&mut dev) & STATUS_OUT_DATA,
                0,
                "the command answers only the ack"
            );
            write_data(&mut dev, 0x01);
            assert_eq!(read_data(&mut dev), KBD_ACK);
            assert_eq!(
                read_status(&mut dev) & STATUS_OUT_DATA,
                0,
                "the parameter consumed"
            );
        }
    }

    #[test]
    fn keyboard_reset_acks_then_reports_bat_pass() {
        // atkbd's RESET_BAT (0x02ff) reads FA then AA.
        let (mut dev, _) = controller();
        write_data(&mut dev, KBD_RESET);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(read_data(&mut dev), KBD_BAT_PASS);
        // Echo answers itself; GETID answers the full triple.
        write_data(&mut dev, KBD_ECHO);
        assert_eq!(read_data(&mut dev), KBD_ECHO);
        write_data(&mut dev, KBD_READ_ID);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(read_data(&mut dev), 0xAB);
        assert_eq!(read_data(&mut dev), 0x00);
    }

    #[test]
    fn write_control_is_a_two_step_command() {
        let (mut dev, _) = controller();
        write_command(&mut dev, CMD_WRITE_CONTROL);
        write_data(&mut dev, 0x43);
        write_command(&mut dev, CMD_READ_CONTROL);
        assert_eq!(read_data(&mut dev), 0x43);
    }

    #[test]
    fn port_locks_fold_into_the_control_register() {
        let (mut dev, _) = controller();
        // A clean PC boots at 0x43: interrupts + translation, ports enabled.
        write_command(&mut dev, CMD_READ_CONTROL);
        assert_eq!(
            read_data(&mut dev),
            CONTROL_KBD_INTERRUPT | CONTROL_AUX_INTERRUPT | CONTROL_TRANSLATION
        );
        // 0xAD/0xA7 lock the ports out (disable bits set).
        write_command(&mut dev, CMD_DISABLE_FIRST_PORT);
        write_command(&mut dev, CMD_DISABLE_SECOND_PORT);
        write_command(&mut dev, CMD_READ_CONTROL);
        assert_eq!(
            read_data(&mut dev),
            CONTROL_KBD_INTERRUPT
                | CONTROL_AUX_INTERRUPT
                | CONTROL_TRANSLATION
                | CONTROL_FIRST_PORT_DISABLED
                | CONTROL_SECOND_PORT_DISABLED
        );
        // 0xAE/0xAC re-enable them.
        write_command(&mut dev, CMD_ENABLE_FIRST_PORT);
        write_command(&mut dev, CMD_ENABLE_SECOND_PORT);
        write_command(&mut dev, CMD_READ_CONTROL);
        assert_eq!(
            read_data(&mut dev),
            CONTROL_KBD_INTERRUPT | CONTROL_AUX_INTERRUPT | CONTROL_TRANSLATION
        );
    }

    #[test]
    fn controller_commands_reply_on_the_data_port() {
        let (mut dev, _) = controller();
        write_command(&mut dev, CMD_CONTROLLER_TEST);
        assert_eq!(read_data(&mut dev), CONTROLLER_TEST_PASS);
        write_command(&mut dev, CMD_READ_OUTPUT_PORT);
        assert_eq!(read_data(&mut dev), 0x00);
        write_command(&mut dev, CMD_WRITE_OUTPUT_PORT);
        write_data(&mut dev, 0xA2);
        write_command(&mut dev, CMD_READ_OUTPUT_PORT);
        assert_eq!(read_data(&mut dev), 0xA2);
    }

    #[test]
    fn unknown_controller_commands_ack() {
        let (mut dev, _) = controller();
        // A keyboard command on the controller port is unknown there: ack,
        // not a keyboard reply.
        write_command(&mut dev, KBD_READ_ID);
        assert_eq!(read_data(&mut dev), KBD_ACK);
        assert_eq!(read_status(&mut dev) & STATUS_OUT_DATA, 0);
    }

    #[test]
    fn wide_access_walks_ports_without_panic() {
        let (mut dev, _) = controller();
        write_data(&mut dev, KBD_READ_ID);
        // A wide access visits distinct ports: only offset 0 pops the data
        // queue, offsets 1..3 are unclaimed, offset 4 is the status port.
        let mut data = [0u8; 5];
        dev.read(0, &mut data);
        assert_eq!(data[0], KBD_ACK);
        assert_eq!(data[1..4], [0, 0, 0]);
        assert_eq!(data[4] & STATUS_OUT_DATA, STATUS_OUT_DATA); // ID bytes queued
        assert_eq!(read_data(&mut dev), 0xAB);
        assert_eq!(read_data(&mut dev), 0x00);
        // A write walk that crosses both ports: replies, never a panic.
        dev.write(0, &[0x00; 8]);
        assert_eq!(read_status(&mut dev) & STATUS_OUT_DATA, STATUS_OUT_DATA);
    }
}
