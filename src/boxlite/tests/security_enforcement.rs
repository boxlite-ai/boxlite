//! Integration tests for security enforcement from GHSA-g6ww-w5j2-r7x3:
//!
//! 1. Read-only virtiofs volumes enforced at hypervisor level
//! 2. Dangerous capabilities excluded (CAP_SYS_ADMIN etc.)
//! 3. TSI network isolation when network disabled
//!
//! Run with:
//!
//! ```sh
//! cargo test -p boxlite --test security_enforcement -- --nocapture
//! ```

mod common;

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, NetworkSpec, RootfsSpec, VolumeSpec};
use boxlite::{BoxCommand, BoxliteRuntime, LiteBox};
use futures::StreamExt;
use tempfile::TempDir;

// ============================================================================
// HELPERS
// ============================================================================

async fn exec_stdout(bx: &LiteBox, cmd: BoxCommand) -> String {
    let mut execution = bx.exec(cmd).await.expect("exec failed");
    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }
    let result = execution.wait().await.expect("wait failed");
    assert_eq!(
        result.exit_code, 0,
        "command should exit 0, got stdout: {stdout}"
    );
    stdout
}

async fn exec_full(bx: &LiteBox, cmd: BoxCommand) -> (i32, String) {
    let mut execution = bx.exec(cmd).await.expect("exec failed");
    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }
    let result = execution.wait().await.expect("wait failed");
    (result.exit_code, stdout)
}

async fn exec_exit_code(bx: &LiteBox, cmd: BoxCommand) -> i32 {
    exec_full(bx, cmd).await.0
}

// ============================================================================
// TEST SUITE: single VM for virtiofs + capabilities tests
// ============================================================================

#[tokio::test(flavor = "multi_thread")]
async fn virtiofs_readonly_and_capabilities() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let ro_dir = TempDir::new_in("/tmp").unwrap();
    std::fs::write(ro_dir.path().join("secret.txt"), "classified\n").unwrap();

    let rw_dir = TempDir::new_in("/tmp").unwrap();

    let bx = runtime
        .create(
            BoxOptions {
                volumes: vec![
                    VolumeSpec {
                        host_path: ro_dir.path().to_str().unwrap().into(),
                        guest_path: "/data/readonly".into(),
                        read_only: true,
                    },
                    VolumeSpec {
                        host_path: rw_dir.path().to_str().unwrap().into(),
                        guest_path: "/data/writable".into(),
                        read_only: false,
                    },
                ],
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .expect("create box");
    bx.start().await.expect("start box");

    readonly_volume_readable(&bx).await;
    readonly_volume_blocks_write(&bx).await;
    readonly_volume_blocks_remount(&bx).await;
    rw_volume_allows_write(&bx).await;
    capabilities_exclude_sys_admin(&bx).await;
    capabilities_match_docker_defaults(&bx).await;

    bx.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Read-only virtiofs volume can be read.
async fn readonly_volume_readable(bx: &LiteBox) {
    let content = exec_stdout(bx, BoxCommand::new("cat").arg("/data/readonly/secret.txt")).await;
    assert_eq!(content.trim(), "classified");
}

/// Write to read-only virtiofs volume fails at hypervisor level.
async fn readonly_volume_blocks_write(bx: &LiteBox) {
    let exit = exec_exit_code(
        bx,
        BoxCommand::new("sh").args(["-c", "echo pwned > /data/readonly/hack.txt 2>&1"]),
    )
    .await;
    assert_ne!(exit, 0, "writing to read-only volume should fail");

    let check = exec_exit_code(
        bx,
        BoxCommand::new("test").args(["-f", "/data/readonly/hack.txt"]),
    )
    .await;
    assert_ne!(check, 0, "file should not exist on read-only volume");
}

/// Guest without CAP_SYS_ADMIN cannot remount read-only volume as read-write.
async fn readonly_volume_blocks_remount(bx: &LiteBox) {
    let (exit, output) = exec_full(
        bx,
        BoxCommand::new("sh").args(["-c", "mount -o remount,rw /data/readonly 2>&1"]),
    )
    .await;
    assert_ne!(exit, 0, "remount rw should fail without CAP_SYS_ADMIN");
    assert!(
        output.contains("ermission denied")
            || output.contains("peration not permitted")
            || output.contains("not permitted")
            || output.contains("EPERM")
            || output.contains("Read-only"),
        "error should indicate permission/readonly denial, got: {output}"
    );
}

/// Sanity check: writable volume does accept writes.
async fn rw_volume_allows_write(bx: &LiteBox) {
    let exit = exec_exit_code(
        bx,
        BoxCommand::new("sh").args(["-c", "echo ok > /data/writable/test.txt"]),
    )
    .await;
    assert_eq!(exit, 0, "writing to writable volume should succeed");

    let content = exec_stdout(bx, BoxCommand::new("cat").arg("/data/writable/test.txt")).await;
    assert_eq!(content.trim(), "ok");
}

/// CAP_SYS_ADMIN must NOT be in the effective capability set.
async fn capabilities_exclude_sys_admin(bx: &LiteBox) {
    let status = exec_stdout(
        bx,
        BoxCommand::new("sh").args(["-c", "grep '^CapEff:' /proc/1/status"]),
    )
    .await;

    let hex_str = status.trim().strip_prefix("CapEff:\t").unwrap_or("");
    let cap_bits = u64::from_str_radix(hex_str.trim(), 16).unwrap_or(0);

    // CAP_SYS_ADMIN = bit 21
    let cap_sys_admin = 1u64 << 21;
    assert_eq!(
        cap_bits & cap_sys_admin,
        0,
        "CAP_SYS_ADMIN (bit 21) must not be set, CapEff=0x{:x}",
        cap_bits
    );

    // CAP_NET_ADMIN = bit 12
    let cap_net_admin = 1u64 << 12;
    assert_eq!(
        cap_bits & cap_net_admin,
        0,
        "CAP_NET_ADMIN (bit 12) must not be set, CapEff=0x{:x}",
        cap_bits
    );
}

/// Verify the capability set matches Docker defaults (14 capabilities).
async fn capabilities_match_docker_defaults(bx: &LiteBox) {
    let status = exec_stdout(
        bx,
        BoxCommand::new("sh").args(["-c", "grep '^CapEff:' /proc/1/status"]),
    )
    .await;

    let hex_str = status.trim().strip_prefix("CapEff:\t").unwrap_or("");
    let cap_bits = u64::from_str_radix(hex_str.trim(), 16).unwrap_or(0);

    let expected_docker_caps: u64 = (1 << 0)  // CAP_CHOWN
        | (1 << 1)  // CAP_DAC_OVERRIDE
        | (1 << 3)  // CAP_FOWNER
        | (1 << 4)  // CAP_FSETID
        | (1 << 5)  // CAP_KILL
        | (1 << 6)  // CAP_SETGID
        | (1 << 7)  // CAP_SETUID
        | (1 << 8)  // CAP_SETPCAP
        | (1 << 10) // CAP_NET_BIND_SERVICE
        | (1 << 13) // CAP_NET_RAW
        | (1 << 18) // CAP_SYS_CHROOT
        | (1 << 27) // CAP_MKNOD
        | (1 << 29) // CAP_AUDIT_WRITE
        | (1 << 31); // CAP_SETFCAP

    assert_eq!(
        cap_bits,
        expected_docker_caps,
        "CapEff should match Docker defaults.\n  got:    0x{:016x}\n  expect: 0x{:016x}\n  diff:   0x{:016x}",
        cap_bits,
        expected_docker_caps,
        cap_bits ^ expected_docker_caps,
    );
}

// ============================================================================
// TEST: TSI isolation when network is disabled
// ============================================================================

#[tokio::test(flavor = "multi_thread")]
async fn disabled_network_blocks_tsi_socket_forwarding() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let bx = runtime
        .create(
            BoxOptions {
                network: NetworkSpec::Disabled,
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            None,
        )
        .await
        .expect("create box");
    bx.start().await.expect("start box");

    tsi_inet_blocked(&bx).await;
    tsi_unix_blocked(&bx).await;
    grpc_vsock_still_works(&bx).await;

    bx.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// AF_INET sockets should not be forwarded through TSI when network is disabled.
async fn tsi_inet_blocked(bx: &LiteBox) {
    let (_, output) = exec_full(
        bx,
        BoxCommand::new("sh").args([
            "-c",
            "wget -q -O /dev/null --timeout=3 http://1.1.1.1/ 2>&1; echo EXIT:$?",
        ]),
    )
    .await;

    let exit_line = output
        .lines()
        .find(|l| l.starts_with("EXIT:"))
        .unwrap_or("EXIT:unknown");
    assert_ne!(
        exit_line, "EXIT:0",
        "TCP to external IP should fail with TSI disabled, got: {output}"
    );
}

/// AF_UNIX sockets should not be transparently forwarded through TSI.
async fn tsi_unix_blocked(bx: &LiteBox) {
    let exit = exec_exit_code(
        bx,
        BoxCommand::new("sh").args(["-c", "test -S /var/run/docker.sock 2>/dev/null"]),
    )
    .await;
    assert_ne!(
        exit, 0,
        "host Unix sockets should not be visible in guest with TSI disabled"
    );
}

/// Host-guest gRPC channel (vsock IPC) must still work even with TSI disabled.
async fn grpc_vsock_still_works(bx: &LiteBox) {
    let out = exec_stdout(bx, BoxCommand::new("echo").arg("vsock-ok")).await;
    assert_eq!(out.trim(), "vsock-ok");
}
