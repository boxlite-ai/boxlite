//! Real-KVM acceptance for checkpoint export and import (Linux x86_64 only).
//!
//! One box runs a long-lived guest process, pauses, exports one checkpoint
//! file and is destroyed together with every resource this test created for
//! it. A fresh runtime with an empty home imports the file and resumes it, and
//! the same process must continue: same PID, start time, heap-only marker and
//! execution, with its open and unlinked files and its DAX mapping of a
//! share file intact, a counter that advances past the cut, and no write the
//! source made after the cut. A cold boot, re-exec, source-home or
//! image-cache fallback fails an assertion; nothing here skips.
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
    CheckpointImportOptions, CopyOptions, ExecStdout, LiteBox, PauseOptions, RootfsSpec,
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

/// The checkpoint's manifest, and the VM image's metadata JSON.
fn read_checkpoint(path: &Path) -> (serde_json::Value, serde_json::Value) {
    let mut archive = tar::Archive::new(std::fs::File::open(path).expect("open checkpoint"));
    let mut manifest = None;
    let mut image = None;
    for entry in archive.entries().expect("checkpoint members") {
        let mut entry = entry.expect("checkpoint member");
        let name = entry
            .path()
            .expect("member name")
            .to_string_lossy()
            .into_owned();
        match name.as_str() {
            "checkpoint.json" => {
                manifest = Some(serde_json::from_reader(&mut entry).expect("manifest"))
            }
            "vm.krunvm" => {
                // KRUNVM v8: 8-byte magic, u32 version, u32 metadata length, metadata JSON.
                let mut header = [0u8; 16];
                entry.read_exact(&mut header).expect("image header");
                assert_eq!(&header[..8], b"KRUNVM\0\0");
                assert_eq!(u32::from_le_bytes(header[8..12].try_into().unwrap()), 8);
                let len = u32::from_le_bytes(header[12..].try_into().unwrap()) as usize;
                let mut metadata = vec![0u8; len];
                entry.read_exact(&mut metadata).expect("image metadata");
                image = Some(serde_json::from_slice(&metadata).expect("image metadata JSON"));
            }
            other => panic!("unexpected checkpoint member {other}"),
        }
    }
    (
        manifest.expect("checkpoint.json"),
        image.expect("vm.krunvm"),
    )
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

fn assert_absent(path: &Path) {
    assert!(!path.exists(), "{} still exists", path.display());
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
    let checkpoint = checkpoint_dir.path().join("source.boxckpt");

    let source_rt = BoxliteRuntime::new(BoxliteOptions {
        home_dir: source_home_path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("source runtime");
    let mut options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_delete: Some(0),
        volumes: vec![VolumeSpec::bind_mount(
            share_path.to_str().expect("utf-8 share"),
            SHARE_GUEST,
        )],
        ..Default::default()
    };
    options.advanced.checkpoint_enabled = true;
    let source = source_rt
        .create(options, Some("checkpoint-source".into()))
        .await
        .expect("create checkpoint-enabled box");
    let source_id = source.id().clone();
    source.start().await.expect("start");

    source
        .copy_into(&helper, HELPER_GUEST, CopyOptions::default())
        .await
        .expect("copy helper");
    run_ok(&source, "chmod", &["0755", HELPER_GUEST]).await;
    run_ok(&source, "mkdir", &["-p", DISK_DIR]).await;
    let boot_id = run_ok(&source, "cat", &["/proc/sys/kernel/random/boot_id"]).await;

    // ── Long-lived guest process ──
    let mut workload = source
        .exec(BoxCommand::new(HELPER_GUEST).args([DISK_DIR, SHARE_GUEST]))
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
        source.exec(BoxCommand::new("true")).await.is_err(),
        "a paused box must refuse exec"
    );
    // Buffered output may replay on attach; only a counter past this bound
    // proves the helper ran after the cut.
    let cut = cut_counter(&share_path);
    assert!(
        cut >= before_cut.last().expect("ticks").n,
        "the share lags the printed counter"
    );

    // ── Export exactly one checkpoint; an ordinary failure stays paused ──
    source
        .export_checkpoint(&checkpoint)
        .await
        .expect("export checkpoint");
    assert!(checkpoint.is_file());
    let exported_len = std::fs::metadata(&checkpoint).expect("checkpoint").len();
    assert!(
        source.export_checkpoint(&checkpoint).await.is_err(),
        "an existing destination must never be overwritten"
    );
    assert_eq!(
        std::fs::metadata(&checkpoint).expect("checkpoint").len(),
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

    // ── The source runs on and changes everything after the cut ──
    // Host-guest RPC connections do not survive a pause: reattach.
    drop(lines);
    source.resume().await.expect("resume source");
    let mut source_attach = source
        .attach(AttachOptions::execution(execution_id.clone()).read_only())
        .await
        .expect("reattach source execution");
    let mut lines = Lines::new(
        source_attach.stdout().expect("source stdout"),
        Some(start.clone()),
    );
    let mut source_progress = 0;
    while source_progress <= cut + 5 {
        source_progress = lines.ticks(1).await[0].n;
    }
    assert!(
        cut_counter(&share_path) > cut,
        "the source watermark did not move past the cut"
    );
    std::fs::write(share_path.join("host-after-cut"), b"source").expect("host write");
    run_ok(
        &source,
        "touch",
        &[
            &format!("{DISK_DIR}/guest-after-cut"),
            &format!("{SHARE_GUEST}/guest-after-cut"),
        ],
    )
    .await;

    // ── Destroy the source VM and every resource this test made for it ──
    let source_shim = source.info().await.expect("info").pid.expect("shim pid");
    drop(lines);
    drop(source_attach);
    drop(workload);
    source.stop().await.expect("stop source");
    drop(source_logs);
    source_rt
        .remove(source_id.as_str(), true)
        .await
        .expect("remove source");
    source_rt
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .expect("shutdown source runtime");
    drop(source);
    drop(source_rt);
    assert!(
        !process_alive(source_shim),
        "source shim {source_shim} survived"
    );
    assert!(live_shim_pids(&source_home_path.join("boxes")).is_empty());
    drop(source_home);
    drop(share);
    assert_absent(&source_home_path);
    assert_absent(&share_path);

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
    eprintln!("cut <= {cut}, source reached {source_progress}, restored reached {last}");

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
    for path in [
        format!("{DISK_DIR}/guest-after-cut"),
        format!("{SHARE_GUEST}/guest-after-cut"),
        format!("{SHARE_GUEST}/host-after-cut"),
    ] {
        let (code, _) = run(&restored, "test", &["!", "-e", &path]).await;
        assert_eq!(code, 0, "{path} was written after the cut but was restored");
    }

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

    restored.stop().await.expect("stop restored");
    drop(target_logs);
    target_rt
        .remove(restored.id().as_str(), true)
        .await
        .expect("remove restored");
    let _ = target_rt
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await;
}
