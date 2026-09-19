//! Integration tests for `GitHandle`.
//!
//! Proves `configure_user` / `set_config` / `get_config` reach guest git
//! config — the same write-via-API, observe-via-exec split as
//! `exec_options.rs`. One box is reused because creating a VM dominates
//! the test cost.
//!
//! Each check asserts a project-symbol path:
//!   - ConfigureUser: `GitHandle::configure_user` -> `git config --global`
//!   - GetConfig:     `GitHandle::get_config` -> `git config --get`
//!   - SetConfig local: `GitHandle::set_config(local, path)` -> `working_dir`
//!     -> `git config --local`
//!   - Missing path:  `GitHandle::set_config(local)` -> InvalidArgument
//!     (no guest exec)

mod common;

use boxlite::BoxCommand;
use tokio_stream::StreamExt;

async fn run_stdout(handle: &boxlite::LiteBox, cmd: BoxCommand) -> String {
    let mut execution = handle.exec(cmd).await.expect("exec failed");

    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }

    let result = execution.wait().await.expect("wait failed");
    assert_eq!(
        result.exit_code, 0,
        "command should exit 0; stdout={stdout}"
    );
    stdout
}

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

async fn install_git(handle: &boxlite::LiteBox) {
    let mut execution = handle
        .exec(BoxCommand::new("apk").args(["add", "--no-cache", "git"]))
        .await
        .expect("apk add git failed to spawn");

    let mut stderr = String::new();
    if let Some(mut stream) = execution.stderr() {
        while let Some(chunk) = stream.next().await {
            stderr.push_str(&chunk);
        }
    }

    let result = execution.wait().await.expect("apk add git wait failed");
    assert_eq!(
        result.exit_code, 0,
        "apk add git failed (exit {}); stderr={stderr}",
        result.exit_code
    );
}

#[tokio::test]
async fn git_config_reaches_guest() {
    let tb = TestBox::new().await;
    install_git(&tb.handle).await;
    let git = tb.handle.git();

    git.configure_user("BoxLite Bot", "bot@boxlite.ai", None, None)
        .await
        .expect("configure_user");
    let email = run_stdout(
        &tb.handle,
        BoxCommand::new("git").args(["config", "--global", "--get", "user.email"]),
    )
    .await;
    assert_eq!(
        email.trim(),
        "bot@boxlite.ai",
        "user.email did not reach guest"
    );
    let name = run_stdout(
        &tb.handle,
        BoxCommand::new("git").args(["config", "--global", "--get", "user.name"]),
    )
    .await;
    assert_eq!(name.trim(), "BoxLite Bot", "user.name did not reach guest");

    let log = run_stdout(
        &tb.handle,
        BoxCommand::new("sh").args([
            "-c",
            "set -e\n\
             git init /tmp/repo\n\
             echo hi > /tmp/repo/README\n\
             git -C /tmp/repo add README\n\
             git -C /tmp/repo -c commit.gpgsign=false commit -m init\n\
             git -C /tmp/repo log -1 --format='%an <%ae>'",
        ]),
    )
    .await;
    assert!(
        log.contains("BoxLite Bot <bot@boxlite.ai>"),
        "commit did not record configured author: {log:?}"
    );

    run_stdout(
        &tb.handle,
        BoxCommand::new("git").args(["config", "--global", "user.email", "other@boxlite.ai"]),
    )
    .await;
    let email = git
        .get_config("user.email", None, None)
        .await
        .expect("get_config");
    assert_eq!(
        email, "other@boxlite.ai",
        "get_config did not read guest config"
    );
    git.configure_user("BoxLite Bot", "bot@boxlite.ai", None, None)
        .await
        .expect("restore configure_user");

    let err = git
        .set_config("user.email", "local@boxlite.ai", Some("local"), None)
        .await
        .expect_err("local without path must fail");
    assert!(
        matches!(err, boxlite::BoxliteError::InvalidArgument(ref msg) if msg.contains("path")),
        "local without path must name path, got {err}"
    );

    run_stdout(
        &tb.handle,
        BoxCommand::new("git").args(["init", "/tmp/repo"]),
    )
    .await;
    git.set_config(
        "user.email",
        "local@boxlite.ai",
        Some("local"),
        Some("/tmp/repo"),
    )
    .await
    .expect("set_config local");
    let local_email = run_stdout(
        &tb.handle,
        BoxCommand::new("git").args([
            "-C",
            "/tmp/repo",
            "config",
            "--local",
            "--get",
            "user.email",
        ]),
    )
    .await;
    assert_eq!(
        local_email.trim(),
        "local@boxlite.ai",
        "local user.email did not reach guest"
    );
    let global_email = run_stdout(
        &tb.handle,
        BoxCommand::new("git").args(["config", "--global", "--get", "user.email"]),
    )
    .await;
    assert_eq!(
        global_email.trim(),
        "bot@boxlite.ai",
        "global user.email changed"
    );

    tb.teardown().await;
}
