//! Integration tests for LiteBox::copy_into / copy_out.
//!
//! All tests share a single VM to avoid 18 separate VM boot cycles.
//! Run with:
//!
//! ```sh
//! cargo test -p boxlite --test copy -- --nocapture
//! ```

mod common;

use boxlite::{BoxCommand, CopyOptions, LiteBox};
use std::path::Path;
use tempfile::TempDir;
use tokio_stream::StreamExt;

// ============================================================================
// HELPERS
// ============================================================================

/// Exec a command inside the box and return stdout (asserts exit code 0).
async fn exec_stdout(bx: &LiteBox, cmd: BoxCommand) -> String {
    let mut execution = bx.exec(cmd).await.expect("exec failed");
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

/// Exec a command and return exit code (don't assert success).
async fn exec_exit_code(bx: &LiteBox, cmd: BoxCommand) -> i32 {
    let mut execution = bx.exec(cmd).await.expect("exec failed");
    if let Some(mut stream) = execution.stdout() {
        while stream.next().await.is_some() {}
    }
    let result = execution.wait().await.expect("wait failed");
    result.exit_code
}

// ============================================================================
// SINGLE TEST ENTRY POINT — one VM, all cases
// ============================================================================

#[tokio::test(flavor = "multi_thread")]
async fn copy_integration() {
    let ctx = common::ParallelRuntime::new();
    let bx = ctx
        .runtime
        .create(common::alpine_opts(), None)
        .await
        .expect("create box");
    bx.start().await.expect("start box");

    let tmp = TempDir::new_in("/tmp").unwrap();

    // Run all sub-tests sequentially on the same box.
    // Each uses a unique container path prefix to avoid interference.
    single_file_roundtrip(&bx, tmp.path()).await;
    directory_roundtrip(&bx, tmp.path()).await;
    nested_directory_roundtrip(&bx, tmp.path()).await;
    empty_file_roundtrip(&bx, tmp.path()).await;
    empty_directory_roundtrip(&bx, tmp.path()).await;
    binary_content_fidelity(&bx, tmp.path()).await;
    filename_with_spaces(&bx, tmp.path()).await;
    overwrite_true_replaces_file(&bx, tmp.path()).await;
    overwrite_false_rejects_copy_in(&bx, tmp.path()).await;
    overwrite_false_rejects_copy_in_dir(&bx, tmp.path()).await;
    overwrite_false_rejects_copy_out(&bx, tmp.path()).await;
    non_recursive_rejects_directory(&bx, tmp.path()).await;
    follow_symlinks_false_preserves_link(&bx, tmp.path()).await;
    follow_symlinks_true_dereferences(&bx, tmp.path()).await;
    include_parent_true_nests_dir(&bx, tmp.path()).await;
    include_parent_false_flattens(&bx, tmp.path()).await;
    copy_in_creates_intermediate_dirs(&bx, tmp.path()).await;
    copy_out_nonexistent_errors(&bx, tmp.path()).await;
    concurrent_copy_roundtrip(&bx, tmp.path()).await;

    ctx.shutdown().await;
}

// ============================================================================
// BASIC ROUND-TRIPS
// ============================================================================

async fn single_file_roundtrip(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] single_file_roundtrip");
    let content = "hello boxlite\n";
    let src = tmp.join("input.txt");
    std::fs::write(&src, content).unwrap();

    bx.copy_into(&src, "/root/input.txt", CopyOptions::default())
        .await
        .expect("copy_into failed");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/input.txt"])).await;
    assert_eq!(out, content);

    let dst = tmp.join("output.txt");
    bx.copy_out("/root/input.txt", &dst, CopyOptions::default())
        .await
        .expect("copy_out failed");
    assert_eq!(std::fs::read_to_string(&dst).unwrap(), content);
}

async fn directory_roundtrip(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] directory_roundtrip");
    let dir_src = tmp.join("mydir");
    std::fs::create_dir(&dir_src).unwrap();
    std::fs::write(dir_src.join("a.txt"), "aaa\n").unwrap();
    std::fs::write(dir_src.join("b.txt"), "bbb\n").unwrap();

    // Default include_parent=true → creates /root/mydir/{a,b}.txt
    bx.copy_into(&dir_src, "/root", CopyOptions::default())
        .await
        .expect("copy_into dir failed");

    let ls = exec_stdout(bx, BoxCommand::new("ls").args(["/root/mydir"])).await;
    assert!(ls.contains("a.txt"));
    assert!(ls.contains("b.txt"));

    let dir_dst = tmp.join("dir-out");
    std::fs::create_dir(&dir_dst).unwrap();
    bx.copy_out("/root/mydir", &dir_dst, CopyOptions::default())
        .await
        .expect("copy_out dir failed");

    assert_eq!(
        std::fs::read_to_string(dir_dst.join("mydir").join("a.txt")).unwrap(),
        "aaa\n"
    );
    assert_eq!(
        std::fs::read_to_string(dir_dst.join("mydir").join("b.txt")).unwrap(),
        "bbb\n"
    );
}

async fn nested_directory_roundtrip(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] nested_directory_roundtrip");
    let dir_src = tmp.join("deep");
    std::fs::create_dir_all(dir_src.join("a").join("b").join("c")).unwrap();
    std::fs::write(
        dir_src.join("a").join("b").join("c").join("file.txt"),
        "deep\n",
    )
    .unwrap();
    std::fs::write(dir_src.join("top.txt"), "top\n").unwrap();

    bx.copy_into(&dir_src, "/root", CopyOptions::default())
        .await
        .expect("copy_into nested failed");

    let out = exec_stdout(
        bx,
        BoxCommand::new("cat").args(["/root/deep/a/b/c/file.txt"]),
    )
    .await;
    assert_eq!(out, "deep\n");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/deep/top.txt"])).await;
    assert_eq!(out, "top\n");

    let dir_dst = tmp.join("deep-out");
    std::fs::create_dir(&dir_dst).unwrap();
    bx.copy_out("/root/deep", &dir_dst, CopyOptions::default())
        .await
        .expect("copy_out nested failed");

    assert_eq!(
        std::fs::read_to_string(
            dir_dst
                .join("deep")
                .join("a")
                .join("b")
                .join("c")
                .join("file.txt")
        )
        .unwrap(),
        "deep\n"
    );
}

async fn empty_file_roundtrip(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] empty_file_roundtrip");
    let src = tmp.join("empty.txt");
    std::fs::write(&src, "").unwrap();

    bx.copy_into(&src, "/root/empty.txt", CopyOptions::default())
        .await
        .expect("copy_into empty failed");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/empty.txt"])).await;
    assert_eq!(out, "");

    let dst = tmp.join("empty-out.txt");
    bx.copy_out("/root/empty.txt", &dst, CopyOptions::default())
        .await
        .expect("copy_out empty failed");
    assert_eq!(std::fs::read(&dst).unwrap().len(), 0);
}

async fn empty_directory_roundtrip(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] empty_directory_roundtrip");
    let dir_src = tmp.join("emptydir");
    std::fs::create_dir(&dir_src).unwrap();

    bx.copy_into(&dir_src, "/root", CopyOptions::default())
        .await
        .expect("copy_into emptydir failed");

    let ls = exec_stdout(bx, BoxCommand::new("ls").args(["/root/emptydir"])).await;
    assert!(ls.trim().is_empty());
}

async fn binary_content_fidelity(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] binary_content_fidelity");
    let data: Vec<u8> = (0..=255).collect();
    let src = tmp.join("binary.bin");
    std::fs::write(&src, &data).unwrap();

    bx.copy_into(&src, "/root/binary.bin", CopyOptions::default())
        .await
        .expect("copy_into binary failed");

    let dst = tmp.join("binary-out.bin");
    bx.copy_out("/root/binary.bin", &dst, CopyOptions::default())
        .await
        .expect("copy_out binary failed");
    assert_eq!(std::fs::read(&dst).unwrap(), data);
}

async fn filename_with_spaces(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] filename_with_spaces");
    let src = tmp.join("my file.txt");
    std::fs::write(&src, "spaces\n").unwrap();

    bx.copy_into(&src, "/root/my file.txt", CopyOptions::default())
        .await
        .expect("copy_into spaces failed");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/my file.txt"])).await;
    assert_eq!(out, "spaces\n");

    let dst = tmp.join("my file out.txt");
    bx.copy_out("/root/my file.txt", &dst, CopyOptions::default())
        .await
        .expect("copy_out spaces failed");
    assert_eq!(std::fs::read_to_string(&dst).unwrap(), "spaces\n");
}

// ============================================================================
// COPY OPTIONS: overwrite
// ============================================================================

async fn overwrite_true_replaces_file(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] overwrite_true_replaces_file");
    let src = tmp.join("ow.txt");
    std::fs::write(&src, "original\n").unwrap();

    bx.copy_into(&src, "/root/ow.txt", CopyOptions::default())
        .await
        .expect("first copy_into");

    std::fs::write(&src, "updated\n").unwrap();
    bx.copy_into(&src, "/root/ow.txt", CopyOptions::default())
        .await
        .expect("second copy_into with overwrite=true");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/ow.txt"])).await;
    assert_eq!(out, "updated\n");
}

async fn overwrite_false_rejects_copy_in(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] overwrite_false_rejects_copy_in");
    let src = tmp.join("noo.txt");
    std::fs::write(&src, "first\n").unwrap();

    bx.copy_into(&src, "/root/noo.txt", CopyOptions::default())
        .await
        .expect("first copy_into");

    std::fs::write(&src, "second\n").unwrap();
    let err = bx
        .copy_into(&src, "/root/noo.txt", CopyOptions::default().no_overwrite())
        .await;
    assert!(err.is_err(), "overwrite=false should reject existing file");
}

async fn overwrite_false_rejects_copy_in_dir(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] overwrite_false_rejects_copy_in_dir");
    let dir_src = tmp.join("nodir");
    std::fs::create_dir(&dir_src).unwrap();
    std::fs::write(dir_src.join("x.txt"), "x\n").unwrap();

    bx.copy_into(&dir_src, "/root", CopyOptions::default())
        .await
        .expect("first copy_into dir");

    let err = bx
        .copy_into(&dir_src, "/root", CopyOptions::default().no_overwrite())
        .await;
    assert!(
        err.is_err(),
        "overwrite=false should reject existing directory"
    );
}

async fn overwrite_false_rejects_copy_out(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] overwrite_false_rejects_copy_out");
    let src = tmp.join("out-ow.txt");
    std::fs::write(&src, "data\n").unwrap();
    bx.copy_into(&src, "/root/out-ow.txt", CopyOptions::default())
        .await
        .expect("copy_into");

    let dst = tmp.join("existing.txt");
    std::fs::write(&dst, "existing\n").unwrap();

    let err = bx
        .copy_out(
            "/root/out-ow.txt",
            &dst,
            CopyOptions::default().no_overwrite(),
        )
        .await;
    assert!(
        err.is_err(),
        "overwrite=false should reject existing host file"
    );
}

// ============================================================================
// COPY OPTIONS: recursive
// ============================================================================

async fn non_recursive_rejects_directory(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] non_recursive_rejects_directory");
    let dir_src = tmp.join("norecurse");
    std::fs::create_dir(&dir_src).unwrap();
    std::fs::write(dir_src.join("f.txt"), "f\n").unwrap();

    let err = bx
        .copy_into(
            &dir_src,
            "/root/norecurse",
            CopyOptions::default().non_recursive(),
        )
        .await;
    assert!(
        err.is_err(),
        "non_recursive should reject directory copy_into"
    );
}

// ============================================================================
// COPY OPTIONS: follow_symlinks
// ============================================================================

async fn follow_symlinks_false_preserves_link(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] follow_symlinks_false_preserves_link");
    let dir_src = tmp.join("linkdir");
    std::fs::create_dir(&dir_src).unwrap();
    std::fs::write(dir_src.join("target.txt"), "target content\n").unwrap();
    std::os::unix::fs::symlink("target.txt", dir_src.join("link.txt")).unwrap();

    bx.copy_into(
        &dir_src,
        "/root",
        CopyOptions::default().follow_symlinks(false),
    )
    .await
    .expect("copy_into with symlink");

    let out = exec_stdout(
        bx,
        BoxCommand::new("readlink").args(["/root/linkdir/link.txt"]),
    )
    .await;
    assert_eq!(out.trim(), "target.txt");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/linkdir/link.txt"])).await;
    assert_eq!(out, "target content\n");
}

async fn follow_symlinks_true_dereferences(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] follow_symlinks_true_dereferences");
    let dir_src = tmp.join("derefdir");
    std::fs::create_dir(&dir_src).unwrap();
    std::fs::write(dir_src.join("target.txt"), "deref content\n").unwrap();
    std::os::unix::fs::symlink("target.txt", dir_src.join("link.txt")).unwrap();

    bx.copy_into(
        &dir_src,
        "/root",
        CopyOptions::default().follow_symlinks(true),
    )
    .await
    .expect("copy_into with follow_symlinks");

    let exit = exec_exit_code(
        bx,
        BoxCommand::new("readlink").args(["/root/derefdir/link.txt"]),
    )
    .await;
    assert_ne!(exit, 0, "readlink should fail on dereferenced file");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/derefdir/link.txt"])).await;
    assert_eq!(out, "deref content\n");
}

// ============================================================================
// COPY OPTIONS: include_parent
// ============================================================================

async fn include_parent_true_nests_dir(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] include_parent_true_nests_dir");
    let dir_src = tmp.join("parentdir");
    std::fs::create_dir(&dir_src).unwrap();
    std::fs::write(dir_src.join("p.txt"), "parent\n").unwrap();

    bx.copy_into(
        &dir_src,
        "/root",
        CopyOptions::default().include_parent(true),
    )
    .await
    .expect("copy_into include_parent=true");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/parentdir/p.txt"])).await;
    assert_eq!(out, "parent\n");
}

async fn include_parent_false_flattens(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] include_parent_false_flattens");
    let dir_src = tmp.join("flatdir");
    std::fs::create_dir(&dir_src).unwrap();
    std::fs::write(dir_src.join("f.txt"), "flat\n").unwrap();

    bx.copy_into(
        &dir_src,
        "/root/flatdest/",
        CopyOptions::default().include_parent(false),
    )
    .await
    .expect("copy_into include_parent=false");

    let out = exec_stdout(bx, BoxCommand::new("cat").args(["/root/flatdest/f.txt"])).await;
    assert_eq!(out, "flat\n");
}

// ============================================================================
// ERROR / EDGE CASES
// ============================================================================

async fn copy_in_creates_intermediate_dirs(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] copy_in_creates_intermediate_dirs");
    let src = tmp.join("mkdirs.txt");
    std::fs::write(&src, "nested\n").unwrap();

    bx.copy_into(
        &src,
        "/root/deep/new/path/mkdirs.txt",
        CopyOptions::default(),
    )
    .await
    .expect("copy_into with intermediate dirs");

    let out = exec_stdout(
        bx,
        BoxCommand::new("cat").args(["/root/deep/new/path/mkdirs.txt"]),
    )
    .await;
    assert_eq!(out, "nested\n");
}

async fn copy_out_nonexistent_errors(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] copy_out_nonexistent_errors");
    let dst = tmp.join("nope.txt");
    let err = bx
        .copy_out("/root/does-not-exist-xyz", &dst, CopyOptions::default())
        .await;
    assert!(err.is_err(), "copy_out nonexistent should error");
}

// ============================================================================
// CONCURRENCY
// ============================================================================

async fn concurrent_copy_roundtrip(bx: &LiteBox, tmp: &Path) {
    eprintln!("  [copy] concurrent_copy_roundtrip");

    let futs: Vec<_> = (0..5u32)
        .map(|i| async move {
            let content = format!("concurrent-{}\n", i);
            let src = tmp.join(format!("conc-in-{}.txt", i));
            std::fs::write(&src, &content).unwrap();

            let container_path = format!("/root/conc-{}/file.txt", i);
            bx.copy_into(&src, &container_path, CopyOptions::default())
                .await
                .unwrap_or_else(|e| panic!("copy_into {} failed: {}", i, e));

            let dst = tmp.join(format!("conc-out-{}.txt", i));
            bx.copy_out(&container_path, &dst, CopyOptions::default())
                .await
                .unwrap_or_else(|e| panic!("copy_out {} failed: {}", i, e));

            let got = std::fs::read_to_string(&dst).unwrap();
            assert_eq!(got, content, "roundtrip mismatch for task {}", i);
        })
        .collect();

    futures::future::join_all(futs).await;
}
