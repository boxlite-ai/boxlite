//! Hardware acceptance: run `make test:fractional-cpus:acceptance` with CPU cgroup delegation.
#![cfg(target_os = "linux")]

mod common;

use boxlite::runtime::cpu_limits::MIN_CPUS;
use boxlite::{BoxCommand, BoxOptions, CloneOptions, ExportOptions};
use common::box_test::BoxTestBase;
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

async fn cgroup(bx: &boxlite::LiteBox) -> PathBuf {
    let pid = bx.info().await.unwrap().pid.unwrap();
    let membership = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    let relative = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .unwrap();
    PathBuf::from("/sys/fs/cgroup").join(relative.trim_start_matches('/'))
}

fn stats(path: &std::path::Path) -> HashMap<String, u64> {
    std::fs::read_to_string(path.join("cpu.stat"))
        .unwrap()
        .lines()
        .map(|line| {
            let (key, value) = line.split_once(' ').unwrap();
            (key.to_string(), value.parse().unwrap())
        })
        .collect()
}

async fn assert_quota(bx: &boxlite::LiteBox, cpus: f64) {
    let group = cgroup(bx).await;
    assert_eq!(
        std::fs::read_to_string(group.join("cpu.max"))
            .unwrap()
            .trim(),
        format!("{} 100000", (cpus * 100_000.0) as u64)
    );
    assert_eq!(bx.info().await.unwrap().cpus, cpus);
}

#[tokio::test]
#[ignore = "requires KVM and a writable delegated cgroup v2 CPU controller"]
async fn fractional_cpus_enforces_shared_budget_and_survives_restart_snapshot_clone_import() {
    let t = BoxTestBase::with_options(BoxOptions {
        cpus: Some(MIN_CPUS),
        ..common::alpine_opts()
    })
    .await;
    t.bx.start().await.unwrap();
    assert_quota(&t.bx, MIN_CPUS).await;
    assert_eq!(t.exec_stdout("nproc", &[]).await.trim(), "1");

    for workers in [1, 2] {
        // No output pipes can fill; each yes is killed and reaped by its parent shell.
        let load = t.bx.exec(BoxCommand::new("sh").args(["-c", &format!(
            "pids=''; for i in $(seq 1 {workers}); do yes >/dev/null & pids=\"$pids $!\"; done; sleep 6; kill $pids; wait; exit 0"
        )])).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        let group = cgroup(&t.bx).await;
        let before = stats(&group);
        let started = Instant::now();
        tokio::time::sleep(Duration::from_secs(3)).await;
        let elapsed = started.elapsed().as_secs_f64();
        let after = stats(&group);
        let used_cores =
            (after["usage_usec"] - before["usage_usec"]) as f64 / 1_000_000.0 / elapsed;
        eprintln!(
            "{workers} worker(s): {used_cores:.3} cores, {} throttled periods",
            after["nr_throttled"] - before["nr_throttled"]
        );
        assert!(
            (MIN_CPUS * 0.6..=MIN_CPUS * 1.4).contains(&used_cores),
            "expected aggregate {MIN_CPUS} CPU, measured {used_cores}"
        );
        assert!(after["nr_throttled"] > before["nr_throttled"]);
        assert_eq!(load.wait().await.unwrap().exit_code, 0);
    }

    t.bx.snapshots()
        .create(Default::default(), "limited")
        .await
        .unwrap();
    t.bx.stop().await.unwrap();
    let restored = t.runtime.get(t.bx.id().as_str()).await.unwrap().unwrap();
    restored.snapshots().restore("limited").await.unwrap();
    restored.start().await.unwrap();
    assert_quota(&restored, MIN_CPUS).await;

    // Stop invalidates the handle; reconnect reads the saved configuration.
    restored.stop().await.unwrap();
    let reconnected = t.runtime.get(t.bx.id().as_str()).await.unwrap().unwrap();
    reconnected.start().await.unwrap();
    assert_quota(&reconnected, MIN_CPUS).await;
    reconnected.stop().await.unwrap();

    let source = t.runtime.get(t.bx.id().as_str()).await.unwrap().unwrap();
    let cloned = source
        .clone_box(CloneOptions::default(), None)
        .await
        .unwrap();
    cloned.start().await.unwrap();
    assert_quota(&cloned, MIN_CPUS).await;
    cloned.stop().await.unwrap();
    let archive_dir = tempfile::tempdir().unwrap();
    let archive = source
        .export(ExportOptions::default(), archive_dir.path())
        .await
        .unwrap();
    let imported = t.runtime.import_box(archive, None).await.unwrap();
    imported.start().await.unwrap();
    assert_quota(&imported, MIN_CPUS).await;
    imported.stop().await.unwrap();
    t.runtime
        .remove(imported.id().as_str(), true)
        .await
        .unwrap();
    t.runtime.remove(cloned.id().as_str(), true).await.unwrap();
}

#[tokio::test]
#[ignore = "requires KVM and a writable delegated cgroup v2 CPU controller"]
async fn fractional_cpus_round_up_topology_and_integer_cpus_keep_existing_quota() {
    for cpus in [1.5, 2.0] {
        let t = BoxTestBase::with_options(BoxOptions {
            cpus: Some(cpus),
            ..common::alpine_opts()
        })
        .await;
        t.bx.start().await.unwrap();
        assert_eq!(t.exec_stdout("nproc", &[]).await.trim(), "2");
        let group = cgroup(&t.bx).await;
        if cpus == 2.0 {
            assert!(
                std::fs::read_to_string(group.join("cpu.max"))
                    .unwrap()
                    .starts_with("max ")
            );
        } else {
            assert_quota(&t.bx, cpus).await;
            let load = t.bx.exec(BoxCommand::new("sh").args(["-c", "yes >/dev/null & p1=$!; yes >/dev/null & p2=$!; sleep 6; kill $p1 $p2; wait; exit 0"])).await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
            let before = stats(&group);
            let started = Instant::now();
            tokio::time::sleep(Duration::from_secs(3)).await;
            let elapsed = started.elapsed().as_secs_f64();
            let after = stats(&group);
            let cores = (after["usage_usec"] - before["usage_usec"]) as f64 / 1_000_000.0 / elapsed;
            eprintln!(
                "two vCPUs: {cores:.3} cores, {} throttled periods",
                after["nr_throttled"] - before["nr_throttled"]
            );
            assert!(
                (1.2..=1.8).contains(&cores),
                "expected aggregate 1.5 CPU, measured {cores}"
            );
            assert!(after["nr_throttled"] > before["nr_throttled"]);
            assert_eq!(load.wait().await.unwrap().exit_code, 0);
        }
    }
}
