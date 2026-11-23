//! The reference server lands the original archive using the guest's rules.
#![cfg(target_os = "linux")]
mod common;

use boxlite::{BoxOptions, BoxliteRestOptions, BoxliteRuntime, CopyOptions, RootfsSpec};
use common::serve::ServeChild;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serve_copy_uses_guest_landing_and_refusals() {
    let serve = ServeChild::start();
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(serve.url())).unwrap();
    let bx = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    bx.start().await.unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let tree = tmp.path().join("tree");
    std::fs::create_dir(&tree).unwrap();
    std::fs::write(tree.join("payload"), b"through HTTP and the guest").unwrap();

    for (source, destination, landed, name) in [
        (tree.clone(), "/root/missing", "/root/missing", "missing"),
        (tree.clone(), "/root", "/root/tree", "existing"),
        (
            tree.join("."),
            "/root/contents",
            "/root/contents",
            "contents",
        ),
    ] {
        bx.copy_into(source, destination, CopyOptions::default())
            .await
            .unwrap();
        let downloaded = tmp.path().join(name);
        bx.copy_out(landed, &downloaded, CopyOptions::default())
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(downloaded.join("payload")).unwrap(),
            b"through HTTP and the guest"
        );
    }

    bx.copy_into(
        tree.join("payload"),
        "/root/renamed",
        CopyOptions::default(),
    )
    .await
    .unwrap();
    let downloaded = tmp.path().join("renamed");
    bx.copy_out("/root/renamed", &downloaded, CopyOptions::default())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(downloaded).unwrap(),
        b"through HTTP and the guest"
    );

    let missing = bx
        .copy_out(
            "/root/absent",
            tmp.path().join("absent"),
            CopyOptions::default(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(missing, boxlite::BoxliteError::NotFound(_)),
        "{missing:?}"
    );
    let refused = bx
        .copy_into(
            tree.join("payload"),
            "/tmp/shadowed",
            CopyOptions::default(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(refused, boxlite::BoxliteError::Unsupported(_)),
        "{refused:?}"
    );
    runtime.remove(bx.id().as_str(), true).await.unwrap();
    serve.wait_until_no_boxes();
}
