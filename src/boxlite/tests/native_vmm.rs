//! Native KVM first-box acceptance: ext4 PID 1 boot, ready notification and exec.
//! Run with `make test:integration:vmm:native` on Linux x86_64 with /dev/kvm.

mod common;

use anyhow::{Context, ensure};
use boxlite::experimental::custom_kernel::{self, KernelFormat, KernelOptions};
use boxlite::experimental::{ExperimentalFeature, RuntimeBuilder, native_vmm};
use boxlite::runtime::layout::{BoxFilesystemLayout, FilesystemLayout};
use boxlite::runtime::options::BoxliteOptions;
use boxlite::{BoxliteError, BoxliteRuntime, LiteBox, ResizeOptions};
use boxlite_test_utils::home::PerTestBoxHome;
use futures::StreamExt;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

/// Console lines the boot must reach, in order.
const PROGRESS: &[&str] = &[
    "virtio_blk virtio0: [vda]",
    "virtio_blk virtio1: [vdb]",
    "Mounted root (ext4 filesystem) readonly",
    "devtmpfs: mounted",
    "Run /boxlite/bin/boxlite-guest as init process",
    "[guest] T+0ms: agent starting",
    "BoxLite Guest Agent starting",
    "init bootstrap completed",
    "kernel hardening applied",
    "zygote started",
    "tmpfs mounted",
    "loopback ready",
];

fn native_runtime(home: &PerTestBoxHome) -> BoxliteRuntime {
    RuntimeBuilder::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .enable(ExperimentalFeature::CustomKernel)
    .enable(ExperimentalFeature::NativeVmm)
    .build()
    .expect("create the native runtime")
}

/// Asserts that each of `steps` is found in `log`, in that order.
fn assert_in_order(log: &str, steps: &[&str]) {
    let mut rest = log;
    for step in steps {
        let Some(at) = rest.find(step) else {
            panic!("missing {step:?} after the earlier steps; console:\n{log}");
        };
        rest = &rest[at + step.len()..];
    }
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a boxlite-shim built with native"]
async fn first_box_runs_boxlite_guest_as_pid_1_on_the_ext4_root() {
    let kernel = std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL or run make vmm:boot");
    let home = PerTestBoxHome::new();
    let runtime = native_runtime(&home);

    let mut options = common::alpine_opts();
    custom_kernel::configure(
        &mut options,
        KernelOptions::new(kernel).with_format(KernelFormat::Elf),
    );
    native_vmm::configure(&mut options);
    let bx = runtime.create(options, None).await.expect("create the box");

    bx.start().await.expect("native box must become ready");
    let setup = bx
        .exec(boxlite::BoxCommand::new("sh").args([
            "-c",
            "printf '#!/bin/sh\nexit 23\n' > /tmp/native-entrypoint; chmod +x /tmp/native-entrypoint",
        ]))
        .await
        .expect("create a script entrypoint");
    assert_eq!(setup.wait().await.unwrap().exit_code, 0);
    let execution = bx
        .exec(boxlite::BoxCommand::new("/tmp/native-entrypoint"))
        .await
        .expect("native exec of a shebang script");
    assert_eq!(execution.wait().await.unwrap().exit_code, 23);

    let console_log = home
        .path
        .join("boxes")
        .join(bx.id().as_str())
        .join("logs")
        .join("console.log");
    let console = std::fs::read_to_string(&console_log)
        .unwrap_or_else(|e| panic!("read {}: {e}", console_log.display()));
    println!("--- console.log ---\n{console}");

    assert_in_order(&console, PROGRESS);
    assert!(
        !console.contains("Unable to mount root fs"),
        "the kernel did not mount the guest root"
    );
    assert!(console.contains("server bound (vsock:2695)"));
    assert!(!console.contains("Failed to connect to notify vsock"));
    assert!(!console.contains("Kernel panic"), "console:\n{console}");
    assert!(
        !console.contains("Resizing ext4 filesystem on"),
        "default disk sizing must not resize the mounted root filesystem"
    );

    bx.stop().await.expect("stop the native box");
    runtime
        .remove(bx.id().as_str(), true)
        .await
        .expect("remove the native box");
}

async fn shell_output(bx: &LiteBox, script: &str) -> String {
    let mut execution = bx
        .exec(boxlite::BoxCommand::new("sh").args(["-c", script]))
        .await
        .unwrap();
    let mut output = String::new();
    if let Some(mut stdout) = execution.stdout() {
        while let Some(chunk) = stdout.next().await {
            output.push_str(&chunk);
        }
    }
    assert_eq!(
        execution.wait().await.unwrap().exit_code,
        0,
        "script: {script}"
    );
    output
}

async fn root_capacity_kib(bx: &LiteBox) -> u64 {
    shell_output(bx, "df -Pk / | awk 'NR==2 {print $2}'")
        .await
        .trim()
        .parse()
        .unwrap()
}

fn open_box_db(home: &PerTestBoxHome, flags: rusqlite::OpenFlags) -> rusqlite::Connection {
    let layout = FilesystemLayout::new(home.path.clone(), Default::default());
    rusqlite::Connection::open_with_flags(layout.db_dir().join("boxlite.db"), flags).unwrap()
}

fn configured_disk_size_gb(
    db: &rusqlite::Connection,
    bx: &LiteBox,
) -> rusqlite::Result<Option<i64>> {
    db.query_row(
        "SELECT json_extract(json, '$.options.disk_size_gb') FROM box_config WHERE id = ?1",
        [bx.id().as_str()],
        |row| row.get(0),
    )
}

fn completed_disk_size_gb(
    db: &rusqlite::Connection,
    bx: &LiteBox,
) -> rusqlite::Result<Option<i64>> {
    db.query_row(
        "SELECT json_extract(json, '$.disk_size_gb') FROM box_state WHERE id = ?1",
        [bx.id().as_str()],
        |row| row.get(0),
    )
}

async fn resize_with_lost_shim_reply(
    bx: &LiteBox,
    target: ResizeOptions,
    socket_path: &Path,
    db: &rusqlite::Connection,
) -> anyhow::Result<()> {
    let target_gib = target.disk_size_gb.context("expected an explicit target")?;
    let previous_target = completed_disk_size_gb(db, bx)?;
    let shim_path = socket_path.with_file_name("resize-shim.sock");
    std::fs::rename(socket_path, &shim_path).context("move the live shim socket")?;

    let exchange = async {
        let listener = UnixListener::bind(socket_path)?;
        let proxy = async {
            let (mut client, _) = listener.accept().await?;
            // Sample the database before the shim can receive the request.
            let target_at_dispatch = completed_disk_size_gb(db, bx);
            let mut shim = UnixStream::connect(&shim_path).await?;
            let (mut shim_read, mut shim_write) = shim.split();
            let mut reply = String::new();
            // The shim closes after its HTTP response. Dropping the client here
            // leaves the response unread by the runtime.
            tokio::select! {
                result = shim_read.read_to_string(&mut reply) => { result?; }
                result = tokio::io::copy(&mut client, &mut shim_write) => {
                    result?;
                    anyhow::bail!("resize client closed before the shim replied");
                }
            }
            Ok::<_, anyhow::Error>((target_at_dispatch?, reply))
        };
        let (resize, intercepted) = tokio::join!(bx.resize(target), proxy);
        Ok::<_, anyhow::Error>((resize, intercepted?))
    };
    let exchange = tokio::time::timeout(Duration::from_secs(20), exchange).await;
    std::fs::rename(&shim_path, socket_path).context("restore the live shim socket")?;
    let (resize, (target_at_dispatch, reply)) =
        exchange.context("intercept the resize reply")??;

    let (headers, body) = reply
        .split_once("\r\n\r\n")
        .context("read the shim response")?;
    ensure!(
        headers.starts_with("HTTP/1.1 200 "),
        "shim response: {reply}"
    );
    let body: serde_json::Value = serde_json::from_str(body)?;
    ensure!(
        body == serde_json::json!({"Ok":{"disk_size":target_gib << 30}}),
        "shim resize result: {body}"
    );
    ensure!(
        matches!(&resize, Err(BoxliteError::Engine(message))
            if message.contains("completion is unknown") && message.contains("retry the target")),
        "unexpected resize result after dropping the successful shim reply: {resize:?}"
    );
    ensure!(
        target_at_dispatch == previous_target,
        "dispatch changed the completed disk target from {previous_target:?} to {target_at_dispatch:?}"
    );
    ensure!(
        completed_disk_size_gb(db, bx)? == previous_target,
        "a lost reply changed the completed disk target"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn online_resize_allows_other_execs_to_exit() {
    const ORIGINAL_TOOL: &str = "BOXLITE_TEST_ORIGINAL_RESIZE2FS";
    let Some(original) = std::env::var_os(ORIGINAL_TOOL) else {
        // GuestArtifacts caches its resolution per process. Override only this VM's tool.
        let tool = boxlite::util::find_binary("guest-resize2fs").unwrap();
        let shim = boxlite::util::find_binary("boxlite-shim").unwrap();
        let probe = std::env::var_os("VMM_GUEST_PROBE").expect("set VMM_GUEST_PROBE");
        let fixture = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(probe, fixture.path().join("guest-resize2fs")).unwrap();
        let paths = std::env::var_os("BOXLITE_RUNTIME_DIR")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_else(|| vec![shim.parent().unwrap().to_owned()]);
        let runtime_dirs =
            std::env::join_paths(std::iter::once(fixture.path().to_owned()).chain(paths)).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "online_resize_allows_other_execs_to_exit",
            ])
            .env(ORIGINAL_TOOL, tool)
            .env("BOXLITE_RUNTIME_DIR", runtime_dirs)
            .status()
            .unwrap();
        assert!(status.success(), "isolated resize regression: {status}");
        return;
    };

    let kernel = std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL");
    let home = PerTestBoxHome::new();
    let runtime = native_runtime(&home);
    let mut options = common::alpine_opts();
    options.cpus = Some(1.0);
    options.disk_size_gb = Some(10);
    custom_kernel::configure(
        &mut options,
        KernelOptions::new(kernel).with_format(KernelFormat::Elf),
    );
    native_vmm::configure(&mut options);
    let bx = runtime.create(options, None).await.unwrap();
    let layout = BoxFilesystemLayout::new(
        home.path.join("boxes").join(bx.id().as_str()),
        Default::default(),
        false,
    );
    let gate = layout.shared_dir().join("resize-reaper-probe");
    std::fs::create_dir_all(&gate).unwrap();
    std::fs::copy(original, gate.join("resize2fs")).unwrap();
    bx.start().await.unwrap();

    let mut exec = bx
        .exec(boxlite::BoxCommand::new("sh").args(["-c", "read -r input; exit 23"]))
        .await
        .unwrap();
    let mut stdin = exec.stdin().unwrap();
    std::fs::write(gate.join("armed"), b"").unwrap();
    let resize = bx.resize(ResizeOptions {
        disk_size_gb: Some(20),
    });
    tokio::pin!(resize);
    let wait = tokio::select! {
        result = &mut resize => panic!("resize returned before reaching the gate: {result:?}"),
        wait = async {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !gate.join("started").exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("resize2fs never reached the gate");
            stdin.write_all(b"exit\n").await.unwrap();
            tokio::time::timeout(Duration::from_secs(3), exec.wait()).await
        } => wait,
    };
    // Release the fixture, finish the real ext4 resize, and stop even on regression.
    std::fs::write(gate.join("release"), b"").unwrap();
    let grown = resize.await.unwrap();
    bx.stop().await.unwrap();
    runtime.remove(bx.id().as_str(), true).await.unwrap();
    assert_eq!(grown.disk_size_gb, 20);
    assert_eq!(
        wait.expect("exec exit was blocked while resize2fs was running")
            .unwrap()
            .exit_code,
        23
    );
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn resize_after_snapshot_restore_uses_the_restored_disk_size() {
    let kernel = std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL");
    let home = PerTestBoxHome::new();
    let runtime = native_runtime(&home);
    let mut options = common::alpine_opts();
    options.disk_size_gb = Some(10);
    custom_kernel::configure(
        &mut options,
        KernelOptions::new(kernel).with_format(KernelFormat::Elf),
    );
    native_vmm::configure(&mut options);
    let bx = runtime.create(options, None).await.unwrap();
    let id = bx.id().to_string();
    bx.start().await.unwrap();
    bx.stop().await.unwrap();
    drop(bx);

    let bx = runtime.get(&id).await.unwrap().unwrap();
    let snapshot = bx
        .snapshots()
        .create(Default::default(), "before-growth")
        .await
        .unwrap();
    assert_eq!(snapshot.disk_info.container_disk_bytes, 10_u64 << 30);
    bx.start().await.unwrap();
    let grown = bx
        .resize(ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
        .unwrap();
    assert_eq!(grown.disk_size_gb, 20);
    let db = open_box_db(&home, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), Some(20));
    assert_eq!(configured_disk_size_gb(&db, &bx).unwrap(), Some(10));
    bx.stop().await.unwrap();
    drop(bx);

    let bx = runtime.get(&id).await.unwrap().unwrap();
    bx.snapshots().restore(&snapshot.name).await.unwrap();
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), Some(20));

    let archive = bx
        .export(Default::default(), &home.path.join("restored.boxlite"))
        .await
        .unwrap();
    let imported = runtime.import_box(archive, None).await.unwrap();
    let imported_configured_gib = configured_disk_size_gb(&db, &imported).unwrap();
    let imported_completed_gib = completed_disk_size_gb(&db, &imported).unwrap();
    imported.start().await.unwrap();
    let imported_disk = imported.resize(ResizeOptions::default()).await.unwrap();
    let imported_filesystem_kib = root_capacity_kib(&imported).await;
    imported.stop().await.unwrap();
    runtime.remove(imported.id().as_str(), true).await.unwrap();

    bx.start().await.unwrap();
    let restored = bx.resize(ResizeOptions::default()).await.unwrap();
    assert_eq!(restored.disk_size_gb, 10);
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), Some(20));

    let grown = bx
        .resize(ResizeOptions {
            disk_size_gb: Some(15),
        })
        .await
        .unwrap();
    assert_eq!(grown.disk_size_gb, 15);
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), Some(15));
    assert_eq!(configured_disk_size_gb(&db, &bx).unwrap(), Some(10));
    bx.stop().await.unwrap();
    runtime.remove(&id, true).await.unwrap();

    assert_eq!(imported_disk.disk_size_gb, 10);
    assert!(
        (9 * 1024 * 1024..=10 * 1024 * 1024).contains(&imported_filesystem_kib),
        "the imported root filesystem must use the restored 10 GiB disk: {imported_filesystem_kib} KiB"
    );
    assert_eq!(imported_configured_gib, Some(20));
    assert_eq!(imported_completed_gib, None);
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn online_disk_growth_keeps_workloads_and_recovers_an_interrupted_filesystem_step() {
    let kernel = std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL");
    let temp_dir = std::env::temp_dir();
    let home = PerTestBoxHome::new_in(
        temp_dir
            .to_str()
            .expect("test temp directory must be UTF-8"),
    );
    let runtime = native_runtime(&home);
    let mut options = common::alpine_opts();
    options.disk_size_gb = Some(10);
    options.detach = true;
    custom_kernel::configure(
        &mut options,
        KernelOptions::new(kernel).with_format(KernelFormat::Elf),
    );
    native_vmm::configure(&mut options);
    let bx = runtime.create(options, None).await.unwrap();
    bx.start().await.unwrap();
    assert_eq!(
        bx.resize(ResizeOptions::default())
            .await
            .unwrap()
            .disk_size_gb,
        10
    );
    assert!(matches!(
        bx.resize(ResizeOptions {
            disk_size_gb: Some(9)
        })
        .await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    let workload = bx.exec(boxlite::BoxCommand::new("sh").args([
        "-c", "touch /tmp/resize-running; while [ ! -e /tmp/resize-finished ]; do sleep 0.01; done; exit 23",
    ])).await.unwrap();
    shell_output(
        &bx,
        "while [ ! -e /tmp/resize-running ]; do sleep 0.01; done",
    )
    .await;
    let layout = BoxFilesystemLayout::new(
        home.path.join("boxes").join(bx.id().as_str()),
        Default::default(),
        false,
    );
    let vmm_socket = layout.sockets().vmm_sock();
    let db = open_box_db(&home, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), None);
    let target = ResizeOptions {
        disk_size_gb: Some(20),
    };
    let initial_capacity = root_capacity_kib(&bx).await;
    if let Err(error) = resize_with_lost_shim_reply(&bx, target, &vmm_socket, &db).await {
        let stop = bx.stop().await;
        let remove = runtime.remove(bx.id().as_str(), true).await;
        panic!("resize with lost shim reply: {error:#}\nstop: {stop:?}\nremove: {remove:?}");
    }
    assert_eq!(
        root_capacity_kib(&bx).await,
        initial_capacity,
        "the filesystem step remains pending after losing the shim reply"
    );
    assert_eq!(
        bx.resize(ResizeOptions::default())
            .await
            .unwrap()
            .disk_size_gb,
        20
    );
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), None);
    assert_eq!(bx.resize(target).await.unwrap().disk_size_gb, 20);
    let capacity = root_capacity_kib(&bx).await;
    assert!(
        capacity > 19 * 1024 * 1024,
        "filesystem capacity: {capacity} KiB"
    );
    let completed_gib = completed_disk_size_gb(&db, &bx).unwrap();
    let configured_gib = configured_disk_size_gb(&db, &bx).unwrap();
    shell_output(&bx, "touch /tmp/resize-finished; dd if=/dev/zero of=/past-old-end bs=1M seek=11264 count=1 2>/dev/null; sync").await;
    assert_eq!(
        workload.wait().await.unwrap().exit_code,
        23,
        "the in-flight workload survived growth"
    );
    drop(workload);
    if completed_gib != Some(20) || configured_gib != Some(10) {
        bx.stop().await.unwrap();
        runtime.remove(bx.id().as_str(), true).await.unwrap();
    }
    assert_eq!(completed_gib, Some(20));
    assert_eq!(configured_gib, Some(10));
    bx.resize(target).await.unwrap();

    // Lose the host after sending device growth: no reply is read, no guest RPC runs.
    let mut control = UnixStream::connect(&vmm_socket).await.unwrap();
    let body = serde_json::json!({"block_id":"vda","bytes":24_u64 << 30}).to_string();
    let request = format!(
        "POST /v1/resize-disk HTTP/1.1\r\n\
         Host: vmm\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    control.write_all(request.as_bytes()).await.unwrap();
    drop(control);
    tokio::time::timeout(Duration::from_secs(15), async {
        while bx
            .resize(ResizeOptions::default())
            .await
            .unwrap()
            .disk_size_gb
            != 24
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("query recovers the device growth without its reply");
    assert_eq!(
        root_capacity_kib(&bx).await,
        capacity,
        "query must leave the filesystem step pending"
    );
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), Some(20));

    // An unavailable shim leaves the completed disk target intact.
    let hidden_socket = vmm_socket.with_file_name("resize-shim.sock");
    std::fs::rename(&vmm_socket, &hidden_socket).unwrap();
    let undispatched = bx
        .resize(ResizeOptions {
            disk_size_gb: Some(30),
        })
        .await;
    std::fs::rename(&hidden_socket, &vmm_socket).unwrap();
    assert!(matches!(undispatched, Err(BoxliteError::Unsupported(_))));
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), Some(20));

    let id = bx.id().to_string();
    drop(bx);
    drop(runtime);
    let runtime = native_runtime(&home);
    let adopted = runtime.get(&id).await.unwrap().unwrap();
    assert_eq!(
        adopted
            .resize(ResizeOptions::default())
            .await
            .unwrap()
            .disk_size_gb,
        24
    );
    assert_eq!(completed_disk_size_gb(&db, &adopted).unwrap(), Some(20));

    adopted.stop().await.unwrap();
    let restarted = runtime.get(&id).await.unwrap().unwrap();
    restarted.start().await.unwrap();
    assert_eq!(
        restarted
            .resize(ResizeOptions::default())
            .await
            .unwrap()
            .disk_size_gb,
        24
    );
    let restarted_capacity = root_capacity_kib(&restarted).await;
    let restarted_target = completed_disk_size_gb(&db, &restarted).unwrap();
    if restarted_capacity != capacity || restarted_target != Some(20) {
        restarted.stop().await.unwrap();
        runtime.remove(&id, true).await.unwrap();
    }
    assert_eq!(
        restarted_capacity, capacity,
        "starting with the existing disk leaves ext4 growth pending"
    );
    assert_eq!(restarted_target, Some(20));
    let grown = restarted
        .resize(ResizeOptions {
            disk_size_gb: Some(24),
        })
        .await
        .unwrap();
    assert_eq!(grown.disk_size_gb, 24);
    let capacity = root_capacity_kib(&restarted).await;
    assert!(
        capacity > 23 * 1024 * 1024,
        "retry completed ext4 growth: {capacity} KiB"
    );
    assert_eq!(completed_disk_size_gb(&db, &restarted).unwrap(), Some(24));
    // Write 21 GiB to verify the recovered filesystem can use the grown disk.
    let fill = tokio::time::timeout(Duration::from_secs(180), async {
        restarted
            .exec(boxlite::BoxCommand::new("sh").args([
                "-c",
                "dd if=/dev/zero of=/grow-fill bs=1M count=21504 2>/dev/null && sync && rm /grow-fill /past-old-end",
            ]))
            .await?
            .wait()
            .await
    })
    .await;
    restarted.stop().await.unwrap();
    runtime.remove(&id, true).await.unwrap();
    assert_eq!(
        fill.expect("write 21 GiB to the recovered filesystem")
            .unwrap()
            .exit_code,
        0
    );
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn first_native_boot_uses_creation_size_with_legacy_state() {
    assert_native_boot_disk(BootDisk::LegacyState).await;
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn first_native_boot_uses_latest_completed_disk_target() {
    assert_native_boot_disk(BootDisk::NewWithCompletedTarget).await;
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn failed_native_boot_recreates_missing_disk_at_latest_completed_target() {
    assert_native_boot_disk(BootDisk::MissingAfterFailure).await;
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn failed_native_boot_reuses_intact_disk_and_preserves_data() {
    assert_native_boot_disk(BootDisk::RestoredAfterFailure).await;
}

enum BootDisk {
    LegacyState,
    NewWithCompletedTarget,
    MissingAfterFailure,
    RestoredAfterFailure,
}

async fn assert_native_boot_disk(scenario: BootDisk) {
    let kernel = std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL");
    let home = PerTestBoxHome::new();
    let runtime = native_runtime(&home);
    let mut options = common::alpine_opts();
    options.disk_size_gb = Some(10);
    custom_kernel::configure(
        &mut options,
        KernelOptions::new(kernel).with_format(KernelFormat::Elf),
    );
    native_vmm::configure(&mut options);
    let mut bx = runtime.create(options, None).await.unwrap();
    let db = open_box_db(&home, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE);
    if matches!(
        scenario,
        BootDisk::MissingAfterFailure | BootDisk::RestoredAfterFailure
    ) {
        bx.start().await.unwrap();
        if matches!(scenario, BootDisk::RestoredAfterFailure) {
            shell_output(&bx, "printf preserved > /boot-retry-marker; sync").await;
        }
        bx.stop().await.unwrap();
        let id = bx.id().to_string();
        drop(bx);
        bx = runtime.get(&id).await.unwrap().unwrap();

        let layout =
            BoxFilesystemLayout::new(home.path.join("boxes").join(&id), Default::default(), false);
        let disk = layout.disk_path();
        let saved_disk = disk.with_file_name("before-failed-start.qcow2");
        std::fs::rename(&disk, &saved_disk).unwrap();
        let error = bx.start().await.unwrap_err();
        assert!(
            matches!(&error, BoxliteError::Storage(message)
                if message.contains("Cannot restart: container rootfs disk not found")),
            "{error}"
        );
        let status: String = db
            .query_row("SELECT status FROM box_state WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "failed");
        if matches!(scenario, BootDisk::RestoredAfterFailure) {
            std::fs::rename(saved_disk, disk).unwrap();
        }
    }
    assert_eq!(configured_disk_size_gb(&db, &bx).unwrap(), Some(10));
    assert_eq!(completed_disk_size_gb(&db, &bx).unwrap(), None);
    let update_state = match scenario {
        BootDisk::LegacyState => {
            "UPDATE box_state SET json = json_remove(json, '$.disk_size_gb') WHERE id = ?1"
        }
        _ => "UPDATE box_state SET json = json_set(json, '$.disk_size_gb', 20) WHERE id = ?1",
    };
    assert_eq!(db.execute(update_state, [bx.id().as_str()]).unwrap(), 1);

    bx.start()
        .await
        .expect("native box starts with its root disk");
    let actual_gib = bx
        .resize(ResizeOptions::default())
        .await
        .unwrap()
        .disk_size_gb;
    let capacity = root_capacity_kib(&bx).await;
    let marker = if matches!(scenario, BootDisk::RestoredAfterFailure) {
        Some(shell_output(&bx, "cat /boot-retry-marker 2>/dev/null || true").await)
    } else {
        None
    };
    bx.stop().await.unwrap();
    runtime.remove(bx.id().as_str(), true).await.unwrap();

    let expected_gib = match scenario {
        BootDisk::LegacyState | BootDisk::RestoredAfterFailure => 10,
        BootDisk::NewWithCompletedTarget | BootDisk::MissingAfterFailure => 20,
    };
    assert_eq!(actual_gib, expected_gib);
    assert!(
        (((expected_gib - 1) << 20)..=(expected_gib << 20)).contains(&capacity),
        "filesystem must use the {expected_gib} GiB disk: {capacity} KiB"
    );
    if let Some(marker) = marker {
        assert_eq!(marker, "preserved");
    }
}
