//! Integration tests for container environment delivery.
//!
//! These tests verify end-to-end behavior:
//! 1) User-provided OCI env values are visible inside the box.
//! 2) Large env payloads are delivered via config-file/gRPC path without
//!    breaking guest startup.

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite::{BoxCommand, BoxliteRuntime};
use futures::StreamExt;
use tempfile::TempDir;

struct TestContext {
    runtime: BoxliteRuntime,
    _temp_dir: TempDir,
}

impl TestContext {
    fn new() -> Self {
        // Keep paths short on macOS to avoid UNIX socket length limits.
        let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
        let options = BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
        Self {
            runtime,
            _temp_dir: temp_dir,
        }
    }
}

async fn run_and_capture_stdout(
    handle: &boxlite::LiteBox,
    cmd: BoxCommand,
) -> (String, boxlite::ExecResult) {
    let mut exec = handle.exec(cmd).await.expect("exec failed");
    let mut stdout = exec.stdout().expect("stdout stream not available");
    let mut output = String::new();
    while let Some(chunk) = stdout.next().await {
        output.push_str(&chunk);
    }
    let result = exec.wait().await.expect("wait failed");
    (output, result)
}

#[tokio::test]
async fn env_is_visible_inside_box() {
    let ctx = TestContext::new();

    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                env: vec![("E2E_ENV_VISIBLE".to_string(), "visible-value".to_string())],
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .expect("Failed to create box");

    let (stdout, result) = run_and_capture_stdout(
        &handle,
        BoxCommand::new("sh").args(["-lc", "printf '%s' \"$E2E_ENV_VISIBLE\""]),
    )
    .await;

    assert!(result.success(), "command failed: {:?}", result);
    assert_eq!(stdout, "visible-value");

    handle.stop().await.expect("stop failed");
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .expect("remove failed");
}

#[tokio::test]
async fn large_env_payload_is_delivered_inside_box() {
    let ctx = TestContext::new();

    let mut env = Vec::new();
    for i in 0..300usize {
        let key = format!("E2E_LARGE_ENV_{i:04}");
        let value = format!("VAL_{i:04}_{}", "x".repeat(220));
        env.push((key, value));
    }
    env.push((
        "E2E_LARGE_ENV_SENTINEL".to_string(),
        "sentinel-ok".to_string(),
    ));

    let expected_tail = env
        .iter()
        .find(|(k, _)| k == "E2E_LARGE_ENV_0299")
        .map(|(_, v)| v.clone())
        .expect("missing tail env");

    let handle = ctx
        .runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                env,
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .expect("Failed to create box");

    let (stdout, result) = run_and_capture_stdout(
        &handle,
        BoxCommand::new("sh").args([
            "-lc",
            "printf '%s|%s' \"$E2E_LARGE_ENV_SENTINEL\" \"$E2E_LARGE_ENV_0299\"",
        ]),
    )
    .await;

    assert!(result.success(), "command failed: {:?}", result);
    assert_eq!(stdout, format!("sentinel-ok|{expected_tail}"));

    handle.stop().await.expect("stop failed");
    ctx.runtime
        .remove(handle.id().as_str(), false)
        .await
        .expect("remove failed");
}
