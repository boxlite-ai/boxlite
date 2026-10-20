// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{error::Error as _, io, sync::Arc};

use crate::{
    irq::{IrqChip, IrqLine},
    mock_vm::{Call, MockVm},
};

#[test]
fn pulse_sets_and_clears_the_line() {
    let mock = Arc::new(MockVm::new());
    let mut line = IrqLine::new(Arc::clone(&mock) as Arc<dyn IrqChip>, 4);

    assert_eq!(line.line(), 4);
    assert!(!line.level());

    line.pulse().expect("pulse succeeds");

    assert!(!line.level());
    assert_eq!(
        mock.calls(),
        vec![
            Call::SetIrqLine {
                line: 4,
                level: true,
            },
            Call::SetIrqLine {
                line: 4,
                level: false,
            },
        ]
    );
}

#[test]
fn failing_assert_stops_and_keeps_the_cause() {
    // Fail the first call (setting to true)
    let mock = Arc::new(MockVm::failing_at(&[0]));
    let mut line = IrqLine::new(Arc::clone(&mock) as Arc<dyn IrqChip>, 4);

    let err = line.pulse().expect_err("first set_irq_line fails");
    assert_eq!(err.to_string(), "hypervisor operation failed");

    let hypervisor = err.source().expect("hypervisor error source");
    assert_eq!(hypervisor.to_string(), "failed to set interrupt line 4");
    let cause = hypervisor
        .source()
        .and_then(|c| c.downcast_ref::<io::Error>())
        .expect("io::Error cause");
    assert_eq!(cause.kind(), io::ErrorKind::OutOfMemory);

    assert!(!line.level());
    assert_eq!(
        mock.calls(),
        vec![Call::SetIrqLine {
            line: 4,
            level: true,
        }]
    );
}

#[test]
fn failing_deassert_stops_and_keeps_the_cause() {
    // Fail the second call (clearing back to false)
    let mock = Arc::new(MockVm::failing_at(&[1]));
    let mut line = IrqLine::new(Arc::clone(&mock) as Arc<dyn IrqChip>, 4);

    let err = line.pulse().expect_err("second set_irq_line fails");
    assert_eq!(err.to_string(), "hypervisor operation failed");

    // The line remains asserted because the clear call failed
    assert!(line.level());
    assert_eq!(
        mock.calls(),
        vec![
            Call::SetIrqLine {
                line: 4,
                level: true,
            },
            Call::SetIrqLine {
                line: 4,
                level: false,
            },
        ]
    );
}

#[test]
fn deasserts_on_drop_if_asserted() {
    let mock = Arc::new(MockVm::new());
    {
        let mut line = IrqLine::new(Arc::clone(&mock) as Arc<dyn IrqChip>, 4);
        line.set_level(true).expect("set line high");
        assert!(line.level());
        assert_eq!(
            mock.calls(),
            vec![Call::SetIrqLine {
                line: 4,
                level: true,
            }]
        );
        // line dropped while asserted
    }

    assert_eq!(
        mock.calls(),
        vec![
            Call::SetIrqLine {
                line: 4,
                level: true,
            },
            Call::SetIrqLine {
                line: 4,
                level: false,
            },
        ]
    );
}

#[test]
fn does_not_deassert_on_drop_if_already_cleared() {
    let mock = Arc::new(MockVm::new());
    {
        let mut line = IrqLine::new(Arc::clone(&mock) as Arc<dyn IrqChip>, 4);
        line.set_level(true).expect("set high");
        line.set_level(false).expect("set low");
        assert!(!line.level());
        // line dropped while not asserted
    }

    assert_eq!(
        mock.calls(),
        vec![
            Call::SetIrqLine {
                line: 4,
                level: true,
            },
            Call::SetIrqLine {
                line: 4,
                level: false,
            },
        ]
    );
}
