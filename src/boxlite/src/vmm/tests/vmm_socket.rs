use super::*;
use std::os::unix::fs::PermissionsExt;

fn grow_to(block_id: &str, bytes: u64) -> ControlRequest {
    ControlRequest {
        version: VERSION,
        op: ControlOp::ResizeDisk {
            block_id: block_id.into(),
            bytes,
        },
    }
}

#[test]
fn a_request_reaches_the_handler_and_its_answer_returns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |op, _| match op {
        ControlOp::ResizeDisk { block_id, bytes } if block_id == "container" => {
            Ok(ControlReply::DiskSize(bytes))
        }
        ControlOp::ResizeDisk { block_id, .. } => {
            Err(ControlError::InvalidInput(format!("no disk {block_id}")))
        }
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        _ => panic!("expected a resize request"),
    })
    .unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "the socket is owner-only");

    let timeout = Duration::from_secs(5);
    assert_eq!(
        request(&path, &grow_to("container", 4096), timeout).unwrap(),
        Ok(ControlReply::DiskSize(4096))
    );
    assert_eq!(
        request(&path, &grow_to("missing", 4096), timeout).unwrap(),
        Err(ControlError::InvalidInput("no disk missing".into()))
    );
}

#[test]
fn accept_recovers_from_temporary_errors_with_bounded_backoff() {
    let (mut client, stream) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    write_frame(
        &mut client,
        &serde_json::to_vec(&grow_to("container", 4096)).unwrap(),
    )
    .unwrap();

    let accept_error = |errno| Err(io::Error::from_raw_os_error(errno));
    let incoming = [
        accept_error(libc::EMFILE),
        accept_error(libc::ENFILE),
        accept_error(libc::ECONNABORTED),
        accept_error(libc::EINTR),
        accept_error(libc::EMFILE),
        accept_error(libc::ENFILE),
        accept_error(libc::EMFILE),
        accept_error(libc::ENFILE),
        Ok(stream),
        accept_error(libc::EMFILE),
        accept_error(libc::EBADF),
    ];
    let incoming = incoming.into_iter().chain(std::iter::once_with(|| {
        panic!("the listener must stop accepting after EBADF")
    }));
    let mut waits = Vec::new();
    serve_connections(
        incoming,
        |op, _| match op {
            ControlOp::ResizeDisk { bytes, .. } => Ok(ControlReply::DiskSize(bytes)),
            #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
            _ => panic!("expected a resize request"),
        },
        |delay| waits.push(delay),
    );

    let reply = read_frame(&mut client).expect("request after EMFILE must receive a reply");
    let reply: ControlResponse = serde_json::from_slice(&reply).unwrap();
    assert_eq!(reply, Ok(ControlReply::DiskSize(4096)));
    assert_eq!(waits, [5, 10, 20, 40, 50, 50, 5].map(Duration::from_millis));
}

#[test]
fn another_version_is_unsupported_and_the_shim_keeps_serving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |_, _| Ok(ControlReply::DiskSize(1))).unwrap();
    let timeout = Duration::from_secs(5);
    let mut future = grow_to("container", 512);
    future.version = VERSION + 1;
    assert!(matches!(
        request(&path, &future, timeout).unwrap(),
        Err(ControlError::Unsupported(_))
    ));
    assert_eq!(
        request(&path, &grow_to("container", 512), timeout).unwrap(),
        Ok(ControlReply::DiskSize(1))
    );
}

#[test]
fn an_oversized_or_unknown_request_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |_, _| Ok(ControlReply::DiskSize(1))).unwrap();

    // An oversized frame ends the connection without a reply.
    let mut stream = UnixStream::connect(&path).unwrap();
    stream.write_all(&(MAX_FRAME + 1).to_le_bytes()).unwrap();
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).unwrap();
    assert!(reply.is_empty());

    // An operation this protocol does not name is refused as invalid.
    let mut stream = UnixStream::connect(&path).unwrap();
    write_frame(&mut stream, br#"{"version":1,"op":"reboot"}"#).unwrap();
    let response: ControlResponse =
        serde_json::from_slice(&read_frame(&mut stream).unwrap()).unwrap();
    assert!(matches!(response, Err(ControlError::InvalidInput(_))));

    // A partial header times out, and the next connection is accepted.
    let mut partial = UnixStream::connect(&path).unwrap();
    partial.write_all(&[1, 0]).unwrap();
    assert_eq!(
        request(&path, &grow_to("container", 512), Duration::from_secs(5)).unwrap(),
        Ok(ControlReply::DiskSize(1))
    );
}

#[test]
fn serving_replaces_a_stale_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    drop(UnixListener::bind(&path).unwrap());
    serve(&path, |_, _| Ok(ControlReply::DiskSize(7))).unwrap();
    assert_eq!(
        request(&path, &grow_to("container", 7), Duration::from_secs(5)).unwrap(),
        Ok(ControlReply::DiskSize(7))
    );
}

#[test]
fn resize_requires_a_block_id_and_rejects_index_only_requests() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |_, _| {
        panic!("invalid requests must not reach the handler")
    })
    .unwrap();
    for body in [
        br#"{"version":1,"op":"resize_disk","bytes":4096}"#.as_slice(),
        br#"{"version":1,"op":"resize_disk","index":0,"bytes":4096}"#.as_slice(),
    ] {
        let mut stream = UnixStream::connect(&path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write_frame(&mut stream, body).unwrap();
        let response: ControlResponse =
            serde_json::from_slice(&read_frame(&mut stream).unwrap()).unwrap();
        assert!(matches!(response, Err(ControlError::InvalidInput(_))));
    }
}

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
mod mounts {
    use super::*;
    use crate::vmm::controller::mount_control::{MountControlClient, MountState, Registry};
    use boxlite_vmm::AggregateFs;
    use std::os::fd::AsRawFd;
    use std::path::PathBuf;
    use std::sync::Arc;

    const TIMEOUT: Duration = Duration::from_secs(5);

    fn fixture() -> (tempfile::TempDir, Arc<AggregateFs>, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vmm.sock");
        let tag = dir.path().to_str().unwrap().to_owned();
        let fs = Arc::new(AggregateFs::new(vec![]).unwrap());
        boxlite_vmm::insert_aggregate(&tag, fs.clone());
        let mut registry = Registry::default();
        serve(&path, move |op, directory| {
            registry
                .request(&tag, op, directory)
                .map_err(|error| ControlError::Mount(error.raw_os_error().unwrap()))
        })
        .unwrap();
        (dir, fs, path)
    }

    fn registration(target: &str) -> ControlOp {
        ControlOp::RegisterMount {
            source: "/source".into(),
            target: target.into(),
            read_only: false,
        }
    }

    #[test]
    fn fragmented_directory_delivery_survives_an_unread_reply() {
        let (dir, _fs, path) = fixture();
        let directory = File::open(dir.path()).unwrap();
        let mut stream = UnixStream::connect(&path).unwrap();
        stream.set_read_timeout(Some(TIMEOUT)).unwrap();
        let frame = serde_json::to_vec(&ControlRequest {
            version: VERSION,
            op: registration("/data"),
        })
        .unwrap();
        let header = (frame.len() as u32).to_le_bytes();
        stream.write_all(&header[..2]).unwrap();
        transport::send_parts(
            &stream,
            &header[2..],
            &frame[..1],
            Some(directory.as_raw_fd()),
            Instant::now() + TIMEOUT,
        )
        .unwrap();
        stream.write_all(&frame[1..]).unwrap();
        stream.read_exact(&mut [0]).unwrap();
        drop(stream);

        let client = MountControlClient::new(path);
        let records = client.list().unwrap();
        let [mount] = records.as_slice() else {
            panic!("expected one recoverable registration, got {records:?}");
        };
        assert_eq!(mount.target, "/data");
        assert_eq!(mount.state, MountState::Preparing);
        client
            .set_state(&mount.export, MountState::Mounted)
            .unwrap();
        assert_eq!(client.list().unwrap()[0].state, MountState::Mounted);
        client
            .set_state(&mount.export, MountState::Detaching)
            .unwrap();
        client.remove(&mount.export).unwrap();
        assert!(client.list().unwrap().is_empty());
    }

    #[test]
    fn invalid_descriptors_do_not_publish_a_mount() {
        let (dir, _fs, path) = fixture();
        let directory = File::open(dir.path()).unwrap();
        assert_eq!(
            exchange(&path, registration("/data"), None, TIMEOUT).unwrap(),
            Err(ControlError::Mount(libc::EINVAL))
        );
        assert_eq!(
            exchange(&path, ControlOp::ListMounts, Some(&directory), TIMEOUT).unwrap(),
            Err(ControlError::Mount(libc::EINVAL))
        );
        let file = tempfile::tempfile().unwrap();
        assert_eq!(
            exchange(&path, registration("/data"), Some(&file), TIMEOUT).unwrap(),
            Err(ControlError::Mount(libc::ENOTDIR))
        );
        let frame = serde_json::to_vec(&ControlRequest {
            version: VERSION,
            op: registration("/data"),
        })
        .unwrap();
        let stream = UnixStream::connect(&path).unwrap();
        let end = Instant::now() + TIMEOUT;
        let descriptor = Some(directory.as_raw_fd());
        transport::send_parts(
            &stream,
            &(frame.len() as u32).to_le_bytes(),
            &[],
            descriptor,
            end,
        )
        .unwrap();
        transport::send_parts(&stream, &frame, &[], descriptor, end).unwrap();
        // Closing the malformed exchange must still leave the listener usable.
        assert_eq!(
            transport::receive_frame(&stream, end).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let client = MountControlClient::new(path);
        assert!(client.list().unwrap().is_empty());
        client
            .register("/source".into(), "/data".into(), directory, false)
            .unwrap();
    }

    #[test]
    fn mount_list_fits_after_registration_reaches_capacity() {
        let (dir, _fs, path) = fixture();
        let client = MountControlClient::new(path);
        let mut admitted = 0;
        loop {
            let result = client.register(
                "\\".repeat(2000),
                format!("/{admitted}{}", "\"".repeat(2000)),
                File::open(dir.path()).unwrap(),
                true,
            );
            match result {
                Ok(mount) => {
                    client
                        .set_state(&mount.export, MountState::Mounted)
                        .unwrap();
                    admitted += 1;
                }
                Err(error) => {
                    assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
                    break;
                }
            }
        }
        let mounts = client.list().unwrap();
        assert!(admitted > 0);
        assert_eq!(mounts.len(), admitted);
        for mount in mounts {
            client
                .set_state(&mount.export, MountState::Detaching)
                .unwrap();
        }
        assert_eq!(client.list().unwrap().len(), admitted);
    }

    #[test]
    fn client_deadline_includes_a_full_listener_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vmm.sock");
        let listener = UnixListener::bind(&path).unwrap();
        // SAFETY: the fd belongs to a live Unix listener.
        assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
        let queued = UnixStream::connect(&path).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(100);
            tx.send(transport::connect(&path, deadline)).unwrap();
        });
        let result = rx.recv_timeout(TIMEOUT);
        drop(queued);
        drop(listener);
        assert_eq!(result.unwrap().unwrap_err().kind(), io::ErrorKind::TimedOut);
    }
}
