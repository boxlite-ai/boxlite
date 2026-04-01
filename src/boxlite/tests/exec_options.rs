//! Integration tests for per-exec working_dir and timeout options.
//!
//! Verifies that `BoxCommand::working_dir()` and `BoxCommand::timeout()`
//! correctly affect command execution inside the VM guest.

mod common;

use std::time::Duration;

use boxlite::BoxCommand;
use tokio_stream::StreamExt;

/// Helper: run a command, collect stdout, assert exit code 0.
async fn run_stdout(handle: &boxlite::LiteBox, cmd: BoxCommand) -> String {
    let mut execution = handle.exec(cmd).await.expect("exec failed");

    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }

    let result = execution.wait().await.expect("wait failed");
    assert_eq!(result.exit_code, 0, "command should exit 0");
    stdout
}

/// RAII wrapper that creates/starts a box and cleans up on drop.
struct TestBox {
    handle: boxlite::LiteBox,
    runtime: boxlite::BoxliteRuntime,
    _home: boxlite_test_utils::home::PerTestBoxHome,
}

impl TestBox {
    async fn new() -> Self {
        let home = boxlite_test_utils::home::PerTestBoxHome::new();
        let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
        })
        .expect("create runtime");
        let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
        handle.start().await.unwrap();
        Self {
            handle,
            runtime,
            _home: home,
        }
    }

    async fn teardown(self) {
        self.handle.stop().await.unwrap();
        let _ = self.runtime.remove(self.handle.id().as_str(), true).await;
        let _ = self
            .runtime
            .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
            .await;
    }
}

/// working_dir changes the current directory for the command.
#[tokio::test]
async fn test_working_dir() {
    let tb = TestBox::new().await;
    let stdout = run_stdout(&tb.handle, BoxCommand::new("pwd").working_dir("/tmp")).await;
    assert_eq!(stdout.trim(), "/tmp", "working_dir should set cwd to /tmp");
    tb.teardown().await;
}

/// timeout kills a long-running command.
#[tokio::test]
async fn test_timeout_kills_long_command() {
    let tb = TestBox::new().await;

    let mut execution = tb
        .handle
        .exec(
            BoxCommand::new("sleep")
                .arg("60")
                .timeout(Duration::from_secs(2)),
        )
        .await
        .expect("exec failed");

    let result = execution.wait().await.expect("wait failed");
    assert_ne!(
        result.exit_code, 0,
        "timed-out command should have non-zero exit code"
    );

    tb.teardown().await;
}

/// Combine working_dir and user in a single command.
#[tokio::test]
async fn test_working_dir_with_user() {
    let tb = TestBox::new().await;

    let stdout = run_stdout(
        &tb.handle,
        BoxCommand::new("sh")
            .args(["-c", "echo dir=$(pwd) user=$(whoami)"])
            .working_dir("/tmp")
            .user("nobody"),
    )
    .await;

    assert!(
        stdout.contains("dir=/tmp"),
        "expected dir=/tmp in stdout, got: {stdout:?}"
    );
    assert!(
        stdout.contains("user=nobody"),
        "expected user=nobody in stdout, got: {stdout:?}"
    );

    tb.teardown().await;
}
