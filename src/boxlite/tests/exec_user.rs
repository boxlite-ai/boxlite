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
    runtime: boxlite::BoxliteRuntime,
    _home: boxlite_test_utils::home::PerTestBoxHome,
}

impl TestBox {
    async fn new() -> Self {
        let home = boxlite_test_utils::home::PerTestBoxHome::new();
        let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
            ..Default::default()
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

/// An unknown user or group is the caller's mistake, not an internal failure,
/// and the command must not run.
#[tokio::test]
async fn test_exec_user_invalid_spec_is_invalid_argument() {
    let tb = TestBox::new().await;

    for spec in ["nosuchuser", "1000:nosuchgroup", ":1000"] {
        let result = tb
            .handle
            .exec(BoxCommand::new("touch").arg("/tmp/marker-2116").user(spec))
            .await;
        assert!(
            matches!(result, Err(boxlite::BoxliteError::InvalidArgument(_))),
            "{spec}: got {:?}",
            result.err()
        );
    }

    let check = tb
        .handle
        .exec(BoxCommand::new("test").args(["-e", "/tmp/marker-2116"]))
        .await
        .expect("exec test");
    let status = check.wait().await.expect("wait failed");
    assert_eq!(status.exit_code, 1, "rejected commands must not run");

    tb.teardown().await;
}

/// A non-root image (`nginxinc/nginx-unprivileged:alpine`, `USER "101"`) must
/// satisfy two properties inside the running box:
///
/// 1. **Exec user** — `id -u` returns 101, taken from the numeric OCI config
///    `User` field.
/// 2. **Inode ownership** — `/var/cache/nginx`, which the image's layer owns as
///    uid 101, keeps that owner in the ext4 filesystem. This is the regression
///    guard for #1177: `mke2fs -d` records the host uid, and
///    `normalize_inodes_with_debugfs` restores each layer-declared owner at
///    build time.
///
/// Both assertions use the image-declared uid (101), not the host process uid,
/// which is different from 101 on developer machines and CI runners.
#[tokio::test]
async fn test_non_root_image_user_exec_uid_and_inode_ownership() {
    // The test proves that the box runs as the *image-declared* uid (101), not
    // the host process uid.  If they happen to be equal the assertion is
    // tautological — skip rather than give a false green.
    const IMAGE_UID: u32 = 101;
    let host_uid = unsafe { libc::getuid() };
    if host_uid == IMAGE_UID {
        eprintln!(
            "skipping: host uid={host_uid} == image uid={IMAGE_UID}; \
             test would be vacuous"
        );
        return;
    }

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("create runtime");

    let handle = runtime
        .create(
            boxlite::runtime::options::BoxOptions {
                rootfs: boxlite::runtime::options::RootfsSpec::Image(
                    "nginxinc/nginx-unprivileged:alpine".into(),
                ),
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("create nginx-unprivileged box");
    handle.start().await.expect("start nginx-unprivileged box");

    // 1. Exec user must be the image-declared uid, not the host uid.
    let exec_uid = exec_stdout(&handle, BoxCommand::new("id").arg("-u")).await;
    assert_eq!(
        exec_uid.trim(),
        IMAGE_UID.to_string(),
        "exec uid must be {IMAGE_UID} (OCI User=\"{IMAGE_UID}\"), got: {exec_uid:?}"
    );

    // 2. /var/cache/nginx must keep the uid its layer declared. nginx writes its
    //    temp files there; if the ext4 build loses per-inode ownership, the
    //    directory carries another uid and nginx cannot write it.
    let inode_uid = exec_stdout(
        &handle,
        BoxCommand::new("stat").args(["-c", "%u", "/var/cache/nginx"]),
    )
    .await;
    assert_eq!(
        inode_uid.trim(),
        IMAGE_UID.to_string(),
        "/var/cache/nginx inode must be uid={IMAGE_UID} (image-declared), got: {inode_uid:?}; \
         normalize_inodes_with_debugfs stamps ownership at ext4 build time"
    );

    handle.stop().await.expect("stop");
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
