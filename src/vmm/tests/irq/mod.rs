// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Interrupt lines over the mock backend: edges, held levels, the drop rule,
//! and host failures that keep their cause.

use std::{error::Error as _, io, sync::Arc};

use super::IrqLine;
use crate::{
    error::Error,
    mock_vm::{Call, MockVm},
};

fn set(line: u32, level: bool) -> Call {
    Call::SetIrqLine { line, level }
}

#[test]
fn a_pulse_sets_then_clears_its_line() {
    let vm = Arc::new(MockVm::new());

    let line = IrqLine::new(vm.clone(), 4);
    line.pulse().unwrap();
    drop(line);

    assert_eq!(
        vm.calls(),
        [set(4, true), set(4, false)],
        "drop adds nothing"
    );
}

#[test]
fn a_level_is_set_once_and_lowered_on_drop() {
    let vm = Arc::new(MockVm::new());

    let line = IrqLine::new(vm.clone(), 32);
    line.set_level(false).unwrap();
    line.set_level(true).unwrap();
    line.set_level(true).unwrap();
    assert_eq!(
        vm.calls(),
        [set(32, true)],
        "a repeated level is no host call"
    );
    drop(line);

    assert_eq!(
        vm.calls(),
        [set(32, true), set(32, false)],
        "a line held high is lowered when its owner goes"
    );
}

#[test]
fn a_failed_set_skips_the_clear_and_keeps_the_host_cause() {
    let vm = Arc::new(MockVm::failing_at(&[0]));

    let error = IrqLine::new(vm.clone(), 4).pulse().unwrap_err();

    assert_eq!(vm.calls(), [set(4, true)]);
    assert!(
        matches!(
            error,
            Error::Hypervisor(boxlite_hypervisor::Error::SetIrqLine { line: 4, .. })
        ),
        "{error:?}"
    );
    let cause = error
        .source()
        .and_then(|hypervisor| hypervisor.source())
        .and_then(|cause| cause.downcast_ref::<io::Error>())
        .expect("host cause");
    assert_eq!(cause.kind(), io::ErrorKind::OutOfMemory);
}

#[test]
fn a_failed_clear_is_reported_and_drop_retries_it() {
    let vm = Arc::new(MockVm::failing_at(&[1]));

    let line = IrqLine::new(vm.clone(), 9);
    let error = line.pulse().unwrap_err();
    assert_eq!(
        error.source().map(ToString::to_string).as_deref(),
        Some("failed to set interrupt line 9")
    );
    drop(line);

    assert_eq!(vm.calls(), [set(9, true), set(9, false), set(9, false)]);
}

#[test]
fn a_failed_level_leaves_the_line_as_it_was() {
    let vm = Arc::new(MockVm::failing_at(&[0]));

    let line = IrqLine::new(vm.clone(), 33);
    assert!(line.set_level(true).is_err());
    drop(line);

    assert_eq!(
        vm.calls(),
        [set(33, true)],
        "nothing to lower after a failed set"
    );
}
