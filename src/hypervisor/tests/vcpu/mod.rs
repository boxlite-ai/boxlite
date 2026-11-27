// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;

use super::{PendingIo, PendingIoStep};

#[test]
fn completion_without_pending_io_skips_entry() {
    let mut pending = PendingIo::default();
    assert_eq!(
        pending.complete(|| panic!("no pending I/O")).unwrap(),
        PendingIoStep::Done
    );
}

#[test]
fn interrupted_entry_consumes_pending_io() {
    let errors = [
        io::Error::from(io::ErrorKind::Interrupted),
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        io::Error::from_raw_os_error(libc::EINTR),
    ];
    for error in errors {
        let mut pending = PendingIo(true);
        assert_eq!(
            pending.complete(|| Err(error)).unwrap(),
            PendingIoStep::Done
        );
        assert!(!pending.0);
        assert_eq!(
            pending
                .complete(|| panic!("I/O already completed"))
                .unwrap(),
            PendingIoStep::Done
        );
    }
}

#[test]
fn failed_entry_preserves_pending_io() {
    let mut pending = PendingIo(true);
    let error = pending
        .complete(|| Err(io::Error::other("test I/O error")))
        .unwrap_err();
    assert_eq!(error.to_string(), "test I/O error");
    assert!(pending.0);
}

#[test]
fn successful_kvm_reentry_can_return_a_follow_up_exit() {
    let mut pending = PendingIo(true);
    assert_eq!(pending.complete(|| Ok(())).unwrap(), PendingIoStep::Exit);
    assert!(pending.0);
}
