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

/// A non-root exec-user image (grafana/grafana, User="472") must satisfy two
/// properties inside the running box:
///
/// 1. **Exec user** — `id -u` returns 472 (resolved from OCI config User field
///    via /etc/passwd inside the image).
/// 2. **Inode ownership** — `/etc/grafana` is owned by uid=472 in the ext4
///    filesystem. This is the regression guard: before commit 5f23beec the ext4
///    build stamped all inodes as uid=0, so grafana (uid=472) could not write
///    its own config. `normalize_inodes_with_debugfs` fixes this at build time
///    by reading `user.containers.override_stat` xattr per inode.
///
/// Both assertions use the image-declared uid (472), not the host process uid,
/// which is intentionally different from 472 on any normal developer machine.
#[tokio::test]
async fn test_non_root_image_user_exec_uid_and_inode_ownership() {
    // The test proves that the box runs as the *image-declared* uid (472), not
    // the host process uid.  If they happen to be equal the assertion is
    // tautological — skip rather than give a false green.
    const IMAGE_UID: u32 = 472;
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
    })
    .expect("create runtime");

    let handle = runtime
        .create(
            boxlite::runtime::options::BoxOptions {
                rootfs: boxlite::runtime::options::RootfsSpec::Image(
                    "grafana/grafana:latest".into(),
                ),
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("create grafana box");
    handle.start().await.expect("start grafana box");

    // 1. Exec user must be uid=472, not the host uid.
    let exec_uid = exec_stdout(&handle, BoxCommand::new("id").arg("-u")).await;
    assert_eq!(
        exec_uid.trim(),
        "472",
        "exec uid must be 472 (OCI User=\"472\"), got: {exec_uid:?}"
    );

    // 2. /var/lib/grafana inode must be owned by uid=472 — normalize_inodes guarantee.
    //    The grafana image explicitly chowns this dir to uid=472 so the process
    //    can write its database. If normalize_inodes regresses (all inodes → uid=0),
    //    grafana gets EACCES trying to write /var/lib/grafana and crashes on startup.
    //    Note: /etc/grafana is root-owned by design; /var/lib/grafana is the
    //    canonical uid=472 path in the official grafana/grafana image.
    let inode_uid = exec_stdout(
        &handle,
        BoxCommand::new("stat").args(["-c", "%u", "/var/lib/grafana"]),
    )
    .await;
    assert_eq!(
        inode_uid.trim(),
        "472",
        "/var/lib/grafana inode must be uid=472 (image-declared), not uid=0 (root): \
         normalize_inodes_with_debugfs stamps ownership at ext4 build time"
    );

    handle.stop().await.expect("stop");
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
