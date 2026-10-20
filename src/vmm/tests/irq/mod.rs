// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Interrupt lines over the mock backend.

use std::{error::Error as _, io, sync::Arc};

use super::IrqLine;
use crate::{
    error::Error,
    mock_vm::{Call, MockVm},
};

#[test]
fn a_pulse_sets_then_clears_its_line() {
    let vm = Arc::new(MockVm::new());

    IrqLine::new(vm.clone(), 4).pulse().unwrap();

    assert_eq!(
        vm.calls(),
        [
            Call::SetIrqLine {
                line: 4,
                level: true
            },
            Call::SetIrqLine {
                line: 4,
                level: false
            },
        ]
    );
}

#[test]
fn a_failed_set_skips_the_clear_and_keeps_the_host_cause() {
    let vm = Arc::new(MockVm::failing_at(&[0]));

    let error = IrqLine::new(vm.clone(), 4).pulse().unwrap_err();

    assert_eq!(
        vm.calls(),
        [Call::SetIrqLine {
            line: 4,
            level: true
        }]
    );
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
fn a_failed_clear_is_reported() {
    let vm = Arc::new(MockVm::failing_at(&[1]));

    let error = IrqLine::new(vm.clone(), 9).pulse().unwrap_err();

    assert_eq!(vm.calls().len(), 2);
    assert_eq!(
        error.source().map(ToString::to_string).as_deref(),
        Some("failed to set interrupt line 9")
    );
}
