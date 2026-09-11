//! End-to-end for `boxlite run --url` — the REST data plane, over the wire.
//!
//! The other run-semantics tests drive the local runtime directly. This one
//! goes through the whole REST path a cloud user hits: the CLI builds a REST
//! runtime, `run` creates the box with `POST /v1/boxes` and attaches to its main
//! command with `GET /v1/boxes/{id}/attach`, and `boxlite serve` on the far end
//! runs it on a real local runtime and streams it back.
//!
//! It is the round-trip that unit tests can only approximate: the serve tests
//! prove the route is registered and the client method is wired; only this
//! proves a command's output and exit code actually make it back across the
//! socket. That path's *breakage* — `run --url` starting the box server-side and
//! attaching too late to see a fast command — was a release blocker; without an
//! e2e it is guarded by nothing that exercises the wire.

mod common;

use common::serve::ServeChild;
use std::process::Command;

/// `run --url IMAGE COMMAND` must stream the main command's output back and exit
/// with its code — even for a command that finishes immediately.
///
/// The command prints a line and exits non-zero in one breath. If the client
/// attached only *after* the box started (the bug the create → attach → start
/// ordering removes), a fast command could be gone before the attach landed:
/// stdout empty, and the exit code synthesized rather than real. So both halves
/// are load-bearing — the marker proves the stream connected in time, the code
/// proves it propagated across the wire.
#[test]
fn run_over_rest_streams_output_and_propagates_exit_code() {
    let serve = ServeChild::start();
    let client_home = boxlite_test_utils::home::PerTestBoxHome::new();

    let out = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&client_home.path)
        .arg("--url")
        .arg(serve.url())
        .args([
            "run",
            "--rm",
            "alpine:latest",
            "sh",
            "-c",
            "echo hello-over-rest; exit 7",
        ])
        .output()
        .expect("run --url");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stdout.contains("hello-over-rest"),
        "the main command's stdout must round-trip over REST — stdout={stdout:?} stderr={stderr:?}"
    );
    assert_eq!(
        out.status.code(),
        Some(7),
        "the main command's exit code must propagate over REST — stderr={stderr:?}"
    );

    // `--rm` removes the box a beat after the command exits; wait for that before
    // the server is torn down.
    serve.wait_until_no_boxes();
}
