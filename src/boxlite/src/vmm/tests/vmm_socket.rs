use super::*;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;

const GROW: &[u8] = br#"{"block_id":"container","bytes":4096}"#;
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

fn runtime() -> Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .unwrap()
}

fn echo_resize(op: ControlOp, directory: Option<File>) -> ControlResponse {
    assert!(directory.is_none());
    match op {
        ControlOp::ResizeDisk { bytes, .. } => Ok(ControlReply::DiskSize(bytes)),
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        _ => panic!("expected a resize request"),
    }
}

fn http_request(method: &str, path: &str, body: &[u8]) -> Vec<u8> {
    let headers = format!(
        "{method} {path} HTTP/1.1\r\nHost: vmm\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len(),
    );
    [headers.as_bytes(), body].concat()
}

fn write_http(mut stream: &UnixStream, method: &str, path: &str, body: &[u8]) {
    stream.write_all(&http_request(method, path, body)).unwrap();
}

fn owner_uid() -> libc::uid_t {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

fn set_response_timeout(stream: &UnixStream) {
    // Darwin can reject timeout changes after the peer disconnects.
    stream.set_read_timeout(Some(TEST_TIMEOUT)).unwrap();
}

fn read_http(mut stream: &UnixStream) -> String {
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
    set_response_timeout(&client);
    write_http(&client, method, route, body);
    read_http(&client)
}

#[test]
fn http_resize_reaches_the_handler() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |op, _| match op {
        ControlOp::ResizeDisk { block_id, bytes } => {
            assert_eq!(block_id, "container");
            assert_eq!(bytes, 4096);
            Ok(ControlReply::DiskSize(bytes))
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        _ => panic!("expected a resize request"),
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
    serve(&path, |op, _| match op {
        ControlOp::ResizeDisk { block_id, bytes } if block_id == "container" => {
            Ok(ControlReply::DiskSize(bytes))
        }
        ControlOp::ResizeDisk { block_id, .. } => {
            Err(ControlError::InvalidInput(format!("no disk {block_id}")))
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        _ => panic!("expected a resize request"),
    })
    .unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "the socket is owner-only");

    assert_eq!(
        timeout(TEST_TIMEOUT, request(&path, "container", 4096))
            .await
            .unwrap()
            .unwrap(),
        Ok(ControlReply::DiskSize(4096))
    );
    assert_eq!(
        timeout(TEST_TIMEOUT, request(&path, "missing", 4096))
            .await
            .unwrap()
            .unwrap(),
        Err(ControlError::InvalidInput("no disk missing".into()))
    );
}

#[tokio::test]
async fn client_returns_reply_when_socket_shutdown_would_fail() {
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    struct ShutdownFails(tokio::net::UnixStream);

    impl AsyncRead for ShutdownFails {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.0).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for ShutdownFails {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.0).poll_write(cx, bytes)
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.0).poll_flush(cx)
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            // Darwin can report ENOTCONN when the peer already closed.
            Poll::Ready(Err(io::ErrorKind::NotConnected.into()))
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, echo_resize).unwrap();
    let stream = tokio::net::UnixStream::connect(&path).await.unwrap();

    let reply = timeout(
        TEST_TIMEOUT,
        exchange_http(
            TokioIo::new(ShutdownFails(stream)),
            RESIZE_PATH,
            GROW.to_vec(),
            MAX_BODY,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reply, Ok(ControlReply::DiskSize(4096)));
}

#[test]
fn accept_recovers_from_temporary_errors_with_bounded_backoff() {
    let (client, stream) = UnixStream::pair().unwrap();
    set_response_timeout(&client);
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
    serve_connections(&runtime(), incoming, owner_uid(), echo_resize, |delay| {
        waits.push(delay)
    });

    let reply = read_http(&client);
    assert!(reply.starts_with("HTTP/1.1 200 "), "{reply}");
    assert_eq!(waits, [5, 10, 20, 40, 50, 50, 5].map(Duration::from_millis));
}

#[test]
fn only_the_versioned_post_route_can_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    serve(&path, |_, _| panic!("invalid requests must not dispatch")).unwrap();

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
    serve(&path, |op, directory| {
        assert!(matches!(&op, ControlOp::ResizeDisk { block_id, .. } if block_id == "container"));
        echo_resize(op, directory)
    })
    .unwrap();

    let mut headers = UnixStream::connect(&path).unwrap();
    set_response_timeout(&headers);
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
    set_response_timeout(&blocked);
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
    set_response_timeout(&client);
    write_http(&client, "POST", RESIZE_PATH, GROW);

    let mut submitted = Vec::new();
    serve_connections(
        &runtime(),
        listener.incoming().take(3),
        owner_uid(),
        |op, directory| {
            let reply = echo_resize(op, directory);
            match &reply {
                Ok(ControlReply::DiskSize(bytes)) => submitted.push(*bytes),
                _ => panic!("expected a resize reply"),
            }
            reply
        },
        std::thread::sleep,
    );
    assert_eq!(submitted, [4096, 4096]);
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
    let mut dispatched = false;
    let error = answer(&runtime, stream, owner_uid(), &mut |op, directory| {
        dispatched = true;
        echo_resize(op, directory)
    })
    .unwrap_err();
    assert!(dispatched, "only the reply should stall");
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
    serve(&path, |_, _| {
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
    let body = br#"{"version":1,"op":"resize_disk","block_id":"container","bytes":4096}"#;
    let (mut client, stream) = UnixStream::pair().unwrap();
    set_response_timeout(&client);
    client
        .write_all(&[&(body.len() as u32).to_le_bytes(), body.as_slice()].concat())
        .unwrap();
    client.shutdown(std::net::Shutdown::Write).unwrap();

    let _ = answer(&runtime(), stream, owner_uid(), &mut |_, _| {
        panic!("framed requests must not dispatch")
    });
    let reply = read_http(&client);
    assert!(
        reply.is_empty() || reply.starts_with("HTTP/1.1 400 "),
        "{reply}"
    );
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
    let (reply, ()) = timeout(TEST_TIMEOUT, async {
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
    fn mount_route_rejects_unknown_and_resize_operations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vmm.sock");
        serve(&path, |_, _| {
            panic!("invalid mount requests must not dispatch")
        })
        .unwrap();
        for body in [
            br#"{"op":"reboot"}"#.as_slice(),
            br#"{"op":"resize_disk","block_id":"vda","bytes":4096}"#.as_slice(),
        ] {
            let reply = raw_http(&path, "POST", MOUNT_PATH, body);
            assert!(reply.starts_with("HTTP/1.1 400 "), "{reply}");
        }
    }

    #[test]
    fn fragmented_directory_delivery_survives_an_unread_reply() {
        let (dir, _fs, path) = fixture();
        let directory = File::open(dir.path()).unwrap();
        let mut stream = UnixStream::connect(&path).unwrap();
        stream.set_read_timeout(Some(TIMEOUT)).unwrap();
        let body = serde_json::to_vec(&registration("/data")).unwrap();
        let request = http_request("POST", MOUNT_PATH, &body);
        assert_eq!(
            transport::send_with_file(stream.as_raw_fd(), &request[..1], directory.as_raw_fd())
                .unwrap(),
            1
        );
        stream.write_all(&request[1..]).unwrap();
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
        let body = serde_json::to_vec(&registration("/data")).unwrap();
        let request = http_request("POST", MOUNT_PATH, &body);
        let mut stream = UnixStream::connect(&path).unwrap();
        stream.set_read_timeout(Some(TIMEOUT)).unwrap();
        // Put the second descriptor on the final byte of the body.
        let last = request.len() - 1;
        let send_descriptor = |stream: &UnixStream, bytes: &[u8]| {
            assert_eq!(
                transport::send_with_file(stream.as_raw_fd(), bytes, directory.as_raw_fd())
                    .unwrap(),
                1
            );
        };
        send_descriptor(&stream, &request[..1]);
        stream.write_all(&request[1..last]).unwrap();
        send_descriptor(&stream, &request[last..]);
        let mut reply = [0; 1];
        match stream.read(&mut reply) {
            Ok(0) => {}
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
            result => panic!("malformed descriptor exchange stayed open: {result:?}"),
        }
        let client = MountControlClient::new(path);
        assert!(client.list().unwrap().is_empty());
        client
            .register("/source".into(), "/data".into(), directory, false)
            .unwrap();
    }

    #[test]
    fn a_trailing_descriptor_does_not_publish_a_mount() {
        let dir = tempfile::tempdir().unwrap();
        let tag = dir.path().to_str().unwrap();
        let filesystem = Arc::new(AggregateFs::new(vec![]).unwrap());
        boxlite_vmm::insert_aggregate(tag, filesystem);
        let directory = File::open(dir.path()).unwrap();
        let body = serde_json::to_vec(&registration("/data")).unwrap();
        let (mut client, stream) = UnixStream::pair().unwrap();

        // Queue the complete HTTP request before the byte carrying the descriptor.
        client
            .write_all(&http_request("POST", MOUNT_PATH, &body))
            .unwrap();
        assert_eq!(
            transport::send_with_file(client.as_raw_fd(), b"x", directory.as_raw_fd()).unwrap(),
            1
        );
        client.shutdown(std::net::Shutdown::Write).unwrap();

        let mut registry = Registry::default();
        let mut dispatches = 0;
        let _ = answer(&runtime(), stream, owner_uid(), &mut |op, directory| {
            dispatches += 1;
            registry
                .request(tag, op, directory)
                .map_err(|error| ControlError::Mount(error.raw_os_error().unwrap()))
        });
        assert_eq!(
            registry.request(tag, ControlOp::ListMounts, None).unwrap(),
            ControlReply::Mounts(vec![]),
            "a descriptor beyond the request body must not publish a mount"
        );
        assert_eq!(dispatches, 0);
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
            tx.send(exchange(
                &path,
                ControlOp::ListMounts,
                None,
                Duration::from_millis(100),
            ))
            .unwrap();
        });
        let result = rx.recv_timeout(TIMEOUT);
        drop(queued);
        drop(listener);
        assert_eq!(result.unwrap().unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn another_uid_is_refused_mount_control() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vmm.sock");
        let tag = dir.path().to_str().unwrap().to_owned();
        let fs = Arc::new(AggregateFs::new(vec![]).unwrap());
        boxlite_vmm::insert_aggregate(&tag, fs.clone());
        let mut registry = Registry::default();
        let listener = UnixListener::bind(&path).unwrap();
        let owner = owner_uid() + 1;
        let handled = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&handled);
        std::thread::spawn(move || {
            serve_connections(
                &runtime(),
                listener.incoming().take(2),
                owner,
                move |op, directory| {
                    seen.fetch_add(1, Ordering::SeqCst);
                    registry
                        .request(&tag, op, directory)
                        .map_err(|error| ControlError::Mount(error.raw_os_error().unwrap()))
                },
                std::thread::sleep,
            )
        });
        for (op, directory) in [
            (ControlOp::ListMounts, None),
            (registration("/data"), Some(File::open(dir.path()).unwrap())),
        ] {
            assert_eq!(
                exchange(&path, op, directory.as_ref(), TIMEOUT).unwrap(),
                Err(ControlError::Mount(libc::EPERM))
            );
        }
        assert_eq!(
            handled.load(Ordering::SeqCst),
            0,
            "a refused request must not reach the registry"
        );
    }

    #[test]
    fn client_deadline_includes_a_silent_peer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vmm.sock");
        let _silent_peer = UnixListener::bind(&path).unwrap();
        let result = exchange(
            &path,
            ControlOp::ListMounts,
            None,
            Duration::from_millis(100),
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[tokio::test]
async fn resize_client_validates_replies_and_reports_unsupported_shims() {
    use boxlite_shared::BoxliteError;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.sock");
    assert!(matches!(
        grow_disk(&path, "vda", 4096).await,
        Err(BoxliteError::Unsupported(_))
    ));
    serve(&path, |op, _| match op {
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

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
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
        Err(BoxliteError::Engine(message)) if message.contains("completion is unknown")
            && message.contains("retry the target")
            && message.contains("matching versions")
    ));
}
