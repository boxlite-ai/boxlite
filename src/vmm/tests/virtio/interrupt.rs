// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-mmio interrupt handle: status bits, acknowledgement, the
//! edge-line re-pulse, device status and the configuration generation.

use std::sync::Arc;

use crate::{
    irq::IrqLine,
    mock_vm::{Call, MockVm},
    virtio::{NEEDS_RESET, VirtioInterrupt, interrupt::MmioInterrupt},
};

fn set(line: u32, level: bool) -> Call {
    Call::SetIrqLine { line, level }
}

#[test]
fn raise_sets_the_used_bit_and_pulses_once() {
    let vm = Arc::new(MockVm::new());
    let interrupt = MmioInterrupt::new(IrqLine::new(vm.clone(), 5));

    interrupt.raise();
    assert_eq!(interrupt.interrupt_status(), 0x1);
    assert_eq!(vm.calls(), [set(5, true), set(5, false)]);

    interrupt.ack_interrupt(0x1);
    assert_eq!(interrupt.interrupt_status(), 0);
    assert_eq!(
        vm.calls(),
        [set(5, true), set(5, false)],
        "clearing the last bit needs no re-pulse"
    );
}

#[test]
fn ack_repulses_while_another_bit_remains() {
    let vm = Arc::new(MockVm::new());
    let interrupt = MmioInterrupt::new(IrqLine::new(vm.clone(), 5));

    interrupt.raise();
    interrupt.raise_config();
    assert_eq!(interrupt.interrupt_status(), 0x3);

    interrupt.ack_interrupt(0x1);
    assert_eq!(interrupt.interrupt_status(), 0x2);
    assert_eq!(
        vm.calls(),
        [
            set(5, true),
            set(5, false),
            set(5, true),
            set(5, false),
            set(5, true),
            set(5, false)
        ],
        "the remaining config bit gets a new edge"
    );

    interrupt.ack_interrupt(0x2);
    assert_eq!(interrupt.interrupt_status(), 0);
    assert_eq!(vm.calls().len(), 6);
}

#[test]
fn ack_clears_only_the_acked_bits() {
    let interrupt = MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5));

    interrupt.raise();
    interrupt.raise_config();
    interrupt.ack_interrupt(0x2);
    assert_eq!(interrupt.interrupt_status(), 0x1);
}

#[test]
fn config_generation_bumps_and_survives_reset() {
    let interrupt = MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5));

    interrupt.raise_config();
    interrupt.raise_config();
    assert_eq!(interrupt.config_generation(), 2);

    interrupt.set_device_status(0x8);
    interrupt.reset();
    assert_eq!(interrupt.interrupt_status(), 0);
    assert_eq!(interrupt.device_status(), 0);
    assert_eq!(interrupt.config_generation(), 2);
}

#[test]
fn device_status_is_shared_with_the_reader() {
    let interrupt = MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5));

    interrupt.set_device_status(0x8);
    assert_eq!(interrupt.device_status(), 0x8);
}

#[test]
fn set_needs_reset_keeps_the_driver_bits() {
    let interrupt = MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5));

    interrupt.set_device_status(0x8);
    interrupt.set_needs_reset();
    interrupt.set_needs_reset();
    assert_eq!(interrupt.device_status(), 0x8 | NEEDS_RESET);
}

#[test]
fn a_status_update_adds_its_bits() {
    let interrupt = MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5));

    interrupt.set_device_status(0x8);
    interrupt.update_device_status(0x1, NEEDS_RESET);
    assert_eq!(interrupt.device_status(), 0x9);
}

#[test]
fn a_blocked_status_update_changes_nothing() {
    let interrupt = MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5));

    interrupt.set_device_status(NEEDS_RESET);
    interrupt.update_device_status(0x1, NEEDS_RESET);
    assert_eq!(interrupt.device_status(), NEEDS_RESET);
}

#[test]
fn a_failed_pulse_keeps_the_status_bit() {
    let vm = Arc::new(MockVm::failing_at(&[0]));
    let interrupt = MmioInterrupt::new(IrqLine::new(vm, 5));

    interrupt.raise();
    assert_eq!(
        interrupt.interrupt_status(),
        0x1,
        "the status outlives a failed line pulse"
    );
}
