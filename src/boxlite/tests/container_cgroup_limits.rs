//! Box CPU and memory limits are readable inside the container as cgroup v2
//! files (#2694).
//!
//! - A non-privileged container sees its own cgroup at `/sys/fs/cgroup`:
//!   `cpu.max` and `memory.max` match the box size, `pids.max` is `max`, a
//!   non-root user can read them, and nobody can write them.
//! - A privileged container keeps the writable guest tree that `dockerd`
//!   needs; the same limits sit under its `:youki:<id>` cgroup.
//!
//! Run with:
//!
//! ```sh
//! make test:integration:rust NEXTEST_FILTER='-E "binary(container_cgroup_limits)"'
//! ```

mod common;

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite::{BoxCommand, LiteBox};
use futures::StreamExt;

const CPU_MAX: &str = "200000 100000";
const MEMORY_MAX: &str = "3221225472";

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

async fn sh(bx: &LiteBox, script: &str, user: Option<&str>) -> (i32, String) {
    let mut cmd = BoxCommand::new("sh").args(["-c", script]);
    if let Some(user) = user {
        cmd = cmd.user(user);
    }
    exec_full(bx, cmd).await
}

/// Starts an alpine box sized like the #2694 example: 2 CPUs, 3 GiB.
async fn start_box(
    privileged: bool,
) -> (
    common::TestRuntime,
    LiteBox,
    boxlite_test_utils::home::PerTestBoxHome,
) {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = common::TestRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("create runtime");
    let mut options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        cpus: Some(2.0),
        memory_mib: Some(3072),
        auto_delete: Some(0),
        ..Default::default()
    };
    options.advanced.set_privileged(privileged);
    let bx = runtime.create(options, None).await.expect("create box");
    bx.start().await.expect("start box");
    (runtime, bx, home)
}

async fn shutdown(runtime: common::TestRuntime, bx: LiteBox) {
    bx.stop().await.expect("stop box");
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unprivileged_container_reads_box_limits_read_only() {
    let (runtime, bx, _home) = start_box(false).await;

    // The container is the root of its own cgroup view.
    let (code, cgroup) = sh(&bx, "cat /proc/self/cgroup", None).await;
    assert_eq!((code, cgroup.trim()), (0, "0::/"));

    // A non-root user reads the box limits at the usual path.
    let (code, limits) = sh(
        &bx,
        "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max",
        Some("65534:65534"),
    )
    .await;
    assert_eq!(code, 0, "nobody must read the limit files: {limits}");
    assert_eq!(
        limits.lines().collect::<Vec<_>>(),
        [CPU_MAX, MEMORY_MAX, "max"]
    );

    // Neither nobody nor container root can raise them.
    for user in [Some("65534:65534"), None] {
        let (code, out) = sh(
            &bx,
            "echo 'max 100000' > /sys/fs/cgroup/cpu.max && echo written",
            user,
        )
        .await;
        assert_ne!(code, 0, "write as {user:?} must fail: {out}");
    }
    let (_, cpu_max) = sh(&bx, "cat /sys/fs/cgroup/cpu.max", None).await;
    assert_eq!(cpu_max.trim(), CPU_MAX);

    shutdown(runtime, bx).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn privileged_container_keeps_the_writable_guest_tree() {
    let (runtime, bx, _home) = start_box(true).await;

    let (code, cgroup) = sh(&bx, "cat /proc/self/cgroup", None).await;
    assert_eq!(code, 0);
    assert!(cgroup.contains(":youki:"), "guest-tree view: {cgroup}");

    // dockerd needs to create cgroups here.
    let (code, out) = sh(
        &bx,
        "mkdir /sys/fs/cgroup/boxlite-probe && rmdir /sys/fs/cgroup/boxlite-probe",
        None,
    )
    .await;
    assert_eq!(code, 0, "privileged tree must stay writable: {out}");

    // The box limits are still written to the container cgroup. Its name,
    // `/:youki:<id>`, contains colons, hence `-f3-`.
    let (code, limits) = sh(
        &bx,
        "dir=/sys/fs/cgroup$(cut -d: -f3- /proc/self/cgroup); cat $dir/cpu.max $dir/memory.max",
        None,
    )
    .await;
    assert_eq!(code, 0, "{limits}");
    assert_eq!(limits.lines().collect::<Vec<_>>(), [CPU_MAX, MEMORY_MAX]);

    shutdown(runtime, bx).await;
}
