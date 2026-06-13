//! Integration tests for POL-30 / POL-31: `info` and `logs` must honor
//! `--profile` / `BOXLITE_PROFILE` instead of silently falling back to
//! the local runtime. Each test stands up a tiny HTTP stub on an
//! ephemeral port, writes a `credentials.toml` pointing at it, and runs
//! the CLI through `assert_cmd`.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

/// Minimal HTTP/1.1 stub. `handler(method, path) -> (status, json)`.
/// One request per connection (`Connection: close`); a daemon thread
/// serves sequential connections for the test's lifetime.
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
                    401 => "Unauthorized",
                    404 => "Not Found",
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

/// `boxlite …` with a hermetic env: BOXLITE_HOME points at `home`,
/// inherited BOXLITE_API_KEY / BOXLITE_REST_URL are scrubbed so they
/// can't leak in and decide the routing.
fn cli(home: &TempDir) -> Command {
    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    cmd.env("BOXLITE_HOME", home.path())
        .env_remove("BOXLITE_API_KEY")
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_PROFILE")
        .timeout(Duration::from_secs(30));
    cmd
}

/// Write a `credentials.toml` containing a profile named `p1` whose
/// URL points at `stub_url`. Returns the path for assertions.
fn write_p1_creds(home: &TempDir, stub_url: &str) -> std::path::PathBuf {
    let path = home.path().join("credentials.toml");
    let body = format!(
        "[profiles.p1]\nurl = \"{stub_url}\"\napi_key = \"k_test\"\nauth_method = \"api_key\"\n"
    );
    std::fs::write(&path, body).unwrap();
    path
}

/// POL-30: `info --profile p1` must call the stub server and surface
/// remote state, not the local runtime. The pre-fix code wired `info`
/// through `create_runtime_with_options(...)` — which is local-only —
/// so the URL never got dialed and the user saw the host's home_dir +
/// local box/image counts even though `--profile` named a REST target.
///
/// Post-fix the URL is honored: the stub receives `GET /v1/boxes` and
/// the rendered output shows the stub URL in place of `homeDir` and
/// `remote` for `virtualization`. We assert on the URL substring (a
/// genuine REST-side signal that wouldn't appear in the pre-fix local
/// output) rather than just absence of `/home/`, so the test would
/// also catch a regression that prints a wrong URL.
#[test]
fn info_with_profile_routes_to_rest() {
    let stub = Stub::start(|_m, path| {
        if path.starts_with("/v1/boxes") {
            (200, r#"{"boxes":[]}"#.to_string())
        } else {
            (
                404,
                r#"{"error":{"message":"nope","type":"NotFoundError"}}"#.to_string(),
            )
        }
    });
    let home = TempDir::new().unwrap();
    write_p1_creds(&home, &stub.url());

    cli(&home)
        .args(["--profile", "p1", "info"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains(stub.url())
                .and(predicate::str::contains("virtualization: remote")),
        );
}

/// POL-31: same bug, env-var entry point. Clap maps `BOXLITE_PROFILE`
/// into `GlobalFlags::profile`, so a regression that re-introduced the
/// local-only call site would surface here too. Separate test so a CI
/// failure tells you which entry point is broken at a glance.
#[test]
fn info_with_boxlite_profile_env_routes_to_rest() {
    let stub = Stub::start(|_m, path| {
        if path.starts_with("/v1/boxes") {
            (200, r#"{"boxes":[]}"#.to_string())
        } else {
            (
                404,
                r#"{"error":{"message":"nope","type":"NotFoundError"}}"#.to_string(),
            )
        }
    });
    let home = TempDir::new().unwrap();
    write_p1_creds(&home, &stub.url());

    cli(&home)
        .env("BOXLITE_PROFILE", "p1")
        .args(["info"])
        .assert()
        .success()
        .stdout(predicate::str::contains(stub.url()));
}

/// With no `--profile`, no `BOXLITE_PROFILE`, and no `default` profile in
/// the (otherwise empty) credentials file, `info` keeps its local
/// behavior — homeDir is the BOXLITE_HOME we set, virtualization runs
/// the local system check. Guards against a fix that over-corrects and
/// breaks the unauthenticated default path.
#[test]
fn info_without_profile_stays_local() {
    let home = TempDir::new().unwrap();
    std::fs::write(home.path().join("credentials.toml"), "").unwrap();

    cli(&home)
        .args(["info"])
        .assert()
        .success()
        .stdout(predicate::str::contains(format!(
            "homeDir: {}",
            home.path().display()
        )));
}

/// POL-30 (logs side): `logs` reads the box's console.log file from the
/// host's BOXLITE_HOME — there is no REST endpoint for log streaming
/// yet. The pre-fix code silently dropped the profile and looked up the
/// box in the *local* runtime, which is either wrong-data or a confusing
/// "No such box" depending on host state. Post-fix we error cleanly so a
/// scripted caller can tell the difference.
#[test]
fn logs_with_profile_errors_clearly_over_rest() {
    let stub = Stub::start(|_m, _path| (200, r#"{"boxes":[]}"#.to_string()));
    let home = TempDir::new().unwrap();
    write_p1_creds(&home, &stub.url());

    cli(&home)
        .args(["--profile", "p1", "logs", "anybox"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("not yet supported over REST"));
}
