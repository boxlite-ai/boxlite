// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Error presentation lives here; transport and executor tests exercise the
//! device contract through production consumers rather than a fake device's
//! own getters, setters and default methods.

use crate::virtio::{DeviceError, EventError, SnapshotError};

#[test]
fn device_errors_are_classified() {
    assert_eq!(
        DeviceError::Unsupported("x").to_string(),
        "x is not supported"
    );
    assert_eq!(
        DeviceError::NeedsReset("x").to_string(),
        "x requires a device reset"
    );
    assert_eq!(DeviceError::Fatal("x").to_string(), "x failed");
}

#[test]
fn snapshot_and_event_errors_name_their_cause() {
    assert_eq!(
        SnapshotError::Unsupported.to_string(),
        "the device does not support snapshots"
    );
    assert_eq!(EventError::Closed.to_string(), "the event worker is closed");
}

#[path = "queue.rs"]
mod queue;
