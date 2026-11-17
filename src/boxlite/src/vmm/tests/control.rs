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
    let path = dir.path().join("control.sock");
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
fn another_version_is_unsupported_and_the_shim_keeps_serving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
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
        request(&path, &grow_to("container", 512), Duration::from_secs(5)).unwrap(),
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
        request(&path, &grow_to("container", 7), Duration::from_secs(5)).unwrap(),
        Ok(ControlReply::DiskSize(7))
    );
}

#[test]
fn resize_requires_a_block_id_and_rejects_index_only_requests() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
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

#[test]
fn resize_budget_is_checked_without_changing_process_limits() {
    use std::process::Command;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn limits() -> (libc::rlim_t, libc::rlim_t) {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: limit is a valid output pointer.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, &mut limit) },
            0
        );
        (limit.rlim_cur, limit.rlim_max)
    }

    const CHILD_ENV: &str = "BOXLITE_TEST_RESIZE_BUDGET_CHILD";
    if std::env::var_os(CHILD_ENV).is_none() {
        let before = limits();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "vmm::control::tests::resize_budget_is_checked_without_changing_process_limits",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .expect("start the isolated control-budget test");
        assert!(
            output.status.success(),
            "child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert_eq!(limits(), before);
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("control.sock");
    let calls = Arc::new(AtomicUsize::new(0));
    let handled = calls.clone();
    serve(&path, move |op| {
        handled.fetch_add(1, Ordering::SeqCst);
        let ControlOp::ResizeDisk { bytes, .. } = op;
        Ok(ControlReply::DiskSize(bytes))
    })
    .unwrap();
    let timeout = Duration::from_secs(5);
    let before = limits();
    assert!(matches!(
        request(&path, &grow_to("container", u64::MAX), timeout).unwrap(),
        Err(ControlError::InvalidInput(message)) if message.contains("overflow")
    ));
    assert_eq!(limits(), before);
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let inherited = libc::rlimit {
        rlim_cur: 8192,
        rlim_max: 8192,
    };
    // SAFETY: the limit affects only this isolated child and its control thread.
    assert_eq!(
        unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &inherited) },
        0
    );
    let before = limits();
    assert_eq!(before, (8192, 8192));
    for bytes in [512, 4096] {
        assert_eq!(
            request(&path, &grow_to("container", bytes), timeout).unwrap(),
            Ok(ControlReply::DiskSize(bytes))
        );
        assert_eq!(limits(), before);
    }
    for bytes in [4097, 4608, u64::MAX] {
        assert!(matches!(
            request(&path, &grow_to("container", bytes), timeout).unwrap(),
            Err(ControlError::InvalidInput(_))
        ));
        assert_eq!(limits(), before);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let lower_soft = libc::rlimit {
        rlim_cur: 4096,
        rlim_max: 8192,
    };
    // SAFETY: this isolated process owns the limits, including its control thread.
    assert_eq!(
        unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &lower_soft) },
        0
    );
    assert!(matches!(
        request(&path, &grow_to("container", 4096), timeout).unwrap(),
        Err(ControlError::InvalidInput(_))
    ));
    assert_eq!(limits(), (4096, 8192));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
