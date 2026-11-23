//! Native copies must not depend on an archive staging directory.
#![cfg(unix)]
mod common;

use boxlite::{BoxCommand, CopyOptions};
use std::os::unix::fs::PermissionsExt;

#[tokio::test(flavor = "multi_thread")]
async fn native_copy_without_archive_staging() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = common::TestRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let bx = runtime.create(common::alpine_opts(), None).await.unwrap();
    bx.start().await.unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("payload");
    std::fs::write(&src, b"streamed payload").unwrap();
    let command = bx
        .exec(BoxCommand::new("sh").args(["-c", "printf downloaded > /root/download"]))
        .await
        .unwrap();
    assert_eq!(command.wait().await.unwrap().exit_code, 0);
    let staging = home.path.join("tmp");
    let permissions = std::fs::metadata(&staging).unwrap().permissions();
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o500)).unwrap();
    let uploaded = bx
        .copy_into(&src, "/root/upload", CopyOptions::default())
        .await;
    let dst = tmp.path().join("download");
    let downloaded = bx
        .copy_out("/root/download", &dst, CopyOptions::default())
        .await;
    std::fs::set_permissions(&staging, permissions).unwrap();
    let upload_content = bx
        .exec(
            BoxCommand::new("sh").args(["-c", "test \"$(cat /root/upload)\" = 'streamed payload'"]),
        )
        .await
        .unwrap()
        .wait()
        .await
        .unwrap()
        .exit_code;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
    assert!(
        uploaded.is_ok() && downloaded.is_ok(),
        "copies required staging: upload={uploaded:?}; download={downloaded:?}"
    );
    assert_eq!(
        upload_content, 0,
        "guest did not receive the uploaded content"
    );
    assert_eq!(std::fs::read(dst).unwrap(), b"downloaded");
}

#[cfg(target_os = "linux")]
fn peak_rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

#[cfg(target_os = "linux")]
fn digest(path: &std::path::Path) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 << 10];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    hash.finalize().to_vec()
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn native_copy_memory_does_not_scale_with_archive_size() {
    use std::io::{Seek, SeekFrom, Write};
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = common::TestRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let bx = runtime.create(common::alpine_opts(), None).await.unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("large");
    let dst = tmp.path().join("received");
    let mut peaks = Vec::new();
    for mib in [8, 128] {
        let mut file = std::fs::File::create(&src).unwrap();
        // Allocate the payload so sparse-tar encoding cannot hide buffering.
        for _ in 0..mib * 16 {
            file.write_all(&[42; 64 << 10]).unwrap();
        }
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(b"stream-start").unwrap();
        file.seek(SeekFrom::End(-10)).unwrap();
        file.write_all(b"stream-end").unwrap();
        drop(file);
        bx.copy_into(&src, "/root/large", CopyOptions::default())
            .await
            .unwrap();
        bx.copy_out("/root/large", &dst, CopyOptions::default())
            .await
            .unwrap();
        assert_eq!(std::fs::metadata(&dst).unwrap().len(), mib << 20);
        assert_eq!(digest(&src), digest(&dst));
        peaks.push(peak_rss_kib());
        eprintln!(
            "{mib} MiB native copy roundtrip: peak host RSS {} KiB",
            peaks.last().unwrap()
        );
    }
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
    // Allow allocator/transport slack while detecting a retained 128 MiB tar.
    assert!(
        peaks[1].saturating_sub(peaks[0]) < 64 << 10,
        "host RSS grew with the payload: {peaks:?} KiB"
    );
}
