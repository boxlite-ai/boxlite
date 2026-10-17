//! `boxlite_box_attach_main` and `boxlite_box_exec` driven through the public
//! FFI the way a C caller drives them, against a loopback box API.
//!
//! A REST runtime yields a real box handle with no VM behind it. The server
//! answers the box lookup, `POST /exec` and both attach upgrades, and every
//! session it accepts plays "hi" on stdout, "oops" on stderr, then exit code
//! 7. It serves one connection per request the test makes, then exits.

use crate::*;
use std::ffi::{CStr, CString};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::raw::{c_int, c_void};
use std::ptr;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::Role;
use tungstenite::{Message, WebSocket};

const BOX_JSON: &str = r#"{"box_id":"box1","name":null,"status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","pid":null,"image":"alpine:3.20","cpus":1,"memory_mib":256}"#;
const REFUSAL_JSON: &str =
    r#"{"error":{"message":"another client is attached","code":"already_exists"}}"#;
const NO_ROUTE_JSON: &str = r#"{"error":{"message":"no route","code":"not_found"}}"#;

/// How the server answers the main-session upgrade.
#[derive(Clone, Copy)]
enum MainSession {
    Open,
    Refused,
}

/// A loopback box API. Each request goes on `requests`, as "METHOD /path",
/// before it is answered.
struct BoxApi {
    url: CString,
    requests: Receiver<String>,
}

impl BoxApi {
    fn serve(connections: usize, main: MainSession) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let address = listener.local_addr().expect("loopback listener address");
        let (seen, requests) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                answer(stream.expect("accept connection"), main, &seen);
            }
        });
        Self {
            url: CString::new(format!("http://{address}")).expect("url cstring"),
            requests,
        }
    }

    fn received(&self) -> Vec<String> {
        self.requests.try_iter().collect()
    }
}

fn answer(mut stream: TcpStream, main: MainSession, seen: &Sender<String>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("set read timeout");
    let (request, websocket_key) = read_request(&stream);
    let _ = seen.send(request.clone());
    match (request.as_str(), main) {
        ("GET /v1/boxes/box1", _) => reply(&mut stream, "200 OK", BOX_JSON),
        ("POST /v1/boxes/box1/exec", _) => {
            reply(&mut stream, "200 OK", r#"{"execution_id":"exec-1"}"#)
        }
        ("GET /v1/boxes/box1/attach", MainSession::Refused) => {
            reply(&mut stream, "409 Conflict", REFUSAL_JSON)
        }
        ("GET /v1/boxes/box1/attach", MainSession::Open) => {
            play_session(stream, &websocket_key, "x-boxlite-execution-id: init-1\r\n")
        }
        ("GET /v1/boxes/box1/executions/exec-1/attach", _) => {
            play_session(stream, &websocket_key, "")
        }
        _ => reply(&mut stream, "404 Not Found", NO_ROUTE_JSON),
    }
}

/// Reads one request, body included so closing the socket cannot reset the
/// client before it reads the answer. Returns "METHOD /path" and the
/// request's `Sec-WebSocket-Key`, empty when it is not an upgrade.
fn read_request(stream: &TcpStream) -> (String, String) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).expect("read request line");
    let mut words = line.split_whitespace();
    let method = words.next().unwrap_or_default();
    let target = words.next().unwrap_or_default();
    let path = target.split('?').next().unwrap_or_default();

    let (mut websocket_key, mut body_len) = (String::new(), 0);
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).expect("read header");
        let Some((name, value)) = header.trim_end().split_once(':') else {
            break;
        };
        match name.to_ascii_lowercase().as_str() {
            "sec-websocket-key" => websocket_key = value.trim().to_owned(),
            "content-length" => body_len = value.trim().parse().expect("content length"),
            _ => {}
        }
    }
    let mut body = vec![0; body_len];
    reader.read_exact(&mut body).expect("read body");
    (format!("{method} {path}"), websocket_key)
}

fn reply(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .expect("write response");
}

/// Completes the upgrade, plays the session, then holds the connection until
/// the client hangs up, which it does on the exit frame.
fn play_session(mut stream: TcpStream, websocket_key: &str, extra_headers: &str) {
    let accept = derive_accept_key(websocket_key.as_bytes());
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n{extra_headers}\r\n"
    )
    .expect("write upgrade");
    let mut ws = WebSocket::from_raw_socket(stream, Role::Server, None);
    ws.send(Message::Binary(b"\x01hi".to_vec()))
        .expect("send stdout");
    ws.send(Message::Binary(b"\x02oops".to_vec()))
        .expect("send stderr");
    ws.send(Message::Text(r#"{"type":"exit","exit_code":7}"#.into()))
        .expect("send exit");
    while ws.read().is_ok() {}
}

/// A box as a C caller holds it, on a REST runtime. Dropping it frees both.
struct RestBox {
    runtime: *mut CBoxliteRuntime,
    handle: *mut CBoxHandle,
}

impl RestBox {
    fn open(api: &BoxApi) -> Self {
        let mut options: *mut CBoxliteRestOptions = ptr::null_mut();
        let mut runtime: *mut CBoxliteRuntime = ptr::null_mut();
        let mut error = FFIError::default();
        unsafe {
            let code = boxlite_rest_options_new(api.url.as_ptr(), &mut options, &mut error);
            assert_eq!(code, BoxliteErrorCode::Ok);
            let code = boxlite_rest_runtime_new_with_options(options, &mut runtime, &mut error);
            boxlite_rest_options_free(options);
            assert_eq!(code, BoxliteErrorCode::Ok);
        }

        let mut rest_box = Self {
            runtime,
            handle: ptr::null_mut(),
        };
        let mut lookup = Lookup::default();
        let slot: *mut Lookup = &mut lookup;
        let code = unsafe {
            boxlite_get(
                runtime,
                c"box1".as_ptr(),
                Some(record_box),
                slot.cast(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::Ok);
        rest_box.drain_until(|| unsafe { (*slot).code.is_some() });
        assert_eq!(
            lookup.code,
            Some(BoxliteErrorCode::Ok),
            "boxlite_get: {}",
            lookup.message
        );
        rest_box.handle = lookup.handle;
        rest_box
    }

    /// Dispatches callbacks until `done` holds, for at most 10 s.
    fn drain_until(&self, done: impl Fn() -> bool) {
        let mut error = FFIError::default();
        for _ in 0..20 {
            if done() {
                return;
            }
            let dispatched = unsafe { boxlite_runtime_drain(self.runtime, 500, &mut error) };
            assert!(dispatched >= 0, "drain failed");
        }
        assert!(done(), "the callback did not run within 10s");
    }

    /// Registers every callback on `execution`, drains until its exit has been
    /// reported, then frees it. The exit is dispatched after the last output
    /// chunk, so the session is complete when this returns.
    fn follow(&self, execution: *mut CExecutionHandle) -> Session {
        let mut session = Session::default();
        let slot: *mut Session = &mut session;
        let mut error = FFIError::default();
        unsafe {
            let code =
                boxlite_execution_on_stdout(execution, Some(on_stdout), slot.cast(), &mut error);
            assert_eq!(code, BoxliteErrorCode::Ok);
            let code =
                boxlite_execution_on_stderr(execution, Some(on_stderr), slot.cast(), &mut error);
            assert_eq!(code, BoxliteErrorCode::Ok);
            let code = boxlite_execution_on_exit(execution, Some(on_exit), slot.cast(), &mut error);
            assert_eq!(code, BoxliteErrorCode::Ok);
        }
        self.drain_until(|| unsafe { (*slot).exit_code.is_some() });
        unsafe { boxlite_execution_free(execution) };
        session
    }
}

impl Drop for RestBox {
    fn drop(&mut self) {
        unsafe {
            boxlite_box_free(self.handle);
            boxlite_runtime_free(self.runtime);
        }
    }
}

/// What a session's callbacks received.
#[derive(Default)]
struct Session {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<c_int>,
}

/// What the `boxlite_get` callback received; `code` stays `None` until it runs.
struct Lookup {
    handle: *mut CBoxHandle,
    code: Option<BoxliteErrorCode>,
    message: String,
}

impl Default for Lookup {
    fn default() -> Self {
        Self {
            handle: ptr::null_mut(),
            code: None,
            message: String::new(),
        }
    }
}

extern "C" fn record_box(handle: *mut CBoxHandle, error: *mut FFIError, user_data: *mut c_void) {
    let lookup = unsafe { &mut *user_data.cast::<Lookup>() };
    let error = unsafe { &*error };
    lookup.handle = handle;
    lookup.code = Some(error.code);
    if !error.message.is_null() {
        // The dispatcher frees the message once this returns, so copy it now.
        lookup.message = unsafe { CStr::from_ptr(error.message) }
            .to_string_lossy()
            .into_owned();
    }
}

extern "C" fn on_stdout(data: *const u8, len: usize, user_data: *mut c_void) {
    let session = unsafe { &mut *user_data.cast::<Session>() };
    session
        .stdout
        .extend_from_slice(unsafe { std::slice::from_raw_parts(data, len) });
}

extern "C" fn on_stderr(data: *const u8, len: usize, user_data: *mut c_void) {
    let session = unsafe { &mut *user_data.cast::<Session>() };
    session
        .stderr
        .extend_from_slice(unsafe { std::slice::from_raw_parts(data, len) });
}

extern "C" fn on_exit(exit_code: c_int, user_data: *mut c_void) {
    unsafe { (*user_data.cast::<Session>()).exit_code = Some(exit_code) };
}

/// Takes the message out of `error`, freeing it.
fn take_message(error: &mut FFIError) -> String {
    if error.message.is_null() {
        return String::new();
    }
    let message = unsafe { CStr::from_ptr(error.message) }
        .to_string_lossy()
        .into_owned();
    unsafe { boxlite_error_free(error) };
    message
}

#[test]
fn attach_main_streams_the_init_session_to_the_callbacks() {
    let api = BoxApi::serve(2, MainSession::Open);
    let rest_box = RestBox::open(&api);

    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code = unsafe { boxlite_box_attach_main(rest_box.handle, &mut execution, &mut error) };
    assert_eq!(code, BoxliteErrorCode::Ok, "{}", take_message(&mut error));
    assert!(!execution.is_null());

    let session = rest_box.follow(execution);
    assert_eq!(session.stdout, b"hi");
    assert_eq!(session.stderr, b"oops");
    assert_eq!(session.exit_code, Some(7));
    assert_eq!(
        api.received(),
        ["GET /v1/boxes/box1", "GET /v1/boxes/box1/attach"],
        "the main session is reached over the container-attach route",
    );
}

#[test]
fn attach_main_reports_a_refused_attach_without_a_handle() {
    let api = BoxApi::serve(2, MainSession::Refused);
    let rest_box = RestBox::open(&api);

    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code = unsafe { boxlite_box_attach_main(rest_box.handle, &mut execution, &mut error) };
    let message = take_message(&mut error);

    assert_eq!(code, BoxliteErrorCode::AlreadyExists, "{message}");
    assert!(
        execution.is_null(),
        "a refused attach must not hand out a handle"
    );
    assert!(
        message.contains("box box1 main session"),
        "expected the refused session named in {message:?}"
    );
}

#[test]
fn attach_main_rejects_a_null_out_execution_before_any_request() {
    let api = BoxApi::serve(1, MainSession::Open);
    let rest_box = RestBox::open(&api);

    let mut error = FFIError::default();
    let code = unsafe { boxlite_box_attach_main(rest_box.handle, ptr::null_mut(), &mut error) };
    let message = take_message(&mut error);

    assert_eq!(code, BoxliteErrorCode::InvalidArgument, "{message}");
    assert!(message.contains("out_execution"), "{message}");
    assert_eq!(api.received(), ["GET /v1/boxes/box1"]);
}

#[test]
fn exec_streams_its_session_to_the_callbacks() {
    let api = BoxApi::serve(3, MainSession::Open);
    let rest_box = RestBox::open(&api);

    let command = BoxliteCommand {
        command: c"true".as_ptr(),
        args: ptr::null(),
        argc: 0,
        env_pairs: ptr::null(),
        env_count: 0,
        workdir: ptr::null(),
        user: ptr::null(),
        timeout_secs: 0.0,
        tty: 0,
    };
    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code = unsafe { boxlite_box_exec(rest_box.handle, &command, &mut execution, &mut error) };
    assert_eq!(code, BoxliteErrorCode::Ok, "{}", take_message(&mut error));

    let session = rest_box.follow(execution);
    assert_eq!(session.stdout, b"hi");
    assert_eq!(session.stderr, b"oops");
    assert_eq!(session.exit_code, Some(7));
    assert_eq!(
        api.received(),
        [
            "GET /v1/boxes/box1",
            "POST /v1/boxes/box1/exec",
            "GET /v1/boxes/box1/executions/exec-1/attach",
        ],
    );
}
