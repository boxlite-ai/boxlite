use super::*;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;

const GROW: &[u8] = br#"{"block_id":"container","bytes":4096}"#;

fn runtime() -> Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .unwrap()
}

fn echo_resize(ControlOp::ResizeDisk { bytes, .. }: ControlOp) -> ControlResponse {
    Ok(ControlReply::DiskSize(bytes))
}

fn write_http(mut stream: &UnixStream, method: &str, path: &str, body: &[u8]) {
    let headers = format!(
        "{method} {path} HTTP/1.1\r\nHost: vmm\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len(),
    );
    stream
        .write_all(&[headers.as_bytes(), body].concat())
        .unwrap();
}

fn read_http(mut stream: &UnixStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut response = String::new();
    if let Err(error) = stream.read_to_string(&mut response) {
        // Rejecting a request can close the socket with unread input.
        assert!(
            error.kind() == io::ErrorKind::ConnectionReset && !response.is_empty(),
            "{error}"
        );
    }
    response
}

fn raw_http(path: &Path, method: &str, route: &str, body: &[u8]) -> String {
    let client = UnixStream::connect(path).unwrap();
    write_http(&client, method, route, body);
    read_http(&client)
}

#[test]
fn http_resize_reaches_the_handler() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |op| match op {
        ControlOp::ResizeDisk { block_id, bytes } => {
            assert_eq!(block_id, "container");
            assert_eq!(bytes, 4096);
            Ok(ControlReply::DiskSize(bytes))
        }
    })
    .unwrap();
    let reply = raw_http(&path, "POST", RESIZE_PATH, GROW);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");
    assert!(reply.ends_with(r#"{"Ok":{"disk_size":4096}}"#), "{reply}");
}

#[tokio::test]
async fn a_request_reaches_the_handler_and_its_answer_returns() {
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

    assert_eq!(
        timeout(CLIENT_TIMEOUT, request(&path, "container", 4096))
            .await
            .unwrap()
            .unwrap(),
        Ok(ControlReply::DiskSize(4096))
    );
    assert_eq!(
        timeout(CLIENT_TIMEOUT, request(&path, "missing", 4096))
            .await
            .unwrap()
            .unwrap(),
        Err(ControlError::InvalidInput("no disk missing".into()))
    );
}

#[test]
fn accept_recovers_from_temporary_errors_with_bounded_backoff() {
    let (client, stream) = UnixStream::pair().unwrap();
    write_http(&client, "POST", RESIZE_PATH, GROW);

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
    serve_connections(&runtime(), incoming, echo_resize, |delay| waits.push(delay));

    let reply = read_http(&client);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");
    assert_eq!(waits, [5, 10, 20, 40, 50, 50, 5].map(Duration::from_millis));
}

#[test]
fn only_the_versioned_post_route_can_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |_| panic!("invalid requests must not dispatch")).unwrap();

    let reply = raw_http(&path, "POST", "/v2/resize-disk", GROW);
    assert!(reply.starts_with("HTTP/1.1 404 "), "{reply}");
    let reply = raw_http(&path, "GET", RESIZE_PATH, &[]);
    assert!(reply.starts_with("HTTP/1.1 405 "), "{reply}");
    assert!(reply.contains("\r\nallow: POST\r\n"), "{reply}");
}

#[test]
fn request_size_and_read_deadlines_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |op| {
        let ControlOp::ResizeDisk { block_id, .. } = &op;
        assert_eq!(block_id, "container");
        echo_resize(op)
    })
    .unwrap();

    let mut headers = UnixStream::connect(&path).unwrap();
    let mut request = format!("POST {RESIZE_PATH} HTTP/1.1\r\nHost: vmm\r\nX-Pad: ").into_bytes();
    request.resize(HTTP_BUFFER, b'x');
    headers.write_all(&request).unwrap();
    let reply = read_http(&headers);
    assert!(reply.starts_with("HTTP/1.1 431 "), "{reply}");

    let padded_json = [GROW, &vec![b' '; MAX_BODY + 1 - GROW.len()]].concat();
    let reply = raw_http(&path, "POST", RESIZE_PATH, &padded_json);
    assert!(reply.starts_with("HTTP/1.1 413 "), "{reply}");

    let reply = raw_http(&path, "POST", RESIZE_PATH, &padded_json[..MAX_BODY]);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");

    let mut blocked = UnixStream::connect(&path).unwrap();
    blocked
        .write_all(b"POST /v1/resize-disk HTTP/1.1\r\nHost: vmm\r\nContent-Length: 50\r\n\r\n{")
        .unwrap();
    let reply = read_http(&blocked);
    assert!(reply.starts_with("HTTP/1.1 408 "), "{reply}");

    let _silent = UnixStream::connect(&path).unwrap();
    let reply = raw_http(&path, "POST", RESIZE_PATH, GROW);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");
}

#[test]
fn only_complete_first_requests_dispatch_when_clients_disconnect_before_accept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    let listener = UnixListener::bind(&path).unwrap();

    let client = UnixStream::connect(&path).unwrap();
    write_http(&client, "POST", RESIZE_PATH, GROW);
    write_http(
        &client,
        "POST",
        RESIZE_PATH,
        br#"{"block_id":"container","bytes":8192}"#,
    );
    drop(client);

    let mut partial = UnixStream::connect(&path).unwrap();
    partial
        .write_all(b"POST /v1/resize-disk HTTP/1.1\r\nHost: vmm\r\nContent-Length: 50\r\n\r\n{")
        .unwrap();
    drop(partial);
    let client = UnixStream::connect(&path).unwrap();
    write_http(&client, "POST", RESIZE_PATH, GROW);

    let submitted = std::cell::RefCell::new(Vec::new());
    serve_connections(
        &runtime(),
        listener.incoming().take(3),
        |op| {
            let ControlOp::ResizeDisk { bytes, .. } = &op;
            submitted.borrow_mut().push(*bytes);
            echo_resize(op)
        },
        std::thread::sleep,
    );
    assert_eq!(submitted.into_inner(), [4096, 4096]);
    let reply = read_http(&client);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");
}

#[test]
fn a_stalled_reply_releases_the_connection_at_the_deadline() {
    let (client, mut stream) = UnixStream::pair().unwrap();
    stream.set_nonblocking(true).unwrap();
    loop {
        match stream.write(&[0; 4096]) {
            Ok(size) => assert!(size > 0),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("fill socket buffer: {error}"),
        }
    }
    write_http(&client, "POST", RESIZE_PATH, GROW);

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap();
    let dispatched = std::cell::Cell::new(false);
    let error = answer(&runtime, stream, &|op| {
        dispatched.set(true);
        echo_resize(op)
    })
    .unwrap_err();
    assert!(dispatched.get(), "only the reply should stall");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
}

#[test]
fn serving_replaces_a_stale_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    drop(UnixListener::bind(&path).unwrap());
    serve(&path, echo_resize).unwrap();
    let reply = raw_http(&path, "POST", RESIZE_PATH, GROW);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");
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
        br#"{"bytes":4096}"#.as_slice(),
        br#"{"index":0,"bytes":4096}"#.as_slice(),
    ] {
        let reply = raw_http(&path, "POST", RESIZE_PATH, body);
        assert!(reply.starts_with("HTTP/1.1 400 "), "{reply}");
    }
}

#[test]
fn a_framed_client_cannot_dispatch_to_an_http_shim() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |_| panic!("framed requests must not dispatch")).unwrap();

    let body = br#"{"version":1,"op":"resize_disk","block_id":"container","bytes":4096}"#;
    let mut client = UnixStream::connect(&path).unwrap();
    client
        .write_all(&[&(body.len() as u32).to_le_bytes(), body.as_slice()].concat())
        .unwrap();
    let reply = read_http(&client);
    assert!(reply.starts_with("HTTP/1.1 400 "), "{reply}");
}

#[tokio::test]
async fn the_client_rejects_an_oversized_reply() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let peer = async {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .header_read_timeout(None)
            .serve_connection(
                TokioIo::new(stream),
                hyper::service::service_fn(|request: Request<Incoming>| async {
                    let _ = request.into_body().collect().await.unwrap();
                    Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(vec![
                        b' ';
                        MAX_BODY + 1
                    ]))))
                }),
            )
            .await;
    };
    let (reply, ()) = timeout(CLIENT_TIMEOUT, async {
        tokio::join!(request(&path, "container", 4096), peer)
    })
    .await
    .unwrap();
    assert!(
        reply
            .unwrap_err()
            .into_inner()
            .unwrap()
            .is::<LengthLimitError>()
    );
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

#[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
#[tokio::test]
async fn an_http_client_reports_uncertainty_with_a_framed_shim() {
    use boxlite_shared::BoxliteError;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let old_peer = async {
        use tokio::io::AsyncReadExt;
        let (mut stream, _) = listener.accept().await.unwrap();
        let length = stream.read_u32_le().await.unwrap();
        assert_eq!(length, u32::from_le_bytes(*b"POST"));
        assert!(length > 4096);
    };
    let (reply, ()) = timeout(CLIENT_TIMEOUT, async {
        tokio::join!(grow_disk(&path, "vda", 4096), old_peer)
    })
    .await
    .unwrap();
    assert!(matches!(
        reply,
        Err(BoxliteError::Engine(message)) if message.contains("allocation may have changed")
            && message.contains("matching versions")
    ));
}

#[cfg(all(
    feature = "native",
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu"
))]
#[test]
fn http_runs_under_the_production_vmm_filter() {
    const CHILD: &str = "BOXLITE_TEST_HTTP_SECCOMP_CHILD";
    const DONE: &str = "HTTP resize served under VMM seccomp";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "vmm::vmm_socket::tests::http_runs_under_the_production_vmm_filter",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains(DONE),
            "{:?}\n{stdout}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        );
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    crate::jailer::seccomp::apply_vmm_filter("vmm-http-test").unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, echo_resize).unwrap();
    let reply = raw_http(&path, "POST", RESIZE_PATH, GROW);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");
    println!("{DONE}");
}
