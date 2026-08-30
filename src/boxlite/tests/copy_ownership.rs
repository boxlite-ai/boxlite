//! Integration test for `copy_in` file ownership.
//!
//! A box whose exec user is not root must still be able to read what was
//! copied into it. Tar carries no notion of the destination's user and the
//! guest agent extracts as root, so without an explicit hand-off every
//! copied file lands `root:root` and the workload gets EACCES.
//!
//! Run with:
//!
//! ```sh
//! cargo test -p boxlite --test copy_ownership -- --nocapture
//! ```

mod common;

use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use boxlite::{BoxCommand, CopyOptions};
use tempfile::TempDir;
use tokio_stream::StreamExt;

/// The uid:gid the box runs as. Bare-numeric needs no passwd entry, so this
/// works on a stock alpine image without building one.
const BOX_UID: u32 = 1000;
const BOX_GID: u32 = 1000;

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

#[tokio::test(flavor = "multi_thread")]
async fn copy_in_hands_files_to_the_box_user() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let opts = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_delete: Some(0),
        user: Some(format!("{BOX_UID}:{BOX_GID}")),
        ..Default::default()
    };
    let bx = runtime.create(opts, None).await.expect("create box");
    bx.start().await.expect("start box");

    // Sanity: the box really is running as a non-root user, otherwise the rest
    // of this test proves nothing — root can read a root-owned 0600 file.
    let whoami = exec_stdout(&bx, BoxCommand::new("id").args(["-u"])).await;
    assert_eq!(
        whoami.trim(),
        BOX_UID.to_string(),
        "box should exec as uid {BOX_UID}"
    );

    let tmp = TempDir::new_in("/tmp").unwrap();
    let src = tmp.path().join("payload.txt");
    std::fs::write(&src, "PAYLOAD-OWNED\n").unwrap();
    // 0600 on the host: only the owner can read it, so ownership is the only
    // thing that can make this readable inside the box.
    let mut perms = std::fs::metadata(&src).unwrap().permissions();
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o600);
    }
    std::fs::set_permissions(&src, perms).unwrap();

    // `/srv` exists in alpine and carries no mount, so mkdir_parents has to
    // create `/srv/probe` — which is the parent-directory half of the bug.
    bx.copy_into(&src, "/srv/probe/payload.txt", CopyOptions::default())
        .await
        .expect("copy_into failed");

    let file_owner = exec_stdout(
        &bx,
        BoxCommand::new("stat").args(["-c", "%u:%g", "/srv/probe/payload.txt"]),
    )
    .await;
    assert_eq!(
        file_owner.trim(),
        format!("{BOX_UID}:{BOX_GID}"),
        "copied file must belong to the box user"
    );

    let dir_owner = exec_stdout(
        &bx,
        BoxCommand::new("stat").args(["-c", "%u:%g", "/srv/probe"]),
    )
    .await;
    assert_eq!(
        dir_owner.trim(),
        format!("{BOX_UID}:{BOX_GID}"),
        "directories created for the copy must belong to the box user too"
    );

    // The point of all of the above: the workload can actually open it.
    let content = exec_stdout(&bx, BoxCommand::new("cat").args(["/srv/probe/payload.txt"])).await;
    assert_eq!(
        content, "PAYLOAD-OWNED\n",
        "box user must be able to read it"
    );

    // A destination directory the image already shipped is NOT ours to hand
    // over. `/usr/local/bin` exists in alpine and is root-owned; copying into
    // it must give away the file, never the directory.
    let before = exec_stdout(
        &bx,
        BoxCommand::new("stat").args(["-c", "%u:%g", "/usr/local/bin"]),
    )
    .await;
    assert_eq!(
        before.trim(),
        "0:0",
        "precondition: image dir is root-owned"
    );

    // Trailing slash: the destination *is* the existing directory, which is the
    // shape that would hand it away.
    bx.copy_into(&src, "/usr/local/bin/", CopyOptions::default())
        .await
        .expect("copy_into an existing image dir failed");

    let after = exec_stdout(
        &bx,
        BoxCommand::new("stat").args(["-c", "%u:%g", "/usr/local/bin"]),
    )
    .await;
    assert_eq!(
        after.trim(),
        "0:0",
        "a pre-existing image directory must keep its owner"
    );

    let copied = exec_stdout(
        &bx,
        BoxCommand::new("stat").args(["-c", "%u:%g", "/usr/local/bin/payload.txt"]),
    )
    .await;
    assert_eq!(
        copied.trim(),
        format!("{BOX_UID}:{BOX_GID}"),
        "the copied file itself still goes to the box user"
    );

    let _ = bx.stop().await;
    let _ = runtime.remove(bx.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// The streaming (hinted) copy-in arm must hand created files to the box
/// user exactly like the staged arm does — the extraction recording is the
/// list that decides what changes owner.
#[tokio::test(flavor = "multi_thread")]
async fn streaming_copy_in_hands_files_to_the_box_user() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let opts = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_delete: Some(0),
        user: Some(format!("{BOX_UID}:{BOX_GID}")),
        ..Default::default()
    };
    let bx = runtime.create(opts, None).await.expect("create box");
    bx.start().await.expect("start box");

    let tmp = TempDir::new_in("/tmp").unwrap();
    let src = tmp.path().join("stream-payload.txt");
    std::fs::write(&src, "PAYLOAD-STREAM-OWNED\n").unwrap();
    let mut perms = std::fs::metadata(&src).unwrap().permissions();
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o600);
    }
    std::fs::set_permissions(&src, perms).unwrap();

    let (source_is_dir, tar) = boxlite_shared::tar::pack_stream(
        src.clone(),
        boxlite_shared::tar::PackContext {
            follow_symlinks: false,
            include_parent: false,
        },
    )
    .await
    .expect("pack_stream");
    assert!(!source_is_dir);

    bx.copy_in_tar_stream(
        tar,
        "/srv/probe/stream-payload.txt",
        Some(source_is_dir),
        CopyOptions::default(),
    )
    .await
    .expect("streaming copy_in failed");

    let file_owner = exec_stdout(
        &bx,
        BoxCommand::new("stat").args(["-c", "%u:%g", "/srv/probe/stream-payload.txt"]),
    )
    .await;
    assert_eq!(
        file_owner.trim(),
        format!("{BOX_UID}:{BOX_GID}"),
        "streamed file must belong to the box user"
    );

    // mkdir_parents conjured /srv/probe — the staged arm hands it over, and
    // the streamed arm must match, or the workload cannot replace its file.
    let dir_owner = exec_stdout(
        &bx,
        BoxCommand::new("stat").args(["-c", "%u:%g", "/srv/probe"]),
    )
    .await;
    assert_eq!(
        dir_owner.trim(),
        format!("{BOX_UID}:{BOX_GID}"),
        "directories created for the streamed copy must belong to the box user too"
    );

    let content = exec_stdout(
        &bx,
        BoxCommand::new("cat").args(["/srv/probe/stream-payload.txt"]),
    )
    .await;
    assert_eq!(
        content, "PAYLOAD-STREAM-OWNED\n",
        "box user must be able to read it"
    );

    let _ = bx.stop().await;
    let _ = runtime.remove(bx.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
