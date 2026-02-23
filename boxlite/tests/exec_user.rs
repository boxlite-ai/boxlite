//! Integration tests for per-exec user override.
//!
//! Verifies that `BoxCommand::user()` correctly overrides the execution user
//! inside the VM guest.

mod common;

use boxlite::BoxCommand;
use tokio_stream::StreamExt;

/// Helper: exec a command, collect stdout, assert exit code 0.
async fn exec_stdout(handle: &boxlite::LiteBox, cmd: BoxCommand) -> String {
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
    ctx: common::ParallelRuntime,
}

impl TestBox {
    async fn new() -> Self {
        let ctx = common::ParallelRuntime::new();
        let handle = ctx
            .runtime
            .create(common::alpine_opts(), None)
            .await
            .unwrap();
        handle.start().await.unwrap();
        Self { handle, ctx }
    }

    async fn teardown(self) {
        self.handle.stop().await.unwrap();
        let _ = self
            .ctx
            .runtime
            .remove(self.handle.id().as_str(), true)
            .await;
        self.ctx.shutdown().await;
    }
}

/// Default user in alpine is root (uid 0).
#[tokio::test]
async fn test_exec_default_user_is_root() {
    let tb = TestBox::new().await;
    let stdout = exec_stdout(&tb.handle, BoxCommand::new("id").arg("-u")).await;
    assert_eq!(stdout.trim(), "0", "default user should be root (uid 0)");
    tb.teardown().await;
}

/// Table-driven test for user override variants.
#[tokio::test]
async fn test_exec_user_overrides() {
    let tb = TestBox::new().await;

    // (description, command, expected substring in stdout)
    let cases: Vec<(&str, BoxCommand, &str)> = vec![
        (
            "numeric uid:gid",
            BoxCommand::new("id").arg("-u").user("65534:65534"),
            "65534",
        ),
        (
            "user by name",
            BoxCommand::new("id").arg("-un").user("nobody"),
            "nobody",
        ),
        (
            "uid:gid both set",
            BoxCommand::new("sh")
                .args(["-c", "echo uid=$(id -u) gid=$(id -g)"])
                .user("1000:2000"),
            "uid=1000",
        ),
    ];

    for (desc, cmd, expected) in cases {
        let stdout = exec_stdout(&tb.handle, cmd).await;
        assert!(
            stdout.contains(expected),
            "{desc}: expected stdout to contain {expected:?}, got: {stdout:?}"
        );
    }

    // Extra assertion for uid:gid case — verify gid separately
    let stdout = exec_stdout(
        &tb.handle,
        BoxCommand::new("sh")
            .args(["-c", "echo gid=$(id -g)"])
            .user("1000:2000"),
    )
    .await;
    assert!(
        stdout.contains("gid=2000"),
        "stdout should contain gid=2000, got: {stdout:?}"
    );

    tb.teardown().await;
}
