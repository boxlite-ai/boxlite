//! A read-only attach must have no way to write to the session — not by
//! convention, but because there is no sender to call.

mod common;

use boxlite::{AttachOptions, BoxOptions, RootfsSpec};

/// A box whose init prints once and then stays alive, so the attach has
/// something to follow and the box does not exit mid-test.
fn long_running_opts() -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_delete: Some(0),
        cmd: Some(vec!["sh".into(), "-c".into(), "echo up; sleep 30".into()]),
        ..Default::default()
    }
}

/// Attach to a fresh box with `options` and report whether the resulting
/// `Execution` handed back a stdin sender.
///
/// Each call gets its own box: the guest allows one output consumer per
/// session, so a control and its subject cannot share one.
async fn stdin_is_available(options: AttachOptions) -> bool {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime
        .create(long_running_opts(), None)
        .await
        .expect("create box");
    let mut execution = handle.attach(options).await.expect("attach");
    handle.start().await.expect("start box");

    let available = execution.stdin().is_some();

    let _ = handle.stop().await;
    let _ = runtime.remove(handle.id().as_str(), true).await;
    available
}

#[tokio::test]
async fn read_only_attach_hands_back_no_stdin() {
    assert!(
        !stdin_is_available(AttachOptions::main().read_only()).await,
        "read_only() must leave the Execution with no stdin sender"
    );
}

#[tokio::test]
async fn default_attach_hands_back_stdin() {
    assert!(
        stdin_is_available(AttachOptions::main()).await,
        "the default attach must still wire stdin — this is the control for \
         read_only_attach_hands_back_no_stdin, without which that assertion \
         would also hold if attach were simply broken"
    );
}
