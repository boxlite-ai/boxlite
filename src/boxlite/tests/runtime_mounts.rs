//! Real Box E2E for M6 runtime directory delivery (spec capability:
//! `box-mounts`). One running container, one program, host directories
//! delivered and retired while everything keeps running.
//!
//! Requires a real VM runtime and a kernel with virtio-fs; run through the
//! explicit-engine matrix (`BOXLITE_TEST_ENGINE=native VMM_KERNEL=...`).

mod common;

use boxlite::runtime::options::{BoxliteOptions, VolumeSpec};
use boxlite::{BoxCommand, BoxliteResult, MountRequest, MountState};
use futures::StreamExt;
use tempfile::TempDir;

/// Poll until the container process reports `marker` present, bounded.
async fn wait_for_marker(bx: &boxlite::LiteBox, marker: &str) -> bool {
    for _ in 0..40 {
        let execution = bx
            .exec(BoxCommand::new("sh").args(["-c", &format!("test -e {marker} && echo yes")]))
            .await
            .expect("marker probe exec");
        let exit = execution.wait().await.expect("marker probe wait");
        if exit.exit_code == 0 {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    false
}

/// Run `script` in the container, return (exit code, stdout).
async fn run_sh(bx: &boxlite::LiteBox, script: &str) -> BoxliteResult<(i32, String)> {
    let mut execution = bx.exec(BoxCommand::new("sh").args(["-c", script])).await?;
    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }
    let exit = execution.wait().await?;
    Ok((exit.exit_code, stdout))
}

#[tokio::test]
#[ignore = "requires a real VM runtime; run through the explicit-engine matrix"]
async fn runtime_mount_round_trip_with_lazy_semantics() {
    let home = common::home::PerTestBoxHome::new();
    // BOXLITE_E2E_HOME pins the runtime home so a failing run leaves its
    // diagnostics (shim log, box dir) on disk for inspection.
    let home_dir = std::env::var_os("BOXLITE_E2E_HOME")
        .map(PathBuf::from)
        .inspect(|persistent| {
            std::fs::create_dir_all(persistent).expect("create persistent home");
            eprintln!("[e2e] persistent home: {}", persistent.display());
        });
    let host = TempDir::new_in("/tmp").expect("host temp root");
    let runtime = common::TestRuntime::new(BoxliteOptions {
        home_dir: home_dir.clone().unwrap_or_else(|| home.path.clone()),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("create selected-engine runtime");

    // One boot-time volume guarantees the aggregate virtio-fs device exists;
    // the late directory is deliberately NOT shared at boot.
    let boot_dir = host.path().join("boot");
    let late_dir = host.path().join("late");
    let ro_dir = host.path().join("ro");
    std::fs::create_dir(&boot_dir).expect("create boot volume");
    std::fs::create_dir(&late_dir).expect("create late directory");
    std::fs::write(late_dir.join("from-host"), b"before").expect("seed late content");
    std::fs::create_dir(&ro_dir).expect("create ro directory");
    std::fs::write(ro_dir.join("keep"), b"read-only").expect("seed ro content");

    let mut options = common::alpine_opts();
    options.volumes.push(VolumeSpec {
        managed_volume: None,
        host_path: boot_dir.to_str().unwrap().to_owned(),
        guest_path: "/mnt/boot-vol".into(),
        read_only: false,
    });
    let bx = runtime.create(options, None).await.expect("create Box");
    bx.start().await.expect("start Box");
    let mounts = bx.mounts();

    // --- Add: a directory that did not exist at boot becomes available. ---
    let info = mounts
        .add(MountRequest {
            source: late_dir.clone(),
            target: "/mnt/late".into(),
            read_only: false,
        })
        .await
        .expect("runtime add");
    assert_eq!(info.state, MountState::Mounted);
    assert!(!info.read_only);
    let (code, stdout) = run_sh(&bx, "cat /mnt/late/from-host")
        .await
        .expect("read exec");
    assert_eq!(code, 0, "read the delivered directory");
    assert_eq!(stdout.trim(), "before");

    // --- Query: list and inspect reflect the mount, no internal ids. ---
    let listed = mounts.list().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].target, PathBuf::from("/mnt/late"));
    let got = mounts
        .get("/mnt/late")
        .await
        .expect("get")
        .expect("mount present");
    assert_eq!(got.source, late_dir);

    // --- Writes land on the host directory (no copy semantics). ---
    let (code, _) = run_sh(&bx, "printf container-data > /mnt/late/from-guest")
        .await
        .expect("write exec");
    assert_eq!(code, 0);
    assert_eq!(
        std::fs::read_to_string(late_dir.join("from-guest")).unwrap(),
        "container-data"
    );

    // --- Read-only delivery: the backend refuses entry modifications. ---
    mounts
        .add(MountRequest {
            source: ro_dir.clone(),
            target: "/mnt/late-ro".into(),
            read_only: true,
        })
        .await
        .expect("read-only add");
    let (code, _) = run_sh(&bx, "touch /mnt/late-ro/refused")
        .await
        .expect("ro probe");
    assert_ne!(code, 0, "the read-only export rejects writes");
    assert_eq!(
        std::fs::read_to_string(ro_dir.join("keep")).unwrap(),
        "read-only"
    );

    // --- Destination rules: non-empty and file targets are refused. ---
    let (code, _) = run_sh(&bx, "mkdir -p /mnt/full && printf x > /mnt/full/occupied")
        .await
        .expect("prepare occupied target");
    assert_eq!(code, 0);
    let error = mounts
        .add(MountRequest {
            source: late_dir.clone(),
            target: "/mnt/full".into(),
            read_only: false,
        })
        .await
        .expect_err("a non-empty destination is refused");
    assert!(!error.to_string().is_empty());
    let (code, _) = run_sh(&bx, "cat /mnt/full/occupied")
        .await
        .expect("occupied intact");
    assert_eq!(code, 0, "the refused destination keeps its content");

    // --- Lazy removal: a process holding a descriptor does not block the
    // removal, keeps reading through it, and the name detaches. ---
    let holder = bx
        .exec(BoxCommand::new("sh").args(["-c",
            "exec 9< /mnt/late/from-host && printf y > /root/ready && sleep 4 && cat <&9 > /root/held"]))
        .await
        .expect("spawn holder");
    assert!(
        wait_for_marker(&bx, "/root/ready").await,
        "the holder opened its descriptor"
    );

    mounts
        .remove("/mnt/late")
        .await
        .expect("lazy removal with a held descriptor");
    let (code, stdout) = run_sh(&bx, "ls -A /mnt/late 2>/dev/null | wc -l")
        .await
        .expect("probe");
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), "0", "the name no longer serves the export");
    let listed = mounts.list().await.expect("list after removal");
    assert!(listed.iter().all(|mount| mount.target != *"/mnt/late"));

    // The holder closes, its descriptor still reads the pre-detach content.
    let _ = holder.wait().await.expect("holder exits");
    let (code, stdout) = run_sh(&bx, "cat /root/held").await.expect("held read");
    assert_eq!(code, 0);
    assert_eq!(
        stdout.trim(),
        "before",
        "the held descriptor kept the old content"
    );

    // --- Same-path remount while everything else kept running. ---
    mounts
        .add(MountRequest {
            source: late_dir.clone(),
            target: "/mnt/late".into(),
            read_only: false,
        })
        .await
        .expect("remount the same target");
    let (code, stdout) = run_sh(&bx, "cat /mnt/late/from-guest")
        .await
        .expect("remount read");
    assert_eq!(code, 0);
    assert_eq!(
        stdout.trim(),
        "container-data",
        "the new delivery serves the export"
    );

    // --- Detach of the read-only entry and final state. ---
    mounts
        .remove("/mnt/late-ro")
        .await
        .expect("detach read-only entry");
    mounts
        .remove("/mnt/late")
        .await
        .expect("detach the remounted entry");
    assert!(mounts.list().await.expect("final list").is_empty());

    let stopped = bx.stop().await;
    stopped.expect("stop Box");
    // A persistent home keeps the box on disk for diagnosis; skip removal.
    if home_dir.is_none() {
        runtime
            .remove(bx.id().as_str(), true)
            .await
            .expect("remove Box");
    }
}

use std::path::PathBuf;
