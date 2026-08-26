//! `?stdin=0` is enforced by the server, not by the client's good manners.
//!
//! The client here is deliberately hostile: it sends the frames a read-only
//! attach is supposed to be incapable of sending. Each assertion is paired
//! with a `?stdin=1` control, because "no echo came back" is equally
//! consistent with the attach never having worked at all.

mod common;

use common::serve::ServeChild;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

/// Create a box whose init echoes whatever arrives on stdin, and start it.
/// Returns its id.
fn create_echo_box(serve: &ServeChild) -> String {
    let out = serve.client(&[
        "create",
        "alpine:latest",
        "sh",
        "-c",
        "while read line; do echo \"ECHO:$line\"; done",
    ]);
    assert!(
        out.status.success(),
        "create failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();

    let started = serve.client(&["start", &id]);
    assert!(
        started.status.success(),
        "start failed: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    id
}

/// Remove the box and wait for the server to report none left.
///
/// Called before the assertions, not after: `PerTestBoxHome` refuses to drop
/// with a live shim, so a failing assertion would otherwise replace the real
/// failure with a teardown panic.
fn remove_box(serve: &ServeChild, box_id: &str) {
    let removed = serve.client(&["rm", "--force", box_id]);
    assert!(
        removed.status.success(),
        "rm failed: {}",
        String::from_utf8_lossy(&removed.stderr)
    );
    serve.wait_until_no_boxes();
}

/// Attach over a raw WebSocket, send one stdin Binary frame, and collect
/// everything the server sends back for a bounded window.
///
/// Returns (text control frames, stdout text, close code).
async fn attach_and_write(
    port: u16,
    box_id: &str,
    stdin_query: &str,
) -> (Vec<String>, String, Option<u16>) {
    let url = format!("ws://127.0.0.1:{port}/v1/boxes/{box_id}/attach?stdin={stdin_query}");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("attach upgrade");

    ws.send(Message::Binary(b"hello\n".to_vec()))
        .await
        .expect("send stdin frame");

    let mut controls = Vec::new();
    let mut stdout = String::new();
    let mut close_code = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => controls.push(text.to_string()),
            Ok(Some(Ok(Message::Binary(bytes)))) => {
                if bytes.first() == Some(&0x01u8) {
                    stdout.push_str(&String::from_utf8_lossy(&bytes[1..]));
                }
            }
            Ok(Some(Ok(Message::Close(frame)))) => {
                close_code = frame.map(|f| u16::from(f.code));
                break;
            }
            Ok(None) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => break,
            Err(_) => {
                if !stdout.is_empty() || !controls.is_empty() {
                    break;
                }
            }
        }
    }
    (controls, stdout, close_code)
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_attach_refuses_stdin_and_the_bytes_never_land() {
    let serve = ServeChild::start();
    let box_id = create_echo_box(&serve);

    let (controls, stdout, close_code) = attach_and_write(serve.port(), &box_id, "0").await;
    remove_box(&serve, &box_id);

    assert!(
        controls.iter().any(|c| c.contains("read_only_attach")),
        "expected a read_only_attach rejection control frame, got {controls:?}"
    );
    assert!(
        !stdout.contains("ECHO:hello"),
        "read-only attach let stdin reach the process: {stdout:?}"
    );
    assert_eq!(
        close_code,
        Some(1008),
        "a stdin write on a read-only socket must close it with a policy violation"
    );
}

/// Attach read-only and send every control frame that writes into the
/// workload. Returns the control frames the server sent back.
async fn attach_and_send_controls(port: u16, box_id: &str) -> Vec<String> {
    let url = format!("ws://127.0.0.1:{port}/v1/boxes/{box_id}/attach?stdin=0");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("attach upgrade");

    for frame in [
        r#"{"type":"signal","sig":15}"#,
        r#"{"type":"resize","rows":10,"cols":40}"#,
        r#"{"type":"stdin_eof"}"#,
    ] {
        ws.send(Message::Text(frame.to_string()))
            .await
            .expect("send control frame");
    }

    let mut controls = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while controls.len() < 3 && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => controls.push(text.to_string()),
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => break,
        }
    }
    let _ = ws.close(None).await;
    controls
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_attach_refuses_signal_resize_and_stdin_eof() {
    let serve = ServeChild::start();
    let box_id = create_echo_box(&serve);

    let controls = attach_and_send_controls(serve.port(), &box_id).await;

    // A later writable attach that still echoes proves two things the rejection
    // frames alone cannot: the SIGTERM never reached init, and stdin_eof never
    // closed the workload's stdin.
    let (_c, stdout, _close) = attach_and_write(serve.port(), &box_id, "1").await;
    remove_box(&serve, &box_id);

    assert_eq!(
        controls
            .iter()
            .filter(|c| c.contains("read_only_attach"))
            .count(),
        3,
        "signal, resize and stdin_eof must all be refused, got {controls:?}"
    );
    assert!(
        stdout.contains("ECHO:hello"),
        "the box must still read stdin after a refused SIGTERM and stdin_eof, got {stdout:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unrecognized_stdin_value_is_refused_rather_than_opened_writable() {
    let serve = ServeChild::start();
    let box_id = create_echo_box(&serve);

    let url = format!(
        "ws://127.0.0.1:{}/v1/boxes/{}/attach?stdin=False",
        serve.port(),
        box_id
    );
    let outcome = tokio_tungstenite::connect_async(&url).await;
    remove_box(&serve, &box_id);

    // Failing open here would hand a writable socket to a client that asked,
    // in a typo, for a read-only one.
    match outcome {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(
                response.status(),
                400,
                "expected a 400 for an out-of-enum stdin value"
            );
        }
        Err(other) => panic!("expected an HTTP 400, got transport error: {other}"),
        Ok(_) => panic!("an out-of-enum stdin value must not upgrade to a writable socket"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_writable_attach_still_delivers_stdin() {
    let serve = ServeChild::start();
    let box_id = create_echo_box(&serve);

    let (_controls, stdout, _close_code) = attach_and_write(serve.port(), &box_id, "1").await;
    remove_box(&serve, &box_id);

    assert!(
        stdout.contains("ECHO:hello"),
        "the control case must echo; without it, the read-only assertion \
         would also hold if attach were simply broken. got {stdout:?}"
    );
}
