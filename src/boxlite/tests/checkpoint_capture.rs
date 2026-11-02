//! Real shim capture exclusion, separate from the fake-owner control unit tests.
//! Run with `make test:integration:rust FILTER=checkpoint_shim_capture SETUP_DONE=1`.
#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

mod common;

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

use boxlite::runtime::layout::BoxFilesystemLayout;
use boxlite::vmm::checkpoint::protocol::DescriptorRequest;
use boxlite::vmm::checkpoint::{ControlClient, ControlRequest, FailureKind, Operation, VmRunState};
use boxlite::{BoxOptions, BoxliteOptions, BoxliteRuntime, LiteBox, PauseOptions, RootfsSpec};
use boxlite_test_utils::home::PerTestBoxHome;

async fn paused_box() -> (PerTestBoxHome, BoxliteRuntime, LiteBox, ControlClient) {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/kvm")
        .expect("real capture tests require KVM");
    let home = PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let box_ = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    box_.start().await.unwrap();
    box_.pause(PauseOptions::default()).await.unwrap();
    let layout = BoxFilesystemLayout::new(
        home.path.join("boxes").join(box_.id().as_str()),
        Default::default(),
        false,
    );
    let client = ControlClient::new(layout.control_socket_path());
    (home, runtime, box_, client)
}

async fn begin(client: &ControlClient) -> (u64, UnixStream) {
    let (peer, owner) = UnixStream::pair().unwrap();
    let (reply, _) = client
        .descriptors(
            DescriptorRequest::Begin { disk_only: false },
            vec![owner.into()],
        )
        .await
        .unwrap();
    assert!(reply.error.is_none(), "{reply:?}");
    assert_eq!(reply.state, VmRunState::Paused);
    let token = reply.metadata["token"].as_u64().unwrap();
    let state = client.send(&ControlRequest::State).await.unwrap();
    assert!(state.error.is_none(), "{state:?}");
    assert_eq!(state.state, VmRunState::Paused);
    assert_eq!(state.in_flight, Some(Operation::Capture));
    (token, peer)
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_shim_capture_excludes_mutations_until_end() {
    let (_home, runtime, box_, client) = paused_box().await;
    let (token, _peer) = begin(&client).await;
    let independent = ControlClient::new(client.socket());
    for request in [
        ControlRequest::Resume,
        ControlRequest::Pause {
            host_writers_stopped: true,
        },
    ] {
        let reply = independent.send(&request).await.unwrap();
        assert_eq!(reply.error.unwrap().kind, FailureKind::Busy);
        assert_eq!(reply.state, VmRunState::Paused);
        assert_eq!(reply.in_flight, Some(Operation::Capture));
    }
    let (_other_peer, other_owner) = UnixStream::pair().unwrap();
    let (reply, _) = independent
        .descriptors(
            DescriptorRequest::Begin { disk_only: false },
            vec![other_owner.into()],
        )
        .await
        .unwrap();
    assert_eq!(reply.error.unwrap().kind, FailureKind::Busy);
    assert_eq!(reply.state, VmRunState::Paused);
    let state = independent.send(&ControlRequest::State).await.unwrap();
    assert_eq!(state.state, VmRunState::Paused);
    assert_eq!(state.in_flight, Some(Operation::Capture));

    let (reply, _) = client
        .descriptors(
            DescriptorRequest::End {
                token,
                cancel: false,
            },
            Vec::new(),
        )
        .await
        .unwrap();
    assert!(reply.error.is_none(), "{reply:?}");
    assert_eq!(reply.state, VmRunState::Paused);
    let reply = independent.send(&ControlRequest::Resume).await.unwrap();
    assert!(reply.error.is_none(), "{reply:?}");
    assert_eq!(reply.state, VmRunState::Running);
    assert_eq!(reply.in_flight, None);
    box_.stop().await.unwrap();
    runtime.remove(box_.id().as_str(), false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_shim_capture_stop_invalidates_session() {
    let (_home, runtime, box_, client) = paused_box().await;
    let pid = box_.info().await.unwrap().pid.unwrap();
    // A pidfd proves this exact shim exited, even if Stop races its final reply.
    // SAFETY: pidfd_open only obtains a handle to the live shim PID.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    assert!(fd >= 0, "pidfd_open: {}", std::io::Error::last_os_error());
    // SAFETY: pidfd_open returned a fresh descriptor owned by this test.
    let pidfd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    let (token, _peer) = begin(&client).await;
    let independent = ControlClient::new(client.socket());
    match independent.send(&ControlRequest::Stop).await {
        Ok(reply) => {
            assert!(reply.error.is_none(), "{reply:?}");
            // Stop can acknowledge before the owner publishes its terminal state.
            // The pidfd below must still prove this shim actually exits.
            eprintln!("Stop accepted; reported state: {}", reply.state);
        }
        Err(error) => eprintln!("Stop transport ended; requiring shim exit: {error}"),
    }
    match client
        .descriptors(
            DescriptorRequest::End {
                token,
                cancel: false,
            },
            Vec::new(),
        )
        .await
    {
        Ok((reply, _)) => {
            assert!(reply.error.is_some(), "old capture token survived Stop");
            assert!(reply.state.is_terminal(), "{reply:?}");
        }
        Err(error) => eprintln!("Old session transport ended: {error}"),
    }
    match independent.send(&ControlRequest::Resume).await {
        Ok(reply) => {
            assert!(reply.error.is_some(), "stopped VM resumed");
            assert!(reply.state.is_terminal(), "{reply:?}");
        }
        Err(error) => eprintln!("Resume transport ended: {error}"),
    }
    tokio::task::spawn_blocking(move || {
        let mut poll = libc::pollfd {
            fd: pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll references one live pidfd for a bounded wait.
        assert_eq!(unsafe { libc::poll(&mut poll, 1, 30_000) }, 1);
        assert_ne!(poll.revents & libc::POLLIN, 0, "shim did not exit");
    })
    .await
    .unwrap();
    runtime.remove(box_.id().as_str(), true).await.unwrap();
}
