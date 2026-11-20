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
    serve(&path, |op| match op {
        ControlOp::ResizeDisk { block_id, bytes } if block_id == "container" => {
            Ok(ControlReply::DiskSize(bytes))
        }
        ControlOp::ResizeDisk { block_id, .. } => {
            Err(ControlError::InvalidInput(format!("no disk {block_id}")))
        }
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
        |ControlOp::ResizeDisk { bytes, .. }| Ok(ControlReply::DiskSize(bytes)),
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
    serve(&path, |_| Ok(ControlReply::DiskSize(1))).unwrap();
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
    serve(&path, |_| Ok(ControlReply::DiskSize(1))).unwrap();

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

    // A client that never sends is dropped after the timeout; serving goes on.
    let _silent = UnixStream::connect(&path).unwrap();
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
    serve(&path, |_| Ok(ControlReply::DiskSize(7))).unwrap();
    assert_eq!(
        request(&path, &grow_to("container", 7), Duration::from_secs(5)).unwrap(),
        Ok(ControlReply::DiskSize(7))
    );
}

#[test]
fn resize_requires_a_block_id_and_rejects_index_only_requests() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |_| {
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
#[tokio::test]
async fn resize_client_validates_replies_and_reports_unsupported_shims() {
    use boxlite_shared::BoxliteError;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    assert!(matches!(
        grow_disk(&path, "vda", 4096).await,
        Err(BoxliteError::Unsupported(_))
    ));
    serve(&path, |op| match op {
        ControlOp::ResizeDisk {
            block_id,
            bytes: 4096 | 8192,
        } if block_id == "vda" => Ok(ControlReply::DiskSize(4096)),
        _ => Err(ControlError::Unsupported("old engine".into())),
    })
    .unwrap();
    grow_disk(&path, "vda", 4096).await.unwrap();
    assert!(matches!(
        grow_disk(&path, "vda", 8192).await,
        Err(BoxliteError::Engine(_))
    ));
    assert!(matches!(
        grow_disk(&path, "vda", 16384).await,
        Err(BoxliteError::Unsupported(_))
    ));
}
