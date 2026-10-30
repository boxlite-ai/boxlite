//! Real-KVM acceptance for checkpoint export and import (Linux x86_64 only).
//!
//! One box runs a long-lived guest process, pauses, exports a two-file pair,
//! then stops while its saved concrete share and boot paths remain available.
//! A fresh runtime imports the pair without a provider and resumes it, and
//! the same process must continue: same PID, start time, heap-only marker and
//! execution, with its linked share files, unlinked disk files and DAX mapping of a
//! share file intact and a counter that advances past the cut. Both networked
//! shims must run the project's
//! VMM seccomp filter on every thread. A cold boot, re-exec or skipped
//! filter fails an assertion; nothing here
//! skips.
//!
//! Run with `make test:checkpoint:acceptance`, which builds the guest helper
//! (`tests/fixtures/checkpoint_helper.c`) and requires `/dev/kvm`, a runtime
//! built by `make runtime:debug` and registry access for `alpine:latest`.
//! Tracing follows `RUST_LOG`; when `BOXLITE_CHECKPOINT_LOGS` names an
//! absolute directory, each box's logs are copied there before its home goes.
#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

mod common;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use boxlite::runtime::options::VolumeSpec;
use boxlite::{
    AttachOptions, BoxCommand, BoxOptions, BoxStatus, BoxliteError, BoxliteOptions, BoxliteRuntime,
    CheckpointImportOptions, CopyOptions, ExecStdout, LiteBox, PauseOptions, ResizeOptions,
    RootfsSpec,
};
use boxlite_test_utils::home::{PerTestBoxHome, live_shim_pids};
use futures::StreamExt;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::TestWriter;

const HELPER_ENV: &str = "BOXLITE_CHECKPOINT_HELPER";
const LOGS_ENV: &str = "BOXLITE_CHECKPOINT_LOGS";
/// Diagnostics a box leaves in its directory; disks, memory and keys are not.
const BOX_LOG_FILES: [&str; 4] = ["logs", "exit", "exit.previous", "shim.stderr"];
const HELPER_GUEST: &str = "/usr/local/bin/checkpoint_helper";
const DISK_DIR: &str = "/root/checkpoint";
const SHARE_GUEST: &str = "/mnt/share";
const HOST_IP: &str = "192.168.127.254";
const TICK_TIMEOUT: Duration = Duration::from_secs(30);
/// `WATERMARK` in `tests/fixtures/checkpoint_helper.c`.
const WATERMARK_OFFSET: u64 = 128;

/// One `tick` line of the guest helper.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Tick {
    pid: u32,
    marker: String,
    n: u64,
    dax: bool,
    state: String,
}

impl Tick {
    fn parse(line: &str) -> Option<Self> {
        let mut fields = line.strip_prefix("tick ")?.split(' ');
        let mut field = |key: &str| fields.next()?.strip_prefix(key).map(str::to_owned);
        Some(Self {
            pid: field("pid=")?.parse().ok()?,
            marker: field("marker=")?,
            n: field("n=")?.parse().ok()?,
            dax: field("dax=")? == "1",
            state: field("state=")?,
        })
    }
}

/// Splits an exec's stdout chunks into lines.
struct Lines {
    stdout: ExecStdout,
    pending: String,
    /// The helper's `start` line. An attach replays buffered output, so the
    /// line may come again, but only byte for byte: a re-executed helper
    /// prints a new marker.
    start: Option<String>,
}

impl Lines {
    fn new(stdout: ExecStdout, start: Option<String>) -> Self {
        Self {
            stdout,
            pending: String::new(),
            start,
        }
    }

    async fn next(&mut self) -> String {
        loop {
            if let Some(end) = self.pending.find('\n') {
                let line = self.pending[..end].to_owned();
                self.pending.drain(..=end);
                return line;
            }
            let chunk = tokio::time::timeout(TICK_TIMEOUT, self.stdout.next())
                .await
                .expect("guest helper went quiet")
                .expect("guest helper stdout closed");
            self.pending.push_str(&chunk);
        }
    }

    /// The next `count` ticks; every one must report intact state.
    async fn ticks(&mut self, count: usize) -> Vec<Tick> {
        let mut ticks = Vec::with_capacity(count);
        while ticks.len() < count {
            let line = self.next().await;
            if line.starts_with("start ") {
                assert_eq!(Some(&line), self.start.as_ref(), "helper restarted");
            }
            assert!(!line.starts_with("fatal "), "helper failed: {line}");
            if let Some(tick) = Tick::parse(&line) {
                assert_eq!(tick.state, "ok", "helper state broke: {line}");
                assert!(tick.dax, "the mapped share file is not DAX: {line}");
                ticks.push(tick);
            }
        }
        ticks
    }
}

async fn run(litebox: &LiteBox, program: &str, args: &[&str]) -> (i32, String) {
    let mut execution = litebox
        .exec(BoxCommand::new(program).args(args.iter().copied()))
        .await
        .unwrap_or_else(|e| panic!("exec {program} {args:?}: {e}"));
    let mut stdout = execution.stdout().expect("stdout");
    let mut output = String::new();
    while let Some(chunk) = stdout.next().await {
        output.push_str(&chunk);
    }
    let result = execution.wait().await.expect("wait");
    (result.exit_code, output)
}

async fn run_ok(litebox: &LiteBox, program: &str, args: &[&str]) -> String {
    let (code, output) = run(litebox, program, args).await;
    assert_eq!(code, 0, "{program} {args:?} failed: {output}");
    output.trim().to_owned()
}

/// Field 22 of `/proc/<pid>/stat`: start time in clock ticks since boot.
async fn start_time(litebox: &LiteBox, pid: u32) -> String {
    let stat = run_ok(litebox, "cat", &[&format!("/proc/{pid}/stat")]).await;
    let after_comm = &stat[stat.rfind(')').expect("stat comm") + 2..];
    after_comm.split(' ').nth(19).expect("starttime").to_owned()
}

async fn status(litebox: &LiteBox) -> BoxStatus {
    litebox.info().await.expect("info").status
}

fn helper_binary() -> PathBuf {
    let path = std::env::var_os(HELPER_ENV).unwrap_or_else(|| {
        panic!("{HELPER_ENV} is not set; run `make test:checkpoint:acceptance`")
    });
    let path = PathBuf::from(path);
    assert!(path.is_file(), "{} is not a file", path.display());
    path
}

fn require_kvm() {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/kvm")
        .unwrap_or_else(|e| panic!("checkpoint acceptance needs /dev/kvm: {e}"));
}

fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Serve one HTTP response carrying `token` on host loopback.
fn serve_once(token: &'static str) -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request);
        write!(
            stream,
            "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{token}",
            token.len()
        )
        .expect("respond");
    });
    (port, server)
}

/// Read the checked v9 envelope emitted by the real producer.
fn read_checkpoint(path: &Path) -> (serde_json::Value, serde_json::Value) {
    let mut members: Vec<_> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    members.sort();
    assert_eq!(members, ["snapshot.mem", "snapshot.qcow2"]);
    let mut memory = std::fs::File::open(path.join("snapshot.mem")).unwrap();
    let mut header = [0; 160];
    memory.read_exact(&mut header).unwrap();
    assert_eq!(&header[..8], b"KRUNVM\0\0");
    assert_eq!(u32::from_le_bytes(header[8..12].try_into().unwrap()), 9);
    assert_eq!(u32::from_le_bytes(header[12..16].try_into().unwrap()), 160);
    let length = u64::from_le_bytes(header[24..32].try_into().unwrap());
    assert!(length <= 16 << 20);
    let mut metadata = vec![0; length as usize];
    memory.read_exact(&mut metadata).unwrap();
    let image: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
    (image["application"].clone(), image)
}

/// Whether any virtio-fs DAX ledger in the image metadata maps a file.
fn has_file_dax_mapping(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            map.get("mappings")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|mappings| {
                    mappings
                        .iter()
                        .any(|mapping| mapping.pointer("/kind/file").is_some())
                })
                || map.values().any(has_file_dax_mapping)
        }
        serde_json::Value::Array(items) => items.iter().any(has_file_dax_mapping),
        _ => false,
    }
}

/// Upper bound of every counter the helper printed before the cut, read on
/// the host side of the share while the box is paused: the helper
/// atomically stores tick n as a little-endian u64 at byte
/// `WATERMARK_OFFSET` of its DAX-mapped `mapped.dat` before printing it.
fn cut_counter(share: &Path) -> u64 {
    use std::os::unix::fs::FileExt;
    let path = share.join("mapped.dat");
    let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut watermark = [0u8; 8];
    file.read_exact_at(&mut watermark, WATERMARK_OFFSET)
        .unwrap_or_else(|e| panic!("{} watermark: {e}", path.display()));
    u64::from_le_bytes(watermark)
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(TestWriter::with_stderr)
        .try_init();
}

/// Copies every box's logs out of one home when dropped, so a failed start
/// still leaves its shim log, console, exit record and stderr behind after
/// the temporary home is deleted. Declare it after its home: on a panic it
/// then drops first. Copy errors are printed and never change the verdict.
struct BoxLogs {
    boxes: PathBuf,
    dest: Option<PathBuf>,
}

impl BoxLogs {
    fn new(home: &Path, label: &str) -> Self {
        let dest = std::env::var_os(LOGS_ENV).map(|dir| {
            let dir = PathBuf::from(dir);
            assert!(dir.is_absolute(), "{LOGS_ENV} must be absolute");
            dir.join(label)
        });
        Self {
            boxes: home.join("boxes"),
            dest,
        }
    }
}

impl Drop for BoxLogs {
    fn drop(&mut self) {
        let Some(dest) = &self.dest else { return };
        let Ok(boxes) = std::fs::read_dir(&self.boxes) else {
            return;
        };
        for entry in boxes.flatten() {
            for name in BOX_LOG_FILES {
                let to = dest.join(entry.file_name()).join(name);
                if let Err(e) = copy_tree(&entry.path().join(name), &to) {
                    eprintln!("saving {}: {e}", to.display());
                }
            }
        }
    }
}

/// Copies regular files and directories; a missing source is not an error.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(from) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        metadata => metadata?,
    };
    if metadata.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        std::fs::create_dir_all(to.parent().expect("log destination parent"))?;
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// What `jailer::seccomp::apply_vmm_filter` logs once `seccomp(TSYNC)`
/// installed the project's VMM filter.
const VMM_FILTER_APPLIED: &str = "VMM seccomp filter applied to all threads (TSYNC)";

/// `(Seccomp, Seccomp_filters)` of one task, or `None` once it is gone.
fn seccomp_state(task: &Path) -> Option<(u32, u32)> {
    let status = std::fs::read_to_string(task.join("status")).ok()?;
    let field = |name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name)?.trim().parse().ok())
            .unwrap_or_else(|| panic!("{}/status has no {name}", task.display()))
    };
    Some((field("Seccomp:"), field("Seccomp_filters:")))
}

/// The parent of every process, read from `/proc/*/stat`.
fn process_parents() -> Vec<(u32, u32)> {
    std::fs::read_dir("/proc")
        .expect("read /proc")
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            // `pid (comm) state ppid ...`; comm may hold spaces.
            let ppid = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?;
            Some((pid, ppid.parse().ok()?))
        })
        .collect()
}

/// The `boxlite-shim` process below `launcher`, the box's recorded PID
/// (bwrap's outer process).
fn shim_process(launcher: u32) -> u32 {
    let parents = process_parents();
    let mut pending = vec![launcher];
    while let Some(pid) = pending.pop() {
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        let program = cmdline.split(|b| *b == 0).next().unwrap_or_default();
        if Path::new(std::str::from_utf8(program).unwrap_or_default()).ends_with("boxlite-shim") {
            return pid;
        }
        pending.extend(parents.iter().filter(|(_, p)| *p == pid).map(|(c, _)| *c));
    }
    panic!("no boxlite-shim process below {launcher}")
}

/// Every thread of the box's shim runs the project's VMM filter, installed
/// by the shim itself: nothing above the shim has a filter, each thread has
/// exactly one, and the shim logged installing it. Threads started during
/// the scan are scanned too; one may be skipped only once it is gone.
async fn assert_vmm_filter_on_every_thread(home: &Path, litebox: &LiteBox) {
    let launcher = litebox.info().await.expect("info").pid.expect("shim pid");
    let shim = shim_process(launcher);
    let parent = process_parents()
        .into_iter()
        .find_map(|(pid, ppid)| (pid == shim).then_some(ppid))
        .expect("shim parent");
    for ancestor in [
        Path::new("/proc/self"),
        &PathBuf::from(format!("/proc/{parent}")),
    ] {
        assert_eq!(
            seccomp_state(ancestor).map(|(mode, _)| mode),
            Some(0),
            "{} must not carry a seccomp filter the shim could inherit",
            ancestor.display()
        );
    }

    let tasks = PathBuf::from(format!("/proc/{shim}/task"));
    let mut checked = std::collections::BTreeMap::new();
    loop {
        let listed: Vec<u32> = std::fs::read_dir(&tasks)
            .expect("shim tasks")
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .filter(|tid| !checked.contains_key(tid))
            .collect();
        if listed.is_empty() {
            break;
        }
        for tid in listed {
            let task = tasks.join(tid.to_string());
            let comm = std::fs::read_to_string(task.join("comm")).unwrap_or_default();
            match seccomp_state(&task) {
                Some(state) => assert_eq!(
                    state,
                    (2, 1),
                    "shim {shim} thread {tid} ({}) is not under exactly one filter",
                    comm.trim()
                ),
                None => assert!(
                    tid != shim && !task.exists(),
                    "shim {shim} thread {tid} is alive but unreadable"
                ),
            }
            checked.insert(tid, comm.trim().to_owned());
        }
    }
    assert!(
        checked.contains_key(&shim) && checked.len() > 1,
        "{checked:?}"
    );
    eprintln!("shim {shim}: VMM filter on every thread: {checked:?}");

    let logs = home.join("boxes").join(litebox.id().as_str()).join("logs");
    let log: String = std::fs::read_dir(&logs)
        .unwrap_or_else(|e| panic!("{}: {e}", logs.display()))
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("boxlite-shim.log")
        })
        .map(|e| std::fs::read_to_string(e.path()).expect("shim log"))
        .collect();
    assert!(
        log.contains(VMM_FILTER_APPLIED),
        "the shim never logged its VMM filter"
    );
    assert!(
        !log.contains("Seccomp disabled"),
        "the shim skipped seccomp"
    );
}

/// Missing backend IDs must reach the real guest as EBADF, while independent
/// surviving handles and the original guest process keep working.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "real KVM acceptance; run with FILTER=checkpoint_missing_orphans_return_guest_ebadf"]
async fn checkpoint_missing_orphans_return_guest_ebadf() {
    init_tracing();
    require_kvm();
    let home = PerTestBoxHome::isolated();
    let _logs = BoxLogs::new(&home.path, "missing-source");
    let share = tempfile::tempdir().unwrap();
    for name in ["whole.dat", "handle.dat", "normal.dat"] {
        std::fs::write(share.path().join(name), vec![b'Q'; 8 * 1024 * 1024]).unwrap();
    }
    let pairs = tempfile::tempdir().unwrap();
    let rt = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let source = rt
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                memory_mib: Some(256),
                auto_delete: Some(0),
                volumes: vec![VolumeSpec::bind_mount(
                    share.path().to_str().unwrap(),
                    SHARE_GUEST,
                )],
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    source.start().await.unwrap();
    source
        .copy_into(helper_binary(), HELPER_GUEST, CopyOptions::default())
        .await
        .unwrap();
    run_ok(&source, "chmod", &["0755", HELPER_GUEST]).await;
    run_ok(&source, "mkdir", &["-p", DISK_DIR]).await;
    let mut execution = source
        .exec(BoxCommand::new(HELPER_GUEST).args([DISK_DIR, SHARE_GUEST, "missing"]))
        .await
        .unwrap();
    let execution_id = execution.id().clone();
    let mut lines = Lines::new(execution.stdout().unwrap(), None);
    let ready = lines.next().await;
    let pid: u32 = ready
        .strip_prefix("ready pid=")
        .expect(&ready)
        .parse()
        .unwrap();
    let started = start_time(&source, pid).await;
    source
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .unwrap();
    let pair = pairs.path().join("first");
    source.export_checkpoint(&pair).await.unwrap();
    let deps = BoxliteRuntime::inspect_checkpoint(&pair).unwrap();
    assert!(
        deps.shares
            .iter()
            .any(|share| share.objects.iter().any(|object| object.unlinked))
    );
    let (application, metadata) = read_checkpoint(&pair);
    assert_eq!(application["local_paths"]["version"], 2);
    assert!(has_file_dax_mapping(&metadata["fs"]));
    // Former unlinked filenames can be reused, but must never substitute for
    // the captured orphan. Both guest handles still return EBADF after import.
    std::fs::write(share.path().join("whole.dat"), b"replacement").unwrap();
    std::fs::write(share.path().join("handle.dat"), b"replacement").unwrap();
    source.stop().await.unwrap();
    rt.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
    drop(lines);
    drop(execution);
    drop(source);
    drop(rt);
    let target_home = PerTestBoxHome::isolated();
    let _target_logs = BoxLogs::new(&target_home.path, "missing-restored");
    let target = BoxliteRuntime::new(BoxliteOptions {
        home_dir: target_home.path.clone(),
        ..Default::default()
    })
    .unwrap();
    // A linked mapped file which disappears cannot be reconstructed.
    let mapped = share.path().join("mapped.dat");
    let temporarily_moved = share.path().join("mapped.saved");
    std::fs::rename(&mapped, &temporarily_moved).unwrap();
    let error = target
        .import_checkpoint(&pair, Default::default())
        .await
        .err()
        .expect("missing mapped backing must reject")
        .to_string();
    eprintln!("missing mapped backing rejected: {error}");
    assert!(target.list_info().await.unwrap().is_empty());
    std::fs::rename(&temporarily_moved, &mapped).unwrap();
    let restored = target
        .import_checkpoint(&pair, Default::default())
        .await
        .unwrap();
    assert_eq!(status(&restored).await, BoxStatus::Paused);
    restored.resume().await.unwrap();
    assert_eq!(start_time(&restored, pid).await, started);
    assert_vmm_filter_on_every_thread(&target_home.path, &restored).await;
    run_ok(&restored, "touch", &[&format!("{DISK_DIR}/probe")]).await;
    let mut attached = restored
        .attach(AttachOptions::execution(execution_id.clone()).read_only())
        .await
        .unwrap();
    let mut lines = Lines::new(attached.stdout().unwrap(), None);
    let mut probes = 0;
    while probes < 3 {
        let line = lines.next().await;
        eprintln!("guest: {line}");
        assert!(!line.starts_with("fatal"), "{line}");
        if line.starts_with("probe ") {
            assert!(
                line.contains(&format!("pid={pid} "))
                    && line.ends_with("normal=ok other-handle=ok flags=ok positions=ok dax=ok"),
                "{line}"
            );
            probes += 1;
        }
    }
    // Allocate fresh IDs before a second checkpoint; old guest descriptors must
    // still fail after another import rather than alias these new resources.
    run_ok(&restored, "sh", &["-c", "echo new > /mnt/share/new.dat"]).await;
    restored
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .unwrap();
    let second_cut = cut_counter(share.path());
    let second = pairs.path().join("second");
    restored.export_checkpoint(&second).await.unwrap();
    restored.stop().await.unwrap();
    let again = target
        .import_checkpoint(&second, Default::default())
        .await
        .unwrap();
    again.resume().await.unwrap();
    assert_eq!(start_time(&again, pid).await, started);
    let mut attached_again = again
        .attach(AttachOptions::execution(execution_id).read_only())
        .await
        .unwrap();
    let mut lines = Lines::new(attached_again.stdout().unwrap(), None);
    loop {
        let line = lines.next().await;
        eprintln!("repeat guest: {line}");
        assert!(!line.starts_with("fatal"), "{line}");
        if line.starts_with("probe ")
            && line
                .split(" n=")
                .nth(1)
                .unwrap()
                .split(' ')
                .next()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                > second_cut + 3
        {
            break;
        }
    }
    again.stop().await.unwrap();
    let again_id = again.id().clone();
    target
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
    drop(again);
    drop(restored);
    drop(target);
    let target = BoxliteRuntime::new(BoxliteOptions {
        home_dir: target_home.path.clone(),
        ..Default::default()
    })
    .unwrap();
    let cold = target.get(again_id.as_str()).await.unwrap().unwrap();
    cold.start().await.unwrap();
    assert_eq!(run_ok(&cold, "cat", &["/mnt/share/new.dat"]).await, "new");
    cold.stop().await.unwrap();
    target
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "real KVM acceptance; run with `make test:checkpoint:acceptance`"]
async fn checkpoint_continues_the_same_guest_process_in_a_new_runtime() {
    init_tracing();
    require_kvm();
    let helper = helper_binary();

    // ── Source: its own home and image cache, nothing linked from outside ──
    let source_home = PerTestBoxHome::isolated();
    let source_home_path = source_home.path.clone();
    let source_logs = BoxLogs::new(&source_home_path, "source");
    let share = tempfile::tempdir().expect("share dir");
    let share_path = share.path().to_path_buf();
    let checkpoint_dir = tempfile::tempdir().expect("checkpoint dir");
    let checkpoint = checkpoint_dir.path().join("source-checkpoint");
    std::fs::write(share_path.join("untouched"), b"never retained by the guest").unwrap();

    let source_rt = BoxliteRuntime::new(BoxliteOptions {
        home_dir: source_home_path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("source runtime");
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        cpus: Some(1),
        memory_mib: Some(256),
        auto_delete: Some(0),
        volumes: vec![VolumeSpec::bind_mount(
            share_path.to_str().expect("utf-8 share"),
            SHARE_GUEST,
        )],
        ..Default::default()
    };
    let source = source_rt
        .create(options, Some("checkpoint-source".into()))
        .await
        .expect("create default box");
    let source_id = source.id().clone();
    source.start().await.expect("start");
    let source_shim = source.info().await.unwrap().pid;
    let ceiling = source.resize(ResizeOptions::default()).await.unwrap();
    assert!(
        ceiling.max_cpus >= 3 && ceiling.max_memory_mib >= 640,
        "resize/checkpoint acceptance needs 3 CPUs and 640 MiB of capacity"
    );
    let before_capture = source
        .resize(ResizeOptions {
            cpus: Some(2),
            memory_mib: Some(512),
        })
        .await
        .expect("grow before checkpoint");
    assert_eq!((before_capture.cpus, before_capture.memory_mib), (2, 512));
    assert_eq!(source.info().await.unwrap().pid, source_shim);

    source
        .copy_into(&helper, HELPER_GUEST, CopyOptions::default())
        .await
        .expect("copy helper");
    run_ok(&source, "chmod", &["0755", HELPER_GUEST]).await;
    run_ok(&source, "mkdir", &["-p", DISK_DIR]).await;
    let boot_id = run_ok(&source, "cat", &["/proc/sys/kernel/random/boot_id"]).await;

    // ── Long-lived guest process ──
    let mut workload = source
        .exec(BoxCommand::new(HELPER_GUEST).args([DISK_DIR, SHARE_GUEST, "resize"]))
        .await
        .expect("start helper");
    let execution_id = workload.id().clone();
    let mut lines = Lines::new(workload.stdout().expect("helper stdout"), None);
    let start = lines.next().await;
    lines.start = Some(start.clone());
    let start_fields: Vec<&str> = start.split(' ').collect();
    assert_eq!(start_fields.first(), Some(&"start"), "{start}");
    let pid: u32 = start_fields[1]
        .strip_prefix("pid=")
        .and_then(|pid| pid.parse().ok())
        .unwrap_or_else(|| panic!("no pid in {start}"));
    let marker = start_fields[2]
        .strip_prefix("marker=")
        .unwrap_or_else(|| panic!("no marker in {start}"))
        .to_owned();
    let share_mount = lines.next().await;
    assert!(share_mount.contains(" - virtiofs "), "{share_mount}");
    assert!(
        share_mount.contains("dax=always"),
        "the share is not mounted with dax=always: {share_mount}"
    );
    eprintln!("share mount: {share_mount}");
    let before_cut = lines.ticks(5).await;
    assert!(
        before_cut
            .iter()
            .all(|t| t.pid == pid && t.marker == marker)
    );
    let started = start_time(&source, pid).await;

    // ── The networked source shim runs the project's VMM filter ──
    assert_vmm_filter_on_every_thread(&source_home_path, &source).await;

    // Disk capture and full checkpoints coexist on a default owner. A live
    // capture preserves the opened source inode and returns Running.
    let source_disk = source_home_path
        .join("boxes")
        .join(source_id.as_str())
        .join("disks/disk.qcow2");
    use std::os::unix::fs::MetadataExt;
    let live_disk = std::fs::File::open(&source_disk).unwrap();
    let disk_inode = live_disk.metadata().unwrap().ino();
    source
        .snapshots()
        .create(Default::default(), "before-checkpoint")
        .await
        .expect("running snapshot");
    assert_eq!(status(&source).await, BoxStatus::Running);
    assert_eq!(std::fs::metadata(&source_disk).unwrap().ino(), disk_inode);

    // ── Pause: an external share needs the writer assertion ──
    let refused = source.pause(PauseOptions::default()).await;
    assert!(
        matches!(refused, Err(BoxliteError::InvalidArgument(_))),
        "pause without the writer assertion: {refused:?}"
    );
    assert_eq!(status(&source).await, BoxStatus::Running);
    source
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .expect("pause");
    assert_eq!(status(&source).await, BoxStatus::Paused);
    assert!(
        source.resize(ResizeOptions::default()).await.is_err(),
        "paused owner must refuse resize"
    );
    assert!(
        source.exec(BoxCommand::new("true")).await.is_err(),
        "a paused box must refuse exec"
    );
    assert!(
        source
            .snapshots()
            .create(Default::default(), "must-not-stage")
            .await
            .is_err()
    );
    assert!(
        source
            .snapshots()
            .get("must-not-stage")
            .await
            .unwrap()
            .is_none()
    );
    // Buffered output may replay on attach; only a counter past this bound
    // proves the helper ran after the cut.
    let cut = cut_counter(&share_path);
    assert!(
        cut >= before_cut.last().expect("ticks").n,
        "the share lags the printed counter"
    );

    // ── Export exactly two files; an ordinary failure stays paused ──
    source
        .export_checkpoint(&checkpoint)
        .await
        .expect("export checkpoint");
    assert!(checkpoint.is_dir());
    let dependencies = BoxliteRuntime::inspect_checkpoint(&checkpoint).expect("inspect pair");
    use sha2::{Digest, Sha256};
    assert_eq!(dependencies.version, 9);
    assert_eq!(dependencies.memory_bytes, 512 << 20);
    assert_eq!(dependencies.cpus, u16::from(before_capture.max_cpus));
    let original_disk_digest =
        Sha256::digest(std::fs::read(checkpoint.join("snapshot.qcow2")).unwrap());
    let exported_len = std::fs::metadata(checkpoint.join("snapshot.mem"))
        .expect("checkpoint")
        .len();
    assert!(
        source.export_checkpoint(&checkpoint).await.is_err(),
        "an existing destination must never be overwritten"
    );
    assert_eq!(
        std::fs::metadata(checkpoint.join("snapshot.mem"))
            .expect("checkpoint")
            .len(),
        exported_len
    );
    assert_eq!(status(&source).await, BoxStatus::Paused);
    assert_eq!(
        cut_counter(&share_path),
        cut,
        "the helper wrote while the box was paused"
    );
    let (manifest, image) = read_checkpoint(&checkpoint);
    assert_eq!(manifest["source_box_id"], source_id.as_str());
    let container_id = manifest
        .pointer("/guest/container_id")
        .and_then(serde_json::Value::as_str)
        .expect("manifest guest.container_id")
        .to_owned();
    assert!(!container_id.is_empty());
    assert!(
        has_file_dax_mapping(&image),
        "the checkpoint holds no file DAX mapping for the helper's mapped file"
    );

    // Stop the source owner and runtime, retaining every saved path.
    let source_shim = source.info().await.unwrap().pid.unwrap();
    drop(lines);
    drop(workload);
    source.stop().await.unwrap();
    drop(source_logs);
    source_rt
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
    drop(source);
    drop(source_rt);
    assert!(!process_alive(source_shim));
    assert!(live_shim_pids(&source_home_path.join("boxes")).is_empty());
    // ── Import into a fresh, empty runtime: paused until resumed ──
    let target_home = PerTestBoxHome::isolated();
    let target_logs = BoxLogs::new(&target_home.path, "restored");
    let target_rt = BoxliteRuntime::new(BoxliteOptions {
        home_dir: target_home.path.clone(),
        ..Default::default()
    })
    .expect("target runtime");
    let restored = target_rt
        .import_checkpoint(
            &checkpoint,
            CheckpointImportOptions {
                name: Some("checkpoint-restored".into()),
            },
        )
        .await
        .expect("import checkpoint");
    assert_ne!(restored.id(), &source_id, "import must mint a new box id");
    assert_eq!(status(&restored).await, BoxStatus::Paused);
    assert!(
        restored.exec(BoxCommand::new("true")).await.is_err(),
        "an imported box must refuse exec before resume"
    );
    assert!(
        restored
            .attach(AttachOptions::execution(execution_id.clone()))
            .await
            .is_err(),
        "an imported box must refuse attach before resume"
    );

    // Resume fails and stops the VM unless the guest reports the container
    // the manifest retained (`container_id`) running and initialized.
    restored.resume().await.expect("resume restored box");
    assert_eq!(status(&restored).await, BoxStatus::Running);
    let restored_shim = restored.info().await.unwrap().pid;
    assert_eq!(
        restored.resize(ResizeOptions::default()).await.unwrap(),
        before_capture
    );
    let after_restore = restored
        .resize(ResizeOptions {
            cpus: Some(3),
            memory_mib: Some(640),
        })
        .await
        .expect("grow the imported continuation");
    assert_eq!((after_restore.cpus, after_restore.memory_mib), (3, 640));
    assert_eq!(restored.info().await.unwrap().pid, restored_shim);
    assert_eq!(
        run_ok(&restored, "cat", &["/sys/devices/system/cpu/online"]).await,
        "0-2"
    );

    // ── Same process, same execution, state from the cut, still counting ──
    let mut attached = restored
        .attach(AttachOptions::execution(execution_id.clone()).read_only())
        .await
        .expect("reattach original execution");
    assert_eq!(attached.id(), &execution_id);
    let mut lines = Lines::new(attached.stdout().expect("reattached stdout"), Some(start));
    // The attach may first replay buffered ticks from before the cut; read
    // until the counter is well past it.
    let mut restored_ticks = Vec::new();
    while restored_ticks.last().is_none_or(|t: &Tick| t.n < cut + 10) {
        restored_ticks.extend(lines.ticks(1).await);
    }
    for tick in &restored_ticks {
        assert_eq!((tick.pid, tick.marker.as_str()), (pid, marker.as_str()));
    }
    assert!(
        restored_ticks.windows(2).all(|w| w[1].n == w[0].n + 1),
        "counter must advance by one per tick: {restored_ticks:?}"
    );
    let last = restored_ticks.last().expect("ticks").n;
    eprintln!("cut <= {cut}, restored reached {last}");

    assert_eq!(
        run_ok(&restored, "cat", &["/proc/sys/kernel/random/boot_id"]).await,
        boot_id,
        "the guest kernel rebooted"
    );
    assert_eq!(
        start_time(&restored, pid).await,
        started,
        "the helper was re-executed"
    );
    // ── New RPC work: exec + wait, and a new network connection ──
    let (code, output) = run(&restored, "sh", &["-c", "echo new-exec"]).await;
    assert_eq!((code, output.trim()), (0, "new-exec"));
    let (port, server) = serve_once("checkpoint-network-ok");
    let fetched = run_ok(
        &restored,
        "wget",
        &["-q", "-O", "-", &format!("http://{HOST_IP}:{port}/")],
    )
    .await;
    assert_eq!(fetched, "checkpoint-network-ok");
    server.join().expect("server");
    // The restored shim, including what the connection started, is filtered.
    assert_vmm_filter_on_every_thread(&target_home.path, &restored).await;

    // The original execution still answers control: kill, then wait.
    attached.kill().await.expect("kill helper");
    let result = tokio::time::timeout(TICK_TIMEOUT, attached.wait())
        .await
        .expect("helper did not exit")
        .expect("wait helper");
    assert_ne!(result.exit_code, 0, "a killed helper cannot exit cleanly");

    // Nothing was pulled or cached to restore the box.
    let images = target_rt
        .images()
        .expect("images")
        .list()
        .await
        .expect("list");
    assert!(
        images.is_empty(),
        "import fell back to an image: {images:?}"
    );

    // Imported boxes also support disk snapshot -> full checkpoint -> resume.
    let imported_snapshot = restored
        .snapshots()
        .create(Default::default(), "imported-disk-cut")
        .await;
    if let Err(error) = imported_snapshot {
        restored
            .pause(PauseOptions {
                host_writers_stopped: true,
            })
            .await
            .expect("pause failed disk for diagnostics");
        if let Some(directory) = std::env::var_os(LOGS_ENV) {
            let disk = target_home
                .path
                .join("boxes")
                .join(restored.id().as_str())
                .join("disks/disk.qcow2");
            std::fs::copy(
                disk,
                PathBuf::from(directory).join("failed-imported-disk.qcow2"),
            )
            .expect("preserve failed disk");
        }
        panic!("imported running snapshot: {error}");
    }
    assert_eq!(status(&restored).await, BoxStatus::Running);
    restored
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .unwrap();
    let second_pair = checkpoint_dir.path().join("imported-checkpoint");
    restored
        .export_checkpoint(&second_pair)
        .await
        .expect("checkpoint after disk snapshot on import");
    let _ = read_checkpoint(&second_pair);
    restored.resume().await.unwrap();
    assert_eq!(
        Sha256::digest(std::fs::read(checkpoint.join("snapshot.qcow2")).unwrap()),
        original_disk_digest,
        "restored writes changed the input pair"
    );
    let private_disk = target_home
        .path
        .join("boxes")
        .join(restored.id().as_str())
        .join("disks/disk.qcow2");
    let private = std::fs::metadata(&private_disk).unwrap();
    let artifact = std::fs::metadata(checkpoint.join("snapshot.qcow2")).unwrap();
    assert_ne!(
        (private.dev(), private.ino()),
        (artifact.dev(), artifact.ino())
    );
    assert_eq!(private.nlink(), 1, "writable imported disk must be private");

    restored.stop().await.expect("stop restored owner");
    // Cold start uses the saved private QCOW2, exact external boot backend and
    // persistent source paths after the source runtime has shut down.
    let restored = target_rt
        .get(restored.id().as_str())
        .await
        .unwrap()
        .unwrap();
    restored.start().await.expect("cold start imported storage");
    assert_eq!(
        run_ok(
            &restored,
            "sh",
            &["-c", "test -f /root/checkpoint/disk.dat && echo retained"]
        )
        .await,
        "retained"
    );
    restored.stop().await.expect("stop cold-started import");
    drop(target_logs);
    target_rt
        .remove(restored.id().as_str(), true)
        .await
        .expect("remove restored");
    let _ = target_rt
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await;
}
