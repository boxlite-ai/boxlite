use crate::runtime::RuntimeHandle;
use crate::ssh::{CSshStatus, owned_ssh_status};
use crate::*;
use boxlite::SshStatus;
use std::ffi::{CStr, CString};
use std::io::{BufRead, BufReader, Read, Write};
use std::mem::MaybeUninit;
use std::net::{TcpListener, TcpStream};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

/// The canned answer to one connection; connections are answered in the
/// order the routes are listed.
struct Route {
    request_line: &'static str,
    status: &'static str,
    body: &'static str,
}

const fn route(request_line: &'static str, status: &'static str, body: &'static str) -> Route {
    Route {
        request_line,
        status,
        body,
    }
}

const BOX_RUNNING: Route = route(
    "GET /v1/boxes/b1 HTTP/1.1",
    "200 OK",
    r#"{"box_id":"b1","name":"b1","status":"Running","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":1,"image":"alpine:3.19","cpus":1,"memory_mib":256}"#,
);
const CONFIGURED: &str = r#"{"enabled":true,"generation":1,"listen_address":"127.0.0.1:2222","host_public_key":"ssh-ed25519 AAAAhost","host_key_fingerprint":"SHA256:hostfp"}"#;
const DISABLED: &str = r#"{"enabled":false,"generation":0,"listen_address":"","host_public_key":"","host_key_fingerprint":""}"#;
const RECONFIGURED: &str = r#"{"enabled":true,"generation":2,"listen_address":"0.0.0.0:2223","host_public_key":"ssh-ed25519 AAAAother","host_key_fingerprint":"SHA256:otherfp"}"#;

const HOST_KEY_SENTINEL: &str = "RUST-HOST-KEY-SENTINEL";
/// A full SshConfig body: address, host key, and an account with both an
/// authorized key and a certificate authority.
const CONFIG_JSON: &CStr = c"{\"listen_address\":\"0.0.0.0:2222\",\"host_private_key\":\"RUST-HOST-KEY-SENTINEL\",\"accounts\":[{\"login\":\"alice\",\"authorized_keys\":[\"ssh-ed25519 AAAAalice\"],\"ca\":{\"public_key\":\"CA-SENTINEL\",\"principal\":\"alice\"}}]}";

/// Answer connections in route order, recording `"<request line>\n<body>"`
/// before each reply. A request line out of order gets a 404, so a
/// mis-sequenced call fails the test rather than passing silently.
fn serve(routes: &'static [Route]) -> (String, Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
    let address = listener.local_addr().expect("loopback listener address");
    let (seen, requests) = mpsc::channel();
    thread::spawn(move || {
        for (index, stream) in listener.incoming().take(routes.len()).enumerate() {
            answer(stream.expect("accept connection"), &routes[index], &seen);
        }
    });
    (format!("http://{address}"), requests)
}

fn answer(mut stream: TcpStream, route: &Route, seen: &Sender<String>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("set read timeout");
    let mut head = String::new();
    let mut content_length = 0usize;
    let mut body = String::new();
    {
        let mut reader = BufReader::new(&stream);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).expect("read head") == 0 {
                break;
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some(value) = line
                .to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(str::trim)
            {
                content_length = value.parse().expect("content length");
            }
            if head.is_empty() {
                head = line.trim_end().to_owned();
            }
        }
        if content_length > 0 {
            let mut bytes = vec![0u8; content_length];
            reader.read_exact(&mut bytes).expect("read body");
            body = String::from_utf8_lossy(&bytes).into_owned();
        }
        let _ = seen.send(format!("{head}\n{body}"));
    }
    let (status, reply_body) = if head == route.request_line {
        (route.status, route.body)
    } else {
        (
            "404 Not Found",
            r#"{"error":{"message":"unexpected request","type":"NotFoundError","code":"not_found"}}"#,
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{reply_body}",
        reply_body.len()
    );
    stream.write_all(response.as_bytes()).expect("write reply");
}

/// What one callback received, copied out before it returned.
struct Delivery {
    code: Option<BoxliteErrorCode>,
    message: String,
    status: Option<StatusSeen>,
}

impl Delivery {
    fn pending() -> Self {
        Self {
            code: None,
            message: String::new(),
            status: None,
        }
    }
}

#[derive(Debug, PartialEq)]
struct StatusSeen {
    enabled: c_int,
    generation: u64,
    listen_address: String,
    host_public_key: String,
    host_key_fingerprint: String,
}

unsafe fn owned_string(s: *const c_char) -> String {
    if s.is_null() {
        return "<null>".to_owned();
    }
    unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned()
}

extern "C" fn record_status(status: *mut CSshStatus, error: *mut FFIError, user_data: *mut c_void) {
    unsafe {
        let delivery = &mut *user_data.cast::<Delivery>();
        let error = &*error;
        delivery.code = Some(error.code);
        delivery.message = owned_string(error.message);
        if let Some(status) = status.as_ref() {
            delivery.status = Some(StatusSeen {
                enabled: status.enabled,
                generation: status.generation,
                listen_address: owned_string(status.listen_address),
                host_public_key: owned_string(status.host_public_key),
                host_key_fingerprint: owned_string(status.host_key_fingerprint),
            });
            boxlite_free_ssh_status(status as *const CSshStatus as *mut _);
        }
    }
}

/// Drain until `ready` holds; panics with `what` after ~20s.
fn drain_until(runtime: *mut RuntimeHandle, what: &str, ready: impl Fn() -> bool) {
    let mut error = FFIError::default();
    for _ in 0..40 {
        if ready() {
            return;
        }
        let dispatched = unsafe { boxlite_runtime_drain(runtime, 500, &mut error) };
        assert!(dispatched >= 0, "{what}: drain failed");
    }
    assert!(ready(), "{what}: the callback did not run within 20s");
}

/// A `boxlite_get` callback: copies the handle out; owns nothing.
struct BoxDelivery {
    handle: *mut CBoxHandle,
    done: bool,
}

extern "C" fn record_box(handle: *mut CBoxHandle, error: *mut FFIError, user_data: *mut c_void) {
    unsafe {
        let delivery = &mut *user_data.cast::<BoxDelivery>();
        assert_eq!((*error).code, BoxliteErrorCode::Ok);
        delivery.handle = handle;
        delivery.done = true;
    }
}

/// A box handle on a REST runtime whose server answers `routes` in order.
struct SshBox {
    runtime: *mut RuntimeHandle,
    box_handle: *mut CBoxHandle,
    requests: Receiver<String>,
}

impl SshBox {
    fn on_rest_server(routes: &'static [Route]) -> Self {
        let (base_url, requests) = serve(routes);
        let base_url = CString::new(base_url).expect("base url cstring");
        let mut options = MaybeUninit::<*mut CBoxliteRestOptions>::uninit();
        let mut runtime = MaybeUninit::<*mut RuntimeHandle>::uninit();
        let mut error = FFIError::default();
        unsafe {
            let code =
                boxlite_rest_options_new(base_url.as_ptr(), options.as_mut_ptr(), &mut error);
            assert_eq!(code, BoxliteErrorCode::Ok);
            let options = options.assume_init();
            let code =
                boxlite_rest_runtime_new_with_options(options, runtime.as_mut_ptr(), &mut error);
            boxlite_rest_options_free(options);
            assert_eq!(code, BoxliteErrorCode::Ok);
            let runtime = runtime.assume_init();

            let mut delivery = BoxDelivery {
                handle: ptr::null_mut(),
                done: false,
            };
            let slot: *mut BoxDelivery = &mut delivery;
            let code = boxlite_get(
                runtime,
                c"b1".as_ptr(),
                Some(record_box),
                slot.cast(),
                &mut error,
            );
            assert_eq!(code, BoxliteErrorCode::Ok);
            drain_until(runtime, "box attach", || (*slot).done);
            Self {
                runtime,
                box_handle: delivery.handle,
                requests,
            }
        }
    }

    fn configure(&self, json: &CStr) -> Delivery {
        self.deliver(|user_data, error| unsafe {
            boxlite_box_ssh_configure(
                self.box_handle,
                json.as_ptr(),
                Some(record_status),
                user_data,
                error,
            )
        })
    }

    fn status(&self) -> Delivery {
        self.deliver(|user_data, error| unsafe {
            boxlite_box_ssh_status(self.box_handle, Some(record_status), user_data, error)
        })
    }

    fn disable(&self) -> Delivery {
        self.deliver(|user_data, error| unsafe {
            boxlite_box_ssh_disable(self.box_handle, Some(record_status), user_data, error)
        })
    }

    /// Queues one call with a fresh delivery slot, then drains until its
    /// callback has run.
    fn deliver(
        &self,
        queue_call: impl FnOnce(*mut c_void, *mut FFIError) -> BoxliteErrorCode,
    ) -> Delivery {
        let mut delivery = Delivery::pending();
        let slot: *mut Delivery = &mut delivery;
        let mut error = FFIError::default();
        let code = queue_call(slot.cast(), &mut error);
        assert_eq!(code, BoxliteErrorCode::Ok, "{}", unsafe {
            owned_string(error.message)
        });
        drain_until(self.runtime, "ssh callback", || unsafe {
            (*slot).code.is_some()
        });
        delivery
    }

    fn requests_received(&self) -> Vec<String> {
        self.requests.try_iter().collect()
    }

    /// Free the box handle, then hand the runtime pointer to a caller that
    /// frees the runtime itself.
    fn forget(mut self) -> *mut RuntimeHandle {
        unsafe { boxlite_box_free(self.box_handle) };
        self.box_handle = ptr::null_mut();
        let runtime = self.runtime;
        self.runtime = ptr::null_mut();
        runtime
    }
}

impl Drop for SshBox {
    fn drop(&mut self) {
        unsafe {
            if !self.box_handle.is_null() {
                boxlite_box_free(self.box_handle);
            }
            if !self.runtime.is_null() {
                boxlite_runtime_free(self.runtime);
            }
        }
    }
}

fn configured_seen() -> StatusSeen {
    StatusSeen {
        enabled: 1,
        generation: 1,
        listen_address: "127.0.0.1:2222".into(),
        host_public_key: "ssh-ed25519 AAAAhost".into(),
        host_key_fingerprint: "SHA256:hostfp".into(),
    }
}

fn disabled_seen() -> StatusSeen {
    StatusSeen {
        enabled: 0,
        generation: 0,
        listen_address: String::new(),
        host_public_key: String::new(),
        host_key_fingerprint: String::new(),
    }
}

#[test]
fn configure_status_repeated_disable_and_reconfigure_round_trip() {
    // Each callback frees a status through the shared counter; hold the lock
    // until `box_ssh` drops so concurrent delta readers stay exact.
    let _counting = FREE_STR_LOCK.lock().unwrap();
    let routes: &'static [Route] = Box::leak(Box::new([
        BOX_RUNNING,
        route("POST /v1/boxes/b1/ssh HTTP/1.1", "200 OK", CONFIGURED),
        route("GET /v1/boxes/b1/ssh HTTP/1.1", "200 OK", CONFIGURED),
        route("DELETE /v1/boxes/b1/ssh HTTP/1.1", "200 OK", DISABLED),
        route("DELETE /v1/boxes/b1/ssh HTTP/1.1", "200 OK", DISABLED),
        route("POST /v1/boxes/b1/ssh HTTP/1.1", "200 OK", RECONFIGURED),
    ]));
    let box_ssh = SshBox::on_rest_server(routes);

    let configured = box_ssh.configure(CONFIG_JSON);
    assert_eq!(configured.code, Some(BoxliteErrorCode::Ok));
    assert_eq!(configured.status, Some(configured_seen()));

    let status = box_ssh.status();
    assert_eq!(status.code, Some(BoxliteErrorCode::Ok));
    assert_eq!(status.status, Some(configured_seen()));

    for _ in 0..2 {
        let disabled = box_ssh.disable();
        assert_eq!(disabled.code, Some(BoxliteErrorCode::Ok));
        assert_eq!(
            disabled.status,
            Some(disabled_seen()),
            "disable is idempotent"
        );
    }

    let reconfigured = box_ssh.configure(CONFIG_JSON);
    assert_eq!(reconfigured.code, Some(BoxliteErrorCode::Ok));
    assert_eq!(reconfigured.status.as_ref().unwrap().generation, 2);

    let requests = box_ssh.requests_received();
    assert_eq!(requests[0], "GET /v1/boxes/b1 HTTP/1.1\n", "the box attach");
    let (configure_line, configure_body) = requests[1].split_once('\n').unwrap();
    assert_eq!(configure_line, "POST /v1/boxes/b1/ssh HTTP/1.1");
    // The wire body re-serializes per field, so assert each credential
    // carried rather than exact JSON ordering.
    for needed in [
        "\"listen_address\":\"0.0.0.0:2222\"",
        "\"host_private_key\":\"RUST-HOST-KEY-SENTINEL\"",
        "\"login\":\"alice\"",
        "\"authorized_keys\":[\"ssh-ed25519 AAAAalice\"]",
        "\"public_key\":\"CA-SENTINEL\"",
        "\"principal\":\"alice\"",
    ] {
        assert!(
            configure_body.contains(needed),
            "configure body misses {needed}: {configure_body}"
        );
    }
    assert_eq!(requests[2], "GET /v1/boxes/b1/ssh HTTP/1.1\n");
    assert_eq!(requests[3], "DELETE /v1/boxes/b1/ssh HTTP/1.1\n");
}

#[test]
fn configure_refusal_maps_invalid_state_and_leaks_no_key() {
    let routes: &'static [Route] = Box::leak(Box::new([
        BOX_RUNNING,
        route(
            "POST /v1/boxes/b1/ssh HTTP/1.1",
            "409 Conflict",
            r#"{"error":{"message":"box b1 is stopped and auto_resume is off","type":"InvalidStateError","code":"invalid_state"}}"#,
        ),
    ]));
    let box_ssh = SshBox::on_rest_server(routes);

    let refused = box_ssh.configure(CONFIG_JSON);
    assert_eq!(refused.code, Some(BoxliteErrorCode::InvalidState));
    assert_eq!(
        refused.message, "invalid state: box b1 is stopped and auto_resume is off",
        "the server's message reaches the callback"
    );
    assert!(!refused.message.contains(HOST_KEY_SENTINEL));
    assert!(
        refused.status.is_none(),
        "no status is handed over on error"
    );
}

#[test]
fn runtime_destruction_drops_undelivered_status() {
    let routes: &'static [Route] = Box::leak(Box::new([
        BOX_RUNNING,
        route("POST /v1/boxes/b1/ssh HTTP/1.1", "200 OK", CONFIGURED),
    ]));
    let box_ssh = SshBox::on_rest_server(routes);

    let _counting = FREE_STR_LOCK.lock().unwrap();
    let mut delivery = Delivery::pending();
    let slot: *mut Delivery = &mut delivery;
    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_ssh_configure(
            box_ssh.box_handle,
            CONFIG_JSON.as_ptr(),
            Some(record_status),
            slot.cast(),
            &mut error,
        )
    };
    assert_eq!(code, BoxliteErrorCode::Ok);

    // Wait for the event to reach the queue without dispatching it, then
    // destroy the runtime: the queued status must be reclaimed and the
    // callback must never run.
    let queue = unsafe { (*box_ssh.runtime).queue.clone() };
    let pending = queue.inner.lock().unwrap();
    let (pending, waited) = queue
        .cv
        .wait_timeout_while(pending, Duration::from_secs(10), |events| events.is_empty())
        .unwrap();
    assert!(!waited.timed_out(), "the status never reached the queue");
    drop(pending);

    let before = FREE_STR_CALLS.load(Ordering::SeqCst);
    let runtime = box_ssh.forget();
    unsafe { boxlite_runtime_free(runtime) };
    let strings_freed = FREE_STR_CALLS.load(Ordering::SeqCst) - before;

    assert_eq!(
        strings_freed, 3,
        "the queued status's strings were not reclaimed"
    );
    assert!(
        unsafe { (*slot).code.is_none() },
        "a dropped event reached its callback"
    );
}

#[test]
fn status_conversion_maps_every_field_and_free_reclaims_strings() {
    let _counting = FREE_STR_LOCK.lock().unwrap();
    let owned = owned_ssh_status(SshStatus {
        enabled: true,
        generation: 7,
        listen_address: "127.0.0.1:2222".into(),
        host_public_key: "ssh-ed25519 AAAAhost".into(),
        host_key_fingerprint: "SHA256:hostfp".into(),
    });
    let raw = owned.take();
    let status = unsafe { &*raw };
    assert_eq!(status.enabled, 1);
    assert_eq!(status.generation, 7);
    unsafe {
        assert_eq!(owned_string(status.listen_address), "127.0.0.1:2222");
        assert_eq!(owned_string(status.host_public_key), "ssh-ed25519 AAAAhost");
        assert_eq!(owned_string(status.host_key_fingerprint), "SHA256:hostfp");
    }
    let before = FREE_STR_CALLS.load(Ordering::SeqCst);
    unsafe { boxlite_free_ssh_status(raw) };
    assert_eq!(
        FREE_STR_CALLS.load(Ordering::SeqCst) - before,
        3,
        "free reclaims the three status strings"
    );
}

#[test]
fn dropping_an_undelivered_status_payload_reclaims_its_strings() {
    let _counting = FREE_STR_LOCK.lock().unwrap();
    let owned = owned_ssh_status(SshStatus {
        enabled: true,
        generation: 1,
        listen_address: "127.0.0.1:2222".into(),
        host_public_key: "ssh-ed25519 AAAAhost".into(),
        host_key_fingerprint: "SHA256:hostfp".into(),
    });
    let before = FREE_STR_CALLS.load(Ordering::SeqCst);
    drop(owned);
    assert_eq!(
        FREE_STR_CALLS.load(Ordering::SeqCst) - before,
        3,
        "OwnedFfiPtr's destructor reclaims nested strings"
    );
}

#[test]
fn configure_rejects_bad_bodies_with_a_constant_sanitized_message() {
    let sentinel_bodies = [
        format!("{{\"unknown_field_{HOST_KEY_SENTINEL}\":1}}"),
        format!("{{\"listen_address\": \"{HOST_KEY_SENTINEL}\"}}"),
        format!(
            "{{\"listen_address\": \"{HOST_KEY_SENTINEL}\", \"accounts\": [], \
             \"host_private_key\": 5}}"
        ),
        "not json at all".to_owned(),
    ];
    for body in sentinel_bodies {
        let body = CString::new(body).unwrap();
        let mut error = FFIError::default();
        let code = unsafe {
            boxlite_box_ssh_configure(
                ptr::null_mut(),
                body.as_ptr(),
                Some(record_status),
                ptr::null_mut(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        let message = unsafe { owned_string(error.message) };
        assert_eq!(message, "invalid argument: invalid SSH configuration");
        assert!(!message.contains(HOST_KEY_SENTINEL));
    }

    // Non-UTF-8 bytes are refused with the same constant message.
    let raw = CString::new([0xffu8, 0xfe]).unwrap();
    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_ssh_configure(
            ptr::null_mut(),
            raw.as_ptr(),
            Some(record_status),
            ptr::null_mut(),
            &mut error,
        )
    };
    assert_eq!(code, BoxliteErrorCode::InvalidArgument);
    assert_eq!(
        unsafe { owned_string(error.message) },
        "invalid argument: invalid SSH configuration"
    );
}

#[test]
fn null_pointers_and_callbacks_are_refused_before_queueing() {
    let check = |what: &str, code: BoxliteErrorCode, error: &FFIError, tail: &str| {
        assert_eq!(code, BoxliteErrorCode::InvalidArgument, "{what}");
        let message = unsafe { owned_string(error.message) };
        assert!(message.ends_with(tail), "{what}: {message}");
    };
    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_ssh_configure(
            ptr::null_mut(),
            ptr::null(),
            Some(record_status),
            ptr::null_mut(),
            &mut error,
        )
    };
    check("configure: null body", code, &error, "config_json is null");

    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_ssh_configure(
            ptr::null_mut(),
            CONFIG_JSON.as_ptr(),
            Some(record_status),
            ptr::null_mut(),
            &mut error,
        )
    };
    check("configure: null handle", code, &error, "handle is null");

    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_ssh_configure(
            ptr::null_mut(),
            CONFIG_JSON.as_ptr(),
            None,
            ptr::null_mut(),
            &mut error,
        )
    };
    check("configure: null callback", code, &error, "cb is null");

    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_ssh_status(
            ptr::null_mut(),
            Some(record_status),
            ptr::null_mut(),
            &mut error,
        )
    };
    check("status: null handle", code, &error, "handle is null");

    let mut error = FFIError::default();
    let code =
        unsafe { boxlite_box_ssh_status(ptr::null_mut(), None, ptr::null_mut(), &mut error) };
    check("status: null callback", code, &error, "cb is null");

    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_box_ssh_disable(
            ptr::null_mut(),
            Some(record_status),
            ptr::null_mut(),
            &mut error,
        )
    };
    check("disable: null handle", code, &error, "handle is null");

    let mut error = FFIError::default();
    let code =
        unsafe { boxlite_box_ssh_disable(ptr::null_mut(), None, ptr::null_mut(), &mut error) };
    check("disable: null callback", code, &error, "cb is null");
}
