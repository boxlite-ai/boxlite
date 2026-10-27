//! `boxlite_box_attach` and `boxlite_box_exec` driven through the public
//! FFI the way a C caller drives them, against a loopback box API.
//!
//! A REST runtime yields a real box handle with no VM behind it. The server
//! answers the box lookup, `POST /exec` and both attach upgrades, and a session
//! it accepts plays "hi" on stdout, "oops" on stderr, then exit code 7 — or,
//! held, stops after "hi" so the client gets a session still running. It
//! serves one connection per request the test makes, then exits.

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
const EXIT_FRAME: &str = r#"{"type":"exit","exit_code":7}"#;
const SESSION_ENDED: &str = "session ended";

/// How the server plays the sessions it accepts.
#[derive(Clone, Copy)]
enum Sessions {
    /// Every session plays to its exit.
    Open,
    /// The main-session upgrade is refused; an exec still plays to its exit.
    Refused,
    /// Every session is still running when the client gets it.
    Held,
}

/// A loopback box API. Each request goes on `requests`, as "METHOD target"
/// with any query string, before it is answered.
struct BoxApi {
    url: CString,
    requests: Receiver<String>,
}

impl BoxApi {
    fn serve(connections: usize, sessions: Sessions) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let address = listener.local_addr().expect("loopback listener address");
        let (seen, requests) = mpsc::channel();
        thread::spawn(move || {
            // One thread per connection, so a request made while a session is
            // held open — a kill, say — is answered and seen at once.
            for stream in listener.incoming().take(connections) {
                let stream = stream.expect("accept connection");
                let seen = seen.clone();
                thread::spawn(move || answer(stream, sessions, &seen));
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

    /// Everything seen up to and including the end of a held session, so a
    /// control message the client sends after the test's last call is counted.
    fn received_until_session_ends(&self) -> Vec<String> {
        let mut seen = Vec::new();
        while let Ok(entry) = self.requests.recv_timeout(Duration::from_secs(10)) {
            let ended = entry == SESSION_ENDED;
            seen.push(entry);
            if ended {
                break;
            }
        }
        seen
    }
}

fn answer(mut stream: TcpStream, sessions: Sessions, seen: &Sender<String>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("set read timeout");
    let (method, target, websocket_key) = read_request(&stream);
    let _ = seen.send(format!("{method} {target}"));
    let path = target.split('?').next().unwrap_or_default();
    match (format!("{method} {path}").as_str(), sessions) {
        ("GET /v1/boxes/box1", _) => reply(&mut stream, "200 OK", BOX_JSON),
        ("POST /v1/boxes/box1/exec", _) => {
            reply(&mut stream, "200 OK", r#"{"execution_id":"exec-1"}"#)
        }
        ("GET /v1/boxes/box1/attach", Sessions::Refused) => {
            reply(&mut stream, "409 Conflict", REFUSAL_JSON)
        }
        ("GET /v1/boxes/box1/attach", _) => serve_session(
            stream,
            &websocket_key,
            "x-boxlite-execution-id: init-1\r\n",
            sessions,
            seen,
        ),
        ("GET /v1/boxes/box1/executions/exec-1/attach", _) => {
            serve_session(stream, &websocket_key, "", sessions, seen)
        }
        _ => reply(&mut stream, "404 Not Found", NO_ROUTE_JSON),
    }
}

/// Reads one request, body included so closing the socket cannot reset the
/// client before it reads the answer. Returns the method, the target with its
/// query string, and the request's `Sec-WebSocket-Key`, empty when it is not
/// an upgrade.
fn read_request(stream: &TcpStream) -> (String, String, String) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).expect("read request line");
    let mut words = line.split_whitespace();
    let method = words.next().unwrap_or_default().to_owned();
    let target = words.next().unwrap_or_default().to_owned();

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
    (method, target, websocket_key)
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

/// Completes the upgrade, `extra_headers` on the 101, and plays the session
/// the way `sessions` says.
fn serve_session(
    mut stream: TcpStream,
    websocket_key: &str,
    extra_headers: &str,
    sessions: Sessions,
    seen: &Sender<String>,
) {
    let accept = derive_accept_key(websocket_key.as_bytes());
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n{extra_headers}\r\n"
    )
    .expect("write upgrade");
    let ws = WebSocket::from_raw_socket(stream, Role::Server, None);
    match sessions {
        Sessions::Held => play_held_session(ws, seen),
        Sessions::Open | Sessions::Refused => play_session(ws),
    }
}

/// Plays the whole session, then holds the connection until the client hangs
/// up, which it does on the exit frame.
fn play_session(mut ws: WebSocket<TcpStream>) {
    ws.send(Message::Binary(b"\x01hi".to_vec()))
        .expect("send stdout");
    ws.send(Message::Binary(b"\x02oops".to_vec()))
        .expect("send stderr");
    ws.send(Message::Text(EXIT_FRAME.into()))
        .expect("send exit");
    while ws.read().is_ok() {}
}

/// Plays a session that is still running when the client gets it: "hi", then
/// the exit only once the client hangs up or two seconds pass. The bound keeps
/// a client that waits for the exit from hanging the test. Every control
/// message the client sends goes on `seen` as "WS <text>", and
/// `SESSION_ENDED` once the session is over.
fn play_held_session(mut ws: WebSocket<TcpStream>, seen: &Sender<String>) {
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set read timeout");
    ws.send(Message::Binary(b"\x01hi".to_vec()))
        .expect("send stdout");
    while let Ok(message) = ws.read() {
        if let Message::Text(text) = message {
            let _ = seen.send(format!("WS {text}"));
        }
    }
    let _ = ws.send(Message::Text(EXIT_FRAME.into()));
    let _ = seen.send(SESSION_ENDED.to_string());
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

/// A command with no arguments, environment or options.
fn bare_command(program: &'static CStr) -> BoxliteCommand {
    BoxliteCommand {
        command: program.as_ptr(),
        args: ptr::null(),
        argc: 0,
        env_pairs: ptr::null(),
        env_count: 0,
        workdir: ptr::null(),
        user: ptr::null(),
        timeout_secs: 0.0,
        tty: 0,
    }
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
fn attach_streams_the_main_session_to_the_callbacks() {
    let api = BoxApi::serve(2, Sessions::Open);
    let rest_box = RestBox::open(&api);

    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code =
        unsafe { boxlite_box_attach(rest_box.handle, ptr::null(), 0, &mut execution, &mut error) };
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
fn attach_reports_a_refused_attach_without_a_handle() {
    let api = BoxApi::serve(2, Sessions::Refused);
    let rest_box = RestBox::open(&api);

    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code =
        unsafe { boxlite_box_attach(rest_box.handle, ptr::null(), 0, &mut execution, &mut error) };
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
fn attach_rejects_a_null_out_execution_before_any_request() {
    let api = BoxApi::serve(1, Sessions::Open);
    let rest_box = RestBox::open(&api);

    let mut error = FFIError::default();
    let code =
        unsafe { boxlite_box_attach(rest_box.handle, ptr::null(), 0, ptr::null_mut(), &mut error) };
    let message = take_message(&mut error);

    assert_eq!(code, BoxliteErrorCode::InvalidArgument, "{message}");
    assert!(message.contains("out_execution"), "{message}");
    assert_eq!(api.received(), ["GET /v1/boxes/box1"]);
}

#[test]
fn attach_reattaches_an_exec_by_id_read_only() {
    let api = BoxApi::serve(2, Sessions::Open);
    let rest_box = RestBox::open(&api);

    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_attach(
            rest_box.handle,
            c"exec-1".as_ptr(),
            1,
            &mut execution,
            &mut error,
        )
    };
    assert_eq!(code, BoxliteErrorCode::Ok, "{}", take_message(&mut error));

    let session = rest_box.follow(execution);
    assert_eq!(session.stdout, b"hi");
    assert_eq!(session.exit_code, Some(7));
    assert_eq!(
        api.received(),
        [
            "GET /v1/boxes/box1",
            "GET /v1/boxes/box1/executions/exec-1/attach?stdin=0",
        ],
        "an id reattaches over the exec route, and read-only asks the server to refuse stdin",
    );
}

#[test]
fn exec_streams_its_session_to_the_callbacks() {
    let api = BoxApi::serve(3, Sessions::Open);
    let rest_box = RestBox::open(&api);

    let command = bare_command(c"true");
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

#[test]
fn freeing_an_attach_detaches_without_killing_the_session() {
    // One connection to spare, so a kill would be served and recorded.
    let api = BoxApi::serve(3, Sessions::Held);
    let rest_box = RestBox::open(&api);

    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code =
        unsafe { boxlite_box_attach(rest_box.handle, ptr::null(), 0, &mut execution, &mut error) };
    assert_eq!(code, BoxliteErrorCode::Ok, "{}", take_message(&mut error));

    // The box's command is still running; this client only joined it.
    unsafe { boxlite_execution_free(execution) };

    // Like every SDK's attach, a writable one closes stdin on the way out
    // (#2045); what it must never do is kill the session it joined.
    assert_eq!(
        api.received_until_session_ends(),
        [
            "GET /v1/boxes/box1",
            "GET /v1/boxes/box1/attach",
            r#"WS {"type":"stdin_eof"}"#,
            SESSION_ENDED
        ],
        "freeing an attach must not kill the session it joined",
    );
}

#[test]
fn freeing_an_exec_still_kills_its_running_process() {
    let api = BoxApi::serve(4, Sessions::Held);
    let rest_box = RestBox::open(&api);

    let command = bare_command(c"sleep");
    let mut execution: *mut CExecutionHandle = ptr::null_mut();
    let mut error = FFIError::default();
    let code = unsafe { boxlite_box_exec(rest_box.handle, &command, &mut execution, &mut error) };
    assert_eq!(code, BoxliteErrorCode::Ok, "{}", take_message(&mut error));

    // This handle started the process, so letting go must not leak it.
    unsafe { boxlite_execution_free(execution) };

    let requests = api.received_until_session_ends();
    assert!(
        requests.contains(&"DELETE /v1/boxes/box1/executions/exec-1".to_string()),
        "freeing an exec still running must kill it, got {requests:?}",
    );
}
