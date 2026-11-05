//! Online resize: spare vCPUs stay offline and capped until a resize.

mod common;

use boxlite::BoxOptions;
use common::box_test::BoxTestBase;

#[cfg(target_os = "linux")]
#[tokio::test]
async fn resize_memory_grows_without_restart() {
    use boxlite::{BoxliteError, ResizeOptions};
    const BOOT_MIB: u32 = 128;
    let t = BoxTestBase::with_options(BoxOptions {
        cpus: Some(1),
        memory_mib: Some(BOOT_MIB),
        ..common::alpine_opts()
    })
    .await;
    if let Err(error) = t.bx.start().await {
        let dir = t.home_dir().join("boxes").join(t.bx.id().as_str());
        for name in ["shim.stderr", "logs/console.log", "exit.json"] {
            eprintln!(
                "{name}: {}",
                std::fs::read_to_string(dir.join(name)).unwrap_or_default()
            );
        }
        panic!("memory test VM startup: {error}");
    }
    let initial = t.bx.info().await.unwrap();
    let current = t.bx.resize(ResizeOptions::default()).await.unwrap();
    assert!(
        current.max_memory_mib >= 512,
        "virtio-mem must be available: {current:?}"
    );
    async fn mem_total(t: &BoxTestBase) -> u64 {
        t.read_file("/proc/meminfo")
            .await
            .lines()
            .find(|line| line.starts_with("MemTotal:"))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap()
    }
    let before = mem_total(&t).await;
    eprintln!("initial resources={current:?}, MemTotal={before} KiB");
    assert!(
        before < u64::from(BOOT_MIB) * 1024,
        "all boot RAM must fit the allocation: {before} KiB"
    );
    // A fixed-memory boot must expose the same RAM as a boot with spare capacity.
    let mut fixed_options = BoxOptions {
        cpus: Some(1),
        memory_mib: Some(BOOT_MIB),
        ..common::alpine_opts()
    };
    fixed_options.advanced.security.resource_limits.max_memory = Some(32 * 1024 * 1024 * 1024);
    let fixed = BoxTestBase::with_options(fixed_options).await;
    fixed.bx.start().await.unwrap();
    assert_eq!(
        fixed
            .bx
            .resize(ResizeOptions::default())
            .await
            .unwrap()
            .max_memory_mib,
        BOOT_MIB
    );
    let fixed_total = mem_total(&fixed).await;
    fixed.bx.stop().await.unwrap();
    assert_eq!(
        before, fixed_total,
        "hotplug reservation must add no guest-usable RAM"
    );
    assert!(matches!(
        t.bx.resize(ResizeOptions {
            cpus: None,
            memory_mib: Some(BOOT_MIB + 1),
        })
        .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    let grown =
        t.bx.resize(ResizeOptions {
            cpus: None,
            memory_mib: Some(512),
        })
        .await
        .unwrap();
    assert_eq!(grown.memory_mib, 512);
    assert_eq!(t.bx.info().await.unwrap().pid, initial.pid);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let after = mem_total(&t).await;
        if after > before + 360 * 1024 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "memory did not online: {before} -> {after}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(matches!(
        t.bx.resize(ResizeOptions {
            cpus: None,
            memory_mib: Some(384),
        })
        .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    let large_target = current.max_memory_mib;
    let large =
        t.bx.resize(ResizeOptions {
            cpus: Some(current.max_cpus.min(2)),
            memory_mib: Some(large_target),
        })
        .await
        .unwrap();
    assert_eq!(large.memory_mib, large_target);
    assert_eq!(t.bx.info().await.unwrap().pid, initial.pid);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let total = mem_total(&t).await;
        assert!(total < u64::from(large_target) * 1024);
        if total > u64::from(large_target) * 1024 * 95 / 100 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "memory ceiling did not online: {total} KiB for {large_target} MiB"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let allocated = tokio::time::timeout(std::time::Duration::from_secs(30),
        t.exec_stdout("awk", &["BEGIN { for (i=0;i<96;i++) a[i]=sprintf(\"%4194304s%d\",\"\",i); print length(a[95]); }"])
    ).await.expect("guest allocation completed");
    assert_eq!(
        allocated.trim(),
        "4194306",
        "guest can allocate more than its boot RAM"
    );
    t.bx.stop().await.unwrap();
    let recovered = t.runtime.get(t.bx.id().as_str()).await.unwrap().unwrap();
    recovered.start().await.unwrap();
    assert_eq!(recovered.info().await.unwrap().memory_mib, large_target);
    recovered.stop().await.unwrap();
}

/// Memory growth is independent of networking and CPU cgroup delegation.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn resize_memory_works_without_network_or_spare_cpus() {
    use boxlite::{BoxliteError, ResizeOptions};
    for jailer_enabled in [true, false] {
        let mut options = BoxOptions {
            cpus: Some(1),
            memory_mib: Some(256),
            network: boxlite::runtime::options::NetworkSpec::Disabled,
            ..common::alpine_opts()
        };
        options.advanced.security.jailer_enabled = jailer_enabled;
        let t = BoxTestBase::with_options(options).await;
        t.bx.start().await.unwrap();
        let current = t.bx.resize(ResizeOptions::default()).await.unwrap();
        if !jailer_enabled {
            assert_eq!(current.max_cpus, 1);
        }
        assert!(matches!(
            t.bx.resize(ResizeOptions {
                cpus: Some(current.max_cpus + 1),
                memory_mib: Some(384),
            })
            .await,
            Err(BoxliteError::InvalidArgument(_))
        ));
        assert_eq!(
            t.bx.resize(ResizeOptions::default())
                .await
                .unwrap()
                .memory_mib,
            256
        );
        assert_eq!(
            t.bx.resize(ResizeOptions {
                memory_mib: Some(384),
                ..Default::default()
            })
            .await
            .unwrap()
            .memory_mib,
            384
        );
        t.bx.stop().await.unwrap();
    }
}

/// Box cgroup directory, matching the jailer's layout.
#[cfg(target_os = "linux")]
fn box_cgroup(box_id: &str) -> std::path::PathBuf {
    let uid = unsafe { libc::getuid() };
    let base = if uid == 0 {
        std::path::PathBuf::from("/sys/fs/cgroup")
    } else {
        format!("/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service").into()
    };
    base.join("boxlite").join(box_id)
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn resize_spare_vcpus_boot_offline_behind_a_one_cpu_quota() {
    let t = BoxTestBase::with_options(BoxOptions {
        cpus: Some(1),
        ..common::alpine_opts()
    })
    .await;
    t.bx.start().await.expect("start box");

    let cgroup = box_cgroup(t.bx.id().as_str());
    if !cgroup.join("cpu.max").exists() {
        eprintln!("skipping: the box cgroup has no cpu controller on this host");
        return;
    }

    assert_eq!(t.exec_stdout("nproc", &[]).await.trim(), "1");
    let online = t.read_file("/sys/devices/system/cpu/online").await;
    assert_eq!(online.trim(), "0");
    let present = t.read_file("/sys/devices/system/cpu/present").await;
    assert_ne!(present.trim(), "0", "the box boots spare vCPUs offline");

    let cpu_max = std::fs::read_to_string(cgroup.join("cpu.max")).expect("read cpu.max");
    assert_eq!(cpu_max.trim(), "100000 100000");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn resize_cpu_grows_without_restart_and_survives_recovery() {
    use boxlite::{BoxliteError, ResizeOptions};
    let t = BoxTestBase::with_options(BoxOptions {
        cpus: Some(1),
        ..common::alpine_opts()
    })
    .await;
    t.bx.start().await.unwrap();
    let initial = t.bx.info().await.unwrap();
    let current = t.bx.resize(ResizeOptions::default()).await.unwrap();
    if current.max_cpus < 2 {
        eprintln!("skipping: CPU growth requires a delegated cpu controller and two host CPUs");
        return;
    }
    let resized =
        t.bx.resize(ResizeOptions {
            cpus: Some(2),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(resized.cpus, 2);
    assert_eq!(
        t.bx.info().await.unwrap().pid,
        initial.pid,
        "online growth retains the VM"
    );
    assert_eq!(t.exec_stdout("nproc", &[]).await.trim(), "2");
    assert_eq!(
        t.read_file("/sys/devices/system/cpu/online").await.trim(),
        "0-1"
    );
    assert_eq!(
        std::fs::read_to_string(box_cgroup(t.bx.id().as_str()).join("cpu.max"))
            .unwrap()
            .trim(),
        "200000 100000"
    );
    assert!(matches!(
        t.bx.resize(ResizeOptions {
            cpus: Some(1),
            ..Default::default()
        })
        .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(matches!(
        t.bx.resize(ResizeOptions {
            cpus: Some(2),
            memory_mib: Some(resized.memory_mib - 1)
        })
        .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert_eq!(
        t.bx.resize(ResizeOptions {
            cpus: Some(2),
            ..Default::default()
        })
        .await
        .unwrap(),
        resized
    );
    t.bx.stop().await.unwrap();
    let recovered = t.runtime.get(t.bx.id().as_str()).await.unwrap().unwrap();
    recovered.start().await.unwrap();
    assert_eq!(recovered.info().await.unwrap().cpus, 2);
    recovered.stop().await.unwrap();
}
