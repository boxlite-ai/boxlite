// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `set_online_cpus_at` against fake sysfs trees: its time bound and its
//! mapping of failures to gRPC codes.

use std::time::Duration;

use tonic::Status;

use super::{set_online_cpus_at, SetOnlineCpusError, SET_ONLINE_CPUS_TIMEOUT};

/// A fake sysfs CPU directory with CPUs 0-1, where writing CPU 1's
/// `online` file blocks like onlining a CPU the host has not granted.
fn blocking_cpu_root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("present"), "0-1\n").unwrap();
    std::fs::create_dir(root.path().join("cpu1")).unwrap();
    // Opening a FIFO for writing blocks until a reader opens it.
    nix::unistd::mkfifo(
        &root.path().join("cpu1/online"),
        nix::sys::stat::Mode::from_bits_truncate(0o600),
    )
    .unwrap();
    root
}

#[test]
fn set_online_cpus_gives_up_on_a_blocked_write() {
    let root = blocking_cpu_root();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let started = std::time::Instant::now();
    // Count 1 reads CPU 1's state to offline it; that open never returns.
    let error = runtime
        .block_on(set_online_cpus_at(
            root.path().into(),
            1,
            Duration::from_millis(100),
        ))
        .unwrap_err();
    assert!(
        matches!(error, SetOnlineCpusError::TimedOut(_)),
        "{error:?}"
    );
    assert_eq!(Status::from(error).code(), tonic::Code::DeadlineExceeded);
    assert!(started.elapsed() < Duration::from_secs(5));
    // The worker stays blocked in the kernel, as a refused online would;
    // do not wait for it.
    runtime.shutdown_background();
}

#[tokio::test]
async fn set_online_cpus_maps_a_bad_count_to_invalid_argument() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("present"), "0\n").unwrap();
    let error = set_online_cpus_at(root.path().into(), 2, SET_ONLINE_CPUS_TIMEOUT)
        .await
        .unwrap_err();
    assert_eq!(Status::from(error).code(), tonic::Code::InvalidArgument);
    let online = set_online_cpus_at(root.path().into(), 1, SET_ONLINE_CPUS_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(online, [0]);
}
