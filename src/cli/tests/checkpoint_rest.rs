//! One explicit real-KVM check of the independent serve/client checkpoint path.
#![cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod common;
use boxlite::runtime::options::VolumeSpec;
use boxlite::{
    AttachOptions, BoxCommand, BoxOptions, BoxStatus, BoxliteOptions, BoxliteRestOptions,
    BoxliteRuntime, CheckpointImportOptions, ExecStdout, LiteBox, PauseOptions,
};
use common::serve::ServeChild;
use futures::StreamExt;
use std::path::Path;
use std::time::Duration;

async fn run(box_: &LiteBox, command: &str) -> String {
    let mut execution = box_
        .exec(BoxCommand::new("sh").args(["-c", command]))
        .await
        .unwrap();
    let mut stdout = execution.stdout().unwrap();
    let mut output = String::new();
    while let Some(chunk) = stdout.next().await {
        output.push_str(&chunk);
    }
    assert_eq!(execution.wait().await.unwrap().exit_code, 0);
    output.trim().to_owned()
}

async fn tick(stdout: &mut ExecStdout, previous: u64) -> (u32, String, u64) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut pending = String::new();
        loop {
            pending.push_str(&stdout.next().await.expect("main output"));
            while let Some(end) = pending.find('\n') {
                let line: String = pending.drain(..=end).collect();
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() == 3
                    && let (Ok(pid), Ok(counter)) = (fields[0].parse(), fields[2].parse::<u64>())
                {
                    if counter > previous {
                        return (pid, fields[1].to_owned(), counter);
                    }
                }
            }
        }
    })
    .await
    .expect("guest main stopped advancing")
}

fn filtered(home: &Path, box_: &LiteBox, pid: u32) {
    let launcher = pid;
    let mut pending = vec![pid];
    let mut shim = None;
    while let Some(pid) = pending.pop() {
        let root = Path::new("/proc").join(pid.to_string());
        let command = std::fs::read(root.join("cmdline")).unwrap_or_default();
        if command
            .split(|byte| *byte == 0)
            .next()
            .is_some_and(|name| name.ends_with(b"boxlite-shim"))
        {
            shim = Some(pid);
            break;
        }
        for entry in std::fs::read_dir("/proc").unwrap().flatten() {
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            if stat
                .rsplit_once(')')
                .and_then(|(_, rest)| rest.split_whitespace().nth(1))
                .and_then(|parent| parent.parse::<u32>().ok())
                == Some(pid)
                && let Ok(child) = entry.file_name().to_string_lossy().parse()
            {
                pending.push(child);
            }
        }
    }
    let pid = shim.expect("sandbox launcher has no shim descendant");
    assert_ne!(
        pid, launcher,
        "default sandbox must launch the shim through bwrap"
    );
    let root = Path::new("/proc").join(pid.to_string());
    for thread in std::fs::read_dir(root.join("task")).unwrap() {
        let status = std::fs::read_to_string(thread.unwrap().path().join("status")).unwrap();
        assert!(status.lines().any(|line| line == "Seccomp:\t2"), "{status}");
        let filters = status
            .lines()
            .find_map(|line| line.strip_prefix("Seccomp_filters:\t"))
            .unwrap()
            .parse::<u32>()
            .unwrap();
        assert_eq!(filters, 1);
    }
    let command = std::fs::read(root.join("cmdline")).unwrap();
    assert!(
        !command
            .windows(b"--no-sandbox".len())
            .any(|window| window == b"--no-sandbox")
    );
    let logs = std::env::var_os("BOXLITE_CHECKPOINT_LOGS").expect("set durable KVM log directory");
    let destination = Path::new(&logs).join(box_.id().as_str());
    std::fs::create_dir_all(&destination).unwrap();
    let source = home.join("boxes").join(box_.id().as_str());
    let mut shim_log = String::new();
    for entry in std::fs::read_dir(source.join("logs")).unwrap().flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("boxlite-shim.log")
        {
            let log = std::fs::read_to_string(entry.path()).unwrap();
            shim_log.push_str(&log);
            std::fs::copy(entry.path(), destination.join(entry.file_name())).unwrap();
        }
    }
    assert!(shim_log.contains("VMM seccomp filter applied to all threads (TSYNC)"));
    eprintln!(
        "box {}: launcher={launcher}, shim={pid}; default bwrap and VMM seccomp verified",
        box_.id()
    );
    for name in ["shim.stderr", "config.json", "state.json"] {
        if source.join(name).is_file() {
            std::fs::copy(source.join(name), destination.join(name)).unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "real KVM; make test:checkpoint:rest:acceptance"]
async fn checkpoint_rest_preserves_process_across_independent_homes() {
    assert!(Path::new("/dev/kvm").exists());
    let source_home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let target_home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    assert_ne!(source_home.path, target_home.path);
    let storage = tempfile::tempdir().unwrap();
    let volume = storage.path().join("volume");
    std::fs::create_dir(&volume).unwrap();
    std::fs::write(volume.join("normal"), "prepared-data").unwrap();
    let source_local = BoxliteRuntime::new(BoxliteOptions {
        home_dir: source_home.path.clone(),
        image_registries: boxlite_test_utils::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let source = source_local.create(BoxOptions {
        memory_mib: Some(256), auto_delete: Some(0),
        volumes: vec![VolumeSpec::bind_mount(volume.to_str().unwrap(), "/data")],
        entrypoint: Some(vec!["/bin/sh".into()]),
        cmd: Some(vec!["-c".into(), "marker=$(cat /proc/sys/kernel/random/uuid); n=0; while :; do n=$((n+1)); echo $n > /data/counter; echo \"$$ $marker $n\"; sleep 0.1; done".into()]),
        ..Default::default()
    }, Some("source".into())).await.unwrap();
    let source_id = source.id().clone();
    drop(source);
    source_local.shutdown(Some(10)).await.unwrap();
    drop(source_local);
    // Prepare the target dependencies independently. Import must find the captured
    // exact boot digest in its cache after the source boot path is removed.
    let target_local = BoxliteRuntime::new(BoxliteOptions {
        home_dir: target_home.path.clone(),
        image_registries: boxlite_test_utils::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let seed = target_local
        .create(
            BoxOptions {
                memory_mib: Some(256),
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    seed.start().await.unwrap();
    seed.pause(Default::default()).await.unwrap();
    let seed_checkpoint = storage.path().join("seed-checkpoint");
    seed.export_checkpoint(&seed_checkpoint).await.unwrap();
    let target_boot = BoxliteRuntime::inspect_checkpoint(&seed_checkpoint)
        .unwrap()
        .boot_disk_path
        .unwrap();
    seed.stop().await.unwrap();
    target_local
        .remove(seed.id().as_str(), false)
        .await
        .unwrap();
    target_local.shutdown(Some(10)).await.unwrap();
    drop(seed);
    drop(target_local);
    let source_server = ServeChild::start_in(source_home, &[], None);
    let target_server = ServeChild::start_in(target_home, &[], None);
    let source_rt = BoxliteRuntime::rest(BoxliteRestOptions::new(source_server.url())).unwrap();
    let target_rt = BoxliteRuntime::rest(BoxliteRestOptions::new(target_server.url())).unwrap();
    let source = source_rt.get(source_id.as_str()).await.unwrap().unwrap();
    let mut original = source
        .attach(AttachOptions::main().read_only())
        .await
        .unwrap();
    source.start().await.unwrap();
    let execution_id = original.id().clone();
    let mut stdout = original.stdout().unwrap();
    let before = tick(&mut stdout, 2).await;
    let process_start = run(&source, &format!("cat /proc/{}/stat", before.0)).await;
    filtered(
        source_server.home_path(),
        &source,
        source.info().await.unwrap().pid.unwrap(),
    );
    source
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .unwrap();
    let cut: u64 = std::fs::read_to_string(volume.join("counter"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let checkpoint = storage.path().join("download");
    source.export_checkpoint(&checkpoint).await.unwrap();
    eprintln!(
        "source {} execution={execution_id}, guest_pid={}, marker={}, cut={cut}; downloaded pair",
        source.id(),
        before.0,
        before.1
    );
    let dependencies = BoxliteRuntime::inspect_checkpoint(&checkpoint).unwrap();
    assert_eq!(std::fs::read_dir(&checkpoint).unwrap().count(), 2);
    source.stop().await.unwrap();
    drop(stdout);
    drop(original);
    source_rt.remove(source.id().as_str(), false).await.unwrap();

    let source_boot = dependencies.boot_disk_path.unwrap();
    std::fs::copy(&source_boot, &target_boot).unwrap();
    std::fs::remove_file(source_boot).unwrap();
    std::fs::rename(&volume, storage.path().join("old-volume")).unwrap();
    std::fs::create_dir(&volume).unwrap();
    for name in ["normal", "counter"] {
        std::fs::copy(
            storage.path().join("old-volume").join(name),
            volume.join(name),
        )
        .unwrap();
    }
    use std::os::unix::fs::MetadataExt;
    assert_ne!(
        std::fs::metadata(&volume).unwrap().ino(),
        std::fs::metadata(storage.path().join("old-volume"))
            .unwrap()
            .ino()
    );

    let restored = target_rt
        .import_checkpoint(
            &checkpoint,
            CheckpointImportOptions {
                name: Some("restored".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(restored.info().await.unwrap().status, BoxStatus::Paused);
    eprintln!(
        "imported {} Paused into independent target home",
        restored.id()
    );
    assert!(restored.exec(BoxCommand::new("true")).await.is_err());
    restored.resume().await.unwrap();
    let mut execution = restored
        .attach(AttachOptions::main().read_only())
        .await
        .unwrap();
    assert_eq!(execution.id(), &execution_id);
    let after = tick(&mut execution.stdout().unwrap(), cut + 2).await;
    assert_eq!((after.0, after.1.as_str()), (before.0, before.1.as_str()));
    let restored_stat = run(&restored, &format!("cat /proc/{}/stat", before.0)).await;
    assert_eq!(
        process_start.split_whitespace().nth(21),
        restored_stat.split_whitespace().nth(21)
    );
    assert_eq!(run(&restored, "cat /data/normal").await, "prepared-data");
    filtered(
        target_server.home_path(),
        &restored,
        restored.info().await.unwrap().pid.unwrap(),
    );
    restored
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .unwrap();
    let repeated = storage.path().join("repeated");
    restored.export_checkpoint(&repeated).await.unwrap();
    restored.stop().await.unwrap();
    drop(execution);
    let again = target_rt
        .import_checkpoint(&repeated, Default::default())
        .await
        .unwrap();
    assert_eq!(again.info().await.unwrap().status, BoxStatus::Paused);
    again.resume().await.unwrap();
    assert_eq!(run(&again, "cat /data/normal").await, "prepared-data");
    again.stop().await.unwrap();
    again.start().await.unwrap();
    assert_eq!(run(&again, "cat /data/normal").await, "prepared-data");
    again.stop().await.unwrap();
}
