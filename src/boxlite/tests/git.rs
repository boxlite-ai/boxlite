//! Integration tests for `GitHandle`.
//!
//! Proves `status()` / `branches()` read the guest repository: the repo is
//! prepared via exec, then observed through the API. One box is reused
//! because creating a VM dominates the test cost.

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
async fn git_status_and_branches_read_guest() {
    let tb = TestBox::new().await;
    install_git(&tb.handle).await;
    let git = tb.handle.git();

    let err = git.status("").await.expect_err("empty path must fail");
    assert!(
        matches!(err, boxlite::BoxliteError::InvalidArgument(ref msg) if msg.contains("path")),
        "empty path must name path, got {err}"
    );

    run_stdout(
        &tb.handle,
        BoxCommand::new("git").args(["init", "/tmp/repo"]),
    )
    .await;

    // status()/branches() on the unborn repo, with a file name containing a space.
    run_stdout(
        &tb.handle,
        BoxCommand::new("sh").args(["-c", "echo x > '/tmp/repo/with space.txt'"]),
    )
    .await;
    let st = git.status("/tmp/repo").await.expect("status");
    assert!(st.head_commit.is_none(), "fresh repo must be unborn");
    assert_eq!(st.file_status.len(), 1);
    assert_eq!(st.file_status[0].path, "with space.txt");
    assert!(st.file_status[0].is_untracked());
    let branches = git.branches("/tmp/repo").await.expect("branches");
    assert!(
        branches.current.is_some(),
        "unborn branch must still be current"
    );
    assert_eq!(branches.current, st.current_branch);

    tb.teardown().await;
}
