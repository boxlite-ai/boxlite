//! POL-34 end-to-end: when the remote returns a transient-state
//! `invalid_state` error for a lifecycle command (e.g. the box is
//! still `Stopping` from a prior call), the CLI must wait and retry
//! instead of surfacing the transient error to the user.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

struct Stub {
    port: u16,
}

impl Stub {
    fn start<H>(handler: H) -> Self
    where
        H: Fn(&str, &str) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        let handler = Arc::new(handler);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let Ok(peek) = stream.try_clone() else {
                    continue;
                };
                let mut reader = BufReader::new(peek);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) if line == "\r\n" || line == "\n" => break,
                        Ok(_) => continue,
                        Err(_) => break,
                    }
                }
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let raw_path = parts.next().unwrap_or("");
                let path = raw_path.split('?').next().unwrap_or(raw_path);

                let (status, body) = handler(method, path);
                let reason = match status {
                    200 => "OK",
                    400 => "Bad Request",
                    404 => "Not Found",
                    409 => "Conflict",
                    _ => "OK",
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
                     Content-Length: {len}\r\nConnection: close\r\n\r\n{body}",
                    len = body.len(),
                );
                let _ = stream.flush();
            }
        });
        Self { port }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

fn cli(home: &TempDir) -> Command {
    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    cmd.env("BOXLITE_HOME", home.path())
        .env_remove("BOXLITE_API_KEY")
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_PROFILE")
        .timeout(Duration::from_secs(30));
    cmd
}

fn write_p1_creds(home: &TempDir, url: &str) {
    let body = format!(
        "[profiles.p1]\nurl = \"{url}\"\napi_key = \"k_test\"\nauth_method = \"api_key\"\n"
    );
    std::fs::write(home.path().join("credentials.toml"), body).unwrap();
}

const REAL_BOX_JSON: &str = r#"{
  "box_id":"box_real",
  "name":"real",
  "image":"alpine",
  "status":"Running",
  "created_at":"2026-06-01T00:00:00Z",
  "updated_at":"2026-06-01T00:00:00Z",
  "cpus":1,
  "memory_mib":256
}"#;

const STOPPED_BOX_JSON: &str = r#"{
  "box_id":"box_real",
  "name":"real",
  "image":"alpine",
  "status":"Stopped",
  "created_at":"2026-06-01T00:00:00Z",
  "updated_at":"2026-06-01T00:00:00Z",
  "cpus":1,
  "memory_mib":256
}"#;

const TRANSIENT_STATE_JSON: &str = r#"{"error":{"message":"Cannot start box in stopping state","type":"InvalidStateError","code":"invalid_state"}}"#;

/// `start` while the server still reports a `stopping`-state error
/// must succeed once the transient error stops firing. The stub
/// returns 409/invalid_state with "stopping" message for the first
/// two `POST /start` calls and then a 200 on the third — the CLI
/// must wait through the first two and surface success.
#[test]
fn start_waits_through_transient_invalid_state() {
    let attempts = Arc::new(AtomicU32::new(0));
    let attempts_in = attempts.clone();
    let stub = Stub::start(move |method, path| {
        if method == "POST" && path.ends_with("/start") {
            let n = attempts_in.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                (409, TRANSIENT_STATE_JSON.to_string())
            } else {
                (200, REAL_BOX_JSON.to_string())
            }
        } else if method == "GET" && path.starts_with("/v1/boxes/") {
            (200, STOPPED_BOX_JSON.to_string())
        } else {
            (
                404,
                r#"{"error":{"message":"nope","type":"NotFoundError","code":"not_found"}}"#
                    .to_string(),
            )
        }
    });
    let home = TempDir::new().unwrap();
    write_p1_creds(&home, &stub.url());

    cli(&home)
        // Keep the test snappy — 5 s budget is more than enough for
        // two retries (200ms + 400ms) and still safe well under the
        // 30 s assert_cmd timeout.
        .env("BOXLITE_TRANSIENT_RETRY_MS", "5000")
        .args(["--profile", "p1", "start", "real"])
        .assert()
        .success()
        .stdout(predicate::str::contains("real"));
    assert!(
        attempts.load(Ordering::SeqCst) >= 3,
        "stub must have been hit at least 3 times (2 transient + 1 success), got {}",
        attempts.load(Ordering::SeqCst)
    );
}

/// A persistently transient state must still time out and surface a
/// real failure — otherwise a stuck server would hang the user's
/// shell indefinitely. The budget is intentionally tiny here so the
/// test runs fast.
#[test]
fn start_gives_up_after_persistent_transient_state() {
    let stub = Stub::start(|method, path| {
        if method == "POST" && path.ends_with("/start") {
            (409, TRANSIENT_STATE_JSON.to_string())
        } else if method == "GET" && path.starts_with("/v1/boxes/") {
            (200, STOPPED_BOX_JSON.to_string())
        } else {
            (
                404,
                r#"{"error":{"message":"nope","type":"NotFoundError","code":"not_found"}}"#
                    .to_string(),
            )
        }
    });
    let home = TempDir::new().unwrap();
    write_p1_creds(&home, &stub.url());

    cli(&home)
        .env("BOXLITE_TRANSIENT_RETRY_MS", "400")
        .args(["--profile", "p1", "start", "real"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("gave up"));
}

/// A `start` against a non-transient `invalid_state` (e.g. "Cannot
/// start box in failed state") must propagate immediately — the retry
/// loop is for in-flight transitions, not permanent failures. Pinning
/// this with a long budget so a regression that retries every
/// `InvalidState` would hang past the assert_cmd timeout and fail
/// the test loudly.
#[test]
fn start_does_not_retry_non_transient_invalid_state() {
    let attempts = Arc::new(AtomicU32::new(0));
    let attempts_in = attempts.clone();
    let stub = Stub::start(move |method, path| {
        if method == "POST" && path.ends_with("/start") {
            attempts_in.fetch_add(1, Ordering::SeqCst);
            (
                409,
                r#"{"error":{"message":"Cannot start box in failed state","type":"InvalidStateError","code":"invalid_state"}}"#.to_string(),
            )
        } else if method == "GET" && path.starts_with("/v1/boxes/") {
            (200, STOPPED_BOX_JSON.to_string())
        } else {
            (
                404,
                r#"{"error":{"message":"nope","type":"NotFoundError","code":"not_found"}}"#
                    .to_string(),
            )
        }
    });
    let home = TempDir::new().unwrap();
    write_p1_creds(&home, &stub.url());

    cli(&home)
        // 20 s — long enough that a retry-everything regression would
        // hang well past the 0.4 s a one-shot path takes.
        .env("BOXLITE_TRANSIENT_RETRY_MS", "20000")
        .args(["--profile", "p1", "start", "real"])
        .assert()
        .failure();
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        1,
        "non-transient InvalidState must not trigger retry; got {} attempts",
        attempts.load(Ordering::SeqCst)
    );
}
