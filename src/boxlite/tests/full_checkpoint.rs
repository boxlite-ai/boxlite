//! End-to-end integration tests for full memory+device+disk export/import
//! (`Box::export(ExportOptions::full())` + `BoxliteRuntime::import_box()`)
//! using a real hypervisor (`libkrun` on HVF/KVM).

#![cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
))]

mod common;

use std::time::Duration;

use boxlite::runtime::options::{
    BoxArchive, BoxOptions, BoxliteOptions, ExportOptions, NetworkMode, NetworkSpec,
    OutboundNetworkConfig, RootfsSpec,
};
use boxlite::runtime::types::BoxStatus;
use boxlite::{AttachOptions, BoxCommand, BoxliteError, LiteBox};
use tempfile::TempDir;
use tokio_stream::StreamExt;

async fn exec_output(handle: &LiteBox, cmd: &str, args: &[&str]) -> (i32, String, String) {
    let mut execution = handle
        .exec(BoxCommand::new(cmd).args(args.iter().copied()))
        .await
        .unwrap_or_else(|e| panic!("exec `{cmd} {args:?}` failed: {e}"));

    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }
    let mut stderr = String::new();
    if let Some(mut stream) = execution.stderr() {
        while let Some(chunk) = stream.next().await {
            stderr.push_str(&chunk);
        }
    }
    let result = execution.wait().await.expect("wait for exec");
    (result.exit_code, stdout, stderr)
}

async fn exec_ok(handle: &LiteBox, script: &str) -> String {
    let (code, stdout, stderr) = exec_output(handle, "sh", &["-c", script]).await;
    assert_eq!(
        code, 0,
        "script failed (exit={code}): {script}\nstdout={stdout}\nstderr={stderr}"
    );
    stdout
}

fn read_archive_manifest(archive_path: &std::path::Path) -> serde_json::Value {
    let file = std::fs::File::open(archive_path).expect("open archive");
    let decoder = zstd::stream::read::Decoder::new(file).expect("zstd decoder");
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries().expect("tar entries") {
        let mut entry = entry.expect("tar entry");
        let path = entry.path().expect("entry path");
        if path.as_ref() == std::path::Path::new("manifest.json") {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut entry, &mut text).expect("read manifest.json");
            return serde_json::from_str(&text).expect("parse manifest.json");
        }
    }
    panic!("manifest.json not found in {}", archive_path.display());
}

fn runtime_for_test(home: &std::path::Path) -> common::TestRuntime {
    common::TestRuntime::new(BoxliteOptions {
        home_dir: home.to_path_buf(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("create runtime")
}

#[tokio::test]
async fn full_checkpoint_export_import_live_restore_and_cold_restart() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = runtime_for_test(&home.path);
    let export_dir = TempDir::new_in("/tmp").unwrap();

    // 1. Start a standard running box (default networking + SHARED virtio-fs).
    let src = runtime
        .create(
            BoxOptions {
                detach: true,
                ..common::alpine_opts()
            },
            Some("full-export-src".into()),
        )
        .await
        .expect("create source box");
    src.start().await.expect("start source box");

    // Seed both in-memory state (/dev/shm + live background process) and disk state (/root).
    let bg_pid = exec_ok(
        &src,
        "echo mem-live-state > /dev/shm/mem_marker && \
         echo disk-initial-state > /root/disk_marker && \
         sync && \
         { sh -c 'while :; do sleep 60; done' >/dev/null 2>&1 & \
         pid=$!; echo $pid > /dev/shm/bg.pid; echo $pid; }",
    )
    .await
    .trim()
    .to_string();
    assert!(
        bg_pid.parse::<u32>().is_ok(),
        "expected numeric background PID, got {bg_pid:?}"
    );

    // 2. Disable egress without removing the NIC, then export the running box.
    src.network()
        .update_outbound(OutboundNetworkConfig {
            mode: NetworkMode::Disabled,
            allow_net: Vec::new(),
        })
        .await
        .expect("disable live egress");
    let archive_path = export_dir.path().join("live.boxlite");
    let archive = src
        .export(ExportOptions::full(), &archive_path)
        .await
        .expect("full checkpoint export");
    assert!(archive.path().is_file());
    assert!(std::fs::metadata(archive.path()).unwrap().len() > 0);
    let manifest = read_archive_manifest(archive.path());
    assert_eq!(manifest["memory_checkpoint"]["outbound_disabled"], true);
    assert!(manifest["box_options"]["network"]["Enabled"].is_object());

    // 3. Source box remains alive and its GuestSession reconnects cleanly.
    let src_mem = exec_ok(
        &src,
        &format!(
            "kill -0 {bg_pid} && cat /dev/shm/mem_marker && echo src-after-export > /root/src_only"
        ),
    )
    .await;
    assert_eq!(src_mem.trim(), "mem-live-state");

    // 4. Import the archive twice into two independent boxes.
    let r1 = runtime
        .import_box(BoxArchive::new(archive.path()), Some("restored-1".into()))
        .await
        .expect("import first restored box");
    let r2 = runtime
        .import_box(BoxArchive::new(archive.path()), Some("restored-2".into()))
        .await
        .expect("import second restored box");

    assert_ne!(r1.id(), r2.id());
    assert_ne!(r1.id(), src.id());
    assert_eq!(r1.info().await.unwrap().status, BoxStatus::Configured);
    assert_eq!(r2.info().await.unwrap().status, BoxStatus::Configured);

    let r1_checkpoint_dir = home
        .path
        .join("boxes")
        .join(r1.id().as_str())
        .join("checkpoint");
    let r2_checkpoint_dir = home
        .path
        .join("boxes")
        .join(r2.id().as_str())
        .join("checkpoint");
    assert!(r1_checkpoint_dir.is_dir());
    assert!(r2_checkpoint_dir.is_dir());

    r1.start().await.expect("start first restored box");
    r2.start().await.expect("start second restored box");
    assert_eq!(
        r1.info().await.unwrap().network.unwrap().outbound.mode,
        NetworkMode::Disabled
    );

    // First Running commit clears pending_memory_restore and removes vmstate.krun,
    // retaining guest-rootfs.ext4 until stop() so chained export(full) can read live vdb.
    assert_eq!(r1.info().await.unwrap().status, BoxStatus::Running);
    assert_eq!(r2.info().await.unwrap().status, BoxStatus::Running);
    assert!(
        !r1_checkpoint_dir.join("vmstate.krun").exists(),
        "r1 vmstate.krun should be reclaimed after Running commit"
    );
    assert!(
        r1_checkpoint_dir.join("guest-rootfs.ext4").is_file(),
        "r1 guest-rootfs.ext4 should remain while Running for chained export"
    );
    assert!(
        !r2_checkpoint_dir.join("vmstate.krun").exists(),
        "r2 vmstate.krun should be reclaimed after Running commit"
    );
    assert!(
        r2_checkpoint_dir.join("guest-rootfs.ext4").is_file(),
        "r2 guest-rootfs.ext4 should remain while Running for chained export"
    );

    // Verify both restored boxes preserve PID and tmpfs memory state and stay isolated.
    let r1_out = exec_ok(
        &r1,
        &format!(
            "kill -0 {bg_pid} && \
             test \"$(cat /dev/shm/bg.pid)\" = \"{bg_pid}\" && \
             cat /dev/shm/mem_marker && \
             cat /root/disk_marker && \
             test ! -e /root/src_only && \
             echo r1-write > /root/r1_only && sync"
        ),
    )
    .await;
    assert_eq!(
        r1_out.lines().collect::<Vec<_>>(),
        vec!["mem-live-state", "disk-initial-state"]
    );

    let r2_out = exec_ok(
        &r2,
        &format!(
            "kill -0 {bg_pid} && \
             test \"$(cat /dev/shm/bg.pid)\" = \"{bg_pid}\" && \
             cat /dev/shm/mem_marker && \
             cat /root/disk_marker && \
             test ! -e /root/src_only && \
             test ! -e /root/r1_only && \
             echo r2-write > /root/r2_only && sync"
        ),
    )
    .await;
    assert_eq!(
        r2_out.lines().collect::<Vec<_>>(),
        vec!["mem-live-state", "disk-initial-state"]
    );

    // Writes in r1 and r2 must not leak back to src or each other.
    let (code, _, _) = exec_output(&src, "test", &["-e", "/root/r1_only"]).await;
    assert_ne!(code, 0, "r1 write leaked to source box");
    let (code, _, _) = exec_output(&r1, "test", &["-e", "/root/r2_only"]).await;
    assert_ne!(code, 0, "r2 write leaked to r1");

    // 5. Remove the archive file and source box, then verify r1 cold-restarts cleanly.
    std::fs::remove_file(archive.path()).expect("remove .boxlite archive");
    src.stop().await.unwrap();
    runtime.remove(src.id().as_str(), false).await.unwrap();

    exec_ok(
        &r1,
        "echo persisted-across-cold-boot > /root/cold_boot_marker && sync",
    )
    .await;
    let r1_id = r1.id().as_str().to_string();
    r1.stop().await.expect("stop r1");
    assert!(
        !r1_checkpoint_dir.exists(),
        "r1 checkpoint dir should be deleted after stop"
    );

    let r1_restarted = runtime
        .get(&r1_id)
        .await
        .expect("get r1")
        .expect("r1 exists");
    r1_restarted
        .start()
        .await
        .expect("cold-start r1 after stop");

    let cold_out = exec_ok(
        &r1_restarted,
        "cat /root/disk_marker && cat /root/r1_only && cat /root/cold_boot_marker && test ! -e /dev/shm/mem_marker",
    )
    .await;
    assert_eq!(
        cold_out.lines().collect::<Vec<_>>(),
        vec![
            "disk-initial-state",
            "r1-write",
            "persisted-across-cold-boot"
        ]
    );

    r1_restarted.stop().await.unwrap();
    r2.stop().await.unwrap();
    runtime.remove(&r1_id, false).await.unwrap();
    runtime.remove(r2.id().as_str(), false).await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn full_checkpoint_export_import_network_disabled_seccomp() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = runtime_for_test(&home.path);
    let export_dir = TempDir::new_in("/tmp").unwrap();

    // NetworkSpec::Disabled activates the Linux seccomp profile on KVM.
    let src = runtime
        .create(
            BoxOptions {
                network: NetworkSpec::Disabled,
                detach: true,
                ..common::alpine_opts()
            },
            Some("net-disabled-src".into()),
        )
        .await
        .expect("create network-disabled box");
    src.start().await.expect("start network-disabled box");

    let bg_pid = exec_ok(
        &src,
        "echo offline-mem > /dev/shm/offline_mem && \
         echo offline-disk > /root/offline_disk && \
         sync && \
         { sh -c 'while :; do sleep 60; done' >/dev/null 2>&1 & echo $!; }",
    )
    .await
    .trim()
    .to_string();

    let archive = src
        .export(ExportOptions::full(), export_dir.path())
        .await
        .expect("export full checkpoint with network disabled");

    // Source remains responsive.
    assert_eq!(
        exec_ok(
            &src,
            &format!("kill -0 {bg_pid} && cat /dev/shm/offline_mem")
        )
        .await
        .trim(),
        "offline-mem"
    );

    let restored = runtime
        .import_box(archive, Some("net-disabled-restored".into()))
        .await
        .expect("import network-disabled full checkpoint");

    tokio::time::timeout(Duration::from_secs(60), restored.start())
        .await
        .expect("restore start timed out")
        .expect("start restored network-disabled box");

    let out = exec_ok(
        &restored,
        &format!("kill -0 {bg_pid} && cat /dev/shm/offline_mem && cat /root/offline_disk"),
    )
    .await;
    assert_eq!(
        out.lines().collect::<Vec<_>>(),
        vec!["offline-mem", "offline-disk"]
    );

    src.stop().await.unwrap();
    restored.stop().await.unwrap();
    runtime.remove(src.id().as_str(), false).await.unwrap();
    runtime.remove(restored.id().as_str(), false).await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn full_checkpoint_export_import_chained() {
    let home1 = boxlite_test_utils::home::PerTestBoxHome::new();
    let home2 = boxlite_test_utils::home::PerTestBoxHome::new();
    let home3 = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime1 = runtime_for_test(&home1.path);
    let runtime2 = runtime_for_test(&home2.path);
    let runtime3 = runtime_for_test(&home3.path);
    let export_dir = TempDir::new_in("/tmp").unwrap();

    let src = runtime1
        .create(
            BoxOptions {
                detach: true,
                ..common::alpine_opts()
            },
            Some("chain-src".into()),
        )
        .await
        .expect("create chain source box");
    src.start().await.expect("start chain source box");

    let pid1 = exec_ok(
        &src,
        "echo step1-mem > /dev/shm/chain_step1 && \
         echo step1-disk > /root/chain_step1 && \
         sync && \
         { sh -c 'while :; do sleep 60; done' >/dev/null 2>&1 & echo $!; }",
    )
    .await
    .trim()
    .to_string();

    let archive1 = src
        .export(
            ExportOptions::full(),
            &export_dir.path().join("chain1.boxlite"),
        )
        .await
        .expect("export archive1");

    // Import into an isolated BOXLITE_HOME runtime2 so r1 has no access to runtime1's guest rootfs.
    let r1 = runtime2
        .import_box(BoxArchive::new(archive1.path()), Some("chain-r1".into()))
        .await
        .expect("import r1");
    let r1_checkpoint_dir = home2
        .path
        .join("boxes")
        .join(r1.id().as_str())
        .join("checkpoint");
    tokio::time::timeout(Duration::from_secs(60), r1.start())
        .await
        .expect("r1 start timed out")
        .expect("start r1");
    assert!(!r1_checkpoint_dir.join("vmstate.krun").exists());
    assert!(r1_checkpoint_dir.join("guest-rootfs.ext4").is_file());

    let pid2 = exec_ok(
        &r1,
        &format!(
            "kill -0 {pid1} && \
             test \"$(cat /dev/shm/chain_step1)\" = step1-mem && \
             test \"$(cat /root/chain_step1)\" = step1-disk && \
             echo step2-mem > /dev/shm/chain_step2 && \
             echo step2-disk > /root/chain_step2 && \
             sync && \
             {{ sh -c 'while :; do sleep 60; done' >/dev/null 2>&1 & echo $!; }}"
        ),
    )
    .await
    .trim()
    .to_string();

    let archive2 = r1
        .export(
            ExportOptions::full(),
            &export_dir.path().join("chain2.boxlite"),
        )
        .await
        .expect("export chained archive2 from restored r1");

    let manifest1 = read_archive_manifest(archive1.path());
    let manifest2 = read_archive_manifest(archive2.path());
    let cs1 = manifest1["memory_checkpoint"]["guest_rootfs_checksum"]
        .as_str()
        .expect("archive1 guest_rootfs_checksum");
    let cs2 = manifest2["memory_checkpoint"]["guest_rootfs_checksum"]
        .as_str()
        .expect("archive2 guest_rootfs_checksum");
    assert_eq!(
        cs2, cs1,
        "chained export must preserve live guest-rootfs.ext4 checksum across isolated runtimes"
    );

    let r2 = runtime3
        .import_box(archive2, Some("chain-r2".into()))
        .await
        .expect("import r2");
    let r2_checkpoint_dir = home3
        .path
        .join("boxes")
        .join(r2.id().as_str())
        .join("checkpoint");
    tokio::time::timeout(Duration::from_secs(60), r2.start())
        .await
        .expect("r2 start timed out")
        .expect("start r2");
    assert!(!r2_checkpoint_dir.join("vmstate.krun").exists());
    assert!(r2_checkpoint_dir.join("guest-rootfs.ext4").is_file());

    let out = exec_ok(
        &r2,
        &format!(
            "kill -0 {pid1} && kill -0 {pid2} && \
             cat /dev/shm/chain_step1 && cat /dev/shm/chain_step2 && \
             cat /root/chain_step1 && cat /root/chain_step2"
        ),
    )
    .await;
    assert_eq!(
        out.lines().collect::<Vec<_>>(),
        vec!["step1-mem", "step2-mem", "step1-disk", "step2-disk"]
    );

    // Cold restart on final restored box preserves both generations' disk files.
    let r2_id = r2.id().as_str().to_string();
    r2.stop().await.unwrap();
    assert!(
        !r2_checkpoint_dir.exists(),
        "r2 checkpoint dir must be removed after stop"
    );
    let r2_restarted = runtime3.get(&r2_id).await.unwrap().expect("re-fetch r2");
    r2_restarted.start().await.unwrap();
    let cold_out = exec_ok(
        &r2_restarted,
        "cat /root/chain_step1 && cat /root/chain_step2 && test ! -e /dev/shm/chain_step1",
    )
    .await;
    assert_eq!(
        cold_out.lines().collect::<Vec<_>>(),
        vec!["step1-disk", "step2-disk"]
    );

    src.stop().await.unwrap();
    r1.stop().await.unwrap();
    assert!(
        !r1_checkpoint_dir.exists(),
        "r1 checkpoint dir must be removed after stop"
    );
    r2_restarted.stop().await.unwrap();
    runtime3.remove(&r2_id, false).await.unwrap();
    runtime2.remove(r1.id().as_str(), false).await.unwrap();
    runtime1.remove(src.id().as_str(), false).await.unwrap();
    let _ = runtime3.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
    let _ = runtime2.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
    let _ = runtime1.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test]
async fn full_checkpoint_export_import_negative_guards() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = runtime_for_test(&home.path);
    let export_dir = TempDir::new_in("/tmp").unwrap();

    // 1. LocalRuntime::checkpoints() remains Unsupported.
    let checkpoints = runtime.checkpoints();
    assert!(matches!(
        checkpoints.list().await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert!(matches!(
        runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Checkpoint("ckpt-1".into()),
                    ..Default::default()
                },
                None
            )
            .await,
        Err(BoxliteError::Unsupported(_))
    ));

    // 2. Stopped box calling export(ExportOptions::full()) returns InvalidState.
    let box_handle = runtime
        .create(
            BoxOptions {
                detach: true,
                cmd: Some(vec!["sleep".into(), "3600".into()]),
                ..common::alpine_opts()
            },
            Some("stopped-full-export".into()),
        )
        .await
        .expect("create box");
    drop(
        box_handle
            .attach(AttachOptions::main().read_only())
            .await
            .expect("attach before start"),
    );
    let id = box_handle.id().clone();
    drop(box_handle);
    let box_handle = runtime.get(id.as_str()).await.unwrap().unwrap();

    // Capture must start the container even when this handle has never attached.
    let archive_path = export_dir.path().join("valid-full.boxlite");
    let archive = box_handle
        .export(ExportOptions::full(), &archive_path)
        .await
        .expect("full export while running");
    box_handle.stop().await.expect("stop box");

    let stopped_err = box_handle
        .export(ExportOptions::full(), export_dir.path())
        .await
        .expect_err("full export on stopped box must return InvalidState");
    assert!(
        matches!(stopped_err, BoxliteError::InvalidState(_)),
        "expected InvalidState, got {stopped_err:?}"
    );

    // 3. Untrusted upload of a v8 memory checkpoint archive is rejected with Unsupported.
    let untrusted_err = runtime
        .import_box(BoxArchive::from_untrusted_upload(archive.path()), None)
        .await
        .err()
        .expect("untrusted import of v8 full checkpoint archive must be rejected");
    assert!(
        matches!(untrusted_err, BoxliteError::Unsupported(_)),
        "expected Unsupported, got {untrusted_err:?}"
    );

    runtime
        .remove(box_handle.id().as_str(), false)
        .await
        .unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
