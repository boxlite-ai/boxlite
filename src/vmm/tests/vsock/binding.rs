// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn bound_paths_follow_device_lifetime_and_failed_bind_preserves_existing_socket() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("agent.sock");
    let occupied = dir.path().join("occupied.sock");
    let owner = UnixListener::bind(&occupied).unwrap();
    let mut config = crate::VsockConfig {
        cid: 3,
        listen: vec![(2695, first.clone()), (2696, occupied.clone())],
        connect: vec![],
    };
    assert!(Vsock::bind(&config).is_err());
    assert!(!first.exists());
    assert!(occupied.exists());
    config.listen.pop();
    let device = Vsock::bind(&config).unwrap();
    assert!(first.exists());
    drop(device);
    assert!(!first.exists());
    drop(owner);
}

#[test]
fn dropping_device_preserves_a_replacement_at_the_bound_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agent.sock");
    let device = Vsock::bind(&crate::VsockConfig {
        cid: 3,
        listen: vec![(2695, path.clone())],
        connect: vec![],
    })
    .unwrap();
    std::fs::remove_file(&path).unwrap();
    let replacement = UnixListener::bind(&path).unwrap();
    drop(device);
    assert!(std::os::unix::net::UnixStream::connect(&path).is_ok());
    drop(replacement);
}

#[test]
fn invalid_mapping_cleans_up_successfully_bound_paths() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agent.sock");
    assert!(
        Vsock::bind(&crate::VsockConfig {
            cid: 2,
            listen: vec![(2695, path.clone())],
            connect: vec![],
        })
        .is_err()
    );
    assert!(!path.exists());
}
