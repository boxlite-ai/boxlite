//! `resize_tty` must reach the guest PTY, not merely return success.
//!
//! kill/signal already have host coverage in the Node and Python SDK suites,
//! and `zygote_integration` covers stdin. Resize is the gap: every existing
//! test asserts only that the call returned, so a resize that never reaches
//! the terminal would pass all of them.

mod common;

use std::time::Duration;

use boxlite::BoxCommand;
use tokio_stream::StreamExt;

/// `resize_tty` changes the window the process actually sees.
#[tokio::test]
async fn resize_tty_changes_the_window_the_process_sees() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    handle.start().await.unwrap();

    // The shell announces it is ready, then blocks on stdin. That handshake is
    // what orders the resize before `stty` runs — a sleep would race exec setup
    // on a cold pull or a loaded machine.
    let mut execution = handle
        .exec(
            BoxCommand::new("sh")
                .args(["-c", "echo ready; read _ack; stty size"])
                .tty(true),
        )
        .await
        .expect("exec failed");

    let mut stream = execution.stdout().expect("stdout should be available once");
    let mut stdout = String::new();
    while !stdout.contains("ready") {
        let chunk = tokio::time::timeout(Duration::from_secs(30), stream.next())
            .await
            .expect("shell should announce readiness")
            .expect("stdout closed before the shell was ready");
        stdout.push_str(&chunk);
    }

    execution.resize_tty(40, 100).await.expect("resize failed");

    let mut stdin = execution.stdin().expect("stdin should be available once");
    stdin.write_all(b"\n").await.expect("stdin write failed");
    stdin.close();

    while let Some(chunk) = stream.next().await {
        stdout.push_str(&chunk);
    }
    let _ = tokio::time::timeout(Duration::from_secs(30), execution.wait()).await;

    assert!(
        stdout.contains("40 100"),
        "resize did not reach the guest pty, stty reported: {stdout:?}"
    );

    handle.stop().await.unwrap();
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
