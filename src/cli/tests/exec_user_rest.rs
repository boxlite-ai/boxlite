//! Per-exec `user` over a real `boxlite serve` and its guest (#2116).
//!
//! The REST client, serve handler, and guest must carry `BoxCommand::user`
//! end to end; an unknown user must surface as `InvalidArgument`.

mod common;

use std::process::{Command, Stdio};

use boxlite::{
    BoxCommand, BoxOptions, BoxliteError, BoxliteRestOptions, BoxliteRuntime, LiteBox, RootfsSpec,
};
use common::serve::ServeChild;
use futures::StreamExt;

/// Remove the box even when an assertion panics. Declared after `ServeChild`,
/// so it drops first and the server is still available to service the removal.
struct BoxCleanup {
    url: String,
    box_ids: Vec<String>,
}

impl Drop for BoxCleanup {
    fn drop(&mut self) {
        for box_id in self.box_ids.drain(..) {
            let _ = Command::new(env!("CARGO_BIN_EXE_boxlite"))
                .args(["--url", &self.url, "rm", "--force", &box_id])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

async fn ids(sandbox: &LiteBox, user: Option<&str>) -> Result<String, BoxliteError> {
    let mut cmd = BoxCommand::new("sh").args(["-c", "echo $(id -u):$(id -g)"]);
    if let Some(user) = user {
        cmd = cmd.user(user);
    }
    let mut execution = sandbox.exec(cmd).await?;
    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }
    let result = execution.wait().await.expect("wait failed");
    assert_eq!(result.exit_code, 0, "command should exit 0");
    Ok(stdout.trim().to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_user_over_serve() {
    let serve = ServeChild::start();
    let mut cleanup = BoxCleanup {
        url: serve.url(),
        box_ids: Vec::new(),
    };

    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(serve.url())).expect("rest runtime");
    let sandbox = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("create box over REST");
    cleanup.box_ids.push(sandbox.id().to_string());

    assert_eq!(ids(&sandbox, Some("1000:1000")).await.unwrap(), "1000:1000");
    assert_eq!(ids(&sandbox, None).await.unwrap(), "0:0");
    let err = ids(&sandbox, Some("nosuchuser")).await.unwrap_err();
    assert!(
        matches!(err, BoxliteError::InvalidArgument(_)),
        "got: {err:?}"
    );
}
