//! Integration tests for `boxlite auth {login,whoami,status}` against a
//! std-only stub HTTP server (zero new deps). Covers the Phase-1 identity
//! flow: `login` validates via `GET /v1/me` and prints who you are; falls
//! back to `GET /v1/default/boxes` when `/v1/me` is 404 (zero regression);
//! 401 fails without writing credentials; `whoami` reflects identity.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

/// Minimal HTTP/1.1 stub. `handler(method, path) -> (status, json_body)`.
/// One request per connection (`Connection: close`); a daemon thread serves
/// sequential connections for the test's lifetime.
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
                // Drain headers (we never need a body — all GETs).
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
                    401 => "Unauthorized",
                    404 => "Not Found",
                    _ => "Status",
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

const PRINCIPAL_JSON: &str = r#"{"sub":"usr_1","principal_type":"user","email":"dev@acme.test","display_name":"Dev","prefix":"acme","scopes":["box:read","box:write"]}"#;
const NOT_FOUND_JSON: &str =
    r#"{"error":{"message":"no /v1/me here","type":"NotFoundError","code":404}}"#;
const AUTH_ERR_JSON: &str = r#"{"error":{"message":"bad key","type":"AuthError","code":401}}"#;
const EMPTY_BOXES_JSON: &str = r#"{"boxes":[]}"#;

/// `boxlite auth …` command with hermetic env: isolated `BOXLITE_HOME`, and
/// host `BOXLITE_API_KEY`/`BOXLITE_REST_URL` removed so they can't leak in.
fn auth_cmd(home: &TempDir) -> Command {
    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    cmd.env("BOXLITE_HOME", home.path())
        .env_remove("BOXLITE_API_KEY")
        .env_remove("BOXLITE_REST_URL")
        .timeout(Duration::from_secs(30));
    cmd
}

fn creds_path(home: &TempDir) -> std::path::PathBuf {
    home.path().join("credentials.toml")
}

#[test]
fn login_success_prints_identity_and_saves() {
    let stub = Stub::start(|_m, path| match path {
        "/v1/me" => (200, PRINCIPAL_JSON.to_string()),
        _ => (404, NOT_FOUND_JSON.to_string()),
    });
    let home = TempDir::new().unwrap();

    auth_cmd(&home)
        .args(["auth", "login", "--url", &stub.url(), "--api-key-stdin"])
        .write_stdin("k_test\n")
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Logged in as dev@acme.test (org: acme)",
        ));

    assert!(
        creds_path(&home).exists(),
        "credentials.toml must be written"
    );
}

#[test]
fn login_falls_back_to_boxes_when_me_404() {
    let stub = Stub::start(|_m, path| {
        if path == "/v1/me" {
            (404, NOT_FOUND_JSON.to_string())
        } else if path.starts_with("/v1/default/boxes") {
            (200, EMPTY_BOXES_JSON.to_string())
        } else {
            (404, NOT_FOUND_JSON.to_string())
        }
    });
    let home = TempDir::new().unwrap();

    auth_cmd(&home)
        .args(["auth", "login", "--url", &stub.url(), "--api-key-stdin"])
        .write_stdin("k_test\n")
        .assert()
        .success()
        .stdout(predicate::str::contains("Logged in (API key)"));

    assert!(
        creds_path(&home).exists(),
        "fallback validation must still save credentials"
    );
}

#[test]
fn login_fails_and_does_not_save_on_401() {
    let stub = Stub::start(|_m, _path| (401, AUTH_ERR_JSON.to_string()));
    let home = TempDir::new().unwrap();

    auth_cmd(&home)
        .args(["auth", "login", "--url", &stub.url(), "--api-key-stdin"])
        .write_stdin("bad_key\n")
        .assert()
        .failure()
        .stderr(predicate::str::contains("authentication failed"));

    assert!(
        !creds_path(&home).exists(),
        "credentials must NOT be written on auth failure"
    );
}

#[test]
fn whoami_prints_identity_after_login() {
    let stub = Stub::start(|_m, path| match path {
        "/v1/me" => (200, PRINCIPAL_JSON.to_string()),
        _ => (404, NOT_FOUND_JSON.to_string()),
    });
    let home = TempDir::new().unwrap();

    auth_cmd(&home)
        .args(["auth", "login", "--url", &stub.url(), "--api-key-stdin"])
        .write_stdin("k_test\n")
        .assert()
        .success();

    auth_cmd(&home)
        .args(["auth", "whoami"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("Logged in as:    dev@acme.test")
                .and(predicate::str::contains("Organization:    acme")),
        );
}

#[test]
fn whoami_not_logged_in_with_no_credentials() {
    let home = TempDir::new().unwrap();
    auth_cmd(&home)
        .args(["auth", "whoami"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Not logged in."));
}

#[test]
fn status_is_offline_and_reports_source() {
    // No creds → "Not logged in." with no network at all (no stub running).
    let home = TempDir::new().unwrap();
    auth_cmd(&home)
        .args(["auth", "status"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Not logged in."));
}
