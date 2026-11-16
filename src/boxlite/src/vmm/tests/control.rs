use super::*;
use std::os::unix::fs::PermissionsExt;

fn grow_to(index: usize, bytes: u64) -> ControlRequest {
    ControlRequest {
        version: VERSION,
        op: ControlOp::ResizeDisk { index, bytes },
    }
}

#[test]
fn a_request_reaches_the_handler_and_its_answer_returns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
    serve(&path, |op| match op {
        ControlOp::ResizeDisk { index: 0, bytes } => Ok(ControlReply::DiskSize(bytes)),
        ControlOp::ResizeDisk { index, .. } => {
            Err(ControlError::InvalidInput(format!("no disk {index}")))
        }
    })
    .unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "the socket is owner-only");

    let timeout = Duration::from_secs(5);
    assert_eq!(
        request(&path, &grow_to(0, 4096), timeout).unwrap(),
        Ok(ControlReply::DiskSize(4096))
    );
    assert_eq!(
        request(&path, &grow_to(3, 4096), timeout).unwrap(),
        Err(ControlError::InvalidInput("no disk 3".into()))
    );
}

#[test]
fn another_version_is_unsupported_and_the_shim_keeps_serving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
    serve(&path, |_| Ok(ControlReply::DiskSize(1))).unwrap();
    let timeout = Duration::from_secs(5);
    let mut future = grow_to(0, 512);
    future.version = VERSION + 1;
    assert!(matches!(
        request(&path, &future, timeout).unwrap(),
        Err(ControlError::Unsupported(_))
    ));
    assert_eq!(
        request(&path, &grow_to(0, 512), timeout).unwrap(),
        Ok(ControlReply::DiskSize(1))
    );
}

#[test]
fn an_oversized_or_unknown_request_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
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
        request(&path, &grow_to(0, 512), Duration::from_secs(5)).unwrap(),
        Ok(ControlReply::DiskSize(1))
    );
}

#[test]
fn serving_replaces_a_stale_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
    drop(UnixListener::bind(&path).unwrap());
    serve(&path, |_| Ok(ControlReply::DiskSize(7))).unwrap();
    assert_eq!(
        request(&path, &grow_to(0, 7), Duration::from_secs(5)).unwrap(),
        Ok(ControlReply::DiskSize(7))
    );
}
