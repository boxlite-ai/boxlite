//! Native KVM first-box acceptance: ext4 PID 1 boot, ready notification and exec.
//! Run with `make test:integration:vmm:native` on Linux x86_64 with /dev/kvm.

mod common;

use boxlite::BoxliteRuntime;
use boxlite::experimental::custom_kernel::{self, KernelFormat, KernelOptions};
use boxlite::experimental::{ExperimentalFeature, RuntimeBuilder, native_vmm};
use boxlite::runtime::options::BoxliteOptions;
use boxlite_test_utils::home::PerTestBoxHome;
use futures::StreamExt;

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

    bx.stop().await.expect("stop the native box");
    runtime
        .remove(bx.id().as_str(), true)
        .await
        .expect("remove the native box");
}

async fn shell_output(bx: &boxlite::LiteBox, script: &str) -> String {
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

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn online_disk_growth_keeps_workloads_and_recovers_an_interrupted_filesystem_step() {
    use boxlite::{BoxliteError, ResizeOptions};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

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
    assert_eq!(
        bx.resize(ResizeOptions {
            disk_size_gb: Some(20)
        })
        .await
        .unwrap()
        .disk_size_gb,
        20
    );
    let capacity = shell_output(&bx, "df -Pk / | awk 'NR==2 {print $2}'")
        .await
        .trim()
        .parse::<u64>()
        .unwrap();
    assert!(
        capacity > 19 * 1024 * 1024,
        "filesystem capacity: {capacity} KiB"
    );
    shell_output(&bx, "touch /tmp/resize-finished; dd if=/dev/zero of=/past-old-end bs=1M seek=11264 count=1 2>/dev/null; sync").await;
    assert_eq!(
        workload.wait().await.unwrap().exit_code,
        23,
        "the in-flight workload survived growth"
    );
    bx.resize(ResizeOptions {
        disk_size_gb: Some(20),
    })
    .await
    .unwrap();

    // Lose the host after sending device growth: no reply is read, no guest RPC runs.
    let layout = boxlite::runtime::layout::BoxFilesystemLayout::new(
        home.path.join("boxes").join(bx.id().as_str()),
        Default::default(),
        false,
    );
    let mut control = tokio::net::UnixStream::connect(layout.sockets().vmm_sock())
        .await
        .unwrap();
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
        shell_output(&bx, "df -Pk / | awk 'NR==2 {print $2}'")
            .await
            .trim()
            .parse::<u64>()
            .unwrap(),
        capacity,
        "query must leave the filesystem step pending"
    );

    let id = bx.id().to_string();
    bx.stop().await.unwrap();
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
    let capacity = shell_output(&restarted, "df -Pk / | awk 'NR==2 {print $2}'")
        .await
        .trim()
        .parse::<u64>()
        .unwrap();
    assert!(
        capacity > 23 * 1024 * 1024,
        "restart completed ext4 growth: {capacity} KiB"
    );
    // Materialize more than the original 20 GiB file-size limit after restart.
    tokio::time::timeout(Duration::from_secs(180), shell_output(&restarted,
        "dd if=/dev/zero of=/grow-fill bs=1M count=21504 2>/dev/null && sync && rm /grow-fill /past-old-end",
    )).await.expect("write beyond the old shim file-size limit");
    restarted.stop().await.unwrap();
    runtime.remove(&id, true).await.unwrap();
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a native runtime"]
async fn custom_disk_size_is_available_on_first_native_boot() {
    use futures::StreamExt;
    let kernel = std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL");
    let home = PerTestBoxHome::new();
    let runtime = native_runtime(&home);
    let mut options = common::alpine_opts();
    options.disk_size_gb = Some(20);
    custom_kernel::configure(
        &mut options,
        KernelOptions::new(kernel).with_format(KernelFormat::Elf),
    );
    native_vmm::configure(&mut options);
    let bx = runtime.create(options, None).await.unwrap();
    bx.start()
        .await
        .expect("a mounted root disk must support resize2fs at boot");
    let mut execution = bx
        .exec(boxlite::BoxCommand::new("sh").args(["-c", "df -Pk / | awk 'NR==2 {print $2}'"]))
        .await
        .unwrap();
    let mut output = String::new();
    let mut stdout = execution.stdout().unwrap();
    while let Some(chunk) = stdout.next().await {
        output.push_str(&chunk);
    }
    assert_eq!(execution.wait().await.unwrap().exit_code, 0);
    assert!(
        output.trim().parse::<u64>().unwrap() > 19 * 1024 * 1024,
        "filesystem must use the configured 20 GiB: {output}"
    );
    bx.stop().await.unwrap();
    runtime.remove(bx.id().as_str(), true).await.unwrap();
}
