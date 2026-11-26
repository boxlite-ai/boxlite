//! The real guest owns PID 1 on a read-only ext4 root. A test-only child
//! observes its mounts and serves as the Unix RPC client inside the VM.

use std::os::unix::fs::PermissionsExt;

use super::*;

const DEFAULT_MEMORY_MIB: u32 = 512;
const SIX_GIB_MIB: u32 = 6144;

fn guest_root(test_box: &TestBox) -> crate::disk::Disk {
    let root = test_box.home.path().join("guest-root");
    for path in ["dev", "proc", "sys", "tmp", "var/tmp", "run"] {
        fs::create_dir_all(root.join(path)).unwrap();
    }
    for (variable, name) in [("VMM_GUEST", "boxlite-guest"), ("VMM_GUEST_PROBE", "init")] {
        let source = std::env::var_os(variable).unwrap_or_else(|| panic!("set {variable}"));
        let destination = root.join(name);
        fs::copy(source, &destination).unwrap();
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let bases = test_box.home.path().join("bases");
    fs::create_dir_all(&bases).unwrap();
    crate::disk::create_ext4_from_dir(&root, &bases.join("guest.ext4"), 0).unwrap()
}

async fn boot(scenario: &str, memory_mib: u32) -> String {
    let test_box = TestBox::new();
    let root_disk = guest_root(&test_box);
    let kernel = fs::read(std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL")).unwrap();
    let prepared = test_box.stage_kernel(&kernel, None);
    let mut spec = test_box.spec(Some(prepared));

    // vda only preserves the runtime's disk order; neither fixture needs writes.
    let container_disk = test_box.layout.disk_path();
    fs::File::create(&container_disk)
        .unwrap()
        .set_len(1024 * 1024)
        .unwrap();
    for (block_id, disk_path) in [
        ("vda", container_disk),
        ("vdb", root_disk.path().to_path_buf()),
    ] {
        spec.block_devices.add(BlockDevice {
            block_id: block_id.to_string(),
            disk_path,
            format: DiskFormat::Raw,
            read_only: true,
        });
    }
    spec.guest_rootfs.path = test_box.home.path().join("guest-root");
    spec.guest_rootfs.strategy = Strategy::Disk {
        disk_path: root_disk.path().to_path_buf(),
        device_path: Some("/dev/vdb".to_string()),
    };
    spec.memory_mib = Some(memory_mib);
    spec.guest_entrypoint.args.push(scenario.to_string());

    let exit = test_box.run_shim(&spec).await;
    let console = test_box.console();
    assert_eq!(exit, ProcessExit::Code(0), "{console}");
    assert!(
        console.contains("Mounted root (ext4 filesystem) readonly"),
        "{console}"
    );
    assert!(!console.contains("Kernel panic"), "{console}");
    assert!(!console.contains("BOOT_PROBE_FAILED"), "{console}");
    console
}

#[tokio::test]
#[ignore = "requires KVM, VMM_KERNEL and the real guest binaries"]
async fn a_rust_caller_resizes_vcpus_with_the_real_guest_agent() {
    use crate::portal::connection::Connection;
    use boxlite_shared::{GuestClient, SetOnlineCpusRequest};

    let test_box = TestBox::new();
    let root_disk = guest_root(&test_box);
    let kernel = fs::read(std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL")).unwrap();
    let prepared = test_box.stage_kernel(&kernel, None);
    let mut spec = test_box.spec(Some(prepared));
    spec.block_devices.add(BlockDevice {
        block_id: "vda".into(),
        disk_path: root_disk.path().into(),
        format: DiskFormat::Raw,
        read_only: true,
    });
    spec.guest_rootfs.strategy = Strategy::Disk {
        disk_path: root_disk.path().into(),
        device_path: Some("/dev/vda".into()),
    };
    spec.guest_entrypoint.executable = "/boxlite-guest".into();
    spec.guest_entrypoint.args = vec![
        "--listen".into(),
        format!("unix://{}", test_box.layout.socket_path().display()),
    ];

    let mut config = build_config(&spec).unwrap();
    config.max_vcpus = 4;
    let console = fs::File::create(test_box.layout.console_output_path()).unwrap();
    let mut vm = boxlite_vmm::Vm::new(config, Box::new(console)).unwrap();
    let control = vm.control();
    let worker = std::thread::spawn(move || vm.run());
    let result = tokio::time::timeout(SHIM_TIMEOUT, async {
        let mut guest = loop {
            let endpoint = Connection::new(spec.transport.clone()).channel().await?;
            let mut guest = GuestClient::new(endpoint);
            if let Ok(response) = guest
                .set_online_cpus(SetOnlineCpusRequest { count: 1 })
                .await
            {
                break (guest, response.into_inner().online);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let (client, boot) = (&mut guest.0, guest.1);
        let boot_workers = vcpu_worker_count();
        let grow = control.clone();
        let granted = tokio::task::spawn_blocking(move || grow.set_online_vcpus(4)).await??;
        let expanded = client
            .set_online_cpus(SetOnlineCpusRequest { count: 4 })
            .await?
            .into_inner()
            .online;
        let grown_workers = vcpu_worker_count();
        let shrunk = client
            .set_online_cpus(SetOnlineCpusRequest { count: 2 })
            .await?
            .into_inner()
            .online;
        let shrink = control.clone();
        let revoked = tokio::task::spawn_blocking(move || shrink.set_online_vcpus(2)).await??;
        Ok::<_, Box<dyn std::error::Error>>((
            boot,
            expanded,
            shrunk,
            [granted, revoked],
            [boot_workers, grown_workers, vcpu_worker_count()],
        ))
    })
    .await;
    control.stop();
    let ended = worker.join().unwrap();
    let console = test_box.console();
    assert_eq!(
        ended.unwrap(),
        boxlite_vmm::VmExit::StopRequested,
        "{console}"
    );
    let (boot, expanded, shrunk, grants, workers) = result
        .expect("guest resize timed out")
        .unwrap_or_else(|error| panic!("guest resize failed: {error}\n{console}"));
    assert_eq!(boot, [0]);
    assert_eq!(expanded, [0, 1, 2, 3]);
    assert_eq!(shrunk, [0, 1]);
    assert_eq!(grants, [4, 2]);
    assert_eq!(workers, [1, 4, 2]);
}

fn vcpu_worker_count() -> usize {
    fs::read_dir("/proc/self/task")
        .unwrap()
        .filter_map(|entry| fs::read_to_string(entry.ok()?.path().join("comm")).ok())
        .filter(|name| {
            name.trim()
                .strip_prefix("vcpu")
                .is_some_and(|id| id.parse::<u8>().is_ok())
        })
        .count()
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_bootstraps_the_real_guest_and_serves_unix_rpc() {
    let console = boot("fresh", DEFAULT_MEMORY_MIB).await;
    assert!(console.contains("BOXLITE_GUEST_BOOT_OK"), "{console}");
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn a_six_gib_guest_boots_and_prints_the_boot_ok_marker() {
    let console = boot("fresh", SIX_GIB_MIB).await;
    assert!(console.contains("BOXLITE_GUEST_BOOT_OK"), "{console}");
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_reuses_existing_mounts_and_applies_hostname() {
    let console = boot("premounted", DEFAULT_MEMORY_MIB).await;
    assert!(console.contains("BOXLITE_GUEST_BOOT_OK"), "{console}");
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_restarts_on_argument_and_startup_errors() {
    for (scenario, diagnostic, status) in [
        ("bad-args", "unexpected argument", 2),
        ("help", "BoxLite Guest Agent", 0),
        ("bad-uri", "Invalid listen URI", 1),
    ] {
        let console = boot(scenario, DEFAULT_MEMORY_MIB).await;
        assert!(console.contains(diagnostic), "{console}");
        assert!(
            console.contains(&format!("PID 1 restarting (status {status})")),
            "{console}"
        );
    }
}

#[tokio::test]
#[ignore = "requires native shim, KVM, VMM_KERNEL, VMM_GUEST and VMM_GUEST_PROBE"]
async fn init_rejects_incorrect_mount_types_without_overmounting() {
    for (scenario, diagnostic) in [
        ("wrong-proc", "/proc has an unexpected filesystem"),
        ("wrong-proc-bind", "/proc has an unexpected filesystem"),
        ("wrong-dev", "/dev is mounted as tmpfs, expected devtmpfs"),
        ("wrong-run", "/run is mounted as proc, expected tmpfs"),
        (
            "wrong-run-stacked",
            "/run is mounted as proc, expected tmpfs",
        ),
    ] {
        let console = boot(scenario, DEFAULT_MEMORY_MIB).await;
        assert!(console.contains(diagnostic), "{console}");
        assert!(console.contains("PID 1 restarting (status 1)"), "{console}");
        assert!(!console.contains("zygote started"), "{console}");
    }
}
