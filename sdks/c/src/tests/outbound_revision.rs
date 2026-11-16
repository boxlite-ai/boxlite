use super::*;
use crate::network::tests::network_at;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

struct Peer {
    url: String,
    requests: mpsc::Receiver<(String, String)>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Peer {
    fn new(status: u16, headers: &str, body: &str) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (send, requests) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let reply = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !stopping.load(Ordering::SeqCst) && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("accept: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let (mut head, mut line) = (String::new(), String::new());
                loop {
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                    line.clear();
                    assert!(head.len() < 16 << 10);
                }
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                assert!(length < 64 << 10);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                if head.starts_with("GET /v1/boxes/box1 ") {
                    let info = r#"{"box_id":"box1","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}"#;
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{info}",
                        info.len()
                    )
                    .unwrap();
                } else {
                    send.send((head, String::from_utf8(body).unwrap())).unwrap();
                    stream.write_all(reply.as_bytes()).unwrap();
                }
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn request(&self) -> (String, String) {
        self.requests.recv_timeout(Duration::from_secs(2)).unwrap()
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.worker.take().unwrap().join();
    }
}

#[test]
fn outbound_ffi_reads_owned_snapshot_and_status_json() {
    type Read = unsafe extern "C" fn(
        *mut CBoxNetworkHandle,
        *mut *mut c_char,
        *mut CBoxliteError,
    ) -> BoxliteErrorCode;
    for (read, suffix, body, expected) in [
        (
            boxlite_network_outbound_snapshot as Read,
            "",
            r#"{"mode":"enabled"}"#,
            "rev-a",
        ),
        (
            boxlite_network_outbound_status as Read,
            "/status",
            r#"{"persisted":{"policy":{"mode":"enabled"},"revision":"rev-a"},"observed":{"policy":{"mode":"enabled"},"revision":"rev-a","application_state":"confirmed"},"application_state":"confirmed"}"#,
            "rev-a",
        ),
    ] {
        let peer = Peer::new(200, "ETag: \"rev-a\"\r\n", body);
        let (_runtime, mut network) = network_at(&peer.url);
        let mut json = ptr::null_mut();
        let mut error = CBoxliteError::default();
        assert_eq!(
            unsafe { read(&mut network, &mut json, &mut error) },
            BoxliteErrorCode::Ok
        );
        assert!(!json.is_null());
        let value: serde_json::Value =
            serde_json::from_slice(unsafe { CStr::from_ptr(json) }.to_bytes()).unwrap();
        unsafe {
            crate::util::boxlite_free_string(json);
        }
        let revision = if suffix.is_empty() {
            &value["revision"]
        } else {
            &value["persisted"]["revision"]
        };
        assert_eq!(revision, expected);
        assert!(
            peer.request()
                .0
                .starts_with(&format!("GET /v1/boxes/box1/network/outbound{suffix} "))
        );
    }
}

#[test]
fn outbound_ffi_distinguishes_applied_precondition_failure_and_uncertain_ack() {
    for (status, headers, expected_code, expected_applied) in [
        (200, "ETag: \"rev-b\"\r\n", BoxliteErrorCode::Ok, 1),
        (412, "", BoxliteErrorCode::Ok, 0),
        (200, "", BoxliteErrorCode::Network, 0),
        (404, "", BoxliteErrorCode::Unsupported, 0),
    ] {
        let peer = Peer::new(status, headers, r#"{"mode":"enabled"}"#);
        let (_runtime, mut network) = network_at(&peer.url);
        let (mut applied, mut error) = (99, CBoxliteError::default());
        let code = unsafe {
            boxlite_network_replace_outbound_snapshot(
                &mut network,
                c"rev-a".as_ptr(),
                c"rev-b".as_ptr(),
                c"{\"mode\":\"enabled\"}".as_ptr(),
                &mut applied,
                &mut error,
            )
        };
        assert_eq!(code, expected_code);
        assert_eq!(applied, expected_applied);
        unsafe {
            crate::error::boxlite_error_free(&mut error);
        }
        let (head, body) = peer.request();
        let head = head.to_ascii_lowercase();
        assert!(head.starts_with("put /v1/boxes/box1/network/outbound/snapshot "));
        assert!(head.contains("\r\nif-match: \"rev-a\"\r\n"));
        assert!(head.contains("\r\nx-boxlite-outbound-revision: rev-b\r\n"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"mode":"enabled","allow_net":[]})
        );
    }
}

#[test]
fn outbound_ffi_rejects_invalid_inputs_before_dispatch_and_initializes_outputs() {
    let peer = Peer::new(500, "", "unexpected request");
    let (_runtime, mut network) = network_at(&peer.url);
    let invalid_utf8 = c"\xff";
    for (expected, candidate, body) in [
        (ptr::null(), c"rev-b".as_ptr(), c"{}".as_ptr()),
        (invalid_utf8.as_ptr(), c"rev-b".as_ptr(), c"{}".as_ptr()),
        (c"rev/a".as_ptr(), c"rev-b".as_ptr(), c"{}".as_ptr()),
        (c"rev-a".as_ptr(), c"rev-a".as_ptr(), c"{}".as_ptr()),
        (c"rev-a".as_ptr(), c"initial".as_ptr(), c"{}".as_ptr()),
        (c"rev-a".as_ptr(), ptr::null(), c"{}".as_ptr()),
        (c"rev-a".as_ptr(), c"rev-b".as_ptr(), ptr::null()),
        (
            c"rev-a".as_ptr(),
            c"rev-b".as_ptr(),
            c"{\"mode\":\"disabled\",\"allow_net\":[\"example.com\"]}".as_ptr(),
        ),
    ] {
        let (mut applied, mut error) = (99, CBoxliteError::default());
        let code = unsafe {
            boxlite_network_replace_outbound_snapshot(
                &mut network,
                expected,
                candidate,
                body,
                &mut applied,
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert_eq!(applied, 0);
        unsafe {
            crate::error::boxlite_error_free(&mut error);
        }
    }
    assert!(matches!(
        peer.requests.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    let mut json = std::ptr::dangling_mut();
    let mut error = CBoxliteError::default();
    assert_eq!(
        unsafe { boxlite_network_outbound_status(ptr::null_mut(), &mut json, &mut error) },
        BoxliteErrorCode::InvalidArgument
    );
    assert!(json.is_null());
    unsafe {
        crate::error::boxlite_error_free(&mut error);
    }
}
